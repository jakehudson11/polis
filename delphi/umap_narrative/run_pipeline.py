#!/usr/bin/env python3
"""
Process Polis conversation from PostgreSQL and generate visualizations.

This script fetches conversation data from PostgreSQL, processes it using
EVōC for clustering, and generates interactive visualizations with topic labeling.
"""

import json
import logging
import os
import time
import traceback
import uuid  # For generating job_id
from datetime import datetime

import datamapplot

# Import from installed packages
import evoc
import numpy as np
from polismath_commentgraph.utils.converter import DataConverter

# Import from local modules
from polismath_commentgraph.utils.storage import DynamoDBStorage, PostgresClient
from sentence_transformers import SentenceTransformer
from sklearn.feature_extraction.text import CountVectorizer, TfidfTransformer
from umap import UMAP

from llm_factory_constructor.model_provider import get_model_provider

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

def setup_environment(
    db_host=None, db_port=None, db_name=None, db_user=None, db_password=None
):
    """Set up environment variables for database connections."""
    # PostgreSQL settings
    if db_host:
        os.environ["DATABASE_HOST"] = db_host
    elif not os.environ.get("DATABASE_HOST"):
        os.environ["DATABASE_HOST"] = "localhost"

    if db_port:
        os.environ["DATABASE_PORT"] = str(db_port)
    elif not os.environ.get("DATABASE_PORT"):
        os.environ["DATABASE_PORT"] = "5432"

    if db_name:
        os.environ["DATABASE_NAME"] = db_name
    elif not os.environ.get("DATABASE_NAME"):
        os.environ["DATABASE_NAME"] = "polisDB_prod_local_mar14"

    if db_user:
        os.environ["DATABASE_USER"] = db_user
    elif not os.environ.get("DATABASE_USER"):
        os.environ["DATABASE_USER"] = "postgres"

    if db_password:
        os.environ["DATABASE_PASSWORD"] = db_password
    elif not os.environ.get("DATABASE_PASSWORD"):
        os.environ["DATABASE_PASSWORD"] = ""

    # Print database connection info
    logger.info("Database connection info:")
    logger.info(f"- HOST: {os.environ.get('DATABASE_HOST')}")
    logger.info(f"- PORT: {os.environ.get('DATABASE_PORT')}")
    logger.info(f"- DATABASE: {os.environ.get('DATABASE_NAME')}")
    logger.info(f"- USER: {os.environ.get('DATABASE_USER')}")

    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


def fetch_conversation_data(zid):
    """
    Fetch conversation data from PostgreSQL.

    Args:
        zid: Conversation ID

    Returns:
        comments: List of comment dictionaries
        metadata: Dictionary with conversation metadata
    """
    logger.info(f"Fetching conversation {zid} from PostgreSQL...")
    postgres_client = PostgresClient()

    try:
        # Initialize connection
        postgres_client.initialize()

        # Get conversation metadata
        conversation = postgres_client.get_conversation_by_id(zid)
        if not conversation:
            logger.error(f"Conversation {zid} not found in database.")
            return None, None

        # Get comments - include all comments, regardless of active status
        comments = postgres_client.get_comments_by_conversation(zid)
        logger.info(f"Retrieved {len(comments)} comments from conversation {zid}")

        # Count active and inactive for logging purposes only
        active_count = sum(1 for c in comments if c.get("active", True))
        inactive_count = sum(1 for c in comments if not c.get("active", True))
        logger.info(
            f"Comment counts - Active: {active_count}, Inactive: {inactive_count}, Total: {len(comments)}"
        )

        # Create metadata
        metadata = {
            "conversation_id": str(zid),
            "zid": zid,
            "conversation_name": conversation.get("topic", f"Conversation {zid}"),
            "description": conversation.get("description", ""),
            "created": str(conversation.get("created", "")),
            "modified": str(conversation.get("modified", "")),
            "owner": conversation.get("owner", ""),
            "num_comments": len(comments),
            "active_count": active_count,
            "inactive_count": inactive_count,
        }

        return comments, metadata

    except Exception as e:
        logger.error(f"Error fetching conversation: {str(e)}")
        import traceback

        logger.error(traceback.format_exc())
        return None, None

    finally:
        # Clean up connection
        postgres_client.shutdown()


def process_comments(comments, conversation_id):
    """
    Process comments with embedding and clustering.

    Args:
        comments: List of comment dictionaries
        conversation_id: Conversation ID string

    Returns:
        document_map: 2D projection of comment embeddings
        document_vectors: Comment embeddings
        cluster_layers: Hierarchy of cluster assignments
        comment_texts: List of comment text strings
        comment_ids: List of comment IDs
    """
    logger.info(
        f"Processing {len(comments)} comments for conversation {conversation_id}..."
    )

    # Extract comment texts and IDs
    comment_texts, comment_ids = map(
        list,
        zip(
            *[(c["txt"], c["tid"]) for c in comments if c["txt"] and c["txt"].strip()],
            strict=True,
        ),
    )

    # Generate embeddings with SentenceTransformer
    logger.info("Generating embeddings with SentenceTransformer...")
    model_name = os.environ.get("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2")
    logger.info(f"Using model: {model_name}")
    embedding_model = SentenceTransformer(model_name)
    document_vectors = embedding_model.encode(comment_texts, show_progress_bar=True)

    # Generate 2D projection with UMAP
    logger.info("Generating 2D projection with UMAP...")
    document_map = UMAP(n_components=2, metric="cosine", random_state=42).fit_transform(
        document_vectors
    )

    # Cluster with EVōC
    logger.info("Clustering with EVōC...")
    try:
        clusterer = evoc.EVoC(min_samples=5)  # Set min_samples to avoid empty clusters
        cluster_labels = clusterer.fit_predict(document_vectors)
        cluster_layers = clusterer.cluster_layers_

        logger.info(
            f"Found {len(np.unique(cluster_labels))} clusters at the finest level"
        )
        for i, layer in enumerate(cluster_layers):
            unique_clusters = np.unique(layer[layer >= 0])
            logger.info(f"Layer {i}: {len(unique_clusters)} clusters")

    except Exception as e:
        logger.error(f"Error during EVōC clustering: {e}")
        logger.error(traceback.format_exc())
        # Fallback to simple clustering
        from sklearn.cluster import KMeans

        logger.info("Falling back to KMeans clustering...")
        kmeans = KMeans(n_clusters=5, random_state=42)
        cluster_labels = kmeans.fit_predict(document_vectors)

        # Create a simple layered clustering for demonstration
        from sklearn.cluster import AgglomerativeClustering

        layer1 = AgglomerativeClustering(n_clusters=3).fit_predict(document_vectors)
        layer2 = AgglomerativeClustering(n_clusters=2).fit_predict(document_vectors)

        cluster_layers = [cluster_labels, layer1, layer2]
        logger.info(
            f"Created {len(cluster_layers)} cluster layers with fallback clustering"
        )

    return document_map, document_vectors, cluster_layers, comment_texts, comment_ids


def characterize_comment_clusters(cluster_layer, comment_texts):
    """
    Characterize comment clusters by common themes and keywords.

    Args:
        cluster_layer: Cluster assignments for a specific layer
        comment_texts: List of comment text strings

    Returns:
        cluster_characteristics: Dictionary with cluster characterizations
    """
    # Create a dictionary to store cluster characteristics
    cluster_characteristics = {}

    # Get unique clusters
    unique_clusters = np.unique(cluster_layer)
    unique_clusters = unique_clusters[unique_clusters >= 0]  # Remove noise points (-1)

    # Create TF-IDF vectorizer
    vectorizer = CountVectorizer(max_features=1000, stop_words="english")
    transformer = TfidfTransformer()

    # Fit and transform the entire corpus
    X = vectorizer.fit_transform(comment_texts)
    X_tfidf = transformer.fit_transform(X)

    # Get feature names
    feature_names = vectorizer.get_feature_names_out()

    for cluster_id in unique_clusters:
        # Get cluster members
        cluster_members = np.where(cluster_layer == cluster_id)[0]

        if len(cluster_members) == 0:
            continue

        # Get comment texts for this cluster
        cluster_comments = [comment_texts[i] for i in cluster_members]

        # Find top words for this cluster by TF-IDF
        cluster_tfidf = X_tfidf[cluster_members].toarray().mean(axis=0)
        top_indices = np.argsort(cluster_tfidf)[-10:][::-1]  # Top 10 words
        top_words = [feature_names[i] for i in top_indices]

        # Get sample comments (shortest 3 for readability)
        comment_lengths = [len(comment) for comment in cluster_comments]
        shortest_indices = np.argsort(comment_lengths)[:3]  # 3 shortest comments
        sample_comments = [cluster_comments[i] for i in shortest_indices]

        # Add to cluster characteristics
        cluster_characteristics[int(cluster_id)] = {
            "size": len(cluster_members),
            "top_words": top_words,
            "top_tfidf_scores": [float(cluster_tfidf[i]) for i in top_indices],
            "sample_comments": sample_comments,
        }

    return cluster_characteristics


def generate_cluster_topic_labels(
    cluster_characteristics,
    comment_texts=None,
    layer=None,
    layer_idx=0,
    conversation_name=None,
    enable_llm_topic_naming=False,
    document_map=None,
):
    """
    Generate topic labels for clusters based on their characteristics.

    Args:
        cluster_characteristics: Dictionary with cluster characterizations
        comment_texts: List of comment text strings (used for LLM topic naming)
        layer: Cluster assignments for the current layer (used for LLM topic naming)
        layer_idx: Index of the current layer
        conversation_name: Name of the conversation (used for topic naming)
        enable_llm_topic_naming: Whether to use an LLM (Anthropic) for topic naming
        document_map: 2D UMAP coordinates for selecting representative comments

    Returns:
        cluster_labels: Dictionary mapping cluster IDs to topic labels
    """
    cluster_labels = {}
    llm_stats = {
        "attempted": 0,
        "succeeded": 0,
        "failed": 0,
        "skipped": 0,
    }

    def _get_conventional_label(cluster_id, characteristics) -> str:
        top_words = characteristics.get("top_words", [])
        sample_comments = characteristics.get("sample_comments", [])

        label_parts = []

        if len(top_words) > 0:
            label_parts.append("Keywords: " + ", ".join(top_words[:5]))

        if len(sample_comments) > 0:
            first_comment = sample_comments[0]
            if len(first_comment) > 50:
                first_comment = first_comment[:47] + "..."
            label_parts.append("Example: " + first_comment)

        if label_parts:
            label = " | ".join(label_parts)
            if len(label) > 50:
                label = label[:47] + "..."
            return label
        return f"Topic {cluster_id}"

    # LLM topic naming via Anthropic
    if enable_llm_topic_naming and comment_texts is not None and layer is not None:
        anthropic_api_key = os.environ.get("ANTHROPIC_API_KEY")
        anthropic_model = os.environ.get("ANTHROPIC_MODEL")

        if not anthropic_api_key:
            logger.warning(
                "Topic naming skipped (non-blocking): ANTHROPIC_API_KEY not set. Using conventional topic naming."
            )
            llm_stats["skipped"] += 1
        elif not anthropic_model:
            logger.warning(
                "Topic naming skipped (non-blocking): ANTHROPIC_MODEL not set. Using conventional topic naming."
            )
            llm_stats["skipped"] += 1
        else:
            try:
                provider = get_model_provider("anthropic", model_name=anthropic_model)
                logger.info("Using Anthropic for cluster naming")

                def _is_provider_error_payload(text: str) -> bool:
                    """Detect the provider's structured JSON error payload."""
                    if not text:
                        return False
                    t = text.strip()
                    if not (t.startswith("{") and "polis_narrative_error_message" in t):
                        return False
                    try:
                        parsed = json.loads(t)
                    except Exception:
                        return False
                    return parsed.get("id") == "polis_narrative_error_message"

                def _looks_like_overload(text: str) -> bool:
                    t = (text or "").lower()
                    return ("529" in t) or ("overloaded" in t) or ("rate" in t and "limit" in t)

                def _clean_topic_label(raw_text: str) -> str:
                    raw_text = (raw_text or "").strip()
                    if not raw_text:
                        return ""

                    prefixes_to_remove = [
                        "Here is the list of topic labels:",
                        "Here is the list of topic labels",
                        "Here are the topic labels:",
                        "Here are the topic labels",
                        "Here is the topic label:",
                        "Here is the topic label",
                        "The topic label is:",
                        "The topic label is",
                        "Topic label:",
                        "Here is a concise topic label:",
                        "Here's a concise topic label:",
                        "Concise topic label:",
                        "Topic name:",
                        "Topic name",
                        "Topic:",
                        "Label:",
                        "Label",
                    ]

                    import re

                    layer_prefix_match = re.match(r"^\d+_\d+:\s*", raw_text)
                    if layer_prefix_match:
                        raw_text = raw_text[layer_prefix_match.end() :]

                    for prefix in prefixes_to_remove:
                        if raw_text.startswith(prefix):
                            raw_text = raw_text.replace(prefix, "", 1)

                    raw_text = raw_text.strip()
                    topic = raw_text.split("\n")[0].strip()
                    topic = topic.strip("\"'")

                    if topic.startswith("1. ") or topic.startswith("- "):
                        topic = topic[3:].strip()

                    topic = topic.replace("*", "")
                    if len(topic) > 50:
                        topic = topic[:50] + "..."
                    return topic.strip()

                def get_topic_name(comments, fallback_characteristics, cluster_id: int) -> str:
                    prompt = (
                        "Read these comments and provide ONLY ONE short topic label (3–5 words) "
                        "that captures their combined essence. Do not give one topic per comment. "
                        "Do not include explanations, introductions, or multiple outputs. "
                        "Reply with exactly one topic label, in quotation marks, on a single line.\n\n"
                        "Comments:\n"
                    )
                    for j, comment in enumerate(comments[:5]):
                        prompt += f"{j + 1}. {comment}\n"

                    try:
                        llm_stats["attempted"] += 1

                        raw_response = provider.get_response(
                            system_message="",
                            user_message=prompt,
                        )

                        # Defensive check for legacy behavior where providers returned a structured JSON blob.
                        if _is_provider_error_payload(raw_response):
                            raise RuntimeError(
                                f"Anthropic provider returned error payload for layer {layer_idx} cluster {cluster_id}"
                            )

                        topic = _clean_topic_label(raw_response)
                        if not topic:
                            logger.warning(
                                "Empty topic name after cleaning for layer %s cluster %s; falling back to conventional label",
                                layer_idx,
                                cluster_id,
                            )
                            llm_stats["failed"] += 1
                            return _get_conventional_label(cluster_id, fallback_characteristics)
                        llm_stats["succeeded"] += 1
                        return topic
                    except Exception as e:
                        logger.warning(
                            "Topic naming failed via Anthropic: %s",
                            e,
                        )
                        logger.debug(
                            "Anthropic topic naming exception details:\n%s",
                            traceback.format_exc(),
                        )
                        llm_stats["failed"] += 1
                        return _get_conventional_label(cluster_id, fallback_characteristics)

                for cluster_id, characteristics in cluster_characteristics.items():
                    if cluster_id < 0:
                        continue

                    cluster_indices = np.where(layer == cluster_id)[0]

                    if len(cluster_indices) > 5 and document_map is not None:
                        centroid = np.mean(document_map[cluster_indices], axis=0)
                        distances = np.sqrt(
                            np.sum((document_map[cluster_indices] - centroid) ** 2, axis=1)
                        )
                        closest_indices = np.argsort(distances)[:5]
                        selected_indices = cluster_indices[closest_indices].tolist()
                        logger.info(
                            "Selected %s most representative comments for layer %s, cluster %s",
                            len(selected_indices),
                            layer_idx,
                            cluster_id,
                        )
                    else:
                        selected_indices = cluster_indices.tolist()

                    selected_comments = [comment_texts[i] for i in selected_indices]
                    topic_name = get_topic_name(selected_comments, characteristics, cluster_id)

                    cleaned_topic_name = (topic_name or "").strip().strip("\"'")
                    prefixed_topic_name = (
                        f"{layer_idx}_{cluster_id}: {cleaned_topic_name}"
                        if cleaned_topic_name
                        else f"{layer_idx}_{cluster_id}:"
                    )
                    cluster_labels[cluster_id] = prefixed_topic_name

                    time.sleep(0.5)

                logger.info(
                    "Generated %s topic names using Anthropic",
                    len(cluster_labels),
                )
                return cluster_labels, llm_stats

            except Exception as e:
                logger.warning(
                    "Topic naming failed (non-blocking) using Anthropic: %s. Using conventional topic naming.",
                    e,
                )
                logger.debug(
                    "Anthropic exception details:\n%s",
                    traceback.format_exc(),
                )

    # Conventional topic naming (fallback or when LLM naming is not requested)
    for cluster_id, characteristics in cluster_characteristics.items():
        cluster_labels[cluster_id] = _get_conventional_label(cluster_id, characteristics)

    return cluster_labels, llm_stats


def create_comment_hover_info(cluster_layer, cluster_characteristics, comment_texts):
    """
    Create hover text information for comments based on cluster characteristics.

    Args:
        cluster_layer: Cluster assignments for a specific layer
        cluster_characteristics: Dictionary with cluster characterizations
        comment_texts: List of comment text strings

    Returns:
        hover_info: List of hover text strings for each comment
    """
    hover_info = []
    for i, (text, cluster_id) in enumerate(zip(comment_texts, cluster_layer)):
        if cluster_id >= 0 and cluster_id in cluster_characteristics:
            characteristics = cluster_characteristics[cluster_id]

            # Create hover text with the comment and cluster info
            hover_text = f"{text}\n\n"
            hover_text += f"Cluster {cluster_id} - Size: {characteristics['size']}\n"

            # Add top keywords
            if "top_words" in characteristics:
                hover_text += "Keywords: " + ", ".join(characteristics["top_words"][:5])
        else:
            hover_text = f"{text}\n\nUnclustered"

        hover_info.append(hover_text)

    return hover_info


def create_basic_layer_visualization(
    output_path,
    file_prefix,
    data_map,
    cluster_layer,
    cluster_characteristics,
    cluster_labels,
    hover_info,
    title,
    sub_title,
):
    """
    Create a basic visualization with numeric topic labels for a specific layer.

    Args:
        output_path: Path to save the visualization
        file_prefix: Prefix for the output file
        data_map: 2D coordinates of data points
        cluster_layer: Cluster assignments for a specific layer
        cluster_characteristics: Dictionary with cluster characterizations
        cluster_labels: Dictionary mapping cluster IDs to topic labels
        hover_info: Hover text for each data point
        title: Title for the visualization
        sub_title: Subtitle for the visualization

    Returns:
        file_path: Path to the saved visualization
    """
    data_map_array = np.asarray(data_map)
    cluster_layer_array = np.asarray(cluster_layer)

    if data_map_array.ndim != 2 or data_map_array.shape[0] == 0:
        logger.warning(
            "Skipping basic visualization %s due to empty/invalid data_map shape: %s",
            file_prefix,
            getattr(data_map_array, "shape", None),
        )
        return None

    expected_len = data_map_array.shape[0]
    if len(cluster_layer_array) != expected_len or len(hover_info) != expected_len:
        trunc_len = min(expected_len, len(cluster_layer_array), len(hover_info))
        logger.warning(
            "Input length mismatch for %s (map=%s, clusters=%s, hover=%s). Truncating to %s.",
            file_prefix,
            expected_len,
            len(cluster_layer_array),
            len(hover_info),
            trunc_len,
        )
        if trunc_len <= 0:
            logger.warning("Skipping basic visualization %s due to no usable points.", file_prefix)
            return None
        data_map_array = data_map_array[:trunc_len]
        cluster_layer_array = cluster_layer_array[:trunc_len]
        hover_info = hover_info[:trunc_len]

    # Create labels vector
    labels_for_viz = np.array(
        [
            cluster_labels.get(int(label), f"Topic {int(label)}")
            if int(label) >= 0
            else "Unlabelled"
            for label in cluster_layer_array
        ],
        dtype=object,
    )

    # Create interactive visualization
    logger.info(f"Creating basic visualization for {file_prefix}...")
    viz_file = os.path.join(output_path, f"{file_prefix}.html")

    try:
        interactive_figure = datamapplot.create_interactive_plot(
            data_map_array,
            labels_for_viz,
            hover_text=hover_info,
            title=title,
            sub_title=sub_title,
            point_radius_min_pixels=2,
            point_radius_max_pixels=10,
            width="100%",
            height=800,
        )

        # Save the visualization
        interactive_figure.save(viz_file)
        logger.info(f"Saved basic visualization to {viz_file}")
        return viz_file
    except Exception as e:
        logger.warning(
            "Basic visualization failed for %s (%s); retrying with per-point fallback labels.",
            file_prefix,
            e,
        )
        try:
            fallback_labels = np.array(
                [f"Point {idx}" for idx in range(len(data_map_array))], dtype=object
            )
            interactive_figure = datamapplot.create_interactive_plot(
                data_map_array,
                fallback_labels,
                hover_text=hover_info,
                title=title,
                sub_title=sub_title,
                point_radius_min_pixels=2,
                point_radius_max_pixels=10,
                width="100%",
                height=800,
            )
            interactive_figure.save(viz_file)
            logger.info(
                "Saved basic visualization to %s using fallback labels", viz_file
            )
            return viz_file
        except Exception as retry_err:
            logger.error(f"Error creating basic visualization after retry: {retry_err}")
            return None


def create_named_layer_visualization(
    output_path,
    file_prefix,
    data_map,
    cluster_layer,
    cluster_labels,
    hover_info,
    title,
    sub_title,
):
    """
    Create a named visualization with explicit topic labels for a specific layer.

    Args:
        output_path: Path to save the visualization
        file_prefix: Prefix for the output file
        data_map: 2D coordinates of data points
        cluster_layer: Cluster assignments for a specific layer
        cluster_labels: Dictionary mapping cluster IDs to topic labels
        hover_info: Hover text for each data point
        title: Title for the visualization
        sub_title: Subtitle for the visualization

    Returns:
        file_path: Path to the saved visualization
    """
    data_map_array = np.asarray(data_map)
    cluster_layer_array = np.asarray(cluster_layer)

    if data_map_array.ndim != 2 or data_map_array.shape[0] == 0:
        logger.warning(
            "Skipping named visualization %s due to empty/invalid data_map shape: %s",
            file_prefix,
            getattr(data_map_array, "shape", None),
        )
        return None

    expected_len = data_map_array.shape[0]
    if len(cluster_layer_array) != expected_len or len(hover_info) != expected_len:
        trunc_len = min(expected_len, len(cluster_layer_array), len(hover_info))
        logger.warning(
            "Input length mismatch for %s (map=%s, clusters=%s, hover=%s). Truncating to %s.",
            file_prefix,
            expected_len,
            len(cluster_layer_array),
            len(hover_info),
            trunc_len,
        )
        if trunc_len <= 0:
            logger.warning("Skipping named visualization %s due to no usable points.", file_prefix)
            return None
        data_map_array = data_map_array[:trunc_len]
        cluster_layer_array = cluster_layer_array[:trunc_len]
        hover_info = hover_info[:trunc_len]

    # Create labels vector
    labels_for_viz = np.array(
        [
            cluster_labels.get(int(label), f"Topic {int(label)}")
            if int(label) >= 0
            else "Unlabelled"
            for label in cluster_layer_array
        ],
        dtype=object,
    )

    # Create interactive visualization
    logger.info(f"Creating named visualization for {file_prefix}...")
    viz_file = os.path.join(output_path, f"{file_prefix}.html")

    try:
        interactive_figure = datamapplot.create_interactive_plot(
            data_map_array,
            labels_for_viz,
            hover_text=hover_info,
            title=title,
            sub_title=sub_title,
            point_radius_min_pixels=2,
            point_radius_max_pixels=10,
            width="100%",
            height=800,
        )

        # Save the visualization
        interactive_figure.save(viz_file)
        logger.info(f"Saved named visualization to {viz_file}")
        return viz_file
    except Exception as e:
        logger.warning(
            "Named visualization failed for %s (%s); retrying with per-point fallback labels.",
            file_prefix,
            e,
        )
        try:
            fallback_labels = np.array(
                [f"Point {idx}" for idx in range(len(data_map_array))], dtype=object
            )
            interactive_figure = datamapplot.create_interactive_plot(
                data_map_array,
                fallback_labels,
                hover_text=hover_info,
                title=title,
                sub_title=sub_title,
                point_radius_min_pixels=2,
                point_radius_max_pixels=10,
                width="100%",
                height=800,
            )
            interactive_figure.save(viz_file)
            logger.info(
                "Saved named visualization to %s using fallback labels", viz_file
            )
            return viz_file
        except Exception as retry_err:
            logger.error(f"Error creating named visualization after retry: {retry_err}")
            return None


def process_layers_and_store_characteristics(
    conversation_id,
    cluster_layers,
    comment_texts,
    output_dir=None,
    dynamo_storage=None,
    job_id=None,  # Added job_id
):
    """
    Process layers and store cluster characteristics and enhanced topic names in DynamoDB.

    Args:
        conversation_id: Conversation ID string
        cluster_layers: Cluster assignments for each layer
        comment_texts: List of comment text strings
        output_dir: Optional directory to save visualization data as JSON
        dynamo_storage: Optional DynamoDBStorage object for storing in DynamoDB
        job_id: Job ID for this run

    Returns:
        Dictionary with layer data including characteristics and enhanced topic names
    """
    layer_data = {}

    for layer_idx, cluster_layer in enumerate(cluster_layers):
        logger.info(
            f"Processing layer {layer_idx} with {len(np.unique(cluster_layer[cluster_layer >= 0]))} clusters..."
        )

        # Generate cluster characteristics
        cluster_characteristics = characterize_comment_clusters(
            cluster_layer, comment_texts
        )

        # Create basic numeric topic names
        numeric_labels = {
            str(i): f"Topic {i}" for i in np.unique(cluster_layer[cluster_layer >= 0])
        }

        # Store layer data
        layer_data[layer_idx] = {
            "characteristics": cluster_characteristics,
            "numeric_topic_names": numeric_labels,
        }

        # Save data to files if output directory provided
        if output_dir:
            # Save cluster characteristics
            with open(
                os.path.join(
                    output_dir,
                    f"{conversation_id}_comment_layer_{layer_idx}_characteristics.json",
                ),
                "w",
            ) as f:
                json_compatible = json.dumps(
                    cluster_characteristics,
                    default=lambda x: float(x) if isinstance(x, np.float32) else x,
                )
                f.write(json_compatible)

            # Save numeric topic names
            with open(
                os.path.join(
                    output_dir, f"{conversation_id}_layer_{layer_idx}_topic_names.json"
                ),
                "w",
            ) as f:
                json.dump(numeric_labels, f, indent=2)

        # Store in DynamoDB if provided
        if dynamo_storage:
            # Convert and store cluster characteristics
            logger.info(
                f"Storing cluster characteristics for layer {layer_idx} in DynamoDB..."
            )
            characteristic_models = DataConverter.batch_convert_cluster_characteristics(
                conversation_id, cluster_characteristics, layer_idx
            )  # job_id is not directly part of characteristics PK, but good to have if we extend

            result = dynamo_storage.batch_create_cluster_characteristics(
                characteristic_models
            )
            logger.info(
                f"Stored {result['success']} cluster characteristics with {result['failure']} failures"
            )

    logger.info("Processing of layers and storing characteristics complete!")
    return layer_data


def create_static_datamapplot(
    conversation_id,
    document_map,
    cluster_layer,
    cluster_labels,
    output_dir,
    layer_num=0,
):
    """
    Generate static datamapplot visualizations for a layer.

    Args:
        conversation_id: Conversation ID string
        document_map: 2D coordinates for visualization
        cluster_layer: Cluster assignments for this layer
        cluster_labels: Dictionary mapping cluster IDs to topic names
        output_dir: Directory to save visualizations
        layer_num: Layer number (default 0)

    Returns:
        Boolean indicating success
    """
    logger.info(
        f"Generating static datamapplot for conversation {conversation_id}, layer {layer_num}"
    )

    try:
        # Create visualization directory if it doesn't exist
        # Default location in the project structure
        vis_dir = os.path.join("visualizations", str(conversation_id))
        os.makedirs(vis_dir, exist_ok=True)

        # Also ensure the output directory exists in the pipeline's structure
        # This is typically polis_data/zid/python_output/comments_enhanced_multilayer
        os.makedirs(output_dir, exist_ok=True)

        # Prepare label strings with topic names
        def clean_topic_name(name):
            # Remove asterisks from topic names (e.g., "**Topic Name**" becomes "Topic Name")
            if isinstance(name, str):
                return name.replace("*", "")
            return name

        # Create labels vector
        label_strings = np.array(
            [
                (
                    clean_topic_name(cluster_labels.get(label, f"Topic {label}"))
                    if label >= 0
                    else "Unclustered"
                )
                for label in cluster_layer
            ]
        )

        # Generate the static plot - it returns (fig, ax) tuple
        fig, ax = datamapplot.create_plot(
            document_map,
            label_strings,
            title=f"Conversation {conversation_id} - Layer {layer_num}",
            label_over_points=True,  # Place labels directly over the point clusters
            dynamic_label_size=True,  # Vary label size based on cluster size
            dynamic_label_size_scaling_factor=0.75,
            max_font_size=28,  # Maximum font size for labels
            min_font_size=12,  # Minimum font size for labels
            label_wrap_width=15,  # Wrap long cluster names
            point_size=3,  # Size of the data points
            noise_label="Unclustered",  # Label for uncategorized points
            noise_color="#aaaaaa",  # Grey color for uncategorized points
            color_label_text=True,  # Color the label text to match points
            cvd_safer=True,  # Use CVD-safer colors
        )

        # Save to both locations: default visualizations directory and pipeline output

        # 1. Save to visualizations directory
        # Regular PNG
        static_png = os.path.join(
            vis_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_static.png"
        )
        fig.savefig(static_png, dpi=300, bbox_inches="tight")
        logger.info(f"Saved static PNG to {static_png}")

        # High resolution PNG for presentations
        presentation_png = os.path.join(
            vis_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_presentation.png"
        )
        fig.savefig(presentation_png, dpi=600, bbox_inches="tight")
        logger.info(f"Saved high-resolution PNG to {presentation_png}")

        # SVG for vector graphics
        svg_file = os.path.join(
            vis_dir, f"{conversation_id}_layer_{layer_num}_datamapplot_static.svg"
        )
        fig.savefig(svg_file, format="svg", bbox_inches="tight")
        logger.info(f"Saved vector SVG to {svg_file}")

        # 2. Save the same files to the pipeline output directory
        if output_dir != vis_dir:
            # Regular PNG
            output_static_png = os.path.join(
                output_dir,
                f"{conversation_id}_layer_{layer_num}_datamapplot_static.png",
            )
            fig.savefig(output_static_png, dpi=300, bbox_inches="tight")
            logger.info(f"Saved static PNG to pipeline output: {output_static_png}")

            # High resolution PNG for presentations
            output_presentation_png = os.path.join(
                output_dir,
                f"{conversation_id}_layer_{layer_num}_datamapplot_presentation.png",
            )
            fig.savefig(output_presentation_png, dpi=600, bbox_inches="tight")
            logger.info(
                f"Saved high-resolution PNG to pipeline output: {output_presentation_png}"
            )

            # SVG for vector graphics
            output_svg_file = os.path.join(
                output_dir,
                f"{conversation_id}_layer_{layer_num}_datamapplot_static.svg",
            )
            fig.savefig(output_svg_file, format="svg", bbox_inches="tight")
            logger.info(f"Saved vector SVG to pipeline output: {output_svg_file}")

        return True

    except Exception as e:
        logger.error(f"Error generating static datamapplot: {str(e)}")
        logger.error(traceback.format_exc())
        return False


def create_visualizations(
    conversation_id,
    conversation_name,
    document_map,
    cluster_layers,
    comment_texts,
    output_dir,
    layer_data=None,
):
    """
    Create visualizations based on processed layer data.

    Args:
        conversation_id: Conversation ID string
        conversation_name: Name of the conversation
        document_map: 2D coordinates for visualization
        cluster_layers: Cluster assignments for each layer
        comment_texts: List of comment text strings
        output_dir: Directory to save visualizations
        layer_data: Optional dictionary with layer data including characteristics and enhanced topic names

    Returns:
        The path to the index file
    """
    # If layer_data not provided, generate it
    if layer_data is None:
        logger.info("Layer data not provided, generating it...")
        layer_data = {}
        for layer_idx, cluster_layer in enumerate(cluster_layers):
            # Generate cluster characteristics
            characteristics = characterize_comment_clusters(
                cluster_layer, comment_texts
            )

            # Create basic numeric topic names
            numeric_labels = {
                i: f"Topic {i}" for i in np.unique(cluster_layer[cluster_layer >= 0])
            }

            layer_data[layer_idx] = {
                "characteristics": characteristics,
                "numeric_topic_names": numeric_labels,
            }

    # Create visualizations
    layer_files = []
    layer_info = []

    for layer_idx, cluster_layer in enumerate(cluster_layers):
        if layer_idx not in layer_data:
            logger.warning(
                f"No layer data for layer {layer_idx}, skipping visualization..."
            )
            continue

        # Get characteristics and numeric topic names
        characteristics = layer_data[layer_idx]["characteristics"]
        numeric_topic_names = layer_data[layer_idx]["numeric_topic_names"]

        # Create hover information
        hover_info = create_comment_hover_info(
            cluster_layer, characteristics, comment_texts
        )

        # Create basic visualization
        create_basic_layer_visualization(
            output_dir,
            f"{conversation_id}_comment_layer_{layer_idx}_basic",
            document_map,
            cluster_layer,
            characteristics,
            numeric_topic_names,
            hover_info,
            f"{conversation_name} Comment Layer {layer_idx} - {len(np.unique(cluster_layer[cluster_layer >= 0]))} topics",
            "Comment topics with numeric labels",
        )

        # Create named visualization with just numeric topic names for now
        # (LLM names will be added in a separate step later)
        named_file = create_named_layer_visualization(
            output_dir,
            f"{conversation_id}_comment_layer_{layer_idx}_named",
            document_map,
            cluster_layer,
            numeric_topic_names,
            hover_info,
            f"{conversation_name} Comment Layer {layer_idx} - {len(np.unique(cluster_layer[cluster_layer >= 0]))} topics",
            "Comment topics (to be updated with LLM topic names)",
        )

        # Generate static datamapplot visualizations
        # TEMPORARILY DISABLED - These static files aren't used by the web interface
        # create_static_datamapplot(
        #     conversation_id,
        #     document_map,
        #     cluster_layer,
        #     numeric_topic_names,
        #     output_dir,
        #     layer_idx
        # )

        # Generate consensus/divisive visualization
        # TEMPORARILY DISABLED - These files aren't used by the web interface and slow down processing
        # try:
        #     logger.info(f"Generating consensus/divisive visualization for layer {layer_idx}...")
        #     # Use subprocess to run as a separate process to avoid any memory leaks
        #     import subprocess
        #     script_path = os.path.join(os.path.dirname(__file__), "702_consensus_divisive_datamapplot.py")
        #     command = [
        #         "python", script_path,
        #         "--zid", str(conversation_id),
        #         "--layer", str(layer_idx),
        #         "--output_dir", output_dir
        #     ]
        #
        #     # Run the script with appropriate environment variables
        #     env = os.environ.copy()
        #     process = subprocess.Popen(
        #         command,
        #         env=env,
        #         stdout=subprocess.PIPE,
        #         stderr=subprocess.PIPE,
        #         universal_newlines=True
        #     )
        #     stdout, stderr = process.communicate()
        #
        #     if process.returncode != 0:
        #         logger.warning(f"Consensus/divisive visualization failed: {stderr}")
        #     else:
        #         logger.info(f"Consensus/divisive visualization for layer {layer_idx} completed successfully")
        #
        # except Exception as e:
        #     logger.warning(f"Error running consensus/divisive visualization: {e}")

        # Add to list of layer files and info
        if named_file:
            layer_files.append(named_file)
            layer_info.append(
                (layer_idx, len(np.unique(cluster_layer[cluster_layer >= 0])))
            )

    # Create index file
    index_file = create_enhanced_multilayer_index(
        output_dir, conversation_id, layer_files, layer_info
    )

    logger.info("Visualization creation complete!")
    logger.info(f"Index file available at: {index_file}")

    # Try to open in browser
    # try:
    #     import webbrowser
    #     webbrowser.open(f"file://{index_file}")
    # except:
    #     pass

    return index_file


def process_layers_and_create_visualizations(
    conversation_id,
    conversation_name,
    document_map,
    cluster_layers,
    comment_texts,
    output_dir,
    enable_llm_topic_naming=False,
    dynamo_storage=None,
    job_id=None,  # Added job_id
):
    """
    Process layers, store data, and create visualizations.

    Args:
        conversation_id: Conversation ID string
        conversation_name: Name of the conversation
        document_map: 2D coordinates for visualization
        cluster_layers: Cluster assignments for each layer
        comment_texts: List of comment text strings
        output_dir: Directory to save visualizations
        enable_llm_topic_naming: Whether to use LLM (Anthropic) for topic naming
        dynamo_storage: Optional DynamoDBStorage object for storing in DynamoDB
        job_id: Job ID for this run
    """
    # Process layers and store characteristics
    layer_data = process_layers_and_store_characteristics(
        conversation_id,
        cluster_layers,
        comment_texts,
        output_dir=output_dir,
        dynamo_storage=dynamo_storage,
        job_id=job_id,  # Pass job_id
    )

    # Create visualizations with basic numeric labels
    index_file = create_visualizations(
        conversation_id,
        conversation_name,
        document_map,
        cluster_layers,
        comment_texts,
        output_dir,
        layer_data=layer_data,
    )

    # LLM topic naming
    # If enabled, treat "0 successful LLM labels" as a hard failure. This prevents jobs from being
    # marked COMPLETED when the LLM returns overload/error placeholders for every cluster.
    strict_llm = os.environ.get("DELPHI_STRICT_LLM", "0").strip().lower() not in ("0", "false", "no")

    if enable_llm_topic_naming:
        total_llm_succeeded = 0
        total_llm_attempted = 0
        total_clusters = 0
        for layer_idx, cluster_layer in enumerate(cluster_layers):
            try:
                characteristics = layer_data[layer_idx]["characteristics"]

                # Count clusters (exclude noise -1)
                unique_clusters = np.unique(cluster_layer)
                unique_clusters = unique_clusters[unique_clusters >= 0]
                total_clusters += int(len(unique_clusters))

                logger.info(
                    f"Generating LLM topic names for layer {layer_idx} with Anthropic..."
                )
                cluster_labels, llm_stats = generate_cluster_topic_labels(
                    characteristics,
                    comment_texts=comment_texts,
                    layer=cluster_layer,
                    layer_idx=layer_idx,
                    conversation_name=conversation_name,
                    enable_llm_topic_naming=True,
                    document_map=document_map,
                )

                total_llm_attempted += int(llm_stats.get("attempted", 0))
                total_llm_succeeded += int(llm_stats.get("succeeded", 0))

                if not cluster_labels:
                    logger.warning(
                        f"Topic naming produced no labels (non-blocking) for layer {layer_idx}; skipping persistence"
                    )
                    continue

                # Save LLM topic names
                with open(
                    os.path.join(
                        output_dir,
                        f"{conversation_id}_comment_layer_{layer_idx}_labels.json",
                    ),
                    "w",
                ) as f:
                    json.dump(cluster_labels, f, indent=2)

                # Store in DynamoDB if provided
                if dynamo_storage:
                    try:
                        logger.info(
                            f"Storing LLM topic names for layer {layer_idx} in DynamoDB..."
                        )
                        model_name = os.environ.get("ANTHROPIC_MODEL")
                        llm_topic_models = DataConverter.batch_convert_llm_topic_names(
                            conversation_id,
                            cluster_labels,
                            layer_idx,
                            model_name=model_name,  # Model used for LLM topic naming
                            job_id=job_id,  # Pass job_id
                        )
                        result = dynamo_storage.batch_create_llm_topic_names(
                            llm_topic_models
                        )
                        logger.info(
                            f"Stored {result['success']} LLM topic names with {result['failure']} failures"
                        )
                    except Exception as e:
                        logger.warning(
                            f"Failed to persist LLM topic names (non-blocking) for layer {layer_idx}: {e}"
                        )
                        logger.debug(
                            "LLM topic persistence exception details:\n%s",
                            traceback.format_exc(),
                        )
            except Exception as e:
                logger.warning(f"Topic naming failed for layer {layer_idx}: {e}")
                logger.debug(
                    "Topic naming layer exception details:\n%s", traceback.format_exc()
                )
                continue

            # Create a new static datamapplot with the LLM labels
            # logger.info(f"Generating static datamapplot with LLM labels for layer {layer_idx}...")
            # create_static_datamapplot(
            #     conversation_id,
            #     document_map,
            #     cluster_layer,
            #     cluster_labels,
            #     output_dir,
            #     layer_idx
            # )
            logger.info(
                f"Skipped static datamapplot with LLM labels for layer {layer_idx}..."
            )

        if strict_llm and total_clusters > 0 and total_llm_succeeded == 0:
            raise RuntimeError(
                f"LLM topic naming enabled but produced 0 successful labels across {total_clusters} clusters "
                f"({total_llm_attempted} LLM attempts)."
            )

        # --- Topic Distinction Enforcement ---
        # After all layers have topic names, check for similar topics within each layer
        # and revise them for distinctness before they're used in narrative prompts.
        if dynamo_storage and total_llm_succeeded > 0:
            try:
                import importlib.util
                _distinction_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "752_enforce_topic_distinction.py")
                _spec = importlib.util.spec_from_file_location("enforce_topic_distinction_752", _distinction_path)
                _mod = importlib.util.module_from_spec(_spec)
                _spec.loader.exec_module(_mod)

                anthropic_model = os.environ.get("ANTHROPIC_MODEL")
                logger.info("Running topic distinction enforcement for conversation %s...", conversation_id)
                distinction_result = _mod.enforce_topic_distinction(
                    conversation_id=conversation_id,
                    anthropic_model=anthropic_model,
                )
                logger.info(
                    "Topic distinction: layers_checked=%d, revised=%d topics",
                    distinction_result.get("layers_checked", 0),
                    distinction_result.get("topics_revised", 0),
                )
            except Exception as e:
                logger.warning("Topic distinction enforcement failed (non-blocking): %s", e, exc_info=True)

    return index_file


def create_enhanced_multilayer_index(
    output_path, conversation_name, layer_files, layer_info
):
    """
    Create an index HTML file linking to all enhanced layer visualizations.

    Args:
        output_path: Path to save the index file
        conversation_name: Name of the conversation
        layer_files: List of paths to layer visualization files
        layer_info: List of tuples (layer_idx, num_clusters) for each layer

    Returns:
        file_path: Path to the saved index file
    """
    index_file = os.path.join(
        output_path, f"{conversation_name}_comment_enhanced_index.html"
    )

    with open(index_file, "w") as f:
        f.write(
            f"""<!DOCTYPE html>
<html>
<head>
    <title>{conversation_name} - Enhanced Multi-layer Comment Visualization</title>
    <style>
        body {{ font-family: Arial, sans-serif; margin: 20px; }}
        h1 {{ color: #333; }}
        .layer-container {{ margin-bottom: 30px; }}
        .description {{ margin-bottom: 10px; }}
        iframe {{ border: 1px solid #ddd; width: 100%; height: 600px; }}
        .button-container {{ margin-bottom: 10px; }}
        .button {{
            background-color: #4CAF50;
            border: none;
            color: white;
            padding: 10px 20px;
            text-align: center;
            text-decoration: none;
            display: inline-block;
            font-size: 16px;
            margin: 4px 2px;
            cursor: pointer;
            border-radius: 4px;
        }}
        .view-options {{
            margin: 10px 0;
            display: flex;
            gap: 10px;
        }}
        .view-link {{
            padding: 5px 10px;
            background-color: #f0f0f0;
            color: #333;
            text-decoration: none;
            border-radius: 4px;
            font-weight: bold;
        }}
        .view-link:hover {{
            background-color: #e0e0e0;
        }}
        .active {{
            background-color: #007BFF;
            color: white;
        }}
        .static-downloads {{
            margin: 10px 0;
            padding: 10px;
            background-color: #f8f9fa;
            border-radius: 4px;
            border: 1px solid #e9ecef;
        }}
        .static-downloads h3 {{
            margin-top: 0;
            font-size: 16px;
        }}
        .static-downloads a {{
            display: inline-block;
            margin-right: 15px;
            color: #0066cc;
            text-decoration: none;
        }}
        .static-downloads a:hover {{
            text-decoration: underline;
        }}
    </style>
</head>
<body>
    <h1>{conversation_name} - Enhanced Multi-layer Comment Visualization</h1>
    <p>This page provides access to different layers of clustering granularity with topic labeling:</p>

    <div class="button-container">
        <button class="button" onclick="window.location.reload();">Refresh Page</button>
    </div>
"""
        )

        # Add links to each layer
        for (layer_idx, num_clusters), file_path in zip(layer_info, layer_files):
            file_name = os.path.basename(file_path)
            basic_view_file = file_name.replace("_named.html", "_enhanced.html")
            named_view_file = file_name

            # Static file references
            static_png = f"{conversation_name}_layer_{layer_idx}_datamapplot_static.png"
            presentation_png = (
                f"{conversation_name}_layer_{layer_idx}_datamapplot_presentation.png"
            )
            static_svg = f"{conversation_name}_layer_{layer_idx}_datamapplot_static.svg"

            # Consensus/divisive visualization references
            consensus_png = f"{conversation_name}_consensus_divisive_colored_map.png"
            consensus_enhanced = f"{conversation_name}_consensus_divisive_enhanced.png"

            description = (
                "Fine-grained grouping"
                if layer_idx == 0
                else (
                    "Coarser grouping"
                    if layer_idx == len(layer_info) - 1
                    else "Medium granularity"
                )
            )

            f.write(
                f"""
    <div class="layer-container">
        <h2>Layer {layer_idx}</h2>
        <p class="description">{description} with topic labels</p>
        <div class="view-options">
            <a href="{basic_view_file}" class="view-link " target="_blank">Basic View</a>
            <a href="{named_view_file}" class="view-link active" target="_blank">Named View (LLM-labeled)</a>
        </div>

        <div class="static-downloads">
            <h3>Static Visualizations:</h3>
            <a href="{static_png}" target="_blank">Standard PNG</a>
            <a href="{presentation_png}" target="_blank">Presentation PNG (HiRes)</a>
            <a href="{static_svg}" target="_blank">Vector SVG</a>
        </div>

        <div class="static-downloads">
            <h3>Consensus/Divisive Visualizations:</h3>
            <a href="{consensus_png}" target="_blank">Consensus Map</a>
            <a href="{consensus_enhanced}" target="_blank">Enhanced Consensus Map</a>
            <p><strong>Color legend:</strong> Green = Consensus Comments, Yellow = Mixed Opinions, Red = Divisive Comments</p>
        </div>

        <iframe src="{named_view_file}"></iframe>
    </div>
"""
            )

        f.write(
            """
</body>
</html>
"""
        )

    logger.info(f"Created enhanced multi-layer index at {index_file}")
    return index_file


def process_conversation(
    zid, export_dynamo=True, enable_llm_topic_naming=False, include_moderation=False
):
    """
    Main function to process a conversation and generate visualizations.

    Args:
        zid: Conversation ID
        export_dynamo: Whether to export results to DynamoDB
        enable_llm_topic_naming: Whether to use LLM (Anthropic) for topic naming
    """
    # Create conversation directory
    output_dir = os.path.join(
        "polis_data", str(zid), "python_output", "comments_enhanced_multilayer"
    )
    os.makedirs(output_dir, exist_ok=True)

    # Fetch data from PostgreSQL
    comments, metadata = fetch_conversation_data(zid)
    if not comments:
        logger.error("Failed to fetch conversation data.")
        return False

    logger.info(f"moderation status: {include_moderation}")

    if include_moderation:
        comments = [comment for comment in comments if comment["mod"] > -1]

    # Generate a job_id for this pipeline run
    # If DELPHI_JOB_ID is set (e.g., by a calling script like run_delphi.py), use that.
    job_id = os.environ.get("DELPHI_JOB_ID", f"pipeline_run_{uuid.uuid4()}")
    logger.info(f"Using job_id: {job_id} for this pipeline run.")

    conversation_id = str(zid)
    conversation_name = metadata.get("conversation_name", f"Conversation {zid}")

    # Process comments
    document_map, document_vectors, cluster_layers, comment_texts, comment_ids = (
        process_comments(comments, conversation_id)
    )

    # Initialize DynamoDB storage if requested
    dynamo_storage = None
    if export_dynamo:
        # Use endpoint from environment if available
        raw_endpoint = os.environ.get("DYNAMODB_ENDPOINT")
        endpoint_url = raw_endpoint if raw_endpoint and raw_endpoint.strip() else None
        logger.info(f"Using DynamoDB endpoint from environment: {endpoint_url}")
        region = os.environ.get("AWS_REGION", "us-east-1")

        dynamo_storage = DynamoDBStorage(region_name=region, endpoint_url=endpoint_url)

        # Store basic data in DynamoDB
        logger.info(
            f"Storing basic data in DynamoDB for conversation {conversation_id}..."
        )

        # Store conversation metadata
        logger.info("Storing conversation metadata...")
        conversation_meta = DataConverter.create_conversation_meta(
            conversation_id, document_vectors, cluster_layers, metadata
        )
        dynamo_storage.create_conversation_meta(conversation_meta)

        # Store embeddings
        logger.info("Storing comment embeddings...")
        embedding_models = DataConverter.batch_convert_embeddings(
            conversation_id, document_vectors, comment_ids
        )
        result = dynamo_storage.batch_create_comment_embeddings(embedding_models)
        logger.info(
            f"Stored {result['success']} embeddings with {result['failure']} failures"
        )

        # Store UMAP graph edges
        logger.info("Storing UMAP graph edges...")
        edge_models = DataConverter.batch_convert_umap_edges(
            conversation_id, document_map, cluster_layers, comment_ids=comment_ids
        )
        result = dynamo_storage.batch_create_graph_edges(edge_models)
        logger.info(
            f"Stored {result['success']} UMAP graph edges with {result['failure']} failures"
        )

        # Store cluster assignments
        logger.info("Storing comment cluster assignments...")
        cluster_models = DataConverter.batch_convert_clusters(
            conversation_id, cluster_layers, document_map, comment_ids
        )
        result = dynamo_storage.batch_create_comment_clusters(cluster_models)
        logger.info(
            f"Stored {result['success']} cluster assignments with {result['failure']} failures"
        )

        # Store cluster topics (basic info only)
        logger.info("Storing cluster topics...")
        topic_models = DataConverter.batch_convert_topics(
            conversation_id,
            cluster_layers,
            document_map,
            comment_texts,
            topic_names={},  # No topic names yet
            characteristics={},  # No characteristics yet
        )
        result = dynamo_storage.batch_create_cluster_topics(topic_models)
        logger.info(
            f"Stored {result['success']} topics with {result['failure']} failures"
        )

    # Process layers, store characteristics, and create visualizations
    process_layers_and_create_visualizations(
        conversation_id,
        conversation_name,
        document_map,
        cluster_layers,
        comment_texts,
        output_dir,
        enable_llm_topic_naming=enable_llm_topic_naming,
        dynamo_storage=dynamo_storage,
        job_id=job_id,  # Pass job_id
    )

    # Save metadata
    with open(os.path.join(output_dir, f"{conversation_id}_metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    logger.info(f"Processing of conversation {conversation_id} complete!")

    return True


def main():
    """Main entry point."""
    # Parse arguments
    import argparse

    parser = argparse.ArgumentParser(
        description="Process Polis conversation from PostgreSQL"
    )
    parser.add_argument(
        "--zid",
        type=int,
        required=False,
        default=22154,
        help="Conversation ID to process",
    )
    parser.add_argument(
        "--no-dynamo", action="store_true", help="Skip exporting to DynamoDB"
    )
    parser.add_argument("--db-host", type=str, default=None, help="PostgreSQL host")
    parser.add_argument("--db-port", type=int, default=None, help="PostgreSQL port")
    parser.add_argument(
        "--db-name", type=str, default=None, help="PostgreSQL database name"
    )
    parser.add_argument("--db-user", type=str, default=None, help="PostgreSQL user")
    parser.add_argument(
        "--db-password", type=str, default=None, help="PostgreSQL password"
    )
    parser.add_argument(
        "--use-mock-data",
        action="store_true",
        help="Use mock data instead of connecting to PostgreSQL",
    )
    parser.add_argument(
        "--enable-llm-topic-naming",
        action="store_true",
        help="Enable LLM topic naming for clusters (uses Anthropic via ANTHROPIC_MODEL)",
    )
    parser.add_argument(
        "--include_moderation",
        action="store_true",
        help="Include moderated comments in reports (flag: present=True, absent=False).",
    )

    args = parser.parse_args()

    # Set up environment
    setup_environment(
        db_host=args.db_host,
        db_port=args.db_port,
        db_name=args.db_name,
        db_user=args.db_user,
        db_password=args.db_password,
    )

    if args.enable_llm_topic_naming:
        logger.info("LLM topic naming is enabled (Anthropic)")

    # Process conversation
    if args.use_mock_data:
        logger.info("Using mock data instead of connecting to PostgreSQL")
        # Create mock comments data
        mock_comments = []
        for i in range(100):
            mock_comments.append(
                {
                    "tid": i,
                    "zid": args.zid,
                    "txt": f"This is a mock comment {i} for testing purposes without PostgreSQL connection.",
                    "created": datetime.now().isoformat(),
                    "pid": i % 20,  # Mock 20 different participants
                    "active": True,
                }
            )

        # Create mock metadata
        mock_metadata = {
            "conversation_id": str(args.zid),
            "zid": args.zid,
            "conversation_name": f"Mock Conversation {args.zid}",
            "description": "Mock conversation for testing without PostgreSQL",
            "created": datetime.now().isoformat(),
            "modified": datetime.now().isoformat(),
            "owner": "mock_user",
            "num_comments": len(mock_comments),
        }

        # Process with mock data
        document_map, document_vectors, cluster_layers, comment_texts, comment_ids = (
            process_comments(mock_comments, str(args.zid))
        )

        # Process each layer and create visualizations
        output_dir = os.path.join(
            "polis_data", str(args.zid), "python_output", "comments_enhanced_multilayer"
        )
        os.makedirs(output_dir, exist_ok=True)

        process_layers_and_create_visualizations(
            str(args.zid),
            mock_metadata.get("conversation_name"),
            document_map,
            cluster_layers,
            comment_texts,
            output_dir,
            enable_llm_topic_naming=args.enable_llm_topic_naming,
        )
    else:
        # Process with real data from PostgreSQL
        ok = process_conversation(
            args.zid,
            export_dynamo=not args.no_dynamo,
            enable_llm_topic_naming=args.enable_llm_topic_naming,
            include_moderation=args.include_moderation,
        )

        if not ok:
            raise RuntimeError("Conversation processing failed")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logger.error("Fatal error in run_pipeline: %s", e)
        logger.debug("Fatal exception details:\n%s", traceback.format_exc())
        raise
