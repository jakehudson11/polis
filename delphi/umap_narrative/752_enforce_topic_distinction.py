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
from umap_narrative.llm_factory_constructor import get_model_provider, get_model_provider_with_cascade, AgoraProxyProvider
from umap_narrative.llm_factory_constructor.model_provider import log_ai_usage

logger = logging.getLogger(__name__)

# Max rounds of revision per layer before giving up.
MAX_ROUNDS = 3

# Appended instruction when the LLM response fails to parse (retry once).
_STRICT_JSON_INSTRUCTION = "Respond with ONLY the JSON object, no markdown, no prose."

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


def _max_pairwise_similarity(
    candidate_name: str,
    other_names: List[str],
    embedder,
) -> float:
    """Return the max cosine similarity of candidate_name vs other_names.

    Used to gate revisions: a revision is only applied if its max similarity
    to all OTHER names at the layer strictly decreased vs the old name.
    """
    from sklearn.metrics.pairwise import cosine_similarity
    import numpy as np

    if not other_names:
        return 0.0
    embeddings = embedder.encode([candidate_name] + other_names)
    sims = cosine_similarity(embeddings[0:1], embeddings[1:])[0]
    return float(sims.max())


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
# LLM model + provider resolution
# ---------------------------------------------------------------------------

# The model name and the provider name are a MATCHED PAIR and must be resolved
# from the same (job-scoped) configuration. Resolving them with two independent
# precedence chains let them disagree in production: the provider came from the
# job-scoped LLM_PRIMARY_PROVIDER (Z.AI) while the model fell back to the
# container-global ANTHROPIC_MODEL (claude-sonnet-4-20250514), so every
# delphi_report call failed and silently degraded to a slower backup tier.
# Do not split these two lookups apart again.


def resolve_model_and_provider(
    model_name: Optional[str] = None,
    provider_type: Optional[str] = None,
) -> Tuple[str, str, bool]:
    """Resolve the matched (model, provider) pair for this invocation.

    Precedence (an explicit CLI --model argument always wins):
      Agora route:  --model  >  LLM_MODEL (job-scoped)  >  ANTHROPIC_MODEL
      direct SDK:   --model  >  ANTHROPIC_MODEL                        (unchanged)

    The Agora route's provider is job-scoped (LLM_PRIMARY_PROVIDER ->
    LLM_PROVIDER_ACTUAL), so its model must prefer the job-scoped LLM_MODEL
    before the container-global ANTHROPIC_MODEL. ANTHROPIC_MODEL stays a valid
    source for the direct-SDK paths, and a last-resort fallback for Agora.

    Returns:
        (model_name, provider_name, is_agora_route), where provider_name is the
        provider to hand to the chosen constructor (the Agora primary provider on
        the Agora route, otherwise the resolved provider type).
    """
    provider = (
        provider_type
        or os.environ.get("LLM_PROVIDER")
        or os.environ.get("NARRATIVE_BATCH_PROVIDER")
        or "anthropic"
    )

    if provider.lower() == "agora":
        primary_provider = (
            os.environ.get("LLM_PRIMARY_PROVIDER")
            or os.environ.get("LLM_PROVIDER_ACTUAL")
            or "anthropic"
        )
        job_model = os.environ.get("LLM_MODEL")
        resolved_model = model_name or job_model or os.environ.get("ANTHROPIC_MODEL")
        if not resolved_model:
            raise ValueError(
                "No model could be resolved for the Agora route: pass --model or set the "
                "job-scoped LLM_MODEL. Attempted in order: --model argument, LLM_MODEL, "
                "ANTHROPIC_MODEL (all unset). The model must be chosen together with the "
                "job-scoped provider chain LLM_PRIMARY_PROVIDER/LLM_PROVIDER_ACTUAL."
            )
        if not model_name and not job_model:
            logger.warning(
                "Agora route has no job-scoped LLM_MODEL; falling back to the "
                "container-global ANTHROPIC_MODEL=%r while job-scoped provider=%r — "
                "verify the model/provider pair is valid.",
                resolved_model, primary_provider,
            )
        return resolved_model, primary_provider, True

    # Direct-SDK path: behaviour unchanged (ANTHROPIC_MODEL is legitimate here).
    resolved_model = model_name or os.environ.get("ANTHROPIC_MODEL")
    if not resolved_model:
        raise ValueError("model_name must be provided or ANTHROPIC_MODEL env var set")
    return resolved_model, provider, False


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def enforce_topic_distinction(
    conversation_id: str,
    dynamodb_resource=None,
    similarity_threshold: float = 0.60,
    model_name: str = None,
    provider_type: str = None,
    dry_run: bool = False,
    skip_summaries: bool = False,
) -> Dict[str, Any]:
    """Check and revise topic names within each layer for distinctness.

    Revisions are iterative: up to MAX_ROUNDS rounds per layer, each round
    only applying candidate revisions whose max pairwise similarity to all
    other names at the layer strictly decreased. After revision, missing
    topic_summary rows are backfilled best-effort (unless skip_summaries).

    Returns:
        {
            "layers_checked": int,
            "layers_needing_revision": int,
            "topics_revised": int,
            "revisions": {layer_id: {cluster_id: {"old": "...", "new": "..."}, ...}, ...},
            "summaries_generated": int,
            "summaries_failed": int,
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

    # Model and provider are resolved together from one precedence chain so they cannot
    # disagree; see resolve_model_and_provider above for the incident this prevents.
    model_name, provider_name, is_agora_route = resolve_model_and_provider(
        model_name, provider_type,
    )

    if is_agora_route:
        # When LLM_PROVIDER is 'agora', route through AgoraProxyProvider directly.
        # Agora's backend handles cascade/fallback — Delphi does NOT try providers locally.
        deliberation_id = os.environ.get("DELIBERATION_ID") or os.environ.get("DELPHI_DELIBERATION_ID") or None
        
        provider = AgoraProxyProvider(
            model=model_name,
            provider=provider_name,
            backup_model=os.environ.get("LLM_BACKUP_MODEL") or None,
            backup_provider=os.environ.get("LLM_BACKUP_PROVIDER") or None,
            fallback_model=os.environ.get("LLM_FALLBACK_MODEL") or None,
            fallback_provider=os.environ.get("LLM_FALLBACK_PROVIDER") or None,
            use_case='delphi_report',
            deliberation_id=deliberation_id,
        )
    else:
        config = {
            'provider': provider_name,
            'model': model_name,
        }
        provider = get_model_provider_with_cascade(config)

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

        # --- Iterative LLM revision (up to MAX_ROUNDS rounds) ---
        layer_revisions: Dict[str, Dict[str, str]] = {}
        round_num = 0
        while round_num < MAX_ROUNDS:
            round_num += 1

            # Re-compute flagged pairs each round; if none, layer passes.
            flagged_pairs = _compute_similarities(clean_names, embedder, similarity_threshold)
            if not flagged_pairs:
                logger.info(
                    "Layer %d: no pairs exceed threshold %.2f (round %d)",
                    layer_id, similarity_threshold, round_num,
                )
                break

            # --- LLM revision call (one parse-failure retry with stricter instruction) ---
            prompt = _build_revision_prompt(clean_names, flagged_pairs, sample_comments_lookup, layer_id)

            try:
                llm_response = provider.get_response(
                    system_message="You are a topic-naming specialist. Respond with ONLY valid JSON.",
                    user_message=prompt,
                )
            except Exception:
                logger.warning("Layer %d: LLM call failed, skipping layer", layer_id, exc_info=True)
                break

            # Log AI usage with estimated token counts
            try:
                prompt_text = "You are a topic-naming specialist. Respond with ONLY valid JSON." + prompt
                estimated_input = max(1, len(prompt_text) // 4)
                estimated_output = max(1, len(llm_response) // 4) if llm_response else 1
                deliberation_id = os.environ.get('DELPHI_DELIBERATION_ID', '')
                log_ai_usage(
                    use_case='delphi_report',
                    model=model_name,
                    provider='anthropic',
                    input_tokens=estimated_input,
                    output_tokens=estimated_output,
                    deliberation_id=deliberation_id,
                )
            except Exception:
                logger.warning("Layer %d: failed to log AI usage", layer_id, exc_info=True)

            parsed = _parse_llm_response(llm_response)
            if not parsed:
                logger.warning(
                    "Layer %d: could not parse LLM response, retrying with stricter instruction", layer_id,
                )
                try:
                    llm_response = provider.get_response(
                        system_message="You are a topic-naming specialist. Respond with ONLY valid JSON.",
                        user_message=prompt + "\n" + _STRICT_JSON_INSTRUCTION,
                    )
                except Exception:
                    logger.warning("Layer %d: LLM retry call failed", layer_id, exc_info=True)
                    parsed = None
                else:
                    parsed = _parse_llm_response(llm_response)
                if not parsed:
                    logger.warning("Layer %d: could not parse LLM response after retry, skipping round", layer_id)
                    continue

            revised_map = parsed.get("revised", {})
            if not revised_map:
                logger.info("Layer %d: LLM returned no revisions (round %d)", layer_id, round_num)
                break

            # --- Apply revisions only if max similarity strictly decreases ---
            applied_this_round = 0
            for cid, new_clean_name in revised_map.items():
                cid_str = str(cid)
                if cid_str not in layer_items:
                    logger.warning("Layer %d: LLM returned unknown cluster_id '%s', skipping", layer_id, cid_str)
                    continue

                old_clean = clean_names.get(cid_str, "")
                new_clean_name = str(new_clean_name).strip()
                if new_clean_name == old_clean or not new_clean_name:
                    continue

                other_names = [n for c, n in clean_names.items() if c != cid_str]
                old_max_sim = _max_pairwise_similarity(old_clean, other_names, embedder)
                new_max_sim = _max_pairwise_similarity(new_clean_name, other_names, embedder)

                if new_max_sim >= old_max_sim:
                    logger.info(
                        "Layer %d: skipped revision for cluster %s ('%s' -> '%s'): "
                        "max similarity %.3f not strictly below %.3f",
                        layer_id, cid_str, old_clean, new_clean_name, new_max_sim, old_max_sim,
                    )
                    continue

                new_full_name = _apply_prefix(layer_id, cid_str, new_clean_name)
                old_full_name = str(layer_items[cid_str].get("topic_name", ""))
                topic_key = str(layer_items[cid_str].get("topic_key", f"layer{layer_id}_{cid_str}"))

                logger.info("Layer %d: Revised cluster %s topic from '%s' → '%s'", layer_id, cid_str, old_clean, new_clean_name)

                layer_revisions[cid_str] = {"old": old_full_name, "new": new_full_name}
                applied_this_round += 1

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

                # Update in-memory clean name so later rounds embed the revised name
                clean_names[cid_str] = new_clean_name

            if applied_this_round == 0:
                logger.info("Layer %d: no revisions applied in round %d, stopping", layer_id, round_num)
                break

        if layer_revisions:
            result["revisions"][str(layer_id)] = layer_revisions
            result["topics_revised"] += len(layer_revisions)

    # --- Topic summary generation + backfill (best-effort, respects dry_run) ---
    if not skip_summaries:
        try:
            summary_counts = _backfill_topic_summaries(
                dynamodb_resource=dynamodb_resource,
                conversation_id=conversation_id,
                layers=layers,
                sample_comments_lookup=sample_comments_lookup,
                provider=provider,
                dry_run=dry_run,
            )
            result["summaries_generated"] = summary_counts["summaries_generated"]
            result["summaries_failed"] = summary_counts["summaries_failed"]
        except Exception:
            logger.warning("Topic summary backfill failed", exc_info=True)
            result["summaries_generated"] = 0
            result["summaries_failed"] = 0
    else:
        logger.info("Topic summary backfill skipped (--skip-summaries)")
        result["summaries_generated"] = 0
        result["summaries_failed"] = 0

    logger.info(
        "Done. layers_checked=%d, layers_needing_revision=%d, topics_revised=%d, "
        "summaries_generated=%d, summaries_failed=%d",
        result["layers_checked"], result["layers_needing_revision"], result["topics_revised"],
        result["summaries_generated"], result["summaries_failed"],
    )
    return result


# ---------------------------------------------------------------------------
# Topic summary generation + backfill
# ---------------------------------------------------------------------------

def _resolve_summary_key(parsed: Optional[Dict[str, Any]], cid: str) -> Optional[str]:
    """Resolve the LLM JSON key for a cluster id, tolerating label variants.

    The LLM occasionally returns keys like "Cluster 0", "Cluster 0:",
    "cluster 0", or quoted numeric strings instead of plain "0". Tries, in
    order:
      1. exact match on cid (int or str)
      2. str(cid)
      3. case-insensitive match after stripping a leading "cluster " prefix
         and optional trailing colon/whitespace
      4. fuzzy: any key whose normalized form (lowercase, non-alphanumerics
         stripped) equals the normalized form of cid or of f"cluster {cid}"
    Returns the matched summary string (stripped), or None if no key matches.
    """
    if not parsed:
        return None

    # 1. exact match on cid (int or str)
    exact = parsed.get(cid)
    if exact is not None:
        return str(exact).strip() or None

    # 2. str(cid)
    as_str = parsed.get(str(cid))
    if as_str is not None:
        return str(as_str).strip() or None

    def _normalize(text: str) -> str:
        return re.sub(r"[^a-z0-9]", "", text.lower())

    target = _normalize(str(cid))
    target_with_prefix = _normalize(f"cluster {cid}")
    cid_lower = str(cid).lower()

    for key, value in parsed.items():
        key_str = str(key).strip()

        # 3. strip leading "cluster " (case-insensitive) and trailing colon/whitespace
        candidate = re.sub(r"^cluster\s*:?\s*", "", key_str, flags=re.IGNORECASE)
        candidate = candidate.rstrip(": ").strip()
        if candidate.lower() == cid_lower:
            return str(value).strip() or None

        # 4. fuzzy normalized match
        norm = _normalize(key_str)
        if norm == target or norm == target_with_prefix:
            return str(value).strip() or None

    return None


def _backfill_topic_summaries(
    dynamodb_resource,
    conversation_id: str,
    layers: Dict[int, Dict[str, Dict[str, Any]]],
    sample_comments_lookup: Dict[str, List[str]],
    provider,
    dry_run: bool = False,
) -> Dict[str, int]:
    """Generate topic_summary for rows that lack one (idempotent, best-effort).

    layers: {layer_id: {cluster_id: item}} — the same dict built in
    enforce_topic_distinction. Only rows whose item lacks a non-empty
    topic_summary are processed. One LLM call per layer (chunked into <=15
    topics per call), with ONE parse-failure retry using a stricter
    instruction. Failures are logged and skipped, never raised.
    """
    topic_table = dynamodb_resource.Table("Delphi_CommentClustersLLMTopicNames")
    summaries_generated = 0
    summaries_failed = 0

    for layer_id in sorted(layers.keys()):
        layer_items = layers[layer_id]

        # Idempotent: only rows missing a non-empty topic_summary
        pending: Dict[str, Dict[str, Any]] = {}
        for cid, item in layer_items.items():
            if str(item.get("topic_summary") or "").strip():
                continue
            pending[cid] = item

        if not pending:
            logger.info("Summary backfill: layer %d has no rows missing topic_summary", layer_id)
            continue

        clean_names = {
            cid: _strip_prefix(str(item.get("topic_name", f"Topic {cid}")))
            for cid, item in pending.items()
        }

        # Chunk layers with >15 topics into multiple calls of <=15
        pending_ids = sorted(pending.keys(), key=lambda x: int(x) if x.isdigit() else x)
        for chunk_start in range(0, len(pending_ids), 15):
            chunk = pending_ids[chunk_start:chunk_start + 15]

            cluster_specs = []
            for cid in chunk:
                name = clean_names[cid]
                samples = sample_comments_lookup.get(f"layer{layer_id}_{cid}", [])
                sample_str = ", ".join(f'"{s}"' for s in samples[:3]) if samples else "(no sample comments)"
                cluster_specs.append(
                    f'  Cluster {cid}: "{name}" \u2014 Sample comments: [{sample_str}]'
                )

            prompt = (
                "You are writing short summaries of discussion topics for a deliberation platform.\n"
                "For each cluster below, write a 1-2 sentence \"in a nutshell\" summary of the topic "
                "based on the sample comments. The summary MUST NOT restate the topic label verbatim, "
                "must be plain prose, and must NOT include citations or percentages.\n\n"
                + "\n".join(cluster_specs)
                + "\n\nRespond with ONLY a JSON object of the form "
                '{"<cluster_id>": "<summary>", ...}'
            )

            # One LLM call, one retry with stricter instruction on parse failure
            parsed = None
            for attempt in (0, 1):
                try:
                    system_message = "You are a topic summarizer. Respond with ONLY valid JSON."
                    if attempt == 1:
                        system_message += "\n" + _STRICT_JSON_INSTRUCTION
                    response_text = provider.get_response(
                        system_message=system_message,
                        user_message=prompt,
                    )
                except Exception:
                    logger.warning(
                        "Summary backfill: layer %d LLM call failed (attempt %d)",
                        layer_id, attempt + 1, exc_info=True,
                    )
                    parsed = None
                    continue
                parsed = _parse_llm_response(response_text)
                if parsed:
                    break
                logger.warning(
                    "Summary backfill: layer %d could not parse response (attempt %d)",
                    layer_id, attempt + 1,
                )

            if not parsed:
                logger.warning("Summary backfill: layer %d failed after retries, skipping", layer_id)
                summaries_failed += len(chunk)
                continue

            matched = 0
            for cid in chunk:
                summary = _resolve_summary_key(parsed, cid)
                if not summary:
                    logger.warning(
                        "Summary backfill: layer %d cluster %s missing from LLM JSON, skipping",
                        layer_id, cid,
                    )
                    summaries_failed += 1
                    continue
                matched += 1

                item = pending[cid]
                topic_key = str(item.get("topic_key", f"layer{layer_id}_{cid}"))

                if dry_run:
                    logger.info(
                        "Summary backfill (dry-run): layer %d cluster %s \u2192 '%s'",
                        layer_id, cid, summary,
                    )
                else:
                    try:
                        topic_table.update_item(
                            Key={
                                "conversation_id": str(conversation_id),
                                "topic_key": topic_key,
                            },
                            UpdateExpression="SET topic_summary = :ts",
                            ExpressionAttributeValues={":ts": summary},
                        )
                    except Exception:
                        logger.warning(
                            "Summary backfill: layer %d cluster %s DynamoDB update failed",
                            layer_id, cid, exc_info=True,
                        )
                        summaries_failed += 1
                        continue
                summaries_generated += 1
                logger.info("Summary backfill: layer %d cluster %s summary written", layer_id, cid)

            if matched == 0 and len(chunk) > 0:
                keys_preview = ", ".join(repr(k) for k in list(parsed.keys())[:10])
                logger.warning(
                    "Summary backfill: layer %d chunk of %d clusters had no matches in LLM JSON "
                    "(keys: %s); summaries_failed incremented per cluster above",
                    layer_id, len(chunk), keys_preview,
                )

    logger.info(
        "Summary backfill done. summaries_generated=%d, summaries_failed=%d",
        summaries_generated, summaries_failed,
    )
    return {"summaries_generated": summaries_generated, "summaries_failed": summaries_failed}


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
        "--similarity_threshold", type=float, default=0.60,
        help="Cosine-similarity threshold above which topics are flagged (default: 0.60)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Compute and log revisions without writing to DynamoDB")
    parser.add_argument("--skip-summaries", action="store_true", help="Skip topic summary generation/backfill")
    parser.add_argument("--model", default=None, help="Anthropic model name (overrides ANTHROPIC_MODEL env var)")
    parser.add_argument("--provider", type=str, default=None, help="Provider name (default: anthropic or LLM_PROVIDER env)")
    args = parser.parse_args()

    result = enforce_topic_distinction(
        conversation_id=args.conversation_id,
        similarity_threshold=args.similarity_threshold,
        skip_summaries=args.skip_summaries,
        model_name=args.model,
        provider_type=args.provider,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, indent=2))
