#!/usr/bin/env python3
"""Compute and store topic hierarchy with propagation.

This script runs after hierarchical clustering + topic naming.
It computes parent-child relationships between hierarchical cluster layers and
writes a normalized hierarchy to DynamoDB (Delphi_TopicHierarchy), including
"propagated" topics for non-branching nodes so deeper layers have monotonic
(or increasing) topic counts.

Tables:
- Read:  Delphi_CommentHierarchicalClusterAssignments
- Read:  Delphi_CommentClustersLLMTopicNames
- Write: Delphi_TopicHierarchy

Key format (range key): "{job_id}#layer#{layer_id}#topic#{topic_key}"

CLI:
  python 751_topic_hierarchy.py --conversation_id 123 --job_id abc --report_id 456
"""

from __future__ import annotations

import argparse
import logging
import os
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import boto3
from boto3.dynamodb.conditions import Key

from polismath_commentgraph.utils.converter import DataConverter
from polismath_commentgraph.utils.storage import PostgresClient

logger = logging.getLogger(__name__)


PURITY_THRESHOLD = 0.70


@dataclass(frozen=True)
class ParentResult:
    parent_cluster_id: Optional[str]
    purity: float
    is_tie: bool
    is_ambiguous: bool
    parent_counts: Dict[str, int]


def _now_iso() -> str:
    return datetime.now().isoformat()


def _as_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    return str(value)


def _query_all_by_conversation_id(table, conversation_id: str) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    last_key = None

    while True:
        query_kwargs: Dict[str, Any] = {
            "KeyConditionExpression": Key("conversation_id").eq(str(conversation_id)),
        }
        if last_key:
            query_kwargs["ExclusiveStartKey"] = last_key

        response = table.query(**query_kwargs)
        items.extend(response.get("Items", []))

        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break

    return items


def load_comment_cluster_assignments(dynamodb, conversation_id: str) -> Tuple[Dict[str, Dict[int, str]], Set[int]]:
    """Load per-comment hierarchical cluster assignments from DynamoDB.

    Returns:
      - comment_to_layers: {comment_id_str: {layer_id: cluster_id_str}}
      - available_layers: set[int]
    """
    table = dynamodb.Table("Delphi_CommentHierarchicalClusterAssignments")
    items = _query_all_by_conversation_id(table, conversation_id)

    comment_to_layers: Dict[str, Dict[int, str]] = {}
    available_layers: Set[int] = set()

    for item in items:
        comment_id = item.get("comment_id")
        if comment_id is None:
            continue
        comment_id_str = str(comment_id)

        layer_map: Dict[int, str] = {}
        for key, value in item.items():
            if not (isinstance(key, str) and key.startswith("layer") and key.endswith("_cluster_id")):
                continue
            if value is None:
                continue

            layer_num_str = key.replace("layer", "").replace("_cluster_id", "")
            try:
                layer_id = int(layer_num_str)
            except ValueError:
                continue

            cluster_id_str = str(value)
            layer_map[layer_id] = cluster_id_str
            available_layers.add(layer_id)

        if layer_map:
            comment_to_layers[comment_id_str] = layer_map

    logger.info(
        "Loaded %s comment assignments across layers=%s",
        len(comment_to_layers),
        sorted(available_layers),
    )
    return comment_to_layers, available_layers


def load_topic_names(dynamodb, conversation_id: str) -> Dict[Tuple[int, str], Dict[str, Any]]:
    """Load topic names keyed by (layer_id, cluster_id_str).

    If multiple entries exist for the same (layer_id, cluster_id), the most
    recently created one (created_at max) is kept.
    """
    table = dynamodb.Table("Delphi_CommentClustersLLMTopicNames")
    items = _query_all_by_conversation_id(table, conversation_id)

    by_cluster: Dict[Tuple[int, str], Dict[str, Any]] = {}
    duplicates = 0

    for item in items:
        try:
            layer_id = int(item.get("layer_id"))
        except Exception:
            continue

        cluster_id_str = _as_str(item.get("cluster_id"))
        if not cluster_id_str:
            continue

        key = (layer_id, cluster_id_str)
        created_at = str(item.get("created_at", ""))

        if key in by_cluster:
            existing_created_at = str(by_cluster[key].get("created_at", ""))
            if created_at > existing_created_at:
                by_cluster[key] = item
            duplicates += 1
        else:
            by_cluster[key] = item

    logger.info(
        "Loaded %s topic name entries (deduped=%s, duplicates_seen=%s)",
        len(items),
        len(by_cluster),
        duplicates,
    )
    return by_cluster


def _topic_key_for(layer_id: int, cluster_id_str: str, topic_names: Dict[Tuple[int, str], Dict[str, Any]]) -> str:
    item = topic_names.get((layer_id, cluster_id_str))
    if item and item.get("topic_key"):
        return str(item["topic_key"])
    return f"layer{layer_id}_{cluster_id_str}"


def _topic_name_for(layer_id: int, cluster_id_str: str, topic_names: Dict[Tuple[int, str], Dict[str, Any]]) -> str:
    item = topic_names.get((layer_id, cluster_id_str))
    if item and item.get("topic_name"):
        return str(item["topic_name"])
    return f"Topic {cluster_id_str}"


def compute_parent_for_cluster(
    layer_id: int,
    cluster_id_str: str,
    comment_to_layers: Dict[str, Dict[int, str]],
) -> ParentResult:
    """Compute mode parent cluster for a given (layer_id, cluster_id).

    Ambiguous if:
      - purity < 70%, OR
      - there is a tie for most common parent
    """
    if layer_id <= 0:
        return ParentResult(
            parent_cluster_id=None,
            purity=1.0,
            is_tie=False,
            is_ambiguous=False,
            parent_counts={},
        )

    parent_layer_id = layer_id - 1
    counts: Counter[str] = Counter()
    total = 0

    for _comment_id, layers in comment_to_layers.items():
        if layers.get(layer_id) != cluster_id_str:
            continue
        total += 1
        parent_cluster_id = layers.get(parent_layer_id)
        if parent_cluster_id is not None:
            counts[str(parent_cluster_id)] += 1

    if total == 0 or not counts:
        return ParentResult(
            parent_cluster_id=None,
            purity=0.0,
            is_tie=False,
            is_ambiguous=True,
            parent_counts=dict(counts),
        )

    most_common = counts.most_common()
    parent_cluster_id, top_count = most_common[0]

    is_tie = False
    if len(most_common) > 1 and most_common[1][1] == top_count:
        is_tie = True

    purity = top_count / float(total)
    is_ambiguous = is_tie or purity < PURITY_THRESHOLD

    return ParentResult(
        parent_cluster_id=parent_cluster_id,
        purity=purity,
        is_tie=is_tie,
        is_ambiguous=is_ambiguous,
        parent_counts=dict(counts),
    )


def compute_comment_counts_by_cluster(
    comment_to_layers: Dict[str, Dict[int, str]],
    layers: Iterable[int],
) -> Dict[Tuple[int, str], int]:
    counts: Dict[Tuple[int, str], int] = defaultdict(int)

    for _comment_id, layer_map in comment_to_layers.items():
        for layer_id in layers:
            cluster_id_str = layer_map.get(layer_id)
            if cluster_id_str is None:
                continue
            counts[(layer_id, str(cluster_id_str))] += 1

    return dict(counts)


def build_base_topics(
    topic_names: Dict[Tuple[int, str], Dict[str, Any]],
    comment_counts: Dict[Tuple[int, str], int],
    comment_to_layers: Dict[str, Dict[int, str]],
    layers: List[int],
) -> List[Dict[str, Any]]:
    topics: List[Dict[str, Any]] = []

    clusters_by_layer: Dict[int, Set[str]] = defaultdict(set)
    for (layer_id, cluster_id_str) in topic_names.keys():
        clusters_by_layer[layer_id].add(cluster_id_str)

    # Fall back to clusters observed in assignments if topic names are missing
    for (layer_id, cluster_id_str), _count in comment_counts.items():
        clusters_by_layer[layer_id].add(cluster_id_str)

    for layer_id in layers:
        for cluster_id_str in sorted(clusters_by_layer.get(layer_id, set()), key=lambda x: int(x) if x.isdigit() else x):
            topic_key = _topic_key_for(layer_id, cluster_id_str, topic_names)
            topic_name = _topic_name_for(layer_id, cluster_id_str, topic_names)
            comment_count = int(comment_counts.get((layer_id, cluster_id_str), 0))

            parent_result = compute_parent_for_cluster(layer_id, cluster_id_str, comment_to_layers)
            parent_cluster_id_str = parent_result.parent_cluster_id
            parent_topic_key: Optional[str] = None
            if layer_id > 0 and parent_cluster_id_str is not None:
                parent_topic_key = _topic_key_for(layer_id - 1, parent_cluster_id_str, topic_names)

            topics.append(
                {
                    "layer_id": int(layer_id),
                    "cluster_id": cluster_id_str,
                    "topic_key": topic_key,
                    "topic_name": topic_name,
                    "comment_count": comment_count,
                    "parent_layer_id": (layer_id - 1) if layer_id > 0 else None,
                    "parent_cluster_id": parent_cluster_id_str if layer_id > 0 else None,
                    "parent_topic_key": parent_topic_key,
                    "parent_purity": parent_result.purity if layer_id > 0 else 1.0,
                    "parent_is_tie": parent_result.is_tie if layer_id > 0 else False,
                    "is_ambiguous": parent_result.is_ambiguous if layer_id > 0 else False,
                    "parent_counts": parent_result.parent_counts if layer_id > 0 else {},
                    "is_propagated": False,
                    "source_topic_key": None,
                    "source_layer_id": None,
                }
            )

    return topics


def compute_child_counts(base_topics: List[Dict[str, Any]]) -> Dict[Tuple[int, str], int]:
    """Return child_count for each (layer_id, topic_key) based on adjacent-layer parent_topic_key."""

    topics_by_layer: Dict[int, Dict[str, Dict[str, Any]]] = defaultdict(dict)
    for t in base_topics:
        topics_by_layer[int(t["layer_id"])][str(t["topic_key"])] = t

    child_sets: Dict[Tuple[int, str], Set[str]] = defaultdict(set)

    for child in base_topics:
        child_layer = int(child["layer_id"])
        parent_topic_key = child.get("parent_topic_key")
        parent_layer_id = child.get("parent_layer_id")

        if parent_topic_key is None or parent_layer_id is None:
            continue

        parent_layer_id_int = int(parent_layer_id)
        if parent_layer_id_int != child_layer - 1:
            continue

        if str(parent_topic_key) not in topics_by_layer.get(parent_layer_id_int, {}):
            continue

        child_sets[(parent_layer_id_int, str(parent_topic_key))].add(str(child["topic_key"]))

    child_counts: Dict[Tuple[int, str], int] = {}
    for layer_id, topics_map in topics_by_layer.items():
        for topic_key in topics_map.keys():
            child_counts[(layer_id, topic_key)] = len(child_sets.get((layer_id, topic_key), set()))

    return child_counts


def add_propagated_topics(
    topics: List[Dict[str, Any]],
    max_layer: int,
) -> List[Dict[str, Any]]:
    """Add propagated topics for any topic with <=1 child at the next layer.

    Propagated topic has:
      - layer_id = L+1
      - topic_name same as source topic
      - parent_topic_key points to source's parent (grandparent)

    Note: parent pointer intentionally can skip a layer to avoid making the source
    topic look like it branched.
    """

    # Index for uniqueness checks: (layer_id, topic_key)
    existing: Set[Tuple[int, str]] = {(int(t["layer_id"]), str(t["topic_key"])) for t in topics}

    # Compute child counts on the current set (initially base topics)
    child_counts = compute_child_counts(topics)
    for t in topics:
        t["child_count"] = int(child_counts.get((int(t["layer_id"]), str(t["topic_key"])), 0))

    # Iterate layers in order to allow cascading propagation across multiple depths.
    for layer_id in range(0, max_layer):
        new_propagated: List[Dict[str, Any]] = []
        layer_topics = [t for t in topics if int(t["layer_id"]) == layer_id]
        for t in layer_topics:
            child_count = int(t.get("child_count", 0))
            if child_count > 1:
                continue

            target_layer = layer_id + 1
            new_topic_key = f"{t['topic_key']}__prop_layer{target_layer}"
            while (target_layer, new_topic_key) in existing:
                new_topic_key = f"{new_topic_key}_x"

            item = {
                "layer_id": target_layer,
                "cluster_id": str(t.get("cluster_id")) if t.get("cluster_id") is not None else None,
                "topic_key": new_topic_key,
                "topic_name": str(t.get("topic_name", "")),
                "comment_count": int(t.get("comment_count", 0)),
                "parent_layer_id": (layer_id - 1) if layer_id > 0 else None,
                "parent_cluster_id": t.get("parent_cluster_id") if layer_id > 0 else None,
                "parent_topic_key": t.get("parent_topic_key"),
                "parent_purity": None,
                "parent_is_tie": None,
                "is_ambiguous": False,
                "parent_counts": {},
                "child_count": 0,
                "is_propagated": True,
                "source_topic_key": str(t.get("topic_key")),
                "source_layer_id": int(t.get("layer_id")),
            }

            existing.add((target_layer, new_topic_key))
            new_propagated.append(item)

        # Extend topics for next iteration, then recompute child counts
        if new_propagated:
            topics.extend(new_propagated)
            child_counts = compute_child_counts(topics)
            for topic in topics:
                topic["child_count"] = int(child_counts.get((int(topic["layer_id"]), str(topic["topic_key"])), 0))

    return topics


def write_topic_hierarchy(
    dynamodb,
    conversation_id: str,
    job_id: str,
    report_id: str,
    topics: List[Dict[str, Any]],
) -> int:
    table = dynamodb.Table("Delphi_TopicHierarchy")
    timestamp = _now_iso()

    written = 0

    with table.batch_writer(overwrite_by_pkeys=["conversation_id", "job_layer_topic"]) as batch:
        for t in topics:
            layer_id = int(t["layer_id"])
            topic_key = str(t["topic_key"])
            job_layer_topic = f"{job_id}#layer#{layer_id}#topic#{topic_key}"

            item: Dict[str, Any] = {
                "conversation_id": str(conversation_id),
                "job_layer_topic": job_layer_topic,
                "job_id": str(job_id),
                "report_id": str(report_id),
                "layer_id": layer_id,
                "topic_key": topic_key,
                "topic_name": str(t.get("topic_name", "")),
                "cluster_id": t.get("cluster_id"),
                "comment_count": int(t.get("comment_count", 0)),
                "child_count": int(t.get("child_count", 0)),
                "parent_topic_key": t.get("parent_topic_key"),
                "parent_cluster_id": t.get("parent_cluster_id"),
                "parent_layer_id": t.get("parent_layer_id"),
                "parent_purity": t.get("parent_purity"),
                "parent_is_tie": t.get("parent_is_tie"),
                "is_ambiguous": bool(t.get("is_ambiguous", False)),
                "is_propagated": bool(t.get("is_propagated", False)),
                "source_topic_key": t.get("source_topic_key"),
                "source_layer_id": t.get("source_layer_id"),
                "created_at": timestamp,
                "updated_at": timestamp,
            }

            # Keep the full parent distribution for debugging / audits.
            parent_counts = t.get("parent_counts")
            if isinstance(parent_counts, dict) and parent_counts:
                item["parent_counts"] = parent_counts

            item = DataConverter.prepare_for_dynamodb(item)
            batch.put_item(Item=item)
            written += 1

    return written


def build_dynamodb_resource():
    endpoint_url = os.environ.get("DYNAMODB_ENDPOINT") or None
    region_name = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"

    return boto3.resource(
        "dynamodb",
        endpoint_url=endpoint_url,
        region_name=region_name,
    )


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compute and store topic hierarchy with propagation")
    parser.add_argument("--conversation_id", required=True, help="Conversation (zid) as int or string")
    parser.add_argument("--job_id", required=True, help="Job id used for versioning and sort key")
    parser.add_argument("--report_id", required=True, help="Report id for linking downstream narrative generation")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

    args = parse_args(argv)
    conversation_id = str(args.conversation_id)
    job_id = str(args.job_id)
    report_id = str(args.report_id)

    postgres_client = PostgresClient()
    dynamodb = build_dynamodb_resource()

    try:
        # Postgres is not the source of truth for cluster assignments/topic names, but we
        # initialize it for consistent pipeline behavior and basic validation.
        try:
            postgres_client.initialize()
            convo = None
            if conversation_id.isdigit():
                convo = postgres_client.get_conversation_by_id(int(conversation_id))
            if convo:
                logger.info("Conversation %s found in Postgres (topic=%s)", conversation_id, convo.get("topic"))
            else:
                logger.info("Conversation %s not found in Postgres (continuing)", conversation_id)
        except Exception as e:
            logger.warning("Postgres validation failed (continuing): %s", e)

        comment_to_layers, available_layers = load_comment_cluster_assignments(dynamodb, conversation_id)
        topic_names = load_topic_names(dynamodb, conversation_id)

        if not available_layers and not topic_names:
            logger.error("No cluster assignments or topic names found for conversation_id=%s", conversation_id)
            return 2

        max_layer = 0
        if available_layers:
            max_layer = max(max_layer, max(available_layers))
        if topic_names:
            max_layer = max(max_layer, max(layer for (layer, _cid) in topic_names.keys()))

        layers = list(range(0, max_layer + 1))
        logger.info("Processing layers=%s (max_layer=%s)", layers, max_layer)

        comment_counts = compute_comment_counts_by_cluster(comment_to_layers, layers)
        base_topics = build_base_topics(topic_names, comment_counts, comment_to_layers, layers)

        # Add propagation to enforce monotonic topic counts by layer.
        all_topics = add_propagated_topics(base_topics, max_layer=max_layer)

        # Final write
        written = write_topic_hierarchy(
            dynamodb=dynamodb,
            conversation_id=conversation_id,
            job_id=job_id,
            report_id=report_id,
            topics=all_topics,
        )

        logger.info(
            "Wrote %s topic hierarchy items to Delphi_TopicHierarchy for conversation_id=%s job_id=%s",
            written,
            conversation_id,
            job_id,
        )
        return 0

    except Exception as e:
        logger.error("Topic hierarchy computation failed: %s", e, exc_info=True)
        return 1

    finally:
        try:
            postgres_client.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
