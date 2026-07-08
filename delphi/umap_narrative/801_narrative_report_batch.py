#!/usr/bin/env python3
"""
Generate batch narrative reports for Polis conversations using Anthropic's Batch API.

This script is an optimized version of 800_report_topic_clusters.py that:
1. Prepares batch requests for all topics in a conversation
2. Submits them to Anthropic's Batch API
3. Stores batch job metadata in DynamoDB
4. Provides a way to check batch job status

Usage:
    python 801_narrative_report_batch.py --conversation_id CONVERSATION_ID [--model MODEL] [--no-cache] [--layers LAYER_NUMBERS...]

Args:
    --conversation_id: Conversation ID/zid
    --model: LLM model to use (defaults to ANTHROPIC_MODEL env var)
    --no-cache: Ignore cached report data
    --max-batch-size: Maximum number of topics to include in a single batch (default: 20)
    --layers: Specific layer numbers to process (e.g., --layers 0 1 2). If not specified, all layers will be processed.
"""

import os
import sys
import json
import time
import uuid
import logging
import argparse
import boto3
import asyncio
import numpy as np
import pandas as pd
import re  # Added re import for regex operations
import requests  # Added for HTTP error handling
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional, Union, Tuple
import xml.etree.ElementTree as ET
from xml.dom.minidom import parseString
import csv
import io
import xmltodict
from collections import defaultdict
import traceback  # Added for detailed error tracing

# Import the model provider
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from umap_narrative.llm_factory_constructor import get_model_provider
from umap_narrative.llm_factory_constructor.model_provider import AnthropicProvider

# Import from local modules
from polismath_commentgraph.utils.storage import PostgresClient, DynamoDBStorage
from polismath_commentgraph.utils.group_data import GroupDataProcessor

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class NarrativeReportService:
    """Storage service for narrative reports in DynamoDB."""

    def __init__(self, table_name="Delphi_NarrativeReports", dynamodb_resource=None):
        """Initialize the narrative report service."""
        self.table_name = table_name
        if dynamodb_resource:
            self.dynamodb = dynamodb_resource
        else:
            endpoint_url = os.environ.get('DYNAMODB_ENDPOINT') or None
            self.dynamodb = boto3.resource(
                'dynamodb',
                endpoint_url=endpoint_url,
                region_name=os.environ.get('AWS_REGION', 'us-east-1')
            )
        
        self.table = self.dynamodb.Table(self.table_name)

    def store_report(self, report_id, section, model, report_data, job_id=None, metadata=None):
        """Store a report in DynamoDB.

        Args:
            report_id: The report ID
            section: The section of the report
            model: The model used to generate the report
            report_data: The generated report content
            job_id: The ID of the job that generated this report (optional)
            metadata: Additional metadata to store with the report (optional)

        Returns:
            Response from DynamoDB
        """
        try:
            # Create a combined key for the report (report_id, section, model)
            rid_section_model = f"{report_id}#{section}#{model}"

            # Current timestamp
            timestamp = datetime.now().isoformat()

            # Create item to store
            item = {
                'rid_section_model': rid_section_model,
                'timestamp': timestamp,
                'report_id': report_id,
                'section': section,
                'model': model,
                'report_data': report_data
            }

            # Add job_id if provided
            if job_id:
                item['job_id'] = job_id
                
            # Add metadata if provided
            if metadata:
                item['metadata'] = metadata

            # Store in DynamoDB
            response = self.table.put_item(Item=item)
            logger.info(f"Report stored successfully for {rid_section_model}")
            return response
        except Exception as e:
            logger.error(f"Error storing report: {str(e)}")
            return None

    def get_report(self, report_id, section, model):
        """Get a report from DynamoDB.

        Args:
            report_id: The report ID
            section: The section of the report
            model: The model used to generate the report

        Returns:
            The report data if found, None otherwise
        """
        try:
            # Create the combined key
            rid_section_model = f"{report_id}#{section}#{model}"

            # Get from DynamoDB
            response = self.table.get_item(Key={'rid_section_model': rid_section_model})

            # Return the item if found
            return response.get('Item')
        except Exception as e:
            logger.error(f"Error getting report: {str(e)}")
            return None

class PolisConverter:
    """Convert between CSV and XML formats for Polis data."""
    
    @staticmethod
    def convert_to_xml(comment_data):
        """
        Convert comment data to XML format.
        
        Args:
            comment_data: List of dictionaries with comment data
            
        Returns:
            String with XML representation of the comment data
        """
        # Create root element
        root = ET.Element("polis-comments")
        
        # Process each comment
        for record in comment_data:
            # Extract base comment data
            comment = ET.SubElement(root, "comment", {
                "id": str(record.get("comment-id", "")),
                "votes": str(record.get("total-votes", 0)),
                "agrees": str(record.get("total-agrees", 0)),
                "disagrees": str(record.get("total-disagrees", 0)),
                "passes": str(record.get("total-passes", 0)),
            })
            
            # Add comment text
            text = ET.SubElement(comment, "text")
            text.text = record.get("comment", "")
            
            # Process group data
            group_keys = []
            for key in record.keys():
                if key.startswith("group-") and key.count("-") >= 2:
                    group_id = key.split("-")[1]
                    if group_id not in group_keys:
                        group_keys.append(group_id)
            
            # Add data for each group
            for group_id in group_keys:
                group = ET.SubElement(comment, f"tribe-{group_id}", {
                    "votes": str(record.get(f"group-{group_id}-votes", 0)),
                    "agrees": str(record.get(f"group-{group_id}-agrees", 0)),
                    "disagrees": str(record.get(f"group-{group_id}-disagrees", 0)),
                    "passes": str(record.get(f"group-{group_id}-passes", 0)),
                })
        
        # Convert to string with pretty formatting
        rough_string = ET.tostring(root, 'utf-8')
        reparsed = parseString(rough_string)
        return reparsed.toprettyxml(indent="  ")

class BatchReportGenerator:
    """Generate batch reports for Polis conversations."""

    def __init__(self, conversation_id, model=None, provider=None,
                 backup_model=None, backup_provider=None,
                 fallback_model=None, fallback_provider=None,
                 no_cache=False, max_batch_size=20, job_id=None, layers=None,
                 include_moderation=False):
        """Initialize the batch report generator."""
        self.conversation_id = str(conversation_id)
        if not model:
            model = os.environ.get("ANTHROPIC_MODEL")
            if not model:
                raise ValueError("Model must be specified via --model argument or ANTHROPIC_MODEL environment variable")
        self.model = model
        self.provider = provider or os.environ.get("NARRATIVE_BATCH_PROVIDER") or "anthropic"
        self.backup_model = backup_model or os.environ.get("NARRATIVE_BATCH_BACKUP_MODEL") or None
        self.backup_provider = backup_provider or os.environ.get("NARRATIVE_BATCH_BACKUP_PROVIDER") or None
        self.fallback_model = fallback_model or os.environ.get("NARRATIVE_BATCH_FALLBACK_MODEL") or None
        self.fallback_provider = fallback_provider or os.environ.get("NARRATIVE_BATCH_FALLBACK_PROVIDER") or None
        self.no_cache = no_cache
        self.max_batch_size = max_batch_size
        self.layers = layers  # List of layers to process, or None for all layers
        self.job_id = job_id or os.environ.get('DELPHI_JOB_ID')
        self.report_id = os.environ.get('DELPHI_REPORT_ID')
        self.postgres_client = PostgresClient()
        self.include_moderation = include_moderation

        logger.info(f"include_moderation: {include_moderation}")

        endpoint_url = os.environ.get('DYNAMODB_ENDPOINT') or None
        self.dynamodb = boto3.resource(
            'dynamodb',
            endpoint_url=endpoint_url,
            region_name=os.environ.get('AWS_REGION', 'us-east-1')
        )

        self.report_storage = NarrativeReportService(dynamodb_resource=self.dynamodb)
        self.group_processor = GroupDataProcessor(self.postgres_client)

        current_dir = Path(__file__).parent
        self.prompt_base_path = current_dir / "report_experimental"
    
    def _get_math_main_data(self, conversation_id):
        """
        Get pre-calculated math data from the Clojure math pipeline stored in math_main table.
        
        Args:
            conversation_id: Conversation ID (zid)
            
        Returns:
            Dictionary containing math results including group_aware_consensus and comment_extremity
        """
        try:
            # Query the math_main table for the conversation's math results
            sql = """
            SELECT data 
            FROM math_main 
            WHERE zid = :zid AND math_env = :math_env
            ORDER BY modified DESC 
            LIMIT 1
            """
            
            # Use 'prod' as the default math_env (matches the server behavior)
            math_env = os.environ.get('MATH_ENV', 'prod')
            
            results = self.postgres_client.query(sql, {"zid": conversation_id, "math_env": math_env})
            
            if not results:
                logger.warning(f"No math_main data found for conversation {conversation_id} with math_env {math_env}; trying fallback without math_env filter")
                fallback_sql = """
                SELECT data
                FROM math_main
                WHERE zid = :zid
                ORDER BY modified DESC
                LIMIT 1
                """
                results = self.postgres_client.query(fallback_sql, {"zid": conversation_id})
                if not results:
                    logger.warning(f"No math_main data found for conversation {conversation_id} in any math_env")
                    return None
                logger.info(f"Using fallback math_main row for conversation {conversation_id} from any available math_env")
            
            # Parse the JSON data
            math_data = results[0]['data']
            if isinstance(math_data, str):
                import json
                math_data = json.loads(math_data)
            
            logger.info(f"Successfully retrieved math_main data for conversation {conversation_id}")
            logger.debug(f"Math data keys: {list(math_data.keys()) if isinstance(math_data, dict) else 'not a dict'}")
            
            return math_data
            
        except Exception as e:
            logger.error(f"Error retrieving math_main data for conversation {conversation_id}: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return None
    
    async def get_conversation_data(self):
        """Get conversation data from PostgreSQL and DynamoDB."""
        try:
            # Initialize connection
            self.postgres_client.initialize()
            
            # Get conversation metadata
            conversation = self.postgres_client.get_conversation_by_id(int(self.conversation_id))
            if not conversation:
                logger.error(f"Conversation {self.conversation_id} not found in database.")
                return None
            
            # Get comments
            comments = self.postgres_client.get_comments_by_conversation(int(self.conversation_id))
            logger.info(f"Retrieved {len(comments)} comments from conversation {self.conversation_id}")

            if self.include_moderation:
                comments = [comment for comment in comments if comment['mod'] > -1]

            # Get basic comment + vote data in the export format expected downstream.
            # This path is compatible with local/dev where the legacy Clojure math_main table may be empty.
            export_data = self.group_processor.get_export_data(
                int(self.conversation_id),
                self.include_moderation,
            )
            processed_comments = export_data.get('comments', [])

            def _coerce_int(value, default=0):
                if value is None:
                    return default
                if isinstance(value, bool):
                    return int(value)
                if isinstance(value, (int, float)):
                    return int(value)
                if isinstance(value, str):
                    try:
                        return int(float(value.strip()))
                    except ValueError:
                        return default
                return default

            votable_comment_count = sum(
                1
                for comment in processed_comments
                if _coerce_int(comment.get('votes', 0), default=0) > 0
            )
            logger.info(
                f"Exported {len(processed_comments)} comments for conversation {self.conversation_id}; "
                f"comments with votes: {votable_comment_count}"
            )

            if not processed_comments:
                raise ValueError(
                    f"No votable comments found for conversation {self.conversation_id}. "
                    "Cannot generate narratives without vote data."
                )
            if votable_comment_count == 0:
                raise ValueError(
                    f"No votable comments found for conversation {self.conversation_id} (all exported comments have 0 votes). "
                    "Cannot generate narratives without vote data."
                )

            # Attempt to load pre-calculated metrics from the legacy Clojure math pipeline (math_main).
            # If absent, keep GroupDataProcessor metrics (which may be DynamoDB-backed) instead of failing.
            math_data = self._get_math_main_data(int(self.conversation_id))
            if math_data:
                tids = math_data.get('tids', [])
                extremity_array = math_data.get('pca', {}).get('comment-extremity', [])
                consensus_object = math_data.get('group-aware-consensus', {})

                logger.info(
                    f"Retrieved {len(tids)} comment IDs with pre-calculated metrics from Clojure math pipeline"
                )

                extremity_map = {}
                consensus_map = {}
                for i, tid in enumerate(tids):
                    if i < len(extremity_array):
                        extremity_map[str(tid)] = extremity_array[i]
                    if str(tid) in consensus_object:
                        consensus_map[str(tid)] = consensus_object[str(tid)]

                for record in processed_comments:
                    comment_id = str(record.get('comment_id', ''))
                    if comment_id in extremity_map:
                        record['comment_extremity'] = extremity_map.get(comment_id, 0)
                    if comment_id in consensus_map:
                        record['group_aware_consensus'] = consensus_map.get(comment_id, 0)

                logger.info(f"Extremity override: {len(extremity_map)} mapped, "
                            f"{sum(1 for v in extremity_map.values() if v > 1.0)} exceed 1.0")
                logger.info(
                    f"Applied Clojure math_main-derived metrics to {len(processed_comments)} exported comments"
                )
            else:
                logger.warning(
                    f"No math_main data available for conversation {self.conversation_id}; "
                    "continuing with GroupDataProcessor-derived metrics."
                )
            
            # Load cluster assignments from DynamoDB
            cluster_map = self.load_comment_clusters_from_dynamodb(self.conversation_id)
            
            # Enrich comments with cluster assignments from all layers
            enriched_count = 0
            total_assignments = 0
            for comment in processed_comments:
                comment_id = str(comment.get('comment_id', ''))
                if comment_id in cluster_map:
                    # Add cluster assignments for all layers
                    for layer_id, cluster_id in cluster_map[comment_id].items():
                        comment[f'layer{layer_id}_cluster_id'] = cluster_id
                        total_assignments += 1
                    enriched_count += 1
            
            # Log cluster assignment results
            if enriched_count > 0:
                logger.info(f"Enriched {enriched_count} comments with {total_assignments} total cluster assignments across all layers")
            else:
                logger.warning("No comments could be enriched with cluster assignments")
            
            return {
                "conversation": conversation,
                "comments": comments,
                "processed_comments": processed_comments,
                "math_data": math_data,
                "export_data": export_data
            }
        except Exception as e:
            logger.error(f"Error getting conversation data: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            raise
        finally:
            # Clean up connection
            self.postgres_client.shutdown()
    
    # (Inside the BatchReportGenerator class)
    def load_comment_clusters_from_dynamodb(self, conversation_id):
        """
        Load cluster assignments for comments from DynamoDB using an efficient Query.
        Returns a nested structure: {comment_id: {layer_id: cluster_id, ...}}
        """
        try:
            clusters_table = self.dynamodb.Table('Delphi_CommentHierarchicalClusterAssignments')
            cluster_map = {}
            
            logger.info(f"Querying for cluster assignments for conversation_id: {conversation_id}")
            last_evaluated_key = None
            available_layers = set()
            
            while True:
                query_kwargs = {
                    'KeyConditionExpression': boto3.dynamodb.conditions.Key('conversation_id').eq(str(conversation_id))
                }
                if last_evaluated_key:
                    query_kwargs['ExclusiveStartKey'] = last_evaluated_key

                response = clusters_table.query(**query_kwargs)
                
                for item in response.get('Items', []):
                    comment_id = item.get('comment_id')
                    if comment_id is not None:
                        comment_id_str = str(comment_id)
                        if comment_id_str not in cluster_map:
                            cluster_map[comment_id_str] = {}
                        
                        # Extract all layer cluster assignments
                        for key, value in item.items():
                            if key.startswith('layer') and key.endswith('_cluster_id') and value is not None:
                                # Extract layer number from key like 'layer0_cluster_id'
                                layer_num_str = key.replace('layer', '').replace('_cluster_id', '')
                                try:
                                    layer_num = int(layer_num_str)
                                    cluster_map[comment_id_str][layer_num] = value
                                    available_layers.add(layer_num)
                                except ValueError:
                                    # Skip invalid layer keys
                                    continue
                
                last_evaluated_key = response.get('LastEvaluatedKey')
                if not last_evaluated_key:
                    break

            logger.info(f"Loaded {len(cluster_map)} comment cluster assignments across {len(available_layers)} layers: {sorted(available_layers)}")
            return cluster_map
        except Exception as e:
            logger.error(f"Error loading cluster assignments from DynamoDB: {e}")
            return {}

    async def get_topics(self):
        """
        Gets all topics for the conversation from DynamoDB, efficiently fetching
        all necessary data with a minimal number of queries.
        """
        try:
            # Fetch all topic names for the conversation
            logger.info(f"Fetching all topic names for conversation {self.conversation_id}...")
            topic_names_table = self.dynamodb.Table('Delphi_CommentClustersLLMTopicNames')
            topic_names_items = []
            last_key = None
            while True:
                query_kwargs = {
                    'KeyConditionExpression': boto3.dynamodb.conditions.Key('conversation_id').eq(self.conversation_id)
                }
                if last_key:
                    query_kwargs['ExclusiveStartKey'] = last_key
                response = topic_names_table.query(**query_kwargs)
                topic_names_items.extend(response.get('Items', []))
                last_key = response.get('LastEvaluatedKey')
                if not last_key:
                    break
            logger.info(f"Fetched {len(topic_names_items)} total topic name entries.")

            # Fetch all cluster structure/keyword data for the conversation at once
            logger.info(f"Fetching all structure/keyword data for conversation {self.conversation_id}...")
            keywords_table = self.dynamodb.Table('Delphi_CommentClustersStructureKeywords')
            keyword_items = []
            last_key = None
            while True:
                query_kwargs = {
                    'KeyConditionExpression': boto3.dynamodb.conditions.Key('conversation_id').eq(self.conversation_id)
                }
                if last_key:
                    query_kwargs['ExclusiveStartKey'] = last_key
                response = keywords_table.query(**query_kwargs)
                keyword_items.extend(response.get('Items', []))
                last_key = response.get('LastEvaluatedKey')
                if not last_key:
                    break
            
            # Create a fast, in-memory lookup map for keywords
            keywords_lookup = {item['cluster_key']: item for item in keyword_items}
            logger.info(f"Created lookup map for {len(keywords_lookup)} keyword entries.")
            
            # Load all cluster assignments for all comments
            all_clusters = await asyncio.to_thread(self.load_comment_clusters_from_dynamodb, self.conversation_id)
            
            # --- Step 2: Process the fetched data ---
            
            available_layers = set(layer for clusters in all_clusters.values() for layer in clusters.keys())
            layers_to_process = sorted(list(available_layers))
            if self.layers is not None:
                layers_to_process = [layer for layer in layers_to_process if layer in self.layers]
            
            logger.info(f"Preparing to process topics for layers: {layers_to_process}")
            
            all_topics = []
            for layer_id in layers_to_process:
                logger.info(f"Processing layer {layer_id}")
                
                # Filter topic names for the current layer
                layer_topic_names = [item for item in topic_names_items if int(item.get('layer_id', -1)) == layer_id]
                topic_name_by_cluster_id = {}
                for item in layer_topic_names:
                    cluster_id = item.get('cluster_id')
                    if cluster_id is None:
                        continue
                    topic_name_by_cluster_id[cluster_id] = item.get('topic_name', f"Topic {cluster_id}")
                
                # Build a map of {cluster_id: [comment_ids]} for the current layer
                topic_comments = defaultdict(list)
                for comment_id, comment_clusters in all_clusters.items():
                    if layer_id in comment_clusters:
                        cluster_id = comment_clusters[layer_id]
                        topic_comments[cluster_id].append(int(comment_id))

                # Process each topic within the current layer
                for topic_item in layer_topic_names:
                    cluster_id = topic_item.get('cluster_id')
                    topic_key = topic_item.get('topic_key')

                    if cluster_id is None or not topic_key:
                        logger.warning(f"Skipping invalid topic item: {topic_item}")
                        continue

                    # Use the pre-fetched keyword data
                    cluster_lookup_key = f'layer{layer_id}_{cluster_id}'
                    cluster_structure_item = keywords_lookup.get(cluster_lookup_key, {})
                    
                    # Extract sample comments safely from the retrieved item
                    sample_comments = []
                    raw_samples = cluster_structure_item.get('sample_comments', [])
                    if isinstance(raw_samples, list):
                        sample_comments = [str(s) for s in raw_samples]

                    topic = {
                        "section_type": "topic",
                        "layer_id": layer_id,
                        "cluster_id": cluster_id,
                        "name": topic_item.get('topic_name', f"Topic {cluster_id}"),
                        "topic_key": topic_key,
                        "citations": topic_comments.get(cluster_id, []),
                        "sample_comments": sample_comments,
                        "distinction_revised": bool(topic_item.get('distinction_revised', False)),
                        "original_topic_name": topic_item.get('original_topic_name'),
                    }
                    all_topics.append(topic)

                # (Tribe sections are now generated per participant group in prepare_batch_requests)

            # --- Step 3: Add global sections ---
            if not self.job_id:
                raise ValueError("job_id is required for versioned topic keys but is missing or empty")
            
            global_topic_prefix = f"{self.job_id}_global"
            global_sections = [
                {"section_type": "global", "name": "groups", "topic_key": f"{global_topic_prefix}_groups", "filter_type": "comment_extremity", "filter_threshold": 1.0},
                {"section_type": "global", "name": "group_informed_consensus", "topic_key": f"{global_topic_prefix}_group_informed_consensus", "filter_type": "group_aware_consensus", "filter_threshold": "dynamic"},
                {"section_type": "global", "name": "uncertainty", "topic_key": f"{global_topic_prefix}_uncertainty", "filter_type": "uncertainty_ratio", "filter_threshold": 0.2}
            ]
            for section in global_sections: # Ensure placeholder keys exist
                section.setdefault('citations', [])
                section.setdefault('sample_comments', [])

            all_topics.extend(global_sections)
            logger.info(f"Created {len(all_topics)} sections total: {len(all_topics) - len(global_sections)} layer topics + {len(global_sections)} global sections")
            
            # Sort topics for processing
            all_topics.sort(key=lambda x: (0 if x.get('section_type') == 'global' else 1, x.get('layer_id', -1), -len(x.get('citations', []))))
            
            return all_topics
        
        except Exception as e:
            logger.error(f"A critical error occurred in get_topics: {str(e)}", exc_info=True)
            return []
        
    def filter_topics(self, comment, topic_cluster_id=None, topic_layer_id=None, topic_citations=None, sample_comments=None, filter_type=None, filter_threshold=None):
        """Filter for comments that are part of a specific topic or meet global section criteria."""
        # Get comment ID
        comment_id = comment.get('comment_id')
        if not comment_id:
            return False
        
        # Handle global section filtering
        if filter_type is not None:
            return self._apply_global_filter(comment, filter_type, filter_threshold)
        
        # Handle layer-specific topic filtering (existing logic)
        if topic_cluster_id is not None and topic_layer_id is not None:
            # Get the cluster ID for the specified layer
            layer_cluster_key = f'layer{topic_layer_id}_cluster_id'
            comment_cluster_id = comment.get(layer_cluster_key)
            if comment_cluster_id is not None:
                # Debug logging for cluster 0
                if str(topic_cluster_id) == "0" and comment_id in [1, 2, 3]:  # Log first few comments
                    logger.info(f"DEBUG: Checking comment {comment_id} - layer{topic_layer_id}_cluster_id={comment_cluster_id}, topic_cluster_id={topic_cluster_id}")
                    logger.info(f"DEBUG: String comparison: '{str(comment_cluster_id)}' == '{str(topic_cluster_id)}' = {str(comment_cluster_id) == str(topic_cluster_id)}")
                
                # Simple string comparison is more reliable across different numeric types
                if str(comment_cluster_id) == str(topic_cluster_id):
                    return True
                
        # Check if this comment ID is in our topic citations
        if topic_citations and str(comment_id) in [str(c) for c in topic_citations]:
            return True
            
        # If we have sample comments and not enough filtered comments,
        # try to match based on text similarity
        if sample_comments and len(sample_comments) > 0:
            comment_text = comment.get('comment', '')
            if not comment_text:
                return False
                
            # Check if this comment text matches any sample comment
            for sample in sample_comments:
                # Skip non-string samples
                if not isinstance(sample, str) or not sample:
                    continue
                    
                # Simple substring match rather than complex word comparison
                if sample.lower() in comment_text.lower() or comment_text.lower() in sample.lower():
                    return True
        
        return False
    
    def _apply_global_filter(self, comment, filter_type, filter_threshold):
        """
        Apply global section filtering based on Polis statistical metrics.
        
        Args:
            comment: Comment data dictionary
            filter_type: Type of filter ('comment_extremity', 'group_aware_consensus', 'uncertainty_ratio')
            filter_threshold: Threshold value for filtering (or 'dynamic' for group_aware_consensus)
            
        Returns:
            Boolean indicating whether comment passes the filter
        """
        try:
            if filter_type == "comment_extremity":
                # Filter for comments that divide opinion groups (extremity > 1.0)
                extremity = comment.get('comment_extremity', 0)
                return extremity >= filter_threshold
                
            elif filter_type == "group_aware_consensus":
                # Filter for comments with broad cross-group agreement
                # Uses dynamic thresholds based on number of groups
                consensus = comment.get('group_aware_consensus', 0)
                num_groups = comment.get('num_groups', 2)
                
                # Get dynamic threshold based on group count (matches Node.js logic)
                if filter_threshold == "dynamic":
                    if num_groups == 2:
                        base_threshold = 0.7
                    elif num_groups == 3:
                        base_threshold = 0.47
                    elif num_groups == 4:
                        base_threshold = 0.32
                    else:  # 5+ groups
                        base_threshold = 0.24

                    # Scale threshold for small conversations where Laplace smoothing
                    # makes high consensus values mathematically impossible.
                    # consensus = product of (agree+1)/(votes+2) across groups,
                    # so the max achievable consensus shrinks with fewer voters.
                    votes = comment.get('votes', 0)
                    if votes > 0 and votes < 20:
                        avg_group_size = votes / max(num_groups, 1)
                        max_prob = (avg_group_size + 1) / (avg_group_size + 2)
                        max_consensus = max_prob ** num_groups
                        # Use 85% of max achievable as threshold, but never exceed
                        # the base threshold (for large conversations the base applies)
                        threshold = min(base_threshold, max_consensus * 0.85)
                    else:
                        threshold = base_threshold
                else:
                    threshold = filter_threshold
                    
                return consensus >= threshold
                
            elif filter_type == "uncertainty_ratio":
                # Filter for comments with high uncertainty/unsure responses (>= 20% pass votes)
                passes = comment.get('passes', 0)
                votes = comment.get('votes', 0)
                
                if votes == 0:
                    return False
                    
                uncertainty_ratio = passes / votes
                return uncertainty_ratio >= filter_threshold
                
            else:
                logger.warning(f"Unknown filter type: {filter_type}")
                return False
                
        except Exception as e:
            logger.error(f"Error applying global filter {filter_type}: {str(e)}")
            return False
    
    def _get_dynamic_comment_limit(self, layer_id=None, total_layers=None, comment_count=None, filter_type=None):
        """
        Calculate dynamic comment limit based on layer granularity and conversation size.
        Implements the fractal approach where coarse layers get fewer, higher quality comments.
        
        Args:
            layer_id: Current layer ID (None for global sections)
            total_layers: Total number of available layers  
            comment_count: Total number of comments in conversation
            filter_type: Type of filter (for global sections)
            
        Returns:
            Integer comment limit for this section
        """
        try:
            # Base limits for different categories
            base_limits = {
                "global_sections": 50,   # Fixed limit for global sections
                "fine_layers": 100,      # More comments for specific topics (layer 0)
                "medium_layers": 75,     # Balanced approach (middle layers)
                "coarse_layers": 50      # Fewer, highest quality comments (top layer)
            }
            
            # Determine category
            if filter_type is not None:
                # This is a global section
                category = "global_sections"
            elif layer_id is not None and total_layers is not None:
                # This is a layer-specific topic
                if layer_id == 0:
                    category = "fine_layers"  # Most specific layer
                elif layer_id == total_layers - 1:
                    category = "coarse_layers"  # Most general layer
                else:
                    category = "medium_layers"  # Middle layers
            else:
                # Fallback to medium limit
                category = "medium_layers"
            
            # Get base limit
            limit = base_limits[category]
            
            # Scale down for very large conversations to manage token usage
            if comment_count is not None:
                if comment_count > 10000:
                    # Halve limits for huge conversations (>10k comments)
                    limit = int(limit * 0.5)
                elif comment_count > 5000:
                    # Reduce by 25% for large conversations (5k-10k comments)
                    limit = int(limit * 0.75)
                elif comment_count > 2000:
                    # Reduce by 10% for medium-large conversations (2k-5k comments)
                    limit = int(limit * 0.9)
            
            # Ensure minimum limit
            limit = max(limit, 10)
            
            logger.debug(f"Dynamic comment limit: category={category}, base={base_limits[category]}, "
                        f"final={limit}, comment_count={comment_count}, layer_id={layer_id}")
            
            return limit
            
        except Exception as e:
            logger.error(f"Error calculating dynamic comment limit: {str(e)}")
            # Fallback to conservative limit
            return 50
    
    def _select_high_quality_comments(self, comments, limit, filter_type=None):
        """
        Select the highest quality comments based on Polis statistical metrics.
        
        Args:
            comments: List of comment dictionaries
            limit: Maximum number of comments to select
            filter_type: Type of filter being applied (affects sorting priority)
            
        Returns:
            List of selected high-quality comments
        """
        if len(comments) <= limit:
            return comments
            
        try:
            # Create sorting key based on filter type and available metrics
            def get_sort_key(comment):
                # Base score starts with vote count (engagement indicator)
                votes = comment.get('votes', 0)
                vote_score = int(votes) if isinstance(votes, (int, float)) else 0
                
                # Add metric-specific scoring
                if filter_type == "comment_extremity":
                    # For extremity filtering, prioritize highly divisive comments
                    extremity = comment.get('comment_extremity', 0)
                    metric_score = extremity * 1000  # Scale up for sorting
                elif filter_type == "group_aware_consensus":
                    # For consensus filtering, prioritize high agreement comments
                    consensus = comment.get('group_aware_consensus', 0)
                    metric_score = consensus * 1000  # Scale up for sorting
                elif filter_type == "uncertainty_ratio":
                    # For uncertainty filtering, prioritize comments with high pass rates
                    passes = comment.get('passes', 0)
                    total_votes = comment.get('votes', 1)
                    uncertainty = passes / max(total_votes, 1)
                    metric_score = uncertainty * 1000  # Scale up for sorting
                else:
                    # For topic filtering, use a combination of votes and engagement
                    agrees = comment.get('agrees', 0)
                    disagrees = comment.get('disagrees', 0)
                    total_engagement = int(agrees) + int(disagrees) if isinstance(agrees, (int, float)) and isinstance(disagrees, (int, float)) else 0
                    metric_score = total_engagement
                
                # Combine scores (metric score is primary, vote count is secondary)
                return (metric_score, vote_score)
            
            # Sort comments by quality score (descending)
            sorted_comments = sorted(comments, key=get_sort_key, reverse=True)
            
            # Select top comments up to limit
            selected = sorted_comments[:limit]
            
            logger.info(f"Selected {len(selected)} high-quality comments from {len(comments)} "
                       f"(filter_type={filter_type}, limit={limit})")
            
            return selected
            
        except Exception as e:
            logger.error(f"Error selecting high-quality comments: {str(e)}")
            # Fallback to simple vote-based selection
            try:
                sorted_comments = sorted(comments, 
                                       key=lambda c: int(c.get('votes', 0)) if isinstance(c.get('votes'), (int, float)) else 0, 
                                       reverse=True)
                return sorted_comments[:limit]
            except Exception:
                # Last resort: return first N comments
                return comments[:limit]

    def _filter_processed_comments(self, conversation_data: dict, filter_func=None, filter_args=None) -> List[Dict[str, Any]]:
        """Filter processed comments using the same semantics as get_comments_as_xml, but return records."""
        if not conversation_data:
            return []

        processed_comments = conversation_data.get('processed_comments', [])
        if not processed_comments:
            return []

        if not filter_func:
            return list(processed_comments)

        if filter_args:
            return [c for c in processed_comments if filter_func(c, **filter_args)]
        return [c for c in processed_comments if filter_func(c)]

    def _extract_participant_group_ids(self, comment_record: Dict[str, Any]) -> List[int]:
        group_ids = set()
        for key in comment_record.keys():
            if not isinstance(key, str):
                continue
            if key.startswith('group-') and key.endswith('-votes'):
                # key format: group-{g}-votes
                parts = key.split('-')
                if len(parts) >= 3:
                    try:
                        group_ids.add(int(parts[1]))
                    except ValueError:
                        continue
        return sorted(group_ids)

    def _summarize_participant_groups(self, comments: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Aggregate per-participant-group vote totals and rates across a set of comment export records."""
        totals: Dict[int, Dict[str, int]] = {}

        def _coerce_int(value, default=0):
            if value is None:
                return default
            if isinstance(value, bool):
                return int(value)
            if isinstance(value, (int, float)):
                return int(value)
            if isinstance(value, str):
                try:
                    return int(float(value.strip()))
                except ValueError:
                    return default
            return default

        for record in comments:
            for group_id in self._extract_participant_group_ids(record):
                if group_id not in totals:
                    totals[group_id] = {"votes": 0, "agrees": 0, "disagrees": 0, "passes": 0}
                totals[group_id]["votes"] += _coerce_int(record.get(f"group-{group_id}-votes", 0))
                totals[group_id]["agrees"] += _coerce_int(record.get(f"group-{group_id}-agrees", 0))
                totals[group_id]["disagrees"] += _coerce_int(record.get(f"group-{group_id}-disagrees", 0))
                totals[group_id]["passes"] += _coerce_int(record.get(f"group-{group_id}-passes", 0))

        summaries = []
        for group_id, stats in sorted(totals.items(), key=lambda kv: kv[0]):
            votes = max(stats["votes"], 0)
            agrees = max(stats["agrees"], 0)
            disagrees = max(stats["disagrees"], 0)
            passes = max(stats["passes"], 0)
            agree_rate = agrees / votes if votes else 0.0
            disagree_rate = disagrees / votes if votes else 0.0
            pass_rate = passes / votes if votes else 0.0
            summaries.append({
                "participant_group_id": group_id,
                "votes": votes,
                "agrees": agrees,
                "disagrees": disagrees,
                "passes": passes,
                "agree_rate": agree_rate,
                "disagree_rate": disagree_rate,
                "pass_rate": pass_rate
            })

        return {
            "groups": summaries,
            "n_groups": len(summaries)
        }

    def _count_participants_by_group(self, export_data: Dict[str, Any]) -> Dict[int, int]:
        """Count participants per participant-group using export_data['math_result']['group_assignments']."""
        try:
            assignments = export_data.get('math_result', {}).get('group_assignments', {}) if isinstance(export_data, dict) else {}
            counts: Dict[int, int] = {}
            if not isinstance(assignments, dict):
                return counts
            for _participant_id, group_id in assignments.items():
                try:
                    gid = int(group_id)
                except (TypeError, ValueError):
                    continue
                counts[gid] = counts.get(gid, 0) + 1
            return counts
        except Exception:
            return {}

    def _get_participant_group_ids(self, conversation_data: Dict[str, Any]) -> List[int]:
        """Extract sorted list of unique participant group IDs from processed comments."""
        group_ids = set()
        for record in conversation_data.get('processed_comments', []):
            for key in record.keys():
                if isinstance(key, str) and key.startswith('group-') and key.endswith('-votes'):
                    parts = key.split('-')
                    if len(parts) >= 3:
                        try:
                            group_ids.add(int(parts[1]))
                        except ValueError:
                            continue
        return sorted(group_ids)

    def _select_comments_for_tribe_consensus(self, processed_comments: List[Dict[str, Any]], group_id: int, agree_threshold: float = 0.6, disagree_threshold: float = 0.3, limit: int = 50) -> Dict[str, List[Dict[str, Any]]]:
        """Select comments with strong group agreement or disagreement.

        Returns dict with 'strong_agree' and 'strong_disagree' lists, each capped at limit.
        """
        def _coerce_float(value, default=0.0):
            if value is None:
                return default
            if isinstance(value, bool):
                return float(int(value))
            if isinstance(value, (int, float)):
                return float(value)
            if isinstance(value, str):
                try:
                    return float(value.strip())
                except ValueError:
                    return default
            return default

        strong_agree = []
        strong_disagree = []

        for c in processed_comments:
            tribe_votes = _coerce_float(c.get(f'group-{group_id}-votes', 0))
            if tribe_votes <= 0:
                continue
            tribe_agrees = _coerce_float(c.get(f'group-{group_id}-agrees', 0))
            tribe_disagrees = _coerce_float(c.get(f'group-{group_id}-disagrees', 0))
            agree_rate = tribe_agrees / tribe_votes
            disagree_rate = tribe_disagrees / tribe_votes

            entry = {
                "comment_id": c.get('comment_id', c.get('comment-id')),
                "text": c.get('comment', ''),
                "agree_rate": round(agree_rate, 4),
                "disagree_rate": round(disagree_rate, 4),
                "tribe_agrees": int(tribe_agrees),
                "tribe_disagrees": int(tribe_disagrees),
                "tribe_votes": int(tribe_votes),
            }

            if agree_rate >= agree_threshold:
                strong_agree.append(entry)
            if disagree_rate >= disagree_threshold:
                strong_disagree.append(entry)

        strong_agree.sort(key=lambda x: x['agree_rate'], reverse=True)
        strong_disagree.sort(key=lambda x: x['disagree_rate'], reverse=True)

        return {
            "strong_agree": strong_agree[:limit],
            "strong_disagree": strong_disagree[:limit],
        }

    def _select_comments_for_tribe_characteristics(self, processed_comments: List[Dict[str, Any]], group_id: int, limit: int = 30, math_data: dict = None) -> List[Dict[str, Any]]:
        """Select comments that most characteristically represent this group.

        Uses Clojure repness scores when available (preferred), falling back to
        a simple distinctiveness heuristic based on agree-rate difference.

        Returns list sorted by representativeness descending, capped at limit.
        """
        def _coerce_float(value, default=0.0):
            if value is None:
                return default
            if isinstance(value, bool):
                return float(int(value))
            if isinstance(value, (int, float)):
                return float(value)
            if isinstance(value, str):
                try:
                    return float(value.strip())
                except ValueError:
                    return default
            return default

        # --- Primary path: Clojure repness from math_main ---
        if math_data and isinstance(math_data, dict):
            repness_all = math_data.get('repness', {})
            group_repness = repness_all.get(str(group_id), [])
            if group_repness:
                # Build a lookup from tid -> original comment record for enrichment
                comment_by_tid = {}
                for c in processed_comments:
                    cid = c.get('comment_id', c.get('comment-id'))
                    if cid is not None:
                        comment_by_tid[int(cid)] = c

                results = []
                for entry in group_repness:
                    repful_for = entry.get('repful-for', 'agree')
                    score = _coerce_float(entry.get('repness', 0))
                    if score < 1.0:
                        continue
                    tid = int(entry.get('tid', -1))
                    original = comment_by_tid.get(tid, {})

                    tribe_votes = _coerce_float(original.get(f'group-{group_id}-votes', 0))
                    overall_votes = _coerce_float(original.get('votes', original.get('total-votes', 0)))
                    tribe_agrees = _coerce_float(original.get(f'group-{group_id}-agrees', 0))
                    overall_agrees = _coerce_float(original.get('agrees', original.get('total-agrees', 0)))
                    tribe_agree_rate = (tribe_agrees / tribe_votes) if tribe_votes > 0 else 0.0
                    overall_agree_rate = (overall_agrees / overall_votes) if overall_votes > 0 else 0.0

                    results.append({
                        "comment_id": tid,
                        "text": original.get('comment', ''),
                        "repful_for": repful_for,
                        "distinctiveness_score": round(score, 4),
                        "tribe_agree_rate": round(tribe_agree_rate, 4),
                        "overall_agree_rate": round(overall_agree_rate, 4),
                        "tribe_agrees": int(tribe_agrees),
                        "tribe_votes": int(tribe_votes),
                        "overall_votes": int(overall_votes),
                    })

                # Split into agree and disagree, each sorted by score
                agrees = sorted([r for r in results if r.get('repful_for') == 'agree'],
                                key=lambda x: x['distinctiveness_score'], reverse=True)
                disagrees = sorted([r for r in results if r.get('repful_for') == 'disagree'],
                                   key=lambda x: x['distinctiveness_score'], reverse=True)

                # Balanced selection: aim for ~60% agree, ~40% disagree
                target_disagree = max(1, int(limit * 0.4)) if disagrees else 0
                target_agree = limit - target_disagree

                # Adjust if one pool is too small
                if len(disagrees) < target_disagree:
                    target_disagree = len(disagrees)
                    target_agree = min(len(agrees), limit - target_disagree)
                if len(agrees) < target_agree:
                    target_agree = len(agrees)
                    target_disagree = min(len(disagrees), limit - target_agree)

                balanced = agrees[:target_agree] + disagrees[:target_disagree]
                balanced.sort(key=lambda x: x['distinctiveness_score'], reverse=True)

                agree_count = sum(1 for r in balanced if r.get('repful_for') == 'agree')
                disagree_count = len(balanced) - agree_count
                logger.info(f"Tribe {group_id} characteristics: {len(balanced)}/{len(results)} comments from Clojure repness (>= 1.0) — {agree_count} agree, {disagree_count} disagree (balanced)")
                return balanced[:limit]

        # --- Fallback: simple distinctiveness heuristic ---
        logger.info(f"Tribe {group_id} characteristics: falling back to agree-rate distinctiveness (no Clojure repness)")
        results = []
        for c in processed_comments:
            tribe_votes = _coerce_float(c.get(f'group-{group_id}-votes', 0))
            overall_votes = _coerce_float(c.get('votes', c.get('total-votes', 0)))
            if tribe_votes <= 0 or overall_votes <= 0:
                continue
            tribe_agrees = _coerce_float(c.get(f'group-{group_id}-agrees', 0))
            overall_agrees = _coerce_float(c.get('agrees', c.get('total-agrees', 0)))
            tribe_agree_rate = tribe_agrees / tribe_votes
            overall_agree_rate = overall_agrees / overall_votes
            distinctiveness = abs(tribe_agree_rate - overall_agree_rate)

            results.append({
                "comment_id": c.get('comment_id', c.get('comment-id')),
                "text": c.get('comment', ''),
                "distinctiveness_score": round(distinctiveness, 4),
                "tribe_agree_rate": round(tribe_agree_rate, 4),
                "overall_agree_rate": round(overall_agree_rate, 4),
                "tribe_agrees": int(tribe_agrees),
                "tribe_votes": int(tribe_votes),
                "overall_votes": int(overall_votes),
            })

        results.sort(key=lambda x: x['distinctiveness_score'], reverse=True)
        return results[:limit]

    def _build_tribe_payload(self,
                             conversation_data: Dict[str, Any],
                             group_id: int,
                             payload_type: str,
                             comment_limit: int = 50) -> Dict[str, Any]:
        """Build the data payload for tribe_* templates.

        Args:
            conversation_data: Full conversation data dict.
            group_id: Participant group ID (0-based).
            payload_type: One of 'title', 'consensus', 'characteristics'.
            comment_limit: Maximum comments to include per selection list.
        """
        processed_comments = conversation_data.get('processed_comments', [])

        def _coerce_float(value, default=0.0):
            if value is None:
                return default
            if isinstance(value, bool):
                return float(int(value))
            if isinstance(value, (int, float)):
                return float(value)
            if isinstance(value, str):
                try:
                    return float(value.strip())
                except ValueError:
                    return default
            return default

        # Aggregate tribe-level stats across all comments
        tribe_total_votes = 0
        tribe_total_agrees = 0
        tribe_total_disagrees = 0
        for c in processed_comments:
            tribe_total_votes += int(_coerce_float(c.get(f'group-{group_id}-votes', 0)))
            tribe_total_agrees += int(_coerce_float(c.get(f'group-{group_id}-agrees', 0)))
            tribe_total_disagrees += int(_coerce_float(c.get(f'group-{group_id}-disagrees', 0)))

        tribe_agree_rate = (tribe_total_agrees / tribe_total_votes) if tribe_total_votes else 0.0
        tribe_disagree_rate = (tribe_total_disagrees / tribe_total_votes) if tribe_total_votes else 0.0

        export_data = conversation_data.get('export_data', {})
        participant_sizes = self._count_participants_by_group(export_data)

        payload: Dict[str, Any] = {
            "tribe": {
                "group_id": group_id,
                "participant_count": participant_sizes.get(group_id, 0),
                "total_comments": len(processed_comments),
                "agree_rate": round(tribe_agree_rate, 4),
                "disagree_rate": round(tribe_disagree_rate, 4),
            },
        }

        # Route by payload_type to select comments and build type-specific keys
        if payload_type == 'consensus':
            consensus = self._select_comments_for_tribe_consensus(processed_comments, group_id, limit=comment_limit)
            payload["strong_agree_comments"] = consensus["strong_agree"]
            payload["strong_disagree_comments"] = consensus["strong_disagree"]
            representative_records = []
            # Build representative raw records for XML from both lists
            seen_ids = set()
            for entry in consensus["strong_agree"] + consensus["strong_disagree"]:
                cid = entry["comment_id"]
                if cid in seen_ids:
                    continue
                seen_ids.add(cid)
                # Find original record
                for c in processed_comments:
                    if c.get('comment_id', c.get('comment-id')) == cid:
                        representative_records.append(c)
                        break
        elif payload_type == 'characteristics':
            chars = self._select_comments_for_tribe_characteristics(processed_comments, group_id, limit=comment_limit, math_data=conversation_data.get('math_data'))
            payload["characteristic_comments"] = chars
            representative_records = []
            for entry in chars:
                cid = entry["comment_id"]
                for c in processed_comments:
                    if c.get('comment_id', c.get('comment-id')) == cid:
                        representative_records.append(c)
                        break
        else:
            # 'title' — use characteristics with smaller limit
            chars = self._select_comments_for_tribe_characteristics(processed_comments, group_id, limit=comment_limit, math_data=conversation_data.get('math_data'))
            payload["characteristic_comments"] = chars
            representative_records = []
            for entry in chars:
                cid = entry["comment_id"]
                for c in processed_comments:
                    if c.get('comment_id', c.get('comment-id')) == cid:
                        representative_records.append(c)
                        break

        payload["structured_comments"] = PolisConverter.convert_to_xml(representative_records) if representative_records else ""

        # Conversation context
        conversation = conversation_data.get('conversation', {})
        payload["conversation_context"] = {
            "conversation_id": self.conversation_id,
            "total_comments": len(processed_comments),
            "topic": conversation.get('topic', ''),
        }

        # Comparison data for consensus and characteristics
        if payload_type in ('consensus', 'characteristics'):
            all_comments = conversation_data.get('processed_comments', [])
            summary_all = self._summarize_participant_groups(all_comments)
            payload["comparison"] = {
                "participant_group_vote_summary_all_comments": summary_all,
            }

        return payload
    
    async def get_comments_as_xml(self, conversation_data: dict, filter_func=None, filter_args=None):
        """Get comments as XML from pre-fetched data."""
        try:
            # Use the data passed as an argument
            data = conversation_data
            
            if not data:
                logger.error("Received empty conversation data.")
                return "", 0
            
            # Apply filter if provided
            filtered_comments = data["processed_comments"]
            
            if filter_func:
                if filter_args:
                    filtered_comments = [c for c in filtered_comments if filter_func(c, **filter_args)]
                else:
                    filtered_comments = [c for c in filtered_comments if filter_func(c)]

            # Global section fallback: if threshold filter yields zero comments,
            # pass through all comments and let high-quality selection/ranking handle prioritization.
            is_global_filter = (
                filter_func == self.filter_topics
                and isinstance(filter_args, dict)
                and filter_args.get('filter_type') is not None
            )
            if is_global_filter and len(filtered_comments) == 0:
                filter_type = filter_args.get('filter_type')
                logger.warning(f"Global filter '{filter_type}' yielded 0 comments, falling back to top-K selection")
                filtered_comments = data["processed_comments"]
            
            # Apply dynamic comment limiting with intelligent selection
            if filter_func == self.filter_topics and len(filtered_comments) > 0:
                # Get context for dynamic limit calculation
                total_comment_count = len(data["processed_comments"])
                
                # Extract layer and filter information from filter_args
                layer_id = None
                total_layers = None
                filter_type = None
                
                if filter_args:
                    layer_id = filter_args.get('topic_layer_id')
                    filter_type = filter_args.get('filter_type')
                    
                    # Estimate total layers from conversation data (could be improved)
                    # For now, we'll determine this dynamically or use a reasonable default
                    if layer_id is not None:
                        # Try to determine total layers from available cluster data
                        # This is a heuristic - in practice you might want to pass this explicitly
                        total_layers = max(layer_id + 1, 3)  # Assume at least 3 layers if we have layer data
                
                # Calculate dynamic limit
                comment_limit = self._get_dynamic_comment_limit(
                    layer_id=layer_id,
                    total_layers=total_layers, 
                    comment_count=total_comment_count,
                    filter_type=filter_type
                )
                
                # Apply intelligent comment selection if we exceed the limit
                if len(filtered_comments) > comment_limit:
                    logger.info(f"Applying dynamic comment limit: {len(filtered_comments)} -> {comment_limit} "
                               f"(layer_id={layer_id}, filter_type={filter_type}, total_comments={total_comment_count})")
                    
                    # Use intelligent selection based on Polis metrics
                    filtered_comments = self._select_high_quality_comments(
                        filtered_comments, 
                        comment_limit, 
                        filter_type=filter_type
                    )
                else:
                    logger.info(f"No limiting needed: {len(filtered_comments)} comments <= limit of {comment_limit}")
            else:
                # For non-topic filtering, use a conservative limit to avoid token issues
                max_comments = 100
                if len(filtered_comments) > max_comments:
                    logger.info(f"Applying conservative limit: {len(filtered_comments)} -> {max_comments}")
                    filtered_comments = self._select_high_quality_comments(filtered_comments, max_comments)
            
            # Convert to XML
            filtered_count = len(filtered_comments)
            xml = PolisConverter.convert_to_xml(filtered_comments)
            
            return xml, filtered_count
        except Exception as e:
            logger.error(f"Error in get_comments_as_xml: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return "", 0
    
    async def prepare_batch_requests(self):
        """Prepare batch requests for all topics."""
        logger.info("Fetching all conversation data ONCE...")
        conversation_data = await self.get_conversation_data()
        if not conversation_data:
            logger.error("Failed to fetch conversation data. Cannot prepare batch requests.")
            return []
        
        topics = await self.get_topics()

        # --- Add participant-group tribe sections ---
        group_ids = self._get_participant_group_ids(conversation_data)
        logger.info(f"Detected {len(group_ids)} participant groups for tribe sections: {group_ids}")
        for gid in group_ids:
            topics.append({
                "section_type": "tribe_title",
                "section_name": f"{self.job_id}_tribe_g{gid}_title",
                "topic_key": f"tribe_g{gid}_title",
                "name": f"Tribe {gid + 1}",
                "group_id": gid,
                "layer_id": None,
                "cluster_id": None,
                "citations": [],
                "sample_comments": [],
            })
            topics.append({
                "section_type": "tribe_consensus",
                "section_name": f"{self.job_id}_tribe_g{gid}_consensus",
                "topic_key": f"tribe_g{gid}_consensus",
                "name": f"Tribe {gid + 1}",
                "group_id": gid,
                "layer_id": None,
                "cluster_id": None,
                "citations": [],
                "sample_comments": [],
            })
            topics.append({
                "section_type": "tribe_characteristics",
                "section_name": f"{self.job_id}_tribe_g{gid}_characteristics",
                "topic_key": f"tribe_g{gid}_characteristics",
                "name": f"Tribe {gid + 1}",
                "group_id": gid,
                "layer_id": None,
                "cluster_id": None,
                "citations": [],
                "sample_comments": [],
            })

        logger.info(f"Preparing batch requests for {len(topics)} topics")
        
        # Read system lore
        system_path = self.prompt_base_path / 'system.xml'
        if not system_path.exists():
            logger.error(f"System file not found: {system_path}")
            return []
        
        with open(system_path, 'r') as f:
            system_lore = f.read()
        
        # Template content will be selected per topic based on section type
        
        # Initialize list for batch requests
        batch_requests = []
        
        # For each section, prepare a prompt and add it to the batch
        for topic in topics:
            topic_name = topic['name']
            topic_key = topic['topic_key']  # Use the stable topic_key from DynamoDB

            section_type = topic.get('section_type') or ('global' if topic.get('filter_type') is not None else 'topic')
            
            # Determine section_name.
            # - Tribe sections use an explicit, stable section_name that includes job_id and subtype.
            # - Other sections fall back to topic_key-derived naming.
            section_name = topic.get('section_name')
            if not section_name:
                # Convert topic_key to section_name format
                # Topic keys use # delimiters (uuid#layer#cluster) but section names use _ delimiters (uuid_layer_cluster)
                if '#' in topic_key:
                    # Versioned format: convert uuid#layer#cluster -> uuid_layer_cluster
                    section_name = topic_key.replace('#', '_')
                else:
                    # Legacy format: use as-is (layer0_0, global_groups, etc.)
                    section_name = topic_key
            
            # Check section kinds
            is_global_section = section_type == 'global'
            is_tribe_title = section_type == 'tribe_title'
            is_tribe_consensus = section_type == 'tribe_consensus'
            is_tribe_characteristics = section_type == 'tribe_characteristics'
            
            if is_global_section:
                # Global section - use filter_type and filter_threshold
                filter_type = topic.get('filter_type')
                filter_threshold = topic.get('filter_threshold')
                topic_cluster_id = None
                topic_layer_id = None
                
                # Create filter args for global section
                filter_args = {
                    'filter_type': filter_type,
                    'filter_threshold': filter_threshold
                }
                
                logger.info(f"Global section mapping - name: {topic_name}, filter_type: {filter_type}, "
                           f"filter_threshold: {filter_threshold}, topic_key: {topic_key}")
            elif is_tribe_title or is_tribe_consensus or is_tribe_characteristics:
                # Participant-group tribe section — cluster/layer not applicable
                topic_cluster_id = None
                topic_layer_id = None
                filter_args = {}
                logger.info(f"Tribe section mapping - section_type: {section_type}, group_id: {topic.get('group_id')}, "
                           f"topic_key: {topic_key}")
            else:
                # Layer-specific topic - use cluster_id and layer_id
                topic_cluster_id = topic.get('cluster_id')
                topic_layer_id = topic.get('layer_id')
                
                # Create filter args for layer-specific topic
                filter_args = {
                    'topic_cluster_id': topic_cluster_id,
                    'topic_layer_id': topic_layer_id,
                    'topic_citations': topic.get('citations', []),
                    'sample_comments': topic.get('sample_comments', [])
                }
                
                logger.info(f"Topic mapping - cluster_id: {topic_cluster_id}, layer_id: {topic_layer_id}, "
                           f"topic_name: {topic_name}, topic_key: {topic_key}")
            
            
            # Get comments as XML and/or additional payload
            tribe_payload = None
            if is_tribe_title:
                tribe_payload = self._build_tribe_payload(
                    conversation_data,
                    group_id=int(topic.get('group_id', 0)),
                    payload_type='title',
                    comment_limit=15,
                )
                structured_comments = tribe_payload.get('structured_comments', '')
            elif is_tribe_consensus:
                tribe_payload = self._build_tribe_payload(
                    conversation_data,
                    group_id=int(topic.get('group_id', 0)),
                    payload_type='consensus',
                    comment_limit=50,
                )
                structured_comments = tribe_payload.get('structured_comments', '')
            elif is_tribe_characteristics:
                tribe_payload = self._build_tribe_payload(
                    conversation_data,
                    group_id=int(topic.get('group_id', 0)),
                    payload_type='characteristics',
                    comment_limit=30,
                )
                structured_comments = tribe_payload.get('structured_comments', '')
            else:
                structured_comments, filtered_count = await self.get_comments_as_xml(conversation_data, self.filter_topics, filter_args)
            
            # Debug logging for topic 0
            if topic_cluster_id == 0 or str(topic_cluster_id) == "0":
                logger.info(f"DEBUG: Topic 0 filter_args: {filter_args}")
                logger.info(f"DEBUG: Topic 0 structured_comments length: {len(structured_comments) if structured_comments else 0}")
                logger.info(f"DEBUG: Topic 0 has content: {bool(structured_comments and structured_comments.strip())}")
            
            # Skip if no structured comments
            if not structured_comments.strip():
                logger.warning(f"No content after filter for topic {topic_name} (cluster_id={topic_cluster_id})")
                continue
            
            # Select appropriate template based on section type
            if is_global_section:
                # Map global section names to template files
                template_mapping = {
                    "groups": "groups.xml",
                    "group_informed_consensus": "group_informed_consensus.xml", 
                    "uncertainty": "uncertainty.xml"
                }
                
                # Extract the base name from the section_name (works with both old and new formats)
                # Old format: "global_groups" -> "groups"
                # New format: "batch_report_xxx_global_groups" -> "groups"
                if section_name.endswith("_groups"):
                    base_name = "groups"
                elif section_name.endswith("_group_informed_consensus"):
                    base_name = "group_informed_consensus"
                elif section_name.endswith("_uncertainty"):
                    base_name = "uncertainty"
                else:
                    # Fallback: try the old logic for backwards compatibility
                    base_name = topic_name.replace("global_", "")
                    logger.warning(f"Could not determine base name from section_name '{section_name}', using fallback: '{base_name}'")
                
                template_filename = template_mapping.get(base_name, "topics.xml")
                template_path = self.prompt_base_path / f"subtaskPrompts/{template_filename}"
                
                logger.info(f"Using template {template_filename} for global section {section_name} (base_name: {base_name})")
            elif is_tribe_title:
                template_path = self.prompt_base_path / "subtaskPrompts/tribe_title.xml"
                logger.info(f"Using tribe_title.xml template for tribe title section {section_name}")
            elif is_tribe_consensus:
                template_path = self.prompt_base_path / "subtaskPrompts/tribe_consensus.xml"
                logger.info(f"Using tribe_consensus.xml template for tribe consensus section {section_name}")
            elif is_tribe_characteristics:
                template_path = self.prompt_base_path / "subtaskPrompts/tribe_characteristics.xml"
                logger.info(f"Using tribe_characteristics.xml template for tribe characteristics section {section_name}")
            else:
                # Use topics template for layer-specific topics
                template_path = self.prompt_base_path / "subtaskPrompts/topics.xml"
                logger.info(f"Using topics.xml template for topic {topic_name}")
            
            if not template_path.exists():
                logger.error(f"Template file not found: {template_path}")
                continue
                
            with open(template_path, 'r') as f:
                template_content = f.read()
            
            # Insert structured comments into template
            try:
                template_dict = xmltodict.parse(template_content)
                
                # Find the data element and replace its content
                data_payload = {"structured_comments": structured_comments}
                if is_global_section:
                    total_comments = len(conversation_data["processed_comments"])
                    filter_descriptions = {
                        "comment_extremity": "comments that divide opinion tribes (high extremity)",
                        "group_aware_consensus": "comments with high cross-tribe consensus",
                        "uncertainty_ratio": "comments with high uncertainty/pass rates",
                    }
                    data_payload["conversation_context"] = (
                        f"IMPORTANT: This section analyzes a SUBSET of the full conversation. "
                        f"The conversation contains {total_comments} total comments. "
                        f"Only {filtered_count} comments are shown here because they met the filter criteria: "
                        f"{filter_descriptions.get(topic.get('filter_type'), 'filtered comments')}. "
                        f"Do NOT make claims about 'all comments' or 'the entire conversation' — "
                        f"you are only seeing the {filtered_count} comments that passed this specific filter."
                    )
                if tribe_payload is not None:
                    # Provide extra context for tribe templates without changing the existing request flow.
                    # Keep JSON blobs as strings to avoid xmltodict structural quirks.
                    tribe_payload_for_json = dict(tribe_payload)
                    # Avoid embedding the XML blob twice.
                    tribe_payload_for_json.pop('structured_comments', None)
                    data_payload["tribe_payload_json"] = json.dumps(
                        tribe_payload_for_json,
                        ensure_ascii=False,
                        default=lambda o: float(o) if isinstance(o, __import__('decimal').Decimal) else str(o)
                    )
                template_dict['polisAnalysisPrompt']['data'] = {"content": data_payload}
                
                # Add topic name to prompt
                if 'context' in template_dict['polisAnalysisPrompt']:
                    if isinstance(template_dict['polisAnalysisPrompt']['context'], dict):
                        template_dict['polisAnalysisPrompt']['context']['topic_name'] = topic_name
                
                # Add distinction hint for topics that were revised for uniqueness
                if topic.get('distinction_revised') and not (is_global_section or is_tribe_title or is_tribe_consensus or is_tribe_characteristics):
                    sibling_names = [
                        t['name'] for t in topics
                        if t.get('section_type') == 'topic'
                        and t.get('layer_id') == topic.get('layer_id')
                        and t.get('topic_key') != topic_key
                    ]
                    original_name = topic.get('original_topic_name', '')
                    prefix_match = re.match(r'^\d+_\d+:\s*', original_name)
                    clean_original = original_name[prefix_match.end():] if prefix_match else original_name
                    
                    distinction_hint = (
                        f"IMPORTANT DISTINCTION: This topic was originally named '{clean_original}' "
                        f"but was renamed to '{topic_name}' to ensure it is clearly distinct from "
                        f"sibling topics at the same level: {', '.join(sibling_names)}. "
                        f"Focus your analysis on what makes THIS topic's perspective unique and "
                        f"different from those sibling topics. Avoid overlapping with their content."
                    )
                    
                    if isinstance(template_dict['polisAnalysisPrompt'].get('context'), dict):
                        template_dict['polisAnalysisPrompt']['context']['distinction_hint'] = distinction_hint
                    logger.info(f"Added distinction hint for revised topic '{topic_name}' (originally '{clean_original}')")

                # Convert back to XML
                prompt_xml = xmltodict.unparse(template_dict, pretty=True)
                
                # Add model prompt formatting
                if is_tribe_title or is_tribe_consensus or is_tribe_characteristics or is_global_section:
                    # Tribe templates fully define the output format; avoid adding topic-only JSON constraints.
                    model_prompt = prompt_xml
                else:
                    model_prompt = f"""
                        {prompt_xml}

                        You MUST respond with a JSON object that follows this EXACT structure for topic analysis. 
                        IMPORTANT: Do NOT simply repeat the comments verbatim. Instead, analyze the underlying themes, values,
                        and perspectives reflected in the comments. Identify patterns in how different groups view the topic.

                        ```json
                        {{
                        \"id\": \"topic_overview_and_consensus\",
                        \"title\": \"Overview of Topic and Consensus\",
                        \"paragraphs\": [
                            {{
                            \"id\": \"topic_overview\",
                            \"title\": \"Overview of Topic\",
                            \"sentences\": [
                                {{
                                \"clauses\": [
                                    {{
                                    \"text\": \"This topic reveals patterns of participant views on economic development, community identity, and resource priorities.\",
                                    \"citations\": [190, 191, 1142]
                                    }},
                                    {{
                                    \"text\": \"Analysis of what the comments reveal about underlying values and priorities in the community.\",
                                    \"citations\": [1245, 1256]
                                    }}
                                ]
                                }}
                            ]
                            }},
                            {{
                            \"id\": \"topic_by_groups\",
                            \"title\": \"Group Perspectives on Topic\",
                            \"sentences\": [
                                {{
                                \"clauses\": [
                                    {{
                                    \"text\": \"Comparison of how different groups approached this topic, with analysis of the values that drive their different perspectives.\",
                                    \"citations\": [190, 191]
                                    }}
                                ]
                                }}
                            ]
                            }}
                        ]
                        }}
                        ```

                        Make sure the JSON is VALID, as defined at https://www.json.org/json-en.html:
                        - Begin with object '{{' and end with '}}'
                        - All keys MUST be enclosed in double quotes
                        - NO trailing commas should be included after the last element in any array or object
                        - Do NOT include any additional text outside of the JSON object
                        - Do not provide explanations, only the JSON
                        - Use the exact structure shown above with \"id\", \"title\", \"paragraphs\", etc.
                        - Include relevant citations to comment IDs in the data
                    """
                
                # Add to batch requests
                max_tokens = 4000
                if is_tribe_title:
                    max_tokens = 200
                elif is_tribe_consensus:
                    max_tokens = 4000
                elif is_tribe_characteristics:
                    max_tokens = 4000

                batch_request = {
                    "system": system_lore,
                    "messages": [
                        {"role": "user", "content": model_prompt}
                    ],
                    "max_tokens": max_tokens,
                    "metadata": {
                        "topic_name": topic_name,
                        "topic_key": topic_key,
                        "cluster_id": topic_cluster_id,
                        "layer_id": topic_layer_id,
                        "section_name": section_name,
                        "section_type": section_type,
                        "group_id": topic.get('group_id'),
                        "conversation_id": self.conversation_id
                    }
                }
                
                batch_requests.append(batch_request)
                
            except Exception as e:
                logger.error(f"Error preparing prompt for topic {topic_name}: {str(e)}")
                import traceback
                logger.error(traceback.format_exc())
                continue
        
        logger.info(f"Prepared {len(batch_requests)} batch requests")
        return batch_requests
    
    async def process_request(self, request):
        """Process a single topic report request."""
        try:
            # Extract metadata
            metadata = request.get('metadata', {})
            topic_name = metadata.get('topic_name', 'Unknown Topic')
            section_name = metadata.get('section_name', f"topic_{topic_name.lower().replace(' ', '_')}")

            logger.info(f"Processing request for topic: {topic_name}")

            # Create Anthropic provider
            anthropic_provider = get_model_provider("anthropic", self.model)

            # Get response from LLM
            response = await anthropic_provider.get_completion(
                system=request.get('system', ''),
                prompt=request.get('messages', [])[0].get('content', ''),
                max_tokens=request.get('max_tokens', 4000)
            )

            # Log response for debugging
            logger.info(f"Received response from LLM for topic {topic_name}")

            # Extract content from the response
            content = response.get('content', '{}')

            # Store the result in NarrativeReports table
            if self.report_id:
                self.report_storage.store_report(
                    report_id=self.report_id,
                    section=section_name,
                    model=self.model,
                    report_data=content,
                    job_id=self.job_id,
                    metadata={
                        'topic_name': topic_name,
                        'cluster_id': metadata.get('cluster_id')
                    }
                )
                logger.info(f"Stored report for section {section_name}")
            else:
                logger.warning(f"No report_id available, skipping storage for {section_name}")

            return {
                'topic_name': topic_name,
                'section_name': section_name,
                'response': response
            }
        except Exception as e:
            logger.error(f"Error processing request for topic {request.get('metadata', {}).get('topic_name', 'unknown')}: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return None

    async def _submit_sequential(self, provider_type: str, model_name: str, batch_requests: list) -> bool:
        """
        Process batch requests sequentially for providers without a Batch API.
        Stores results directly in DynamoDB via NarrativeReportService.
        Returns True on success, False on failure.
        """
        from umap_narrative.llm_factory_constructor.model_provider import get_model_provider

        logger.info(f"Starting sequential processing with {provider_type}/{model_name} for {len(batch_requests)} requests")

        try:
            provider = get_model_provider(provider_type=provider_type, model_name=model_name)
        except Exception as e:
            logger.error(f"Failed to initialize {provider_type} provider: {e}")
            return False

        success_count = 0
        fail_count = 0

        for i, request in enumerate(batch_requests):
            try:
                system_content = request.get('system', '')
                user_content = ''
                if 'messages' in request and len(request.get('messages', [])) > 0:
                    user_content = request.get('messages', [])[0].get('content', '')

                if not user_content:
                    logger.warning(f"Empty user prompt for request {i}, skipping")
                    continue

                response = provider.get_response(system_content, user_content)

                # Extract metadata from the request
                metadata = request.get('metadata', {})
                section_name = metadata.get('section_name', f'unknown_section_{i}')
                topic_name = metadata.get('topic_name', 'unknown_topic')

                # Store result in DynamoDB using NarrativeReportService
                if self.report_id:
                    self.report_storage.store_report(
                        report_id=self.report_id,
                        section=section_name,
                        model=model_name,
                        report_data=response,
                        job_id=self.job_id,
                        metadata={
                            'section_name': section_name,
                            'topic_name': topic_name,
                            'conversation_id': self.conversation_id,
                            'cluster_id': str(metadata.get('cluster_id', '')),
                            'provider': provider_type,
                            'model': model_name,
                        }
                    )
                    success_count += 1
                else:
                    logger.warning(f"No report_id available, skipping storage for {section_name}")
                    success_count += 1  # Still count as success — response was received

                if success_count % 10 == 0:
                    logger.info(f"Sequential progress: {success_count}/{len(batch_requests)}")

            except Exception as e:
                fail_count += 1
                logger.error(f"Sequential request {i} failed: {e}")
                # Continue with next request — don't abort entire batch

        logger.info(f"Sequential processing complete: {success_count} succeeded, {fail_count} failed")
        return fail_count == 0  # True only if ALL succeeded

    async def submit_batch(self):
        """Prepare and process a batch of topic report requests with provider cascading."""
        logger.info(f"=== Starting batch submission with provider={self.provider} ===")

        # Prepare batch requests (provider-agnostic)
        try:
            batch_requests = await self.prepare_batch_requests()
            if not batch_requests:
                logger.error("No batch requests to submit")
                return None
            logger.info(f"Successfully prepared {len(batch_requests)} batch requests")
        except Exception as e:
            logger.error(f"Critical error during batch request preparation: {str(e)}")
            return None

        # Build provider cascade: primary → backup → fallback
        tiers = []
        if self.provider and self.model:
            tiers.append((self.provider, self.model))
        if self.backup_provider and self.backup_model:
            tiers.append((self.backup_provider, self.backup_model))
        if self.fallback_provider and self.fallback_model:
            tiers.append((self.fallback_provider, self.fallback_model))

        if not tiers:
            logger.error("No provider/model tiers configured")
            return None

        # Try each tier
        for prov, mod in tiers:
            logger.info(f"Trying provider tier: {prov}/{mod}")
            try:
                if prov == "anthropic":
                    result = await self._submit_anthropic_batch(mod, batch_requests)
                else:
                    result = await self._submit_sequential(prov, mod, batch_requests)

                if result:
                    logger.info(f"Provider tier {prov}/{mod} succeeded")
                    return result
                else:
                    logger.warning(f"Provider tier {prov}/{mod} returned failure, trying next tier")
                    continue
            except Exception as e:
                logger.error(f"Provider tier {prov}/{mod} threw exception: {e}")
                logger.error(traceback.format_exc())
                continue

        logger.error(f"All provider tiers failed: {tiers}")
        return None

    async def _submit_anthropic_batch(self, model_name, batch_requests):
        """Submit batch requests to Anthropic's Batch API."""
        # Log job information
        logger.info(f"Processing batch of {len(batch_requests)} requests for conversation {self.conversation_id}")
        if self.job_id:
            logger.info(f"Job ID: {self.job_id}")
        if self.report_id:
            logger.info(f"Report ID: {self.report_id}")

        # Validate API key presence
        anthropic_api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not anthropic_api_key:
            logger.error("ERROR: ANTHROPIC_API_KEY environment variable is not set. Cannot submit batch.")
            if self.job_id:
                try:
                    job_table = self.dynamodb.Table('Delphi_JobQueue')
                    job_table.update_item(
                        Key={'job_id': self.job_id},
                        UpdateExpression="SET #s = :status, error_message = :error",
                        ExpressionAttributeNames={'#s': 'status'},
                        ExpressionAttributeValues={
                            ':status': 'FAILED',
                            ':error': 'Missing ANTHROPIC_API_KEY environment variable'
                        }
                    )
                    logger.info(f"Updated job {self.job_id} status to FAILED due to missing API key")
                except Exception as e:
                    logger.error(f"Failed to update job status: {str(e)}")
            return None

        # Main try block for API interaction
        try:
            # Import Anthropic SDK
            logger.info("Importing Anthropic SDK...")
            try:
                from anthropic import Anthropic, APIError, APIConnectionError, APIResponseValidationError, APIStatusError
                logger.info("Successfully imported Anthropic SDK")
            except ImportError as e:
                logger.error(f"Failed to import Anthropic SDK: {str(e)}")
                logger.error(f"System paths: {sys.path}")
                logger.error("Attempting to install Anthropic SDK...")
                try:
                    import subprocess
                    subprocess.check_call([sys.executable, "-m", "pip", "install", "anthropic"])
                    from anthropic import Anthropic, APIError, APIConnectionError, APIResponseValidationError, APIStatusError
                    logger.info("Successfully installed and imported Anthropic SDK")
                except Exception as e:
                    logger.error(f"Failed to install Anthropic SDK: {str(e)}")
                    logger.error(traceback.format_exc())
                    return None

            # Initialize Anthropic client
            logger.info("Initializing Anthropic client...")
            try:
                anthropic = Anthropic(api_key=anthropic_api_key)
                logger.info("Successfully initialized Anthropic client")
            except Exception as e:
                logger.error(f"Failed to initialize Anthropic client: {str(e)}")
                logger.error(traceback.format_exc())
                return None

            # Format requests for Anthropic Batch API
            logger.info("Formatting batch requests for Anthropic API...")
            formatted_batch_requests = []

            try:
                for i, request in enumerate(batch_requests):
                    # Extract metadata for custom_id
                    metadata = request.get('metadata', {})
                    section_name = metadata.get('section_name', 'unknown_section')

                    # Create a valid custom_id (only allow a-zA-Z0-9_-)
                    # For versioned section names, shorten the job_id portion to avoid long custom_ids
                    if self.job_id and self.job_id in section_name:
                        # Replace the full job_id with just the first 8 characters
                        short_job_id = self.job_id[:8]
                        shortened_section = section_name.replace(self.job_id, short_job_id)
                        custom_id = f"{self.conversation_id}_{shortened_section}"
                    else:
                        # Legacy format or no job_id in section name
                        custom_id = f"{self.conversation_id}_{section_name}"

                    safe_custom_id = re.sub(r'[^a-zA-Z0-9_-]', '_', custom_id)

                    # Debug logging to trace the custom_id construction
                    logger.info(f"Custom ID construction: conversation_id={self.conversation_id}, section_name='{section_name}', custom_id='{custom_id}', safe_custom_id='{safe_custom_id}'")

                    # Validate custom_id length (max 64 chars for Anthropic API)
                    if len(safe_custom_id) > 64:
                        safe_custom_id = safe_custom_id[:64]
                        logger.warning(f"Truncated custom_id to 64 chars: {safe_custom_id}")

                    # Make sure we have system and user messages
                    system_content = request.get('system', '')
                    if not system_content:
                        logger.warning(f"Empty system prompt for request {i}, using default")
                        system_content = "You are a helpful AI assistant analyzing survey data."

                    user_content = ''
                    if 'messages' in request and len(request.get('messages', [])) > 0:
                        user_content = request.get('messages', [])[0].get('content', '')

                    if not user_content:
                        logger.warning(f"Empty user prompt for request {i}, skipping")
                        continue

                    # Create a proper user message format following working example
                    user_message = {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": user_content
                            }
                        ]
                    }

                    # Format request for Anthropic Batch API following working example
                    formatted_request = {
                        "custom_id": safe_custom_id,
                        "params": {
                            "model": model_name,
                            "max_tokens": request.get('max_tokens', 4000),
                            "system": system_content,
                            "messages": [user_message]
                        }
                    }

                    formatted_batch_requests.append(formatted_request)

                logger.info(f"Successfully formatted {len(formatted_batch_requests)} batch requests")

                # Debug: log the first request structure (without full content)
                if formatted_batch_requests:
                    # CRITICAL BUG FIX: Must use deepcopy here!
                    # Using shallow copy causes the debug truncation to modify the actual request sent to Anthropic
                    # This was causing the first batch item to fail with "Report data is not in the expected JSON format"
                    import copy
                    debug_request = copy.deepcopy(formatted_batch_requests[0])
                    if 'params' in debug_request:
                        # Truncate system content
                        if 'system' in debug_request['params'] and isinstance(debug_request['params']['system'], str) and len(debug_request['params']['system']) > 100:
                            debug_request['params']['system'] = debug_request['params']['system'][:100] + "... [content truncated for log]"

                        # Truncate message content
                        if 'messages' in debug_request['params']:
                            for msg in debug_request['params']['messages']:
                                if 'content' in msg and isinstance(msg['content'], list):
                                    for content_item in msg['content']:
                                        if 'text' in content_item and isinstance(content_item['text'], str) and len(content_item['text']) > 100:
                                            content_item['text'] = content_item['text'][:100] + "... [content truncated for log]"

                    logger.info(f"Sample batch request structure: {json.dumps(debug_request, indent=2)}")
                    logger.info(f"Using format that matches working example from other project")

            except Exception as e:
                logger.error(f"Error formatting batch requests: {str(e)}")
                logger.error(traceback.format_exc())
                return None

            if not formatted_batch_requests:
                logger.error("No valid formatted batch requests to submit")
                return None

            logger.info(f"Submitting {len(formatted_batch_requests)} requests to Anthropic Batch API")

            # Submit the batch to Anthropic with detailed error handling
            try:
                batch = anthropic.beta.messages.batches.create(requests=formatted_batch_requests)
                logger.info("Successfully submitted batch to Anthropic API")
                logger.info(f"Batch ID: {batch.id}")
                logger.info(f"Batch status: {batch.processing_status}")
                logger.info(f"FULL BATCH OBJECT: {batch}")
            except APIStatusError as e:
                logger.error(f"Anthropic API Status Error: {str(e)}")
                logger.error(f"Status: {e.status_code}")
                logger.error(f"Response: {e.response}")
                return None
            except APIConnectionError as e:
                logger.error(f"Anthropic API Connection Error: {str(e)}")
                return None
            except APIResponseValidationError as e:
                logger.error(f"Anthropic API Response Validation Error: {str(e)}")
                logger.error(f"Response: {e.response}")
                return None
            except APIError as e:
                logger.error(f"Anthropic API Error: {str(e)}")
                return None
            except Exception as e:
                logger.error(f"Unexpected error submitting batch to Anthropic API: {str(e)}")
                logger.error(traceback.format_exc())
                return None

            # Store batch information in DynamoDB if we have a job ID
            if self.job_id:
                logger.info(f"Updating job {self.job_id} with batch information in DynamoDB...")
                try:
                    job_table = self.dynamodb.Table('Delphi_JobQueue')

                    # Check if the table exists
                    try:
                        job_table.table_status
                        logger.info("Successfully connected to Delphi_JobQueue table")
                    except Exception as e:
                        logger.error(f"Failed to connect to Delphi_JobQueue table: {str(e)}")
                        logger.error("Available tables:")
                        try:
                            tables = list(dynamodb.tables.all())
                            for table in tables:
                                logger.info(f"- {table.name}")
                        except Exception as e:
                            logger.error(f"Failed to list tables: {str(e)}")
                        return batch.id  # Still return batch ID even if we can't update DynamoDB

                    # Simplify the update - just focus on getting batch_id stored
                    batch_id_str = str(batch.id)  # Convert to string to ensure compatibility
                    logger.info(f"Attempting to store batch_id as string: {batch_id_str}")

                    # Update the job with batch information - fixed version with ExpressionAttributeNames
                    update_response = job_table.update_item(
                        Key={'job_id': self.job_id},
                        UpdateExpression="SET batch_id = :batch_id, #s = :job_status, model = :model",
                        ExpressionAttributeNames={
                            '#s': 'status'  # Use ExpressionAttributeNames to avoid 'status' reserved keyword
                        },
                        ExpressionAttributeValues={
                            ':batch_id': batch_id_str,
                            ':job_status': 'PROCESSING',  # Set job status to PROCESSING so poller knows to check batch status
                            ':model': model_name  # Store the model name
                        },
                        ReturnValues="UPDATED_NEW"
                    )

                    # Verify update took effect
                    verify_job = job_table.get_item(Key={'job_id': self.job_id})
                    if 'Item' in verify_job:
                        job_item = verify_job['Item']
                        if 'batch_id' in job_item:
                            logger.info(f"VERIFICATION SUCCESS: batch_id found in job record: {job_item['batch_id']}")
                        else:
                            logger.error(f"VERIFICATION FAILED: batch_id not found in job record!")
                            logger.error(f"Job fields: {list(job_item.keys())}")
                    else:
                        logger.error(f"Could not verify update - job not found!")

                    logger.info(f"Successfully updated job {self.job_id} with batch information")
                    logger.info(f"Batch ID: {batch.id} stored in job record")
                    logger.info(f"DynamoDB update response: {update_response}")
                    logger.info(f"Job is now in PROCESSING state - poller will run batch status checks")

                    # Schedule a batch status check job to run in 60 seconds
                    try:
                        # Create a new job for checking batch status
                        status_check_job_id = f"batch_check_{self.job_id}_{int(time.time())}"

                        # Current timestamp
                        now = datetime.now().isoformat()

                        # Create the status check job with the new job type
                        status_job = {
                            'job_id': status_check_job_id,
                            'status': 'PENDING',
                            'job_type': 'AWAITING_NARRATIVE_BATCH',  # New job type for clearer state machine
                            'batch_job_id': self.job_id,
                            'batch_id': batch.id,
                            'conversation_id': self.conversation_id,
                            'report_id': self.report_id,
                            'created_at': now,
                            'updated_at': now,
                            'priority': 50,  # Medium priority
                            'version': 1,
                            'logs': json.dumps({'entries': []})
                        }

                        # Put the job in the queue
                        job_table.put_item(Item=status_job)

                        logger.info(f"Scheduled batch status check job {status_check_job_id} to run in 60 seconds")
                    except Exception as e:
                        logger.error(f"Failed to schedule batch status check job: {str(e)}")
                        logger.error(traceback.format_exc())
                        # Continue despite failure
                        logger.info("Continuing despite failure to schedule status check job")

                except Exception as e:
                    logger.error(f"Failed to update job with batch information: {str(e)}")
                    logger.error(traceback.format_exc())
                    # Continue despite DynamoDB update failure
                    logger.info("Continuing despite DynamoDB update failure")

            logger.info("=== Batch submission completed successfully ===")
            return batch.id

        except Exception as e:
            logger.error(f"Unhandled error in _submit_anthropic_batch: {str(e)}")
            logger.error(traceback.format_exc())

            # Try to update job status in DynamoDB
            if self.job_id:
                try:
                    job_table = self.dynamodb.Table('Delphi_JobQueue')
                    job_table.update_item(
                        Key={'job_id': self.job_id},
                        UpdateExpression="SET #s = :status, error_message = :error",
                        ExpressionAttributeNames={'#s': 'status'},
                        ExpressionAttributeValues={
                            ':status': 'FAILED',
                            ':error': f"Error in batch submission: {str(e)}"
                        }
                    )
                    logger.info(f"Updated job {self.job_id} status to FAILED due to error")
                except Exception as update_error:
                    logger.error(f"Failed to update job status after error: {str(update_error)}")

            return None

async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Generate narrative reports for Polis conversations')
    parser.add_argument('--conversation_id', '--zid', type=str, required=True,
                        help='Conversation ID to process')
    parser.add_argument('--model', type=str, default=None,
                        help='LLM model to use (defaults to ANTHROPIC_MODEL env var)')
    parser.add_argument('--provider', type=str, default=None,
                        help='LLM provider (anthropic, openai, deepseek, google). Defaults to anthropic.')
    parser.add_argument('--backup-model', type=str, default=None,
                        help='Backup model if primary fails')
    parser.add_argument('--backup-provider', type=str, default=None,
                        help='Backup provider if primary fails')
    parser.add_argument('--fallback-model', type=str, default=None,
                        help='Fallback model if backup also fails')
    parser.add_argument('--fallback-provider', type=str, default=None,
                        help='Fallback provider if backup also fails')
    parser.add_argument('--no-cache', action='store_true',
                        help='Ignore cached report data')
    parser.add_argument('--max-batch-size', type=int, default=5,
                        help='Maximum number of topics to include in a single batch (default: 5)')
    parser.add_argument('--layers', type=int, nargs='+', default=None,
                        help='Specific layer numbers to process (e.g., --layers 0 1 2). If not specified, all layers will be processed.')
    parser.add_argument('--include_moderation', action='store_true',
                        help='Include moderated comments in reports (flag: present=True, absent=False).')
    args = parser.parse_args()

    # Get environment variables for job
    job_id = os.environ.get('DELPHI_JOB_ID')
    report_id = os.environ.get('DELPHI_REPORT_ID')

    # Set up environment variables for database connections
    os.environ.setdefault('DATABASE_HOST', 'host.docker.internal')
    os.environ.setdefault('DATABASE_PORT', '5432')
    os.environ.setdefault('DATABASE_NAME', 'polisDB_prod_local_mar14')
    os.environ.setdefault('DATABASE_USER', 'postgres')
    os.environ.setdefault('DATABASE_PASSWORD', '')

    # Print database connection info
    logger.info(f"Database connection info:")
    logger.info(f"- HOST: {os.environ.get('DATABASE_HOST')}")
    logger.info(f"- PORT: {os.environ.get('DATABASE_PORT')}")
    logger.info(f"- DATABASE: {os.environ.get('DATABASE_NAME')}")
    logger.info(f"- USER: {os.environ.get('DATABASE_USER')}")

    # Print execution summary
    logger.info(f"Running narrative report generator with the following settings:")
    logger.info(f"- Conversation ID: {args.conversation_id}")
    logger.info(f"- Model: {args.model}")
    logger.info(f"- Cache: {'disabled' if args.no_cache else 'enabled'}")
    logger.info(f"- Max batch size: {args.max_batch_size}")
    if args.layers:
        logger.info(f"- Layers to process: {args.layers}")
    else:
        logger.info(f"- Layers to process: all available layers")
    if job_id:
        logger.info(f"- Job ID: {job_id}")
    if report_id:
        logger.info(f"- Report ID: {report_id}")

    # Create batch report generator
    generator = BatchReportGenerator(
        conversation_id=args.conversation_id,
        model=args.model,
        provider=args.provider,
        backup_model=args.backup_model,
        backup_provider=args.backup_provider,
        fallback_model=args.fallback_model,
        fallback_provider=args.fallback_provider,
        no_cache=args.no_cache,
        max_batch_size=args.max_batch_size,
        job_id=job_id,
        layers=args.layers,
        include_moderation=args.include_moderation
    )

    # Process reports
    result = await generator.submit_batch()

    if result:
        logger.info(f"Narrative reports generated successfully")
        print(f"Narrative reports generated successfully")
        if job_id:
            print(f"Job ID: {job_id}")
        if report_id:
            print(f"Reports stored for report_id: {report_id}")
    else:
        logger.error(f"Failed to generate narrative reports")
        print(f"Failed to generate narrative reports. See logs for details.")
        # Exit with error code
        sys.exit(1)

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())