#!/usr/bin/env python3
"""
Delphi Job Poller Service

This script runs as a daemon to poll the Delphi_JobQueue for pending jobs
and execute them.
"""

import argparse
from contextlib import contextmanager
import sqlalchemy as sa
from sqlalchemy.orm import DeclarativeBase, sessionmaker, scoped_session
from sqlalchemy.dialects.postgresql import JSON, JSONB
from sqlalchemy.pool import QueuePool
from sqlalchemy.sql import text
from typing import Any, Dict, List, Optional
import boto3
from boto3.dynamodb.conditions import Attr
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from botocore.exceptions import ClientError
import urllib


class PostgresConfig:
    """Configuration for PostgreSQL connection."""
    
    def __init__(self, 
                url: Optional[str] = None,
                host: Optional[str] = None,
                port: Optional[int] = None,
                database: Optional[str] = None,
                user: Optional[str] = None,
                password: Optional[str] = None,
                ssl_mode: Optional[str] = None):
        """
        Initialize PostgreSQL configuration.
        
        Args:
            url: Database URL (overrides other connection parameters if provided)
            host: Database host
            port: Database port
            database: Database name
            user: Database user
            password: Database password
            ssl_mode: SSL mode (disable, allow, prefer, require, verify-ca, verify-full)
        """
        # Parse URL if provided
        if url:
            self._parse_url(url)
        else:
            self.host = host or os.environ.get('DATABASE_HOST', 'localhost')
            self.port = port or int(os.environ.get('DATABASE_PORT', '5432'))
            self.database = database or os.environ.get('DATABASE_NAME', 'polisDB_prod_local_mar14')
            self.user = user or os.environ.get('DATABASE_USER', 'postgres')
            self.password = password or os.environ.get('DATABASE_PASSWORD', '')
        
        # Set SSL mode
        self.ssl_mode = ssl_mode or os.environ.get('DATABASE_SSL_MODE', 'require')
    
    def _parse_url(self, url: str) -> None:
        """
        Parse a database URL into components.
        
        Args:
            url: Database URL in format postgresql://user:password@host:port/database
        """
        # Use environment variable if url is not provided
        if not url:
            url = os.environ.get('DATABASE_URL', '')
        
        if not url:
            raise ValueError("No database URL provided")
        
        # Parse URL
        parsed = urllib.parse.urlparse(url)
        
        # Extract components
        self.user = parsed.username
        self.password = parsed.password
        self.host = parsed.hostname
        self.port = parsed.port or 5432
        
        # Extract database name (remove leading '/')
        path = parsed.path
        if path.startswith('/'):
            path = path[1:]
        self.database = path
    
    def get_uri(self) -> str:
        """
        Get SQLAlchemy URI for database connection.
        
        Returns:
            SQLAlchemy URI string
        """
        # Format password component if present
        password_str = f":{self.password}" if self.password else ""
        
        # Build URI
        uri = f"postgresql://{self.user}{password_str}@{self.host}:{self.port}/{self.database}"

        if self.ssl_mode: # Check if self.ssl_mode is not None or empty
            uri = f"{uri}?sslmode={self.ssl_mode}"
        
        return uri
    
    @classmethod
    def from_env(cls) -> 'PostgresConfig':
        """
        Create a configuration from environment variables.
        
        Returns:
            PostgresConfig instance
        """
        # Check for DATABASE_URL
        url = os.environ.get('DATABASE_URL')
        if url:
            return cls(url=url)
        
        # Use individual environment variables
        return cls(
            host=os.environ.get('DATABASE_HOST'),
            port=int(os.environ.get('DATABASE_PORT', '5432')),
            database=os.environ.get('DATABASE_NAME'),
            user=os.environ.get('DATABASE_USER'),
            password=os.environ.get('DATABASE_PASSWORD')
        )


class PostgresClient:
    """PostgreSQL client for accessing Polis data."""
    
    def __init__(self, config: Optional[PostgresConfig] = None):
        """
        Initialize PostgreSQL client.
        
        Args:
            config: PostgreSQL configuration
        """
        self.config = config or PostgresConfig.from_env()
        self.engine = None
        self.session_factory = None
        self.Session = None
        self._initialized = False
    
    def initialize(self) -> None:
        """
        Initialize the database connection.
        """
        if self._initialized:
            return
        
        # Create engine
        uri = self.config.get_uri()
        self.engine = sa.create_engine(
            uri,
            pool_size=5,
            max_overflow=10,
            pool_recycle=300  # Recycle connections after 5 minutes
        )
        
        # Create session factory
        self.session_factory = sessionmaker(bind=self.engine)
        self.Session = scoped_session(self.session_factory)
        
        # Mark as initialized
        self._initialized = True
        
        logger.info(f"Initialized PostgreSQL connection to {self.config.host}:{self.config.port}/{self.config.database}")
    
    def shutdown(self) -> None:
        """
        Shut down the database connection.
        """
        if not self._initialized:
            return
        
        # Dispose of the engine
        if self.engine:
            self.engine.dispose()
        
        # Clear session factory
        if self.Session:
            self.Session.remove()
            self.Session = None
        
        # Mark as not initialized
        self._initialized = False
        
        logger.info("Shut down PostgreSQL connection")
    
    @contextmanager
    def session(self):
        """
        Get a database session context.
        
        Yields:
            SQLAlchemy session
        """
        if not self._initialized:
            self.initialize()
        
        session = self.Session()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()
    
    def query(self, sql: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """
        Execute a SQL query.
        
        Args:
            sql: SQL query
            params: Query parameters
            
        Returns:
            List of dictionaries with query results
        """
        if not self._initialized:
            self.initialize()
        
        with self.engine.connect() as conn:
            result = conn.execute(text(sql), params or {})
            
            # Convert to dictionaries
            columns = result.keys()
            return [dict(zip(columns, row)) for row in result]
    
    def get_conversation_by_id(self, zid: int) -> Optional[Dict[str, Any]]:
        """
        Get conversation information by ID.
        
        Args:
            zid: Conversation ID
            
        Returns:
            Conversation data, or None if not found
        """
        sql = """
        SELECT * FROM conversations WHERE zid = :zid
        """
        
        results = self.query(sql, {"zid": zid})
        return results[0] if results else None
    
    def get_comments_by_conversation(self, zid: int) -> List[Dict[str, Any]]:
        """
        Get all comments in a conversation.
        
        Args:
            zid: Conversation ID
            
        Returns:
            List of comments
        """
        sql = """
        SELECT 
            tid, 
            zid, 
            pid, 
            txt, 
            created, 
            mod,
            active
        FROM 
            comments 
        WHERE 
            zid = :zid
        ORDER BY 
            tid
        """
        
        return self.query(sql, {"zid": zid})
    
    def get_votes_by_conversation(self, zid: int) -> List[Dict[str, Any]]:
        """
        Get all votes in a conversation.
        
        Args:
            zid: Conversation ID
            
        Returns:
            List of votes
        """
        sql = """
        SELECT 
            v.zid, 
            v.pid, 
            v.tid, 
            v.vote
        FROM 
            votes_latest_unique v
        WHERE 
            v.zid = :zid
        """
        
        return self.query(sql, {"zid": zid})
    
    def get_participants_by_conversation(self, zid: int) -> List[Dict[str, Any]]:
        """
        Get all participants in a conversation.
        
        Args:
            zid: Conversation ID
            
        Returns:
            List of participants
        """
        sql = """
        SELECT 
            p.zid,
            p.pid,
            p.uid,
            p.vote_count,
            p.created
        FROM 
            participants p
        WHERE 
            p.zid = :zid
        """
        
        return self.query(sql, {"zid": zid})
    
    def get_conversation_id_by_slug(self, conversation_slug: str) -> Optional[int]:
        """
        Get conversation ID by its slug (zinvite).
        
        Args:
            conversation_slug: Conversation slug/zinvite
            
        Returns:
            Conversation ID, or None if not found
        """
        sql = """
        SELECT 
            z.zid
        FROM 
            zinvites z
        WHERE 
            z.zinvite = :zinvite
        """
        
        results = self.query(sql, {"zinvite": conversation_slug})
        return results[0]['zid'] if results else None

# Configure logging
logging.basicConfig(level=logging.INFO, 
                   format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('delphi_poller')

# Global flag for graceful shutdown
running = True

# Exit code from 803_check_batch_status.py script if batch is still processing
EXIT_CODE_PROCESSING_CONTINUES = 3

def signal_handler(sig, frame):
    """Handle exit signals gracefully."""
    global running
    logger.info("Shutdown signal received. Stopping workers...")
    running = False

class JobProcessor:
    """Process jobs from the Delphi_JobQueue."""
    
    def __init__(self, endpoint_url=None, region='us-east-1'):
        """Initialize the job processor."""
        self.worker_id = str(uuid.uuid4())
        raw_endpoint = endpoint_url or os.environ.get('DYNAMODB_ENDPOINT')
        self.endpoint_url = raw_endpoint if raw_endpoint and raw_endpoint.strip() else None

        # Determine instance type from environment variable set by configure_instance.py
        self.instance_type = os.environ.get('INSTANCE_SIZE', 'default') # Default to 'default' if not set
        logger.info(f"Worker {self.worker_id} initialized for instance type: {self.instance_type}")
        
        # Initialize PostgresClient - it will be used per-query within poll_and_process
        # No need to store it as self.postgres_client if we instantiate it on demand.
        # If performance becomes an issue, connection pooling could be considered.
        
        logger.info(f"Connecting to DynamoDB at {self.endpoint_url or 'default AWS endpoint'}")
        self.dynamodb = boto3.resource('dynamodb', 
                                     endpoint_url=self.endpoint_url, 
                                     region_name=region)
        self.table = self.dynamodb.Table('Delphi_JobQueue')
        
        try:
            self.table.table_status
            logger.info("Successfully connected to Delphi_JobQueue table")
        except Exception as e:
            logger.error(f"Failed to connect to Delphi_JobQueue table: {e}")
            raise
        
    def find_pending_job(self):
        """
        Finds the highest-priority actionable job. This includes PENDING jobs, jobs
        awaiting a re-check, and jobs with expired locks ("zombie" jobs).
        """
        try:
            # Helper to query the index with pagination
            def execute_paginated_query(status):
                items = []
                last_key = None
                while True:
                    query_kwargs = {
                        'IndexName': 'StatusCreatedIndex',
                        'KeyConditionExpression': '#s = :status',
                        'ExpressionAttributeNames': {'#s': 'status'},
                        'ExpressionAttributeValues': {':status': status},
                        'ScanIndexForward': True
                    }
                    if last_key:
                        query_kwargs['ExclusiveStartKey'] = last_key
                    
                    response = self.table.query(**query_kwargs)
                    items.extend(response.get('Items', []))
                    last_key = response.get('LastEvaluatedKey')
                    if not last_key:
                        break
                return items

            # 1. Fetch all potentially actionable jobs from different states
            pending_jobs = execute_paginated_query('PENDING')
            awaiting_jobs = execute_paginated_query('AWAITING_RECHECK')
            
            actionable_jobs = pending_jobs + awaiting_jobs

            # 2. Add any jobs that are stuck in PROCESSING with an expired lock (zombies)
            processing_jobs = execute_paginated_query('PROCESSING')
            now_iso = datetime.now(timezone.utc).isoformat()
            for job in processing_jobs:
                if job.get('lock_expires_at', 'z') < now_iso:
                    logger.warning(f"Found zombie job {job['job_id']} with expired lock. Re-queueing.")
                    actionable_jobs.append(job)

            if not actionable_jobs:
                return None

            # 3. Sort all actionable jobs by priority and then by creation date
            actionable_jobs.sort(key=lambda x: (
                0 if x.get('status') == 'PENDING' else 1, # PENDING jobs are highest priority
                x.get('created_at', '')
            ))
            
            logger.info(f"Found {len(actionable_jobs)} actionable job(s). Highest priority is {actionable_jobs[0]['job_id']}")
            return actionable_jobs[0]

        except Exception as e:
            logger.error(f"Error finding pending job: {e}", exc_info=True)
            return None

    def claim_job(self, job: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Atomically claims a job by setting its status to PROCESSING
        and applying a lock timeout, using optimistic locking.
        """
        job_id = job['job_id']
        current_version = job.get('version', 1)
        current_status = job.get('status')
        now = datetime.now(timezone.utc)
        new_expiry_iso = (now + timedelta(minutes=15)).isoformat()

        # This condition handles all actionable states found by find_pending_job.
        # It allows claiming a PENDING job, an AWAITING_RECHECK job, or an expired job.
        #
        # NOTE: Some legacy/malformed items may not have a `version` attribute.
        # Treat missing version as claimable so the poller can take ownership and
        # then fail-fast with a clear error instead of spinning on ConditionalCheckFailed.
        condition_expr = "(#s = :pending OR #s = :awaiting_recheck OR (attribute_exists(lock_expires_at) AND lock_expires_at < :now)) AND (attribute_not_exists(#v) OR #v = :current_version)"
        
        try:
            response = self.table.update_item(
                Key={'job_id': job_id},
                UpdateExpression='SET #s = :processing, started_at = :now, lock_expires_at = :expiry, #v = :new_version, #w = :worker_id',
                ConditionExpression=condition_expr,
                ExpressionAttributeNames={
                    '#s': 'status',
                    '#v': 'version',
                    '#w': 'worker_id'
                },
                ExpressionAttributeValues={
                    ':pending': 'PENDING',
                    ':awaiting_recheck': 'AWAITING_RECHECK',
                    ':now': now.isoformat(),
                    ':processing': 'PROCESSING',
                    ':expiry': new_expiry_iso,
                    ':current_version': current_version,
                    ':new_version': current_version + 1,
                    ':worker_id': self.worker_id
                },
                ReturnValues='ALL_NEW'
            )
            logger.info(f"Successfully claimed job {job_id}. Lock expires at {new_expiry_iso}.")
            return response.get('Attributes')
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                logger.warning(f"Job {job_id} could not be claimed (conditional check failed). Skipping.")
            else:
                logger.error(f"DynamoDB error claiming job {job_id}: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error claiming job {job_id}: {e}", exc_info=True)
            return None
        
    def get_job_actual_size(self, conversation_id_str: str) -> str:
        """
        Queries PostgreSQL to determine the actual size of the job based on comment count.
        Returns "large" or "normal".
        """
        pg_client = None
        try:
            # Ensure conversation_id is an integer for the query
            conversation_id = int(conversation_id_str)
            
            pg_client = PostgresClient()
            pg_client.initialize()
            
            # Query for comment count. Assuming 'comments' table and 'zid' column.
            # Adjust table/column names if different.
            # The table is indeed 'comments' and the column is 'zid' per CLAUDE.md
            sql_query = "SELECT COUNT(*) FROM comments WHERE zid = :zid"
            count_result = pg_client.query(sql_query, {"zid": conversation_id})
            
            if count_result and count_result[0] is not None:
                comment_count = count_result[0]['count']
                logger.info(f"Conversation {conversation_id} has {comment_count} comments.")
                return "large" if comment_count > 5000 else "normal"
            logger.warning(f"Could not retrieve comment count for conversation {conversation_id}. Defaulting to 'normal' size.")
            return "normal"
        except Exception as e:
            logger.error(f"Error querying PostgreSQL for comment count (conv_id: {conversation_id_str}): {e}. Defaulting to 'normal' size.")
            return "normal"
        finally:
            if pg_client:
                pg_client.shutdown()

    def release_lock(self, job, is_still_processing=False):
        """Releases the lock on a job, optionally setting it to be re-checked."""
        job_id = job['job_id']
        logger.info(f"Releasing lock for job {job_id}.")
        try:
            if is_still_processing:
                # Set status to AWAITING_RECHECK so find_pending_job can pick it up again.
                self.table.update_item(
                    Key={'job_id': job_id},
                    UpdateExpression="SET #s = :recheck_status REMOVE lock_expires_at",
                    ExpressionAttributeNames={'#s': 'status'},
                    ExpressionAttributeValues={':recheck_status': 'AWAITING_RECHECK'}
                )
            else:
                # For jobs that are finished (completed/failed), just remove the lock.
                self.table.update_item(
                    Key={'job_id': job_id},
                    UpdateExpression="REMOVE lock_expires_at"
                )
        except Exception as e:
            logger.error(f"Failed to release lock for job {job_id}: {e}")

    @staticmethod
    def _safe_json_loads(raw: Any, default: Any) -> Any:
        if raw is None:
            return default
        if isinstance(raw, (dict, list)):
            return raw
        if not isinstance(raw, str) or not raw.strip():
            return default
        try:
            return json.loads(raw)
        except Exception:
            return default

    @staticmethod
    def _coerce_bool(value: Any, default: bool = False) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            v = value.strip().lower()
            if v in ("1", "true", "t", "yes", "y", "on"):
                return True
            if v in ("0", "false", "f", "no", "n", "off"):
                return False
        return default

    @staticmethod
    def _get_stage_config(job_config: Dict[str, Any], stage_name: str) -> Optional[Dict[str, Any]]:
        """Return the config dict for a stage.

        Returns:
            - None when the stage does not exist
            - {} when the stage exists but has no/empty config
            - dict when the stage exists and has a dict config

        Handles legacy/variant schemas:
            - job_config['stages'] as a list of stage dicts
            - job_config['stages'] as a dict keyed by stage name
            - stage['config'] as dict, empty dict, or JSON string (optionally double-encoded)
        """

        def _normalize_config(cfg: Any) -> Dict[str, Any]:
            if cfg is None:
                return {}
            if isinstance(cfg, dict):
                return cfg
            if isinstance(cfg, str):
                # Some submitters double-encode JSON; attempt up to two loads.
                try:
                    parsed = json.loads(cfg)
                except Exception:
                    return {}
                if isinstance(parsed, str):
                    try:
                        parsed2 = json.loads(parsed)
                        return parsed2 if isinstance(parsed2, dict) else {}
                    except Exception:
                        return {}
                return parsed if isinstance(parsed, dict) else {}
            return {}

        if not isinstance(job_config, dict):
            return None

        stages = job_config.get('stages')

        # Preferred schema: stages as list of {stage/name, config}
        if isinstance(stages, list):
            for stage in stages:
                if not isinstance(stage, dict):
                    continue
                name = stage.get('stage') or stage.get('name')
                if name == stage_name:
                    return _normalize_config(stage.get('config'))
            return None

        # Alternate schema: stages as dict keyed by stage name.
        if isinstance(stages, dict):
            # Direct lookup by stage name.
            if stage_name in stages:
                stage_val = stages.get(stage_name)
                if isinstance(stage_val, dict):
                    # Some schemas store {config: {...}}; others store the config dict directly.
                    if 'config' in stage_val:
                        return _normalize_config(stage_val.get('config'))
                    return stage_val
                return _normalize_config(stage_val)

            # Fallback: scan values for a stage dict with matching name.
            for stage_val in stages.values():
                if not isinstance(stage_val, dict):
                    continue
                name = stage_val.get('stage') or stage_val.get('name')
                if name == stage_name:
                    return _normalize_config(stage_val.get('config'))
            return None

        return None

    def _enqueue_create_narrative_batch_job(
        self,
        parent_job: Dict[str, Any],
        report_stage_config: Dict[str, Any],
        include_moderation: bool,
    ) -> Optional[str]:
        """Enqueue a CREATE_NARRATIVE_BATCH job as a follow-up to a FULL_PIPELINE job."""
        conversation_id = parent_job.get('conversation_id')
        if not conversation_id:
            return None

        # Ensure we always have a stable report_id for DynamoDB keys and URL construction.
        # Some submitters (e.g., delphi_cli) omit report_id, and some code paths may store it as null.
        report_id = parent_job.get('report_id') or str(conversation_id)

        model = report_stage_config.get('model') or os.environ.get('ANTHROPIC_MODEL')
        if not model:
            self.update_job_logs(parent_job, {
                'level': 'WARNING',
                'message': 'REPORT stage requested narratives but no model was provided (missing REPORT.config.model and ANTHROPIC_MODEL). Skipping narrative generation.'
            })
            return None

        max_batch_size = report_stage_config.get('max_batch_size')
        try:
            max_batch_size = int(max_batch_size) if max_batch_size is not None else None
        except Exception:
            max_batch_size = None
        if not max_batch_size:
            # Allow override for local/dev without changing API schema
            env_max = os.environ.get('NARRATIVE_BATCH_MAX_SIZE')
            try:
                max_batch_size = int(env_max) if env_max else 20
            except Exception:
                max_batch_size = 20

        no_cache = self._coerce_bool(report_stage_config.get('no_cache'), default=False)

        now_iso = datetime.now(timezone.utc).isoformat()
        parent_job_id = parent_job.get('job_id', '')
        suffix = uuid.uuid4().hex[:8]
        ts = int(time.time())
        narrative_job_id = f"auto_narrative_{parent_job_id[:8]}_{ts}_{suffix}"

        job_config = {
            'job_type': 'CREATE_NARRATIVE_BATCH',
            'stages': [
                {
                    'stage': 'CREATE_NARRATIVE_BATCH_CONFIG_STAGE',
                    'config': {
                        'model': model,
                        'max_batch_size': max_batch_size,
                        'no_cache': no_cache,
                        'report_id': report_id,
                        'include_moderation': include_moderation,
                    }
                }
            ],
            'parent_job_id': parent_job_id,
        }

        env_blob = {
            'NARRATIVE_BATCH_MODEL': str(model),
            'NARRATIVE_BATCH_MAX_SIZE': str(max_batch_size),
            'NARRATIVE_BATCH_NO_CACHE': '1' if no_cache else '0',
        }

        item = {
            'job_id': narrative_job_id,
            'status': 'PENDING',
            'created_at': now_iso,
            'updated_at': now_iso,
            'version': 1,
            'started_at': '',
            'completed_at': '',
            'worker_id': 'none',
            'job_type': 'CREATE_NARRATIVE_BATCH',
            'priority': int(parent_job.get('priority', 50) or 50),
            'conversation_id': str(conversation_id),
            'report_id': report_id,
            'retry_count': 0,
            'max_retries': 3,
            'timeout_seconds': 14400,
            'job_config': json.dumps(job_config),
            'job_results': json.dumps({}),
            'logs': json.dumps({
                'entries': [
                    {
                        'timestamp': now_iso,
                        'level': 'INFO',
                        'message': f'Auto-enqueued from FULL_PIPELINE {parent_job_id}'
                    }
                ],
                'log_location': ''
            }),
            'created_by': 'poller',
            'environment': json.dumps(env_blob),
            'parent_job_id': parent_job_id,
        }

        try:
            self.table.put_item(Item=item)
            self.update_job_logs(parent_job, {
                'level': 'INFO',
                'message': f'Enqueued CREATE_NARRATIVE_BATCH follow-up job: {narrative_job_id}'
            })
            return narrative_job_id
        except Exception as e:
            self.update_job_logs(parent_job, {
                'level': 'ERROR',
                'message': f'Failed to enqueue CREATE_NARRATIVE_BATCH follow-up job: {e}'
            })
            return None

    def _dynamo_has_any_items(self, table_name: str, conversation_id: Any) -> bool:
        """Best-effort existence check for any items associated with a conversation.

        This is intentionally defensive about table schemas (string vs numeric ids, zid vs conversation_id).
        Returns False on any error.
        """
        try:
            table = self.dynamodb.Table(table_name)
        except Exception as e:
            logger.warning(f"Unable to open DynamoDB table {table_name}: {e}")
            return False

        cid_str = str(conversation_id)
        cid_int: Optional[int]
        try:
            cid_int = int(conversation_id)
        except Exception:
            cid_int = None

        # Scan with a filter so we don't depend on the table's key schema.
        try:
            conditions = [
                Attr('conversation_id').eq(cid_str),
                Attr('zid').eq(cid_str),
            ]
            if cid_int is not None:
                conditions.extend([
                    Attr('conversation_id').eq(cid_int),
                    Attr('zid').eq(cid_int),
                ])

            filter_expr = None
            for cond in conditions:
                filter_expr = cond if filter_expr is None else (filter_expr | cond)

            resp = table.scan(Limit=1, FilterExpression=filter_expr)
            return bool(resp.get('Count', 0))
        except Exception as e:
            logger.warning(f"Error scanning DynamoDB table {table_name} for conversation_id={cid_str}: {e}")
            return False

    def _run_topic_hierarchy(
        self,
        job: Dict[str, Any],
        conversation_id: Any,
        job_id: Any,
        report_id: Any,
        app_path: str,
    ) -> bool:
        """Run 751_topic_hierarchy as a best-effort pre-step before narrative generation.

        - Only runs if prerequisites exist in DynamoDB.
        - Streams stdout/stderr to update_job_logs.
        - Never raises; returns True on success, False otherwise.
        """
        try:
            topic_names_ok = self._dynamo_has_any_items('Delphi_CommentClustersLLMTopicNames', conversation_id)
            assignments_ok = self._dynamo_has_any_items('Delphi_CommentHierarchicalClusterAssignments', conversation_id)

            if not (topic_names_ok and assignments_ok):
                msg = (
                    "Skipping topic hierarchy (751_topic_hierarchy): prerequisites missing "
                    f"(Delphi_CommentClustersLLMTopicNames={topic_names_ok}, "
                    f"Delphi_CommentHierarchicalClusterAssignments={assignments_ok})."
                )
                logger.info(msg)
                self.update_job_logs(job, {'level': 'INFO', 'message': msg})
                return False

            cmd = [
                sys.executable,
                '/app/umap_narrative/751_topic_hierarchy.py',
                '--conversation_id', str(conversation_id),
                '--job_id', str(job_id),
                '--report_id', str(report_id),
            ]

            self.update_job_logs(job, {'level': 'INFO', 'message': f"Executing topic hierarchy: {' '.join(cmd)}"})

            env = os.environ.copy()
            env['DELPHI_JOB_ID'] = str(job_id)
            env['DELPHI_REPORT_ID'] = str(report_id)

            # Ensure the Delphi app root is on PYTHONPATH for module execution.
            existing_pp = env.get('PYTHONPATH', '')
            env['PYTHONPATH'] = f"{app_path}{os.pathsep}{existing_pp}" if existing_pp else str(app_path)

            timeout_seconds = int(job.get('timeout_seconds', 3600) or 3600)
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                universal_newlines=True,
                env=env,
            )

            start_time = time.time()
            for line in iter(process.stdout.readline, ''):
                self.update_job_logs(job, {'level': 'INFO', 'message': f"[topic_hierarchy] {line.strip()}"})
                if time.time() - start_time > timeout_seconds:
                    raise subprocess.TimeoutExpired(cmd, timeout_seconds)

            process.stdout.close()
            return_code = process.wait()
            if return_code == 0:
                self.update_job_logs(job, {'level': 'INFO', 'message': 'Topic hierarchy completed successfully.'})
                return True

            warn_msg = f"Topic hierarchy failed with exit code {return_code}; continuing to narrative enqueue."
            logger.warning(warn_msg)
            self.update_job_logs(job, {'level': 'WARNING', 'message': warn_msg})
            return False
        except subprocess.TimeoutExpired:
            warn_msg = 'Topic hierarchy timed out; continuing to narrative enqueue.'
            logger.warning(warn_msg)
            self.update_job_logs(job, {'level': 'WARNING', 'message': warn_msg})
            return False
        except Exception as e:
            warn_msg = f"Topic hierarchy encountered an error ({e}); continuing to narrative enqueue."
            logger.warning(warn_msg, exc_info=True)
            self.update_job_logs(job, {'level': 'WARNING', 'message': warn_msg})
            return False
            
    def update_job_logs(self, job, log_entry, mirror_to_console=True):
        """
        Add a log entry to the job logs with optimistic locking.
        """
        try:
            # Get current logs and version
            raw_logs = job.get('logs')
            if isinstance(raw_logs, dict):
                current_logs = raw_logs
            elif isinstance(raw_logs, str) and raw_logs.strip():
                try:
                    current_logs = json.loads(raw_logs)
                except Exception:
                    current_logs = {'entries': []}
            else:
                current_logs = {'entries': []}

            if not isinstance(current_logs, dict):
                current_logs = {'entries': []}
            if 'entries' not in current_logs:
                current_logs['entries'] = []
            
            # Add new entry
            current_logs['entries'].append({
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'level': log_entry.get('level', 'INFO'),
                'message': log_entry.get('message', '')
            })
            
            # Mirror to console if requested
            if mirror_to_console:
                colors = {'INFO': '\033[32m', 'WARNING': '\033[33m', 'ERROR': '\033[31m', 'CRITICAL': '\033[31;1m'}
                reset = '\033[0m'
                level = log_entry.get('level', 'INFO')
                color = colors.get(level, '')
                short_job_id = job['job_id'][:8]
                print(f"{color}[DELPHI JOB {short_job_id}] {level}{reset}: {log_entry.get('message', '')}")
            
            # Keep only the most recent log entries
            current_logs['entries'] = current_logs['entries'][-50:]
            
            # Update DynamoDB
            self.table.update_item(
                Key={'job_id': job['job_id']},
                UpdateExpression='SET logs = :logs, updated_at = :updated_at',
                ExpressionAttributeValues={
                    ':logs': json.dumps(current_logs),
                    ':updated_at': datetime.now(timezone.utc).isoformat()
                }
            )
        except Exception as e:
            # Log failure but do not crash the worker
            logger.error(f"Error updating job logs for {job['job_id']}: {e}")

    def complete_job(self, job, success, result=None, error=None):
        """Mark a job as completed or failed using optimistic locking."""
        job_id = job['job_id']
        current_version = job.get('version', 1)
        new_status = 'COMPLETED' if success else 'FAILED'
        now = datetime.now().isoformat()
        
        try:
            # Prepare results
            job_results = {
                'result_type': 'SUCCESS' if success else 'FAILURE',
                'completed_at': now
            }
            
            # This 'if' block correctly handles the 'result' argument
            if result:
                job_results.update(result)
            
            if error:
                job_results['error'] = str(error)
            
            # Update the job with the new status using optimistic locking
            try:
                self.table.update_item(
                    Key={'job_id': job_id},
                    UpdateExpression='''
                        SET #status = :new_status, 
                            updated_at = :now, 
                            completed_at = :now,
                            job_results = :job_results,
                            version = :new_version
                    ''',
                    ConditionExpression='version = :current_version',
                    ExpressionAttributeNames={'#status': 'status'},
                    ExpressionAttributeValues={
                        ':new_status': new_status,
                        ':now': now,
                        ':job_results': json.dumps(job_results),
                        ':current_version': current_version,
                        ':new_version': current_version + 1
                    }
                )
                
                logger.info(f"Job {job_id} marked as {new_status}")
                
            except ClientError as e:
                if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                    logger.warning(f"Job {job_id} was modified by another process, completion state may not be accurate")
                else:
                    raise
        except Exception as e:
            logger.error(f"Error completing job {job_id}: {e}")

    def process_job(self, job: Dict[str, Any]) -> None:
        """Processes a claimed job by executing the correct script with real-time log handling."""
        job_id = job['job_id']
        job_type = job.get('job_type')
        conversation_id = job.get('conversation_id')
        timeout_seconds = int(job.get('timeout_seconds', 3600))

        if not conversation_id:
            self.complete_job(job, False, error="Malformed job schema: missing conversation_id")
            return

        if not job_type:
            self.complete_job(job, False, error="Malformed job schema: missing job_type")
            return

        self.update_job_logs(job, {'level': 'INFO', 'message': f'Worker {self.worker_id} starting job {job_id}'})
        
        try:
            # 1. Build the command
            job_config = self._safe_json_loads(job.get('job_config', '{}'), {})
            job_environment = self._safe_json_loads(job.get('environment', '{}'), {})

            if os.getenv('DELPHI_CONFIG_DEBUG') == '1':
                raw_job_config = job.get('job_config')
                raw_job_config_size = None
                try:
                    raw_job_config_size = len(raw_job_config) if hasattr(raw_job_config, '__len__') else None
                except Exception:
                    raw_job_config_size = None

                logger.info(f"[DEBUG] raw job_config type: {type(raw_job_config)}, size: {raw_job_config_size}")
                logger.info(f"[DEBUG] parsed job_config type: {type(job_config)}")
                if isinstance(job_config, dict):
                    logger.info(f"[DEBUG] job_config keys: {sorted(job_config.keys())}")
                    stages_value = job_config.get('stages')
                    logger.info(f"[DEBUG] stages type: {type(stages_value)}")
                    if isinstance(stages_value, list):
                        stage_names = []
                        for stage in stages_value:
                            if isinstance(stage, dict):
                                stage_names.append(stage.get('stage') or stage.get('name'))
                            else:
                                stage_names.append(type(stage).__name__)
                        logger.info(f"[DEBUG] stages names: {stage_names}")

                    wants_report_legacy = job_config.get('wants_report')
                    include_topics_legacy = job_config.get('include_topics')
                    logger.info(
                        f"[DEBUG] legacy wants_report: {wants_report_legacy} ({type(wants_report_legacy)}), "
                        f"include_topics: {include_topics_legacy} ({type(include_topics_legacy)})"
                    )
                else:
                    logger.info("[DEBUG] job_config is not a dict; key/stage/legacy summaries skipped")

            include_moderation = self._coerce_bool(job_config.get('include_moderation', False), default=False)
            app_path = os.environ.get('DELPHI_APP_PATH', '/app')
            if job_type == 'CREATE_NARRATIVE_BATCH':
                stage_cfg = self._get_stage_config(job_config, 'CREATE_NARRATIVE_BATCH_CONFIG_STAGE') or {}
                stage_model = stage_cfg.get('model')
                env_model = job_environment.get('NARRATIVE_BATCH_MODEL')
                model = stage_model or env_model or job_config.get('model') or os.environ.get("ANTHROPIC_MODEL")
                if not model:
                    raise ValueError("Model not specified for CREATE_NARRATIVE_BATCH (missing job_config stage config, environment.NARRATIVE_BATCH_MODEL, and ANTHROPIC_MODEL)")

                max_batch_size = stage_cfg.get('max_batch_size', job_config.get('max_batch_size'))
                if max_batch_size is None:
                    env_max = job_environment.get('NARRATIVE_BATCH_MAX_SIZE')
                    max_batch_size = env_max if env_max is not None else 20
                max_batch_size = int(max_batch_size)

                no_cache = stage_cfg.get('no_cache', job_config.get('no_cache'))
                if no_cache is None:
                    no_cache = job_environment.get('NARRATIVE_BATCH_NO_CACHE')
                no_cache = self._coerce_bool(no_cache, default=False)

                include_moderation = self._coerce_bool(
                    stage_cfg.get('include_moderation', include_moderation),
                    default=include_moderation,
                )

                cmd = [
                    'python',
                    f'{app_path}/umap_narrative/801_narrative_report_batch.py',
                    f'--conversation_id={conversation_id}',
                    f'--model={model}',
                    f'--max-batch-size={str(max_batch_size)}',
                ]
                if include_moderation:
                    cmd.append('--include_moderation')
                if no_cache:
                    cmd.append('--no-cache')
            elif job_type == 'AWAITING_NARRATIVE_BATCH':
                cmd_job_id = job.get('batch_job_id', job_id)
                cmd = ['python', f'{app_path}/umap_narrative/803_check_batch_status.py', f'--job-id={cmd_job_id}']
            else: # FULL_PIPELINE
                # Base command
                cmd = ['python', f'{app_path}/run_delphi.py', f'--zid={conversation_id}']
                if include_moderation:
                    cmd.append('--include_moderation')
                # Check for report_id and append if it exists
                report_id = job.get('report_id')
                if report_id:
                    cmd.append(f'--rid={report_id}')
                    self.update_job_logs(job, {'level': 'INFO', 'message': f"Passing report_id {report_id} to run_delphi.py"})


            # 2. Execute the command and stream logs to prevent deadlocks
            self.update_job_logs(job, {'level': 'INFO', 'message': f'Executing command: {" ".join(cmd)}'})
            
            env = os.environ.copy()
            env['DELPHI_JOB_ID'] = job_id
            env['DELPHI_REPORT_ID'] = str(job.get('report_id') or conversation_id)
            
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, universal_newlines=True, env=env)

            start_time = time.time()
            for line in iter(process.stdout.readline, ''):
                # Log each line of output as it arrives
                self.update_job_logs(job, {'level': 'INFO', 'message': f"[stdout] {line.strip()}"})
                if time.time() - start_time > timeout_seconds:
                    raise subprocess.TimeoutExpired(cmd, timeout_seconds)
            
            process.stdout.close()
            return_code = process.wait()
            
            # 3. Handle the results
            success = (return_code == 0)
            if job_type == 'AWAITING_NARRATIVE_BATCH':
                if return_code == EXIT_CODE_PROCESSING_CONTINUES:
                    self.release_lock(job, is_still_processing=True)
                else:
                    self.complete_job(job, success, error=f"Script failed with exit code {return_code}" if not success else None)
            
            elif job_type == 'CREATE_NARRATIVE_BATCH':
                if success:
                    logger.info(f"Job {job_id}: CREATE_NARRATIVE_BATCH completed successfully.")
                    self.complete_job(job, True)
                else:
                    self.complete_job(job, False, error=f"CREATE_NARRATIVE_BATCH script failed with exit code {return_code}")

            else: # Handle all other synchronous job types
                # If a FULL_PIPELINE job requested a REPORT stage, enqueue narrative generation as a follow-up job.
                if success and job_type == 'FULL_PIPELINE':
                    logger.info("Checking if narrative generation should be enqueued...")
                    report_stage_cfg = self._get_stage_config(job_config, 'REPORT')
                    has_report_stage = report_stage_cfg is not None
                    top_level_wants_report = self._coerce_bool(job_config.get('wants_report', False), default=False)
                    top_level_include_topics = self._coerce_bool(job_config.get('include_topics', True), default=True)

                    if has_report_stage:
                        # Stage presence usually means REPORT was requested, but honor explicit false if provided.
                        report_cfg = report_stage_cfg or {}
                        wants_report_raw = report_cfg.get('wants_report', True)
                        wants_report = self._coerce_bool(wants_report_raw, default=True)
                        include_topics_raw = report_cfg.get('include_topics', True)
                        include_topics = self._coerce_bool(include_topics_raw, default=True)
                    else:
                        # Legacy compatibility: top-level flags when no stages[] schema is present.
                        wants_report = top_level_wants_report
                        if wants_report:
                            include_topics_raw = job_config.get('include_topics', True)
                            include_topics = top_level_include_topics
                        else:
                            include_topics_raw = None
                            include_topics = False

                    # Extra safety for mixed payloads: top-level wants_report=true should still enable report flow.
                    if top_level_wants_report:
                        wants_report = True
                        if include_topics_raw is None:
                            include_topics_raw = job_config.get('include_topics', True)
                            include_topics = top_level_include_topics

                    if os.getenv('DELPHI_CONFIG_DEBUG') == '1':
                        logger.info(f"[DEBUG] REPORT stage detected: {has_report_stage}")
                        logger.info(f"[DEBUG] wants_report (computed): {wants_report}")
                        logger.info(
                            f"[DEBUG] include_topics raw: {include_topics_raw} ({type(include_topics_raw)}), "
                            f"coerced: {include_topics}"
                        )
                        logger.info(
                            f"[DEBUG] gate wants_report/include_topics: wants_report={wants_report}, include_topics={include_topics}"
                        )
                    logger.info(f"wants_report: {wants_report}, include_topics: {include_topics}")
                    if wants_report and include_topics:
                        logger.info("Enqueueing narrative batch job...")

                        # Best-effort: build the topic hierarchy before enqueueing narratives.
                        # Failures must not block narrative generation.
                        report_id_for_hierarchy = job.get('report_id') or str(conversation_id)
                        self._run_topic_hierarchy(
                            job=job,
                            conversation_id=conversation_id,
                            job_id=job_id,
                            report_id=report_id_for_hierarchy,
                            app_path=app_path,
                        )

                        narrative_job_id = self._enqueue_create_narrative_batch_job(
                            parent_job=job,
                            report_stage_config=report_stage_cfg or {},
                            include_moderation=include_moderation,
                        )
                        logger.info(f"Enqueued narrative job: {narrative_job_id}")

                self.complete_job(job, success, error=f"Process exited with code {return_code}" if not success else None)

        except subprocess.TimeoutExpired:
            logger.error(f"Job {job_id} timed out after {timeout_seconds} seconds.")
            self.complete_job(job, False, error=f"Job process timed out after {timeout_seconds}s.")
        except Exception as e:
            logger.error(f"Critical error processing job {job_id}: {e}", exc_info=True)
            self.complete_job(job, False, error=f"Critical poller error: {str(e)}")


def poll_and_process(processor: JobProcessor, interval: int = 10):
    """The main loop for a worker thread."""
    logger.info(f"Worker {processor.worker_id} starting job polling...")
    while running:
        claimed_job = None
        try:
            # Step 1: Find the next available job.
            job_to_process = processor.find_pending_job()
            
            if job_to_process:
                conversation_id_str = job_to_process.get('conversation_id')
                
                if conversation_id_str:
                    job_actual_size = processor.get_job_actual_size(conversation_id_str)
                else:
                    job_actual_size = "normal"
                
                can_process = False
                instance_type = processor.instance_type
                
                if instance_type == "large":
                    # A large instance ONLY processes large jobs.
                    can_process = (job_actual_size == "large")
                else: # This covers 'small' and the 'default' type.
                    # Small/default instances ONLY process normal-sized jobs.
                    can_process = (job_actual_size == "normal")

                if instance_type == "dev":
                    # Dev instances can process any job size.
                    can_process = True

                if not can_process:
                    logger.info(f"Worker instance type '{instance_type}' cannot process job '{job_to_process['job_id']}' of size '{job_actual_size}'. Skipping for now.")
                    # Sleep for the interval so this worker doesn't hammer the queue checking the same job.
                    time.sleep(interval)
                    continue # This correctly skips to the next iteration of the while loop.

                # If we can process it, attempt to claim it.
                claimed_job = processor.claim_job(job_to_process)
                
                # Only proceed if the claim was successful.
                if claimed_job:
                    processor.process_job(claimed_job)
            else:
                # If no jobs are found, wait for the full interval.
                time.sleep(interval)
                
        except Exception as e:
            logger.error(f"Critical error in polling loop for worker {processor.worker_id}: {e}", exc_info=True)
            if claimed_job:
                processor.complete_job(claimed_job, False, error="Polling loop crashed during processing")
            time.sleep(interval * 6)

def main():
    # This function is correct.
    parser = argparse.ArgumentParser(description='Delphi Job Poller Service')
    parser.add_argument('--endpoint-url', type=str, default=None)
    parser.add_argument('--region', type=str, default='us-east-1')
    parser.add_argument('--interval', type=int, default=10)
    parser.add_argument('--max-workers', type=int, default=1)
    parser.add_argument('--log-level', type=str, default='INFO', choices=['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'])
    args = parser.parse_args()
    
    logger.setLevel(getattr(logging, args.log_level))
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    logger.info("Starting Delphi Job Poller Service...")
    
    try:
        processor = JobProcessor(endpoint_url=args.endpoint_url, region=args.region)
        threads = []
        for i in range(args.max_workers):
            t = threading.Thread(target=poll_and_process, args=(processor, args.interval), daemon=True)
            t.start()
            threads.append(t)
            logger.info(f"Started worker thread {i+1}")
        
        while running and any(t.is_alive() for t in threads):
            time.sleep(1)
        
        logger.info("All workers have stopped. Exiting.")
    except Exception as e:
        logger.error(f"Error in main function: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
