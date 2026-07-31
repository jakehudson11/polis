#!/usr/bin/env python3
import argparse
import os
import subprocess
import sys

# Define colors for output
GREEN = '\033[0;32m'
YELLOW = '\033[0;33m'
RED = '\033[0;31m'
NC = '\033[0m' # No Color

def show_usage():
    print("Process a Polis conversation with the Delphi analytics pipeline.")
    print()
    print("Usage: ./run_delphi.py --zid=CONVERSATION_ID [options]")
    print()
    print("Required arguments:")
    print("  --zid=CONVERSATION_ID     The Polis conversation ID to process")
    print()
    print("Optional arguments:")
    print("  --rid=REPORT_ID           (Optional) The report ID for full narrative cleanup")
    print("  --verbose                 Show detailed logs")
    print("  --force                   Force reprocessing even if data exists")
    print("  --validate                Run extra validation checks")
    print("  --help                    Show this help message")

def main():
    parser = argparse.ArgumentParser(description="Process a Polis conversation with the Delphi analytics pipeline.", add_help=False)
    parser.add_argument("--zid", required=True, help="The Polis conversation ID to process")
    parser.add_argument("--rid", required=False, help="The report ID, if available, for full narrative cleanup.")
    parser.add_argument("--verbose", action="store_true", help="Show detailed logs")
    parser.add_argument("--force", action="store_true", help="Force reprocessing even if data exists")
    parser.add_argument("--validate", action="store_true", help="Run extra validation checks")
    parser.add_argument("--help", action="store_true", help="Show this help message")
    parser.add_argument('--include_moderation', action='store_true',
                        help='Include moderated comments in reports (flag: present=True, absent=False).')
    parser.add_argument('--region', type=str, default='us-east-1', help='AWS region')

    args = parser.parse_args()

    if args.help:
        show_usage()
        sys.exit(0)

    zid = args.zid
    rid = args.rid
    verbose_arg = "--verbose" if args.verbose else ""
    force_arg = "--force" if args.force else ""
    # validate_arg is not used in the python script execution steps, but kept for parity with bash
    # validate_arg = "--validate" if args.validate else ""

    # --- Reset all data before processing ---
    print(f"{YELLOW}Resetting all existing data for conversation {zid} before processing...{NC}")
    reset_command = [
        "python",
        "umap_narrative/reset_conversation.py",
        f"--zid={zid}",
    ]
    # If a report ID is provided, pass it to the reset script for full cleanup
    if rid:
        reset_command.append(f"--rid={rid}")
        print(f"{YELLOW}Using report ID {rid} for full narrative report cleanup.{NC}")
    
    reset_process = subprocess.run(reset_command)
    if reset_process.returncode != 0:
        print(f"{RED}Data reset failed with exit code {reset_process.returncode}. Aborting pipeline.{NC}")
        sys.exit(reset_process.returncode)
    print(f"{GREEN}Data reset complete.{NC}")
    print(f"[PROGRESS: 5] Data reset complete — starting math pipeline")

    print(f"{GREEN}Processing conversation {zid}...{NC}")

    # Resolve provider and model for LLM topic naming
    provider_type = os.environ.get("LLM_PROVIDER") or os.environ.get("NARRATIVE_BATCH_PROVIDER") or "anthropic"
    model_name = os.environ.get("LLM_MODEL") or os.environ.get("ANTHROPIC_MODEL")
    
    if not model_name:
        print(f"{YELLOW}No model specified via LLM_MODEL or ANTHROPIC_MODEL env. Skipping LLM topic naming.{NC}")
        model_name = None
        api_key = None
    else:
        # Resolve API key dynamically for any provider
        provider_upper = provider_type.upper().replace('.', '_')
        api_key = (
            os.environ.get(f"{provider_upper}_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or os.environ.get("ANTHROPIC_API_KEY")
        )
        if not api_key:
            print(f"{YELLOW}No API key found for provider '{provider_type}'. Skipping LLM topic naming.{NC}")
            model_name = None
        else:
            print(f"{YELLOW}Using {provider_type} model for topic naming: {model_name}{NC}")

    # Set up environment for the pipeline
    app_path = os.environ.get('DELPHI_APP_PATH', '/app')
    os.environ["PYTHONPATH"] = f"{app_path}:{os.environ.get('PYTHONPATH', '')}"
    max_votes = os.environ.get("MAX_VOTES")
    max_votes_arg = f"--max-votes={max_votes}" if max_votes else ""
    if max_votes:
        print(f"{YELLOW}Limiting to {max_votes} votes for testing{NC}")

    batch_size = os.environ.get("BATCH_SIZE")
    batch_size_arg = f"--batch-size={batch_size}" if batch_size else "--batch-size=50000" # Default batch size
    if batch_size:
        print(f"{YELLOW}Using batch size of {batch_size}{NC}")
    else:
        print(f"{YELLOW}Using batch size of 50000 (default){NC}")


    # Run the math pipeline
    print(f"{GREEN}Running math pipeline...{NC}")
    math_command = [
        "python", f"{app_path}/polismath/run_math_pipeline.py",
        f"--zid={zid}",
    ]
    if max_votes_arg:
        math_command.append(max_votes_arg)
    if batch_size_arg:
        math_command.append(batch_size_arg)

    print(f"[PROGRESS: 10] Math pipeline running — performing PCA on vote data")
    math_process = subprocess.run(math_command)
    math_exit_code = math_process.returncode

    if math_exit_code != 0:
        print(f"{RED}Math pipeline failed with exit code {math_exit_code}{NC}")
        sys.exit(math_exit_code)

    print(f"[PROGRESS: 30] Math complete — running UMAP narrative pipeline (group analysis)")
    # Run the UMAP narrative pipeline
    print(f"{GREEN}Running UMAP narrative pipeline...{NC}")
    umap_command = [
        "python", f"{app_path}/umap_narrative/run_pipeline.py",
        f"--zid={zid}",
        "--enable-llm-topic-naming"
    ]
    if args.include_moderation:
        umap_command.append("--include_moderation")
    if verbose_arg:
        umap_command.append(verbose_arg)

    pipeline_process = subprocess.run(umap_command)
    pipeline_exit_code = pipeline_process.returncode

    print(f"[PROGRESS: 55] UMAP pipeline complete — group analysis done, calculating metrics")
    # Calculate and store comment extremity values
    print(f"{GREEN}Calculating comment extremity values...{NC}")
    print(f"[PROGRESS: 65] Calculating comment extremity values")
    extremity_command = [
        "python", f"{app_path}/umap_narrative/501_calculate_comment_extremity.py",
        f"--zid={zid}",
    ]
    if args.include_moderation:
        extremity_command.append("--include_moderation")
    if verbose_arg:
        extremity_command.append(verbose_arg)
    if force_arg:
        extremity_command.append(force_arg)
    
    extremity_process = subprocess.run(extremity_command)
    extremity_exit_code = extremity_process.returncode

    if extremity_exit_code != 0:
        print(f"{RED}Warning: Extremity calculation failed with exit code {extremity_exit_code}{NC}")
        print("Continuing with priority calculation...")

    # Calculate comment priorities using group-based extremity
    print(f"[PROGRESS: 75] Calculating comment priorities")
    print(f"{GREEN}Calculating comment priorities with group-based extremity...{NC}")
    priority_command = [
        "python", f"{app_path}/umap_narrative/502_calculate_priorities.py",
        f"--conversation_id={zid}",
    ]
    if verbose_arg:
        priority_command.append(verbose_arg)
    
    priority_process = subprocess.run(priority_command)
    priority_exit_code = priority_process.returncode

    if priority_exit_code != 0:
        print(f"{RED}Warning: Priority calculation failed with exit code {priority_exit_code}{NC}")
        print("Continuing with visualization...")

    if pipeline_exit_code == 0:
        print(f"[PROGRESS: 85] Generating data visualization plots")
        print(f"{YELLOW}Creating visualizations with datamapplot...{NC}")

        # Create output directory
        output_dir = f"{app_path}/polis_data/{zid}/python_output/comments_enhanced_multilayer"
        os.makedirs(output_dir, exist_ok=True)

        # Generate visualizations for all available layers
        # First, determine available layers from DynamoDB
        try:
            import boto3
            from boto3.dynamodb.conditions import Key
            
            raw_endpoint = os.environ.get('DYNAMODB_ENDPOINT')
            endpoint_url = raw_endpoint if raw_endpoint and raw_endpoint.strip() else None
            
            # Using dummy credentials for local, IAM role for AWS
            if endpoint_url:
                dynamodb = boto3.resource('dynamodb', 
                                         endpoint_url=endpoint_url, 
                                         region_name='us-east-1',
                                         aws_access_key_id='dummy',
                                         aws_secret_access_key='dummy')
            else:
                dynamodb = boto3.resource('dynamodb', region_name=args.region)


            table = dynamodb.Table('Delphi_CommentHierarchicalClusterAssignments')
            
            available_layers = set()
            last_key = None

            print(f"{YELLOW}Querying all items to discover available layers...{NC}")
            while True:
                query_kwargs = {
                    'KeyConditionExpression': Key('conversation_id').eq(str(zid))
                }
                if last_key:
                    query_kwargs['ExclusiveStartKey'] = last_key
                
                response = table.query(**query_kwargs)

                for item in response.get('Items', []):
                    for key, value in item.items():
                        if key.startswith('layer') and key.endswith('_cluster_id') and value is not None:
                            try:
                                layer_num = int(key.replace('layer', '').replace('_cluster_id', ''))
                                available_layers.add(layer_num)
                            except ValueError:
                                continue 
                
                last_key = response.get('LastEvaluatedKey')
                if not last_key:
                    break
            
            available_layers = sorted(list(available_layers))
            if not available_layers:
                 raise ValueError("No valid layers found for this conversation.")
                 
            print(f"{YELLOW}Discovered layers: {available_layers}{NC}")
            
        except Exception as e:
            print(f"{RED}Warning: Could not determine layers from DynamoDB: {e}{NC}")
            print(f"{YELLOW}Falling back to layer 0 only{NC}")
            available_layers = [0]
        
        # Generate visualization for each available layer
        for layer_id in available_layers:
            print(f"{YELLOW}Generating visualization for layer {layer_id}...{NC}")
            datamap_command = [
                "python", f"{app_path}/umap_narrative/700_datamapplot_for_layer.py",
                f"--conversation_id={zid}",
                f"--layer={layer_id}",
                f"--output_dir={output_dir}"
            ]
            if verbose_arg:
                datamap_command.append(verbose_arg)
            
            result = subprocess.run(datamap_command)
            if result.returncode == 0:
                print(f"{GREEN}Layer {layer_id} visualization completed{NC}")
            else:
                print(f"{RED}Warning: Layer {layer_id} visualization failed{NC}")

        print(f"{GREEN}UMAP Narrative pipeline completed successfully!{NC}")
        print(f"Results stored in DynamoDB and visualizations for conversation {zid}")
    else:
        print(f"{RED}Error: UMAP Narrative pipeline failed with exit code: {pipeline_exit_code}{NC}")
        print("Aborting: downstream steps may rely on successful pipeline outputs.")
        sys.exit(pipeline_exit_code)

    # --- Enforce topic distinction within each layer ---
    print(f"{GREEN}Enforcing topic distinction within layers...{NC}")
    distinction_command = [
        "python", f"{app_path}/umap_narrative/752_enforce_topic_distinction.py",
        f"--conversation_id={zid}",
    ]
    if verbose_arg:
        distinction_command.append(verbose_arg)

    distinction_process = subprocess.run(distinction_command)
    distinction_exit_code = distinction_process.returncode

    if distinction_exit_code != 0:
        print(f"{YELLOW}Warning: Topic distinction enforcement failed with exit code {distinction_exit_code}{NC}")
        print("Continuing with pipeline...")
    else:
        print(f"{GREEN}Topic distinction enforcement complete.{NC}")

    print(f"[PROGRESS: 95] Pipeline complete — report generation in progress")
    # Success (math pipeline already exited non-zero earlier if it failed)
    sys.exit(0)

    if exit_code == 0: # This condition relies on math_exit_code check above.
        print(f"{GREEN}Pipeline completed successfully!{NC}")
        print(f"Results stored in DynamoDB for conversation {zid}")
    else:
        # This part of the logic seems unreachable given the sys.exit() after math_pipeline failure
        # and resetting pipeline_exit_code to 0 in the warning case.
        # However, keeping it for structural parity.
        print(f"{RED}Pipeline failed with exit code {exit_code}{NC}")
        print("Please check logs for more details")

    sys.exit(exit_code)

if __name__ == "__main__":
    main()