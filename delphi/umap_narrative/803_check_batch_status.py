#!/usr/bin/env python3
"""
Check and process Anthropic Batch API results for a specific job.

This script is a simple worker that is called by the job_poller. It does not
contain any job-finding or locking logic itself. It expects to be given a
single job ID to process.

Usage:
    python 803_check_batch_status.py --job-id JOB_ID
"""

import os, sys, json, boto3, logging, argparse, asyncio
from typing import Dict, Optional
from datetime import datetime, timedelta, timezone
from botocore.exceptions import ClientError
from umap_narrative.llm_factory_constructor.model_provider import log_ai_usage, AgoraProxyBatchClient, AgoraProxyStatusError, AgoraProxyTransportError, BatchNotCompleteError, agora_batch_available

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Anthropic Batch API Statuses
ANTHROPIC_BATCH_PREPARING = "preparing"
ANTHROPIC_BATCH_IN_PROGRESS = "in_progress"
ANTHROPIC_BATCH_COMPLETED = "completed"
ANTHROPIC_BATCH_ENDED = "ended"  # Anthropic API returns "ended" for completed batches
ANTHROPIC_BATCH_FAILED = "failed"
ANTHROPIC_BATCH_CANCELLED = "cancelled"

TERMINAL_BATCH_STATES = [ANTHROPIC_BATCH_COMPLETED, ANTHROPIC_BATCH_ENDED, ANTHROPIC_BATCH_FAILED, ANTHROPIC_BATCH_CANCELLED]
NON_TERMINAL_BATCH_STATES = [ANTHROPIC_BATCH_PREPARING, ANTHROPIC_BATCH_IN_PROGRESS]

# OpenAI-compatible Batch API Statuses
OPENAI_TERMINAL_STATES = ["completed", "failed", "cancelled", "expired"]

# Script Exit Codes (when --job-id is used)
# The job poller treats exit code 0 as success and any non-zero as failure.
EXIT_CODE_SUCCESS = 0
EXIT_CODE_FAILURE = 1
EXIT_CODE_PROCESSING_CONTINUES = 3  # Batch is still processing, poller should wait and re-check.

class BatchStatusChecker:
    """Checks a single batch job's status and processes results if complete."""

    def __init__(self):
        """Initialize the checker."""
        raw_endpoint = os.environ.get('DYNAMODB_ENDPOINT')
        endpoint_url = raw_endpoint if raw_endpoint and raw_endpoint.strip() else None
        
        self.dynamodb = boto3.resource('dynamodb', endpoint_url=endpoint_url, region_name=os.environ.get('AWS_REGION', 'us-east-1'))
        self.job_table = self.dynamodb.Table('Delphi_JobQueue')
        self.report_table = self.dynamodb.Table('Delphi_NarrativeReports')

        try:
            from anthropic import Anthropic
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if not api_key: raise ValueError("ANTHROPIC_API_KEY is not set.")
            self.anthropic = Anthropic(api_key=api_key)
        except (ImportError, ValueError) as e:
            logger.error(f"Failed to initialize Anthropic client: {e}")
            self.anthropic = None

        # Initialize OpenAI client for OpenAI-compatible batch providers
        try:
            from openai import OpenAI
            openai_api_key = os.environ.get("OPENAI_API_KEY")
            if openai_api_key:
                self.openai = OpenAI(api_key=openai_api_key)
                logger.info("OpenAI client initialized successfully")
            else:
                self.openai = None
                logger.warning("OPENAI_API_KEY not set — OpenAI-compatible batch checking unavailable")
        except (ImportError, Exception) as e:
            logger.warning(f"Failed to initialize OpenAI client: {e}")
            self.openai = None

        # Backwards-compatible aliases for older code paths in this module.
        self.EXIT_CODE_TERMINAL_STATE = EXIT_CODE_SUCCESS
        self.EXIT_CODE_SCRIPT_ERROR = EXIT_CODE_FAILURE
        self.EXIT_CODE_PROCESSING_CONTINUES = EXIT_CODE_PROCESSING_CONTINUES

    async def check_and_process_job(self, job_id: str) -> int:
        """
        Main logic: Fetches a job, checks its batch status, and processes if complete.
        Returns an exit code to the calling process.
        """
        if not self.anthropic and not self.openai and not agora_batch_available():
            return EXIT_CODE_FAILURE

        try:
            # 1. Fetch the single job we are responsible for checking.
            response = self.job_table.get_item(Key={'job_id': job_id})
            job_item = response.get('Item')
            if not job_item:
                logger.error(f"Job {job_id} not found in DynamoDB.")
                return EXIT_CODE_FAILURE

            batch_id = job_item.get('batch_id')
            batch_provider = job_item.get('batch_provider', 'anthropic')
            if not batch_id:
                logger.error(f"Job {job_id} is missing a 'batch_id'. Cannot check status.")
                self.job_table.update_item(Key={'job_id': job_id}, UpdateExpression="SET #s = :s", ExpressionAttributeNames={'#s':'status'}, ExpressionAttributeValues={':s':'FAILED'})
                return EXIT_CODE_FAILURE

            # 2. Check the status on the batch provider API
            if batch_provider == "anthropic":
                if not self.anthropic:
                    logger.error(f"Job {job_id}: Anthropic client not available.")
                    return EXIT_CODE_FAILURE
                logger.info(f"Checking status for Anthropic batch {batch_id} (from job {job_id})...")
                batch = self.anthropic.beta.messages.batches.retrieve(batch_id)
                status = batch.processing_status
                logger.info(f"Anthropic API returned status '{status}' for batch {batch_id}.")
                terminal_states = ["completed", "ended", "failed", "cancelled"]
                success_states = ["completed", "ended"]
            elif batch_provider == "agora":
                # Agora-proxied batch
                logger.info(f"Checking status for Agora batch {batch_id} (from job {job_id})...")
                try:
                    agora_client = AgoraProxyBatchClient()
                    status_data = agora_client.get_batch_status(batch_id)
                except BatchNotCompleteError:
                    logger.info(f"Job {job_id}: Agora batch {batch_id} not complete yet. Will check again later.")
                    return EXIT_CODE_PROCESSING_CONTINUES
                except AgoraProxyStatusError as e:
                    if e.status_code in (404, 401):
                        # Batch lost on Agora (404) or auth misconfiguration (401) — permanent.
                        logger.error(f"Job {job_id}: Agora batch status check returned {e.status_code} ({e}). Marking job FAILED.")
                        self.job_table.update_item(
                            Key={'job_id': job_id},
                            UpdateExpression="SET #s = :s, error_message = :e",
                            ExpressionAttributeNames={'#s': 'status'},
                            ExpressionAttributeValues={':s': 'FAILED', ':e': f'Batch status check failed: {e}'}
                        )
                        return EXIT_CODE_FAILURE
                    # 5xx — transient Agora-side issue; keep polling.
                    logger.warning(f"Job {job_id}: Agora batch status check returned {e.status_code} ({e}); will check again later.")
                    return EXIT_CODE_PROCESSING_CONTINUES
                except AgoraProxyTransportError as e:
                    # Proxy unreachable (connection/timeout) — keep polling rather
                    # than failing the job on a transient network blip.
                    logger.warning(f"Job {job_id}: Agora proxy unreachable during status check ({e}); will check again later.")
                    return EXIT_CODE_PROCESSING_CONTINUES
                except Exception as e:
                    logger.error(f"Job {job_id}: Agora batch status check failed: {e}")
                    return EXIT_CODE_FAILURE
                status = status_data.get('status', 'unknown')
                logger.info(f"Agora API returned status '{status}' for batch {batch_id}.")
                # Agora statuses: pending/processing/completed/failed/expired
                # (native batches may also surface provider states like
                # in_progress/preparing/validated/queued via provider_status).
                terminal_states = ["failed", "expired", "cancelled"]
                success_states = ["completed"]
            else:
                # OpenAI-compatible provider
                if not self.openai:
                    logger.error(f"Job {job_id}: OpenAI client not available for provider '{batch_provider}'.")
                    return EXIT_CODE_FAILURE
                logger.info(f"Checking status for OpenAI-compatible batch {batch_id} (from job {job_id}, provider={batch_provider})...")
                batch_obj = self.openai.batches.retrieve(batch_id)
                status = batch_obj.status
                logger.info(f"OpenAI API returned status '{status}' for batch {batch_id}.")
                terminal_states = OPENAI_TERMINAL_STATES
                success_states = ["completed"]

            # 3. Decide what to do based on the status
            if status in success_states:
                ok = await self.process_batch_results(job_item)
                if ok is None:
                    # Agora reported the batch complete but results are not
                    # fetchable yet (race) — keep polling.
                    logger.info(f"Job {job_id}: Batch {batch_id} results are not ready yet; will check again later.")
                    return EXIT_CODE_PROCESSING_CONTINUES
                return EXIT_CODE_SUCCESS if ok else EXIT_CODE_FAILURE
            
            elif status in terminal_states:
                # terminal but not success = failure
                logger.error(f"Batch {batch_id} for job {job_id} is in a terminal failure state: {status}")
                self.job_table.update_item(Key={'job_id': job_id}, UpdateExpression="SET #s = :s, error_message = :e", ExpressionAttributeNames={'#s':'status'}, ExpressionAttributeValues={':s':'FAILED', ':e': f'Batch status: {status}'})
                return EXIT_CODE_FAILURE

            elif status in ["in_progress", "preparing", "validating", "finalizing", "pending", "processing"]:
                logger.info(f"Batch {batch_id} is still {status}. Will check again later.")
                return EXIT_CODE_PROCESSING_CONTINUES
            
            else:
                logger.error(f"Unrecognized batch status '{status}' for batch {batch_id}.")
                return EXIT_CODE_FAILURE

        except ClientError as e:
            if "ResourceNotFoundException" in str(e):
                 logger.error(f"Job {job_id} not found in DynamoDB during processing.")
            else:
                logger.error(f"A DynamoDB error occurred processing job {job_id}: {e}", exc_info=True)
            return EXIT_CODE_FAILURE
        except Exception as e:
            logger.error(f"A critical error occurred processing job {job_id}: {e}", exc_info=True)
            return EXIT_CODE_FAILURE

    async def process_batch_results(self, job_item: Dict) -> bool:
        """Downloads, parses, and stores results for a completed batch job."""
        batch_provider = job_item.get('batch_provider', 'anthropic')
        if batch_provider == "anthropic":
            return await self._process_anthropic_batch_results(job_item)
        elif batch_provider == "agora":
            return await self._process_agora_batch_results(job_item)
        else:
            return await self._process_openai_batch_results(job_item)

    async def _process_anthropic_batch_results(self, job_item: Dict) -> bool:
        """Downloads, parses, and stores results for a completed Anthropic batch job."""
        job_id = job_item.get('job_id', 'unknown')
        batch_id = job_item.get('batch_id')
        report_id = job_item.get('report_id')

        if not all([job_id, batch_id, report_id, self.anthropic]):
            logger.error(f"Job {job_id}: Missing required info (job_id, batch_id, report_id, or client) for processing.")
            return False

        try:
            logger.info(f"Job {job_id}: Retrieving results for completed batch {batch_id}...")
            # Anthropic's SDK can stream results which is memory efficient
            results_stream = self.anthropic.beta.messages.batches.results(batch_id)

            processed_count = 0
            failed_count = 0
            total_input_tokens = 0
            total_output_tokens = 0
            batch_model = "unknown"
            
            for entry in results_stream:
                result_type = getattr(entry.result, 'type', None)
                if result_type == "succeeded":
                    custom_id = entry.custom_id
                    response_message = entry.result.message
                    model = response_message.model
                    content = response_message.content[0].text if response_message.content else "{}"

                    # Reconstruct the section name from the custom_id
                    parts = custom_id.split('_', 1)
                    if len(parts) < 2:
                        logger.error(f"Job {job_id}: Invalid custom_id format '{custom_id}'. Skipping result.")
                        failed_count += 1
                        continue
                    section_name = parts[1]

                    # Store the report
                    rid_section_model = f"{report_id}#{section_name}#{model}"
                    self.report_table.put_item(Item={
                        'rid_section_model': rid_section_model,
                        'timestamp': datetime.now(timezone.utc).isoformat(),
                        'report_id': report_id,
                        'section': section_name,
                        'model': model,
                        'report_data': content,
                        'job_id': job_id,
                        'batch_id': batch_id,
                    })
                    logger.info(f"Job {job_id}: Successfully stored report for section '{section_name}'.")
                    processed_count += 1

                    # Track token usage
                    batch_model = model  # capture the model name from the first successful response
                    usage = getattr(response_message, 'usage', None)
                    if usage:
                        total_input_tokens += getattr(usage, 'input_tokens', 0) or 0
                        total_output_tokens += getattr(usage, 'output_tokens', 0) or 0

                elif result_type in ("failed", "errored", "canceled", "cancelled", "expired"):
                    failed_count += 1
                    # Different SDK result types expose errors slightly differently; be defensive.
                    error_obj = getattr(entry.result, 'error', None)
                    try:
                        error_text = str(error_obj)
                    except Exception:
                        error_text = repr(error_obj)
                    logger.error(
                        f"Job {job_id}: A request in batch {batch_id} did not succeed. "
                        f"Result type: {result_type}. Custom ID: {entry.custom_id}. Error: {error_text}"
                    )

                else:
                    failed_count += 1
                    logger.error(
                        f"Job {job_id}: Unrecognized batch entry result type '{result_type}'. "
                        f"Custom ID: {getattr(entry, 'custom_id', None)}"
                    )

            # Finalize the job status
            final_status = 'COMPLETED' if processed_count > 0 else 'FAILED'
            update_expression = "SET #s = :status, completed_at = :time"
            expression_values = {':status': final_status, ':time': datetime.now(timezone.utc).isoformat()}
            
            if failed_count > 0:
                update_expression += ", error_message = :error"
                expression_values[':error'] = f"{failed_count} of {failed_count + processed_count} batch requests failed."
            elif processed_count == 0:
                update_expression += ", error_message = :error"
                expression_values[':error'] = "No results were returned by the batch results stream."

            self.job_table.update_item(
                Key={'job_id': job_id},
                UpdateExpression=update_expression,
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues=expression_values
            )
            logger.info(f"Job {job_id}: Final status set to '{final_status}'. Processed: {processed_count}, Failed: {failed_count}.")

            # Log actual AI usage (after successful processing)
            if processed_count > 0:
                try:
                    deliberation_id = job_item.get('deliberation_id', '')
                    log_ai_usage(
                        use_case='delphi_report',
                        model=batch_model,
                        provider='anthropic',
                        input_tokens=total_input_tokens or 1,
                        output_tokens=total_output_tokens or 1,
                        deliberation_id=deliberation_id,
                    )
                except Exception as e:
                    logger.warning(f"Job {job_id}: Failed to log AI usage: {e}")

            return processed_count > 0
        
        except Exception as e:
            logger.error(f"Job {job_id}: A critical error occurred during result processing for batch {batch_id}: {e}", exc_info=True)
            # Mark the job as FAILED
            self.job_table.update_item(Key={'job_id': job_id}, UpdateExpression="SET #s = :s, error_message = :e", ExpressionAttributeNames={'#s':'status'}, ExpressionAttributeValues={':s':'FAILED', ':e': f"Result processing error: {str(e)}"})
            return False

    async def _process_openai_batch_results(self, job_item: Dict) -> bool:
        """Downloads, parses, and stores results for a completed OpenAI-compatible batch job."""
        job_id = job_item.get('job_id', 'unknown')
        batch_id = job_item.get('batch_id')
        report_id = job_item.get('report_id')

        if not all([job_id, batch_id, report_id, self.openai]):
            logger.error(f"Job {job_id}: Missing required info (job_id, batch_id, report_id, or client) for processing.")
            return False

        try:
            logger.info(f"Job {job_id}: Retrieving results for completed OpenAI batch {batch_id}...")
            batch_obj = self.openai.batches.retrieve(batch_id)

            if not batch_obj.output_file_id:
                logger.error(f"Job {job_id}: OpenAI batch {batch_id} has no output_file_id.")
                self.job_table.update_item(
                    Key={'job_id': job_id},
                    UpdateExpression="SET #s = :s, error_message = :e, completed_at = :time",
                    ExpressionAttributeNames={'#s': 'status'},
                    ExpressionAttributeValues={
                        ':s': 'FAILED',
                        ':e': 'Batch completed but no output_file_id.',
                        ':time': datetime.now(timezone.utc).isoformat()
                    }
                )
                return False

            # Download the results file
            results_content = self.openai.files.content(batch_obj.output_file_id).text
            if not results_content or not results_content.strip():
                logger.error(f"Job {job_id}: OpenAI batch {batch_id} results file is empty.")
                self.job_table.update_item(
                    Key={'job_id': job_id},
                    UpdateExpression="SET #s = :s, error_message = :e, completed_at = :time",
                    ExpressionAttributeNames={'#s': 'status'},
                    ExpressionAttributeValues={
                        ':s': 'FAILED',
                        ':e': 'Batch results file is empty.',
                        ':time': datetime.now(timezone.utc).isoformat()
                    }
                )
                return False

            processed_count = 0
            failed_count = 0
            total_input_tokens = 0
            total_output_tokens = 0
            batch_model = "unknown"

            for line in results_content.strip().split('\n'):
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    logger.error(f"Job {job_id}: Failed to parse JSONL line in batch results.")
                    failed_count += 1
                    continue

                custom_id = entry.get('custom_id', '')
                response = entry.get('response', {})
                status_code = response.get('status_code')
                body = response.get('body', {})

                if status_code == 200:
                    # Success
                    model = body.get('model', 'unknown')
                    choices = body.get('choices', [])
                    content = ''
                    if choices:
                        message = choices[0].get('message', {})
                        content = message.get('content', '')
                        if isinstance(content, list):
                            # Handle structured content (e.g., array of content blocks)
                            content = json.dumps(content)
                        elif not isinstance(content, str):
                            content = str(content)

                    # Reconstruct the section name from the custom_id
                    parts = custom_id.split('_', 1)
                    if len(parts) < 2:
                        logger.error(f"Job {job_id}: Invalid custom_id format '{custom_id}'. Skipping result.")
                        failed_count += 1
                        continue
                    section_name = parts[1]

                    # Store the report
                    rid_section_model = f"{report_id}#{section_name}#{model}"
                    self.report_table.put_item(Item={
                        'rid_section_model': rid_section_model,
                        'timestamp': datetime.now(timezone.utc).isoformat(),
                        'report_id': report_id,
                        'section': section_name,
                        'model': model,
                        'report_data': content,
                        'job_id': job_id,
                        'batch_id': batch_id,
                    })
                    logger.info(f"Job {job_id}: Successfully stored report for section '{section_name}'.")
                    processed_count += 1

                    # Track token usage
                    batch_model = body.get('model', batch_model)
                    usage = body.get('usage', {})
                    total_input_tokens += usage.get('prompt_tokens', 0)
                    total_output_tokens += usage.get('completion_tokens', 0)
                else:
                    failed_count += 1
                    error_data = body.get('error', {})
                    logger.error(
                        f"Job {job_id}: Request failed in OpenAI batch {batch_id}. "
                        f"Custom ID: {custom_id}. Status: {status_code}. Error: {error_data}"
                    )

            # Finalize the job status
            final_status = 'COMPLETED' if processed_count > 0 else 'FAILED'
            update_expression = "SET #s = :status, completed_at = :time"
            expression_values = {':status': final_status, ':time': datetime.now(timezone.utc).isoformat()}

            if failed_count > 0:
                update_expression += ", error_message = :error"
                expression_values[':error'] = f"{failed_count} of {failed_count + processed_count} batch requests failed."
            elif processed_count == 0:
                update_expression += ", error_message = :error"
                expression_values[':error'] = "No results were returned by the batch results stream."

            self.job_table.update_item(
                Key={'job_id': job_id},
                UpdateExpression=update_expression,
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues=expression_values
            )
            logger.info(f"Job {job_id}: Final status set to '{final_status}'. Processed: {processed_count}, Failed: {failed_count}.")

            if processed_count > 0:
                try:
                    batch_provider_name = job_item.get('batch_provider', 'openai')
                    deliberation_id = job_item.get('deliberation_id', '')
                    log_ai_usage(
                        use_case='delphi_report',
                        model=batch_model,
                        provider=batch_provider_name,
                        input_tokens=total_input_tokens or 1,
                        output_tokens=total_output_tokens or 1,
                        deliberation_id=deliberation_id,
                    )
                except Exception as e:
                    logger.warning(f"Job {job_id}: Failed to log AI usage: {e}")

            return processed_count > 0

        except Exception as e:
            logger.error(f"Job {job_id}: A critical error occurred during OpenAI result processing for batch {batch_id}: {e}", exc_info=True)
            self.job_table.update_item(
                Key={'job_id': job_id},
                UpdateExpression="SET #s = :s, error_message = :e",
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues={':s': 'FAILED', ':e': f"Result processing error: {str(e)}"}
            )
            return False

    async def _process_agora_batch_results(self, job_item: Dict):
        """Fetch and store results for a completed Agora-proxied batch job.

        Results come back from Agora as a full response dict:
            results:  [{custom_id, content, model, provider, input_tokens,
                        output_tokens, finish_reason}]
            failures: [{custom_id, error}]
        Token counts are per-result; totals are aggregated and usage is
        logged once after processing (same shape as the Anthropic/OpenAI
        result-processing methods).

        Returns:
            True if at least one result was stored, False on failure,
            None if the batch is not complete yet (caller should re-check).
        """
        job_id = job_item.get('job_id', 'unknown')
        batch_id = job_item.get('batch_id')
        report_id = job_item.get('report_id')

        if not all([job_id, batch_id, report_id]):
            logger.error(f"Job {job_id}: Missing required info (job_id, batch_id, report_id) for processing.")
            return False

        try:
            logger.info(f"Job {job_id}: Retrieving results for completed Agora batch {batch_id}...")
            agora_client = AgoraProxyBatchClient()
            result_data = agora_client.get_batch_results(batch_id)
            results = result_data.get('results', [])
            failures = result_data.get('failures', [])

            processed_count = 0
            failed_count = 0
            total_input_tokens = 0
            total_output_tokens = 0
            batch_model = "unknown"
            batch_provider = "agora"

            for result in results:
                custom_id = result.get('custom_id', '')

                content = result.get('content', '')
                if not content:
                    failed_count += 1
                    logger.error(f"Job {job_id}: Agora result for custom_id '{custom_id}' has no content.")
                    continue

                model = result.get('model', 'unknown')
                provider = result.get('provider', 'agora')

                # Reconstruct the section name from the custom_id (same reverse
                # logic as the Anthropic/OpenAI branches: "{conversation_id}_{section}")
                parts = custom_id.split('_', 1)
                if len(parts) < 2:
                    logger.error(f"Job {job_id}: Invalid custom_id format '{custom_id}'. Skipping result.")
                    failed_count += 1
                    continue
                section_name = parts[1]

                # Store the report (same shape as the other branches)
                rid_section_model = f"{report_id}#{section_name}#{model}"
                self.report_table.put_item(Item={
                    'rid_section_model': rid_section_model,
                    'timestamp': datetime.now(timezone.utc).isoformat(),
                    'report_id': report_id,
                    'section': section_name,
                    'model': model,
                    'report_data': content,
                    'job_id': job_id,
                    'batch_id': batch_id,
                })
                logger.info(f"Job {job_id}: Successfully stored report for section '{section_name}'.")
                processed_count += 1

                # Track token usage (totals logged once below, like the
                # Anthropic/OpenAI branches)
                batch_model = model
                batch_provider = provider
                total_input_tokens += result.get('input_tokens') or 0
                total_output_tokens += result.get('output_tokens') or 0

            # Agora reports per-request failures separately from successes
            for failure in failures:
                failed_count += 1
                logger.error(
                    f"Job {job_id}: Request failed in Agora batch {batch_id}. "
                    f"Custom ID: {failure.get('custom_id')}. Error: {failure.get('error')}"
                )

            # Finalize the job status
            final_status = 'COMPLETED' if processed_count > 0 else 'FAILED'
            update_expression = "SET #s = :status, completed_at = :time"
            expression_values = {':status': final_status, ':time': datetime.now(timezone.utc).isoformat()}

            if failed_count > 0:
                update_expression += ", error_message = :error"
                expression_values[':error'] = f"{failed_count} of {failed_count + processed_count} batch requests failed."
            elif processed_count == 0:
                update_expression += ", error_message = :error"
                expression_values[':error'] = "No results were returned by the Agora batch."

            self.job_table.update_item(
                Key={'job_id': job_id},
                UpdateExpression=update_expression,
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues=expression_values
            )
            logger.info(f"Job {job_id}: Final status set to '{final_status}'. Processed: {processed_count}, Failed: {failed_count}.")

            # Log actual AI usage (after successful processing)
            if processed_count > 0:
                try:
                    deliberation_id = job_item.get('deliberation_id', '')
                    log_ai_usage(
                        use_case='delphi_report',
                        model=batch_model,
                        provider=batch_provider,
                        input_tokens=total_input_tokens or 1,
                        output_tokens=total_output_tokens or 1,
                        deliberation_id=deliberation_id,
                    )
                except Exception as e:
                    logger.warning(f"Job {job_id}: Failed to log AI usage: {e}")

            return processed_count > 0

        except BatchNotCompleteError:
            # Batch reported complete but results aren't ready (409) — keep polling.
            logger.info(f"Job {job_id}: Agora batch {batch_id} not complete yet (409). Will check again later.")
            return None
        except AgoraProxyTransportError as e:
            # Batch is completed but the proxy is temporarily unreachable —
            # keep polling instead of failing the job.
            logger.warning(f"Job {job_id}: Agora proxy unreachable during results fetch ({e}); will check again later.")
            return None
        except AgoraProxyStatusError as e:
            if e.status_code >= 500:
                # Agora-side transient failure fetching provider results — retry later.
                logger.warning(f"Job {job_id}: Agora proxy returned {e.status_code} while fetching results ({e}); will check again later.")
                return None
            # 401/404 and other statuses — permanent; fall through to the
            # generic failure handler below.
            raise
        except Exception as e:
            logger.error(f"Job {job_id}: A critical error occurred during Agora result processing for batch {batch_id}: {e}", exc_info=True)
            self.job_table.update_item(
                Key={'job_id': job_id},
                UpdateExpression="SET #s = :s, error_message = :e",
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues={':s': 'FAILED', ':e': f"Result processing error: {str(e)}"}
            )
            return False

    async def check_and_process_jobs(self, specific_job_id: Optional[str] = None) -> Optional[int]:
        jobs_to_check = self.find_pending_jobs(specific_job_id)

        if not jobs_to_check:
            if specific_job_id:
                logger.error(f"Job {specific_job_id} not found or no longer in a processable state.")
                return self.EXIT_CODE_TERMINAL_STATE
            logger.info("No pending batch jobs found in this polling cycle.")
            return None

        for job_item in jobs_to_check:
            job_id = job_item.get('job_id')
            if not job_id: continue

            current_status = job_item.get('status')
            now_iso = datetime.now(timezone.utc).isoformat()
            new_expiry_iso = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()

            try:
                logger.info(f"Attempting to lock job {job_id} (current status: {current_status})...")
                condition_expr = "(#s = :processing_status) OR (#s = :locked_status AND lock_expires_at < :now)"
                self.job_table.update_item(
                    Key={'job_id': job_id},
                    UpdateExpression="SET #s = :new_locked_status, lock_expires_at = :new_expiry, last_checked = :now",
                    ConditionExpression=condition_expr,
                    ExpressionAttributeNames={'#s': 'status'},
                    ExpressionAttributeValues={
                        ':processing_status': 'PROCESSING',
                        ':locked_status': 'LOCKED_FOR_CHECKING',
                        ':new_locked_status': 'LOCKED_FOR_CHECKING',
                        ':now': now_iso,
                        ':new_expiry': new_expiry_iso
                    }
                )
                logger.info(f"Successfully locked job {job_id}. Lock expires at {new_expiry_iso}.")
            
            except ClientError as e:
                if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                    logger.warning(f"Job {job_id} was locked or processed by another worker. Skipping.")
                    continue
                else:
                    logger.error(f"Error locking job {job_id}: {e}")
                    continue

            current_job_processing_signal = self.EXIT_CODE_SCRIPT_ERROR
            try:
                batch_api_status = await self.check_batch_status(job_item)

                if batch_api_status in [ANTHROPIC_BATCH_COMPLETED, ANTHROPIC_BATCH_ENDED]:
                    await self.process_batch_results(job_item)
                    current_job_processing_signal = self.EXIT_CODE_TERMINAL_STATE
                
                elif batch_api_status in [ANTHROPIC_BATCH_FAILED, ANTHROPIC_BATCH_CANCELLED, "BATCH_NOT_FOUND"]:
                    self.job_table.update_item(
                        Key={'job_id': job_id},
                        UpdateExpression="SET #s = :final_status, completed_at = :time, error_message = :error",
                        ExpressionAttributeNames={'#s': 'status'},
                        ExpressionAttributeValues={
                            ':final_status': 'FAILED',
                            ':time': now_iso,
                            ':error': f"Batch terminal status: {batch_api_status}"
                        }
                    )
                    current_job_processing_signal = self.EXIT_CODE_TERMINAL_STATE

                elif batch_api_status in NON_TERMINAL_BATCH_STATES:
                    logger.info(f"Job {job_id}: Batch still {batch_api_status}. Lock will time out if worker fails.")
                    current_job_processing_signal = self.EXIT_CODE_PROCESSING_CONTINUES

                else:
                    logger.error(f"Job {job_id}: Could not determine batch status. Lock will time out.")
                    current_job_processing_signal = self.EXIT_CODE_SCRIPT_ERROR
            
            except Exception as processing_error:
                logger.error(f"Critical error processing locked job {job_id}: {processing_error}", exc_info=True)
                try:
                    self.job_table.update_item(Key={'job_id': job_id}, UpdateExpression="SET #s = :s, error_message = :e", ExpressionAttributeNames={'#s':'status'}, ExpressionAttributeValues={':s':'FAILED', ':e': str(processing_error)})
                except Exception as final_error:
                    logger.critical(f"FATAL: Could not mark job {job_id} as FAILED. It is now a zombie: {final_error}")
                current_job_processing_signal = self.EXIT_CODE_SCRIPT_ERROR

            if specific_job_id:
                return current_job_processing_signal
        
        return None

async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Check a single Anthropic Batch Job status.')
    parser.add_argument('--job-id', type=str, required=True, help='The main job ID (e.g., batch_report_...) to check.')
    args = parser.parse_args()

    checker = BatchStatusChecker()
    exit_signal = await checker.check_and_process_job(args.job_id)
    
    logger.info(f"Script finished for job {args.job_id} with exit signal: {exit_signal}")
    sys.exit(exit_signal)

if __name__ == "__main__":
    asyncio.run(main())

if __name__ == "__main__":
    # Module-level constants are accessible here
    asyncio.run(main())