"""Fetch the exact Pol.is math snapshot Agora's results page displays.

The Survey > Results page reads `agora_polis_results.math_pca2`, captured when
results were generated. The Delphi report stage used to re-read live
`math_main` instead. Pol.is maths can re-tick between the two (k-means is
stochastic), which changes the tribe split and therefore the statements a
narrative reports on.

This module resolves the stored snapshot through Agora's internal endpoint.
Failures are deliberately soft: callers fall back to live `math_main` so direct
CLI runs and older deployments keep working.
"""

import logging
import os
from typing import Any, Dict, Optional
from urllib.parse import quote

import requests

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 30


def _agora_backend_url() -> Optional[str]:
    value = os.environ.get('AGORA_BACKEND_URL') or os.environ.get('AGORA_API_URL')
    return value.rstrip('/') if value else None


def _internal_key() -> Optional[str]:
    return os.environ.get('POLIS_INTERNAL_PROXY_SECRET') or os.environ.get('POLIS_INTERNAL_KEY')


def _timeout_seconds() -> float:
    raw = os.environ.get('AGORA_MATH_SNAPSHOT_TIMEOUT_SECONDS')
    if not raw:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_TIMEOUT_SECONDS


def resolve_agora_deliberation_id(
    conversation_id: Optional[str],
    timeout: Optional[float] = None,
) -> Optional[str]:
    """Resolve a Pol.is conversation id (zid) to its Agora deliberation id.

    The Delphi job payload normally carries `deliberation_id`, but older job
    pollers (and direct CLI runs) only know the conversation id. Agora already
    exposes the mapping internally, so resolve it rather than silently falling
    back to live `math_main`.
    """
    if not conversation_id:
        return None

    backend_url = _agora_backend_url()
    internal_key = _internal_key()
    if not backend_url or not internal_key:
        return None

    url = (
        f"{backend_url}/api/v1/internal/deliberation-by-zid/"
        f"{quote(str(conversation_id), safe='')}"
    )

    try:
        response = requests.get(
            url,
            headers={'x-polis-internal-key': internal_key},
            timeout=timeout if timeout is not None else _timeout_seconds(),
        )
    except requests.RequestException as exc:
        logger.warning(
            'Could not resolve deliberation id for conversation %s: %s',
            conversation_id,
            exc,
        )
        return None

    if response.status_code != 200:
        logger.debug(
            'Deliberation lookup for conversation %s returned HTTP %s',
            conversation_id,
            response.status_code,
        )
        return None

    try:
        payload = response.json()
    except ValueError:
        return None

    deliberation_id = payload.get('deliberation_id') if isinstance(payload, dict) else None
    return str(deliberation_id) if deliberation_id else None


def fetch_agora_report_inputs(
    deliberation_id: Optional[str],
    timeout: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """Return the stored math and canonical group-consensus selections, or None.

    Args:
        deliberation_id: Agora deliberation id (NOT the numeric Pol.is zid).
        timeout: Optional request timeout in seconds.

    Returns:
        A dictionary containing Agora's `math_pca2` and, on current deployments,
        `group_consensus_statements`, `group_division_statements` and
        `uncertainty_statements`. Returns None when the snapshot is
        unavailable (missing config, 404, transport error, or malformed
        response). Never raises.
    """
    if not deliberation_id:
        return None

    backend_url = _agora_backend_url()
    internal_key = _internal_key()
    if not backend_url or not internal_key:
        logger.debug(
            'Agora math snapshot unavailable: AGORA_BACKEND_URL or '
            'POLIS_INTERNAL_PROXY_SECRET is not set'
        )
        return None

    url = (
        f"{backend_url}/api/v1/internal/deliberations/"
        f"{quote(str(deliberation_id), safe='')}/polis-math-snapshot"
    )

    try:
        response = requests.get(
            url,
            headers={'x-polis-internal-key': internal_key},
            timeout=timeout if timeout is not None else _timeout_seconds(),
        )
    except requests.RequestException as exc:
        logger.warning(
            'Could not fetch Agora math snapshot for deliberation %s: %s',
            deliberation_id,
            exc,
        )
        return None

    if response.status_code == 404:
        logger.info(
            'No stored Agora math snapshot for deliberation %s; the report will '
            'fall back to live math_main',
            deliberation_id,
        )
        return None

    if response.status_code != 200:
        logger.warning(
            'Agora math snapshot request failed for deliberation %s: HTTP %s',
            deliberation_id,
            response.status_code,
        )
        return None

    try:
        payload = response.json()
    except ValueError as exc:
        logger.warning(
            'Agora math snapshot for deliberation %s was not valid JSON: %s',
            deliberation_id,
            exc,
        )
        return None

    math_pca2 = payload.get('math_pca2') if isinstance(payload, dict) else None
    if not isinstance(math_pca2, dict):
        logger.warning(
            'Agora math snapshot for deliberation %s did not contain a math_pca2 object',
            deliberation_id,
        )
        return None

    selections = payload.get('group_consensus_statements') if isinstance(payload, dict) else None
    if not isinstance(selections, dict):
        selections = None

    divisions = payload.get('group_division_statements') if isinstance(payload, dict) else None
    if not isinstance(divisions, list):
        divisions = None

    uncertainty = payload.get('uncertainty_statements') if isinstance(payload, dict) else None
    if not isinstance(uncertainty, list):
        uncertainty = None

    logger.info(
        'Loaded stored Agora math snapshot for deliberation %s (math_tick=%s)',
        deliberation_id,
        math_pca2.get('math_tick'),
    )
    return {
        'math_pca2': math_pca2,
        'group_consensus_statements': selections,
        'group_division_statements': divisions,
        'uncertainty_statements': uncertainty,
    }


def fetch_agora_math_snapshot(
    deliberation_id: Optional[str],
    timeout: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """Return the stored `math_pca2` payload for compatibility with callers."""
    report_inputs = fetch_agora_report_inputs(deliberation_id, timeout=timeout)
    return report_inputs.get('math_pca2') if report_inputs else None
