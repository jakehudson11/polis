#!/usr/bin/env python3
"""Enforce distinction between topic names at each hierarchical layer.

Loads topic names from DynamoDB, computes pairwise cosine similarity using
sentence-transformer embeddings, and sends flagged layers to an LLM for
revision so that topic names within the same level are clearly distinct.

Tables:
- Read/Write: Delphi_CommentClustersLLMTopicNames
- Read:        Delphi_CommentClustersStructureKeywords  (sample comments)

CLI:
  python 752_enforce_topic_distinction.py --conversation_id 123
  python 752_enforce_topic_distinction.py --conversation_id 123 --similarity_threshold 0.8 --dry-run
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import boto3
from boto3.dynamodb.conditions import Key

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from umap_narrative.llm_factory_constructor import get_model_provider

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# DynamoDB helpers
# ---------------------------------------------------------------------------

def _query_all_by_conversation_id(table, conversation_id: str) -> List[Dict[str, Any]]:
    """Paginate through all items for a conversation_id partition key."""
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


def _load_topic_names(
    dynamodb, conversation_id: str,
) -> Dict[Tuple[int, str], Dict[str, Any]]:
    """Load topic names keyed by (layer_id, cluster_id_str).

    Deduplicates by (layer_id, cluster_id), keeping the most recent created_at.
    """
    table = dynamodb.Table("Delphi_CommentClustersLLMTopicNames")
    items = _query_all_by_conversation_id(table, conversation_id)

    by_cluster: Dict[Tuple[int, str], Dict[str, Any]] = {}
    for item in items:
        try:
            layer_id = int(item.get("layer_id"))
        except Exception:
            continue
        cluster_id_str = str(item.get("cluster_id", ""))
        if not cluster_id_str:
            continue

        key = (layer_id, cluster_id_str)
        created_at = str(item.get("created_at", ""))
        if key in by_cluster:
            if created_at > str(by_cluster[key].get("created_at", "")):
                by_cluster[key] = item
        else:
            by_cluster[key] = item

    logger.info("Loaded %d unique topic name entries for conversation %s", len(by_cluster), conversation_id)
    return by_cluster


def _load_sample_comments(
    dynamodb, conversation_id: str,
) -> Dict[str, List[str]]:
    """Load sample comments from Delphi_CommentClustersStructureKeywords.

    Returns a dict mapping cluster_key (e.g. 'layer0_3') to a list of comment strings.
    """
    table = dynamodb.Table("Delphi_CommentClustersStructureKeywords")
    items = _query_all_by_conversation_id(table, conversation_id)

    lookup: Dict[str, List[str]] = {}
    for item in items:
        cluster_key = item.get("cluster_key", "")
        raw_samples = item.get("sample_comments", [])
        if isinstance(raw_samples, list):
            lookup[cluster_key] = [str(s) for s in raw_samples[:5]]
        else:
            lookup[cluster_key] = []
    logger.info("Loaded sample comments for %d clusters", len(lookup))
    return lookup


# ---------------------------------------------------------------------------
# Topic name prefix handling
# ---------------------------------------------------------------------------

_PREFIX_RE = re.compile(r"^\d+_\d+:\s*")


def _strip_prefix(raw_name: str) -> str:
    """Strip the '0_3: ' style prefix from a topic name."""
    m = _PREFIX_RE.match(raw_name)
    if m:
        return raw_name[m.end():]
    return raw_name


def _apply_prefix(layer_id: int, cluster_id: str, clean_name: str) -> str:
    """Re-apply the layer/cluster prefix to a clean topic name."""
    return f"{layer_id}_{cluster_id}: {clean_name}"


# ---------------------------------------------------------------------------
# Similarity computation
# ---------------------------------------------------------------------------

def _compute_similarities(
    clean_names: Dict[str, str],
    embedder,
    threshold: float,
) -> List[Tuple[str, str, float]]:
    """Return pairs of (cluster_a, cluster_b, similarity) exceeding threshold.

    clean_names: {cluster_id_str: clean_topic_name}
    """
    from sklearn.metrics.pairwise import cosine_similarity
    import numpy as np

    cluster_ids = sorted(clean_names.keys(), key=lambda x: int(x) if x.isdigit() else x)
    if len(cluster_ids) < 2:
        return []

    texts = [clean_names[cid] for cid in cluster_ids]
    embeddings = embedder.encode(texts)
    sim_matrix = cosine_similarity(embeddings)

    flagged: List[Tuple[str, str, float]] = []
    for i in range(len(cluster_ids)):
        for j in range(i + 1, len(cluster_ids)):
            score = float(sim_matrix[i][j])
            if score >= threshold:
                flagged.append((cluster_ids[i], cluster_ids[j], score))
    return flagged


# ---------------------------------------------------------------------------
# LLM prompt + response parsing
# ---------------------------------------------------------------------------

def _build_revision_prompt(
    clean_names: Dict[str, str],
    flagged_pairs: List[Tuple[str, str, float]],
    sample_comments_lookup: Dict[str, List[str]],
    layer_id: int,
) -> str:
    """Build an LLM prompt asking for revision of similar topics."""

    flagged_lines = []
    for cid_a, cid_b, score in flagged_pairs:
        flagged_lines.append(
            f'- "{clean_names[cid_a]}" (cluster {cid_a}) \u2194 '
            f'"{clean_names[cid_b]}" (cluster {cid_b}) \u2014 similarity: {score:.2f}'
        )

    topic_lines = []
    for cid in sorted(clean_names.keys(), key=lambda x: int(x) if x.isdigit() else x):
        cluster_key = f"layer{layer_id}_{cid}"
        samples = sample_comments_lookup.get(cluster_key, [])
        sample_str = ", ".join(f'"{s}"' for s in samples[:3]) if samples else "(no sample comments)"
        topic_lines.append(
            f'  Cluster {cid}: "{clean_names[cid]}" \u2014 Sample comments: [{sample_str}]'
        )

    prompt = (
        "You are reviewing topic labels for a deliberation platform. "
        "These topics exist at the same hierarchical level and should be clearly distinct from each other.\n\n"
        "The following topic pairs were flagged as too similar:\n"
        + "\n".join(flagged_lines)
        + "\n\n"
        "All topics at this level:\n"
        + "\n".join(topic_lines)
        + "\n\n"
        "Please revise ONLY the flagged topics to make them clearly distinct. Keep unchanged topics as-is.\n"
        "Each revised name should be 3-5 words, specific, and clearly differentiated from all other topics at this level.\n\n"
        'Respond with ONLY a JSON object:\n'
        '{"revised": {"<cluster_id>": "<new_name>", ...}, "unchanged": ["<cluster_id>", ...]}'
    )
    return prompt


def _parse_llm_response(response_text: str) -> Optional[Dict[str, Any]]:
    """Try to extract a JSON object from the LLM response text."""
    # Try direct parse first
    try:
        return json.loads(response_text)
    except json.JSONDecodeError:
        pass

    # Try to find JSON block in the response
    json_match = re.search(r"\{[\s\S]*\}", response_text)
    if json_match:
        try:
            return json.loads(json_match.group())
        except json.JSONDecodeError:
            pass

    logger.warning("Could not parse JSON from LLM response: %s", response_text[:300])
    return None


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def enforce_topic_distinction(
    conversation_id: str,
    dynamodb_resource=None,
    similarity_threshold: float = 0.75,
    anthropic_model: str = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Check and revise topic names within each layer for distinctness.

    Returns:
        {
            "layers_checked": int,
            "layers_needing_revision": int,
            "topics_revised": int,
            "revisions": {layer_id: {cluster_id: {"old": "...", "new": "..."}, ...}, ...},
        }
    """
    from sentence_transformers import SentenceTransformer

    # --- Setup ---
    if dynamodb_resource is None:
        endpoint = os.environ.get("DYNAMODB_ENDPOINT")
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
        kwargs: Dict[str, Any] = {"region_name": region}
        if endpoint:
            kwargs["endpoint_url"] = endpoint
        dynamodb_resource = boto3.resource("dynamodb", **kwargs)

    anthropic_model = anthropic_model or os.environ.get("ANTHROPIC_MODEL")
    if not anthropic_model:
        raise ValueError("anthropic_model must be provided or ANTHROPIC_MODEL env var set")

    st_model_name = os.environ.get("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2")
    logger.info("Loading SentenceTransformer model: %s", st_model_name)
    embedder = SentenceTransformer(st_model_name)

    # --- Load data ---
    topic_names = _load_topic_names(dynamodb_resource, conversation_id)
    sample_comments_lookup = _load_sample_comments(dynamodb_resource, conversation_id)

    # Group by layer
    layers: Dict[int, Dict[str, Dict[str, Any]]] = defaultdict(dict)
    for (layer_id, cluster_id), item in topic_names.items():
        layers[layer_id][cluster_id] = item

    result: Dict[str, Any] = {
        "layers_checked": 0,
        "layers_needing_revision": 0,
        "topics_revised": 0,
        "revisions": {},
    }

    provider = get_model_provider("anthropic", model_name=anthropic_model)
    topic_table = dynamodb_resource.Table("Delphi_CommentClustersLLMTopicNames")

    for layer_id in sorted(layers.keys()):
        layer_items = layers[layer_id]
        result["layers_checked"] += 1

        # Build clean-name map for this layer
        clean_names: Dict[str, str] = {}
        for cid, item in layer_items.items():
            raw_name = str(item.get("topic_name", f"Topic {cid}"))
            clean_names[cid] = _strip_prefix(raw_name)

        if len(clean_names) < 2:
            logger.info("Layer %d: only %d topic(s), skipping similarity check", layer_id, len(clean_names))
            continue

        # Compute pairwise similarity
        flagged_pairs = _compute_similarities(clean_names, embedder, similarity_threshold)

        if not flagged_pairs:
            logger.info("Layer %d: no pairs exceed threshold %.2f", layer_id, similarity_threshold)
            continue

        logger.info(
            "Layer %d: %d pair(s) flagged (threshold=%.2f)",
            layer_id, len(flagged_pairs), similarity_threshold,
        )
        for cid_a, cid_b, score in flagged_pairs:
            logger.info(
                "  '%s' (cluster %s) <-> '%s' (cluster %s) — %.3f",
                clean_names[cid_a], cid_a, clean_names[cid_b], cid_b, score,
            )

        result["layers_needing_revision"] += 1

        # --- LLM revision ---
        prompt = _build_revision_prompt(clean_names, flagged_pairs, sample_comments_lookup, layer_id)

        try:
            llm_response = provider.get_response(
                system_message="You are a topic-naming specialist. Respond with ONLY valid JSON.",
                user_message=prompt,
            )
        except Exception:
            logger.warning("Layer %d: LLM call failed, skipping", layer_id, exc_info=True)
            continue

        parsed = _parse_llm_response(llm_response)
        if not parsed:
            logger.warning("Layer %d: could not parse LLM response, skipping", layer_id)
            continue

        revised_map = parsed.get("revised", {})
        if not revised_map:
            logger.info("Layer %d: LLM returned no revisions", layer_id)
            continue

        # --- Apply revisions ---
        layer_revisions: Dict[str, Dict[str, str]] = {}
        for cid, new_clean_name in revised_map.items():
            cid_str = str(cid)
            if cid_str not in layer_items:
                logger.warning("Layer %d: LLM returned unknown cluster_id '%s', skipping", layer_id, cid_str)
                continue

            old_clean = clean_names.get(cid_str, "")
            if new_clean_name == old_clean:
                continue

            new_full_name = _apply_prefix(layer_id, cid_str, new_clean_name)
            old_full_name = str(layer_items[cid_str].get("topic_name", ""))
            topic_key = str(layer_items[cid_str].get("topic_key", f"layer{layer_id}_{cid_str}"))

            logger.info("Layer %d: Revised cluster %s topic from '%s' → '%s'", layer_id, cid_str, old_clean, new_clean_name)

            layer_revisions[cid_str] = {"old": old_full_name, "new": new_full_name}

            if not dry_run:
                try:
                    topic_table.update_item(
                        Key={
                            "conversation_id": str(conversation_id),
                            "topic_key": topic_key,
                        },
                        UpdateExpression=(
                            "SET topic_name = :tn, distinction_revised = :dr, original_topic_name = :otn"
                        ),
                        ExpressionAttributeValues={
                            ":tn": new_full_name,
                            ":dr": True,
                            ":otn": old_full_name,
                        },
                    )
                except Exception:
                    logger.warning(
                        "Layer %d, cluster %s: DynamoDB update failed", layer_id, cid_str, exc_info=True,
                    )

        if layer_revisions:
            result["revisions"][str(layer_id)] = layer_revisions
            result["topics_revised"] += len(layer_revisions)

    logger.info(
        "Done. layers_checked=%d, layers_needing_revision=%d, topics_revised=%d",
        result["layers_checked"], result["layers_needing_revision"], result["topics_revised"],
    )
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Enforce distinction between topic names at each hierarchical layer.",
    )
    parser.add_argument("--conversation_id", required=True, help="Conversation ID / zid")
    parser.add_argument(
        "--similarity_threshold", type=float, default=0.75,
        help="Cosine-similarity threshold above which topics are flagged (default: 0.75)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Compute and log revisions without writing to DynamoDB")
    parser.add_argument("--model", default=None, help="Anthropic model name (overrides ANTHROPIC_MODEL env var)")
    args = parser.parse_args()

    result = enforce_topic_distinction(
        conversation_id=args.conversation_id,
        similarity_threshold=args.similarity_threshold,
        anthropic_model=args.model,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, indent=2))
