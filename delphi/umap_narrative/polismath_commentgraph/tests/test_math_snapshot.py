"""Delphi must report on the same maths snapshot the results page displays.

The page reads `agora_polis_results.math_pca2`, captured when results were
generated. The report stage used to re-read live `math_main`; Pol.is can re-tick
between the two (k-means is stochastic), changing the tribe split and therefore
which statements the narrative describes.
"""

import pytest

from polismath_commentgraph.utils.group_data import GroupDataProcessor

try:  # `umap_narrative` is importable in the container (/app on PYTHONPATH)
    from umap_narrative.agora_math_snapshot import (
        fetch_agora_report_inputs,
        fetch_agora_math_snapshot,
        resolve_agora_deliberation_id,
    )
except ImportError:  # pragma: no cover - direct module path when running from umap_narrative/
    from agora_math_snapshot import (  # type: ignore
        fetch_agora_report_inputs,
        fetch_agora_math_snapshot,
        resolve_agora_deliberation_id,
    )


SNAPSHOT = {
    "math_tick": 1,
    "tids": [1, 2, 3],
    "pca": {"comment-extremity": [0.5, 0.7, 0.9]},
    "group-aware-consensus": {"1": 0.8, "2": 0.4, "3": 0.2},
    "group-votes": {
        "0": {
            "votes": {
                "1": {"A": 3, "D": 0, "S": 4},
                "2": {"A": 1, "D": 2, "S": 3},
            }
        },
        "1": {
            "votes": {
                "1": {"A": 1, "D": 2, "S": 3},
                "2": {"A": 3, "D": 0, "S": 4},
            }
        },
    },
    # group-clusters members are BASE-cluster ids; base-clusters maps them to people.
    "base-clusters": {
        "id": [10, 11],
        "count": [2, 2],
        "members": [[101, 102], [103, 104]],
    },
    "group-clusters": [
        {"id": 0, "members": [10]},
        {"id": 1, "members": [11]},
    ],
}


class _ExplodingPostgres:
    """Fails if the snapshot path touches live votes or live math_main."""

    def get_math_main_by_conversation(self, zid):
        raise AssertionError("live math_main must not be read when a snapshot is supplied")

    def get_votes_by_conversation(self, zid):
        raise AssertionError("live votes must not be read when snapshot group-votes are supplied")

    def get_comments_by_conversation(self, zid):
        return [
            {"tid": 1, "txt": "live", "mod": 1, "active": True},
            {"tid": 2, "txt": "removed", "mod": 0, "active": False},
            {"tid": 3, "txt": "not in the maths", "mod": 1, "active": True},
        ]


def _processor(postgres=None):
    processor = GroupDataProcessor.__new__(GroupDataProcessor)
    processor.postgres_client = postgres or _ExplodingPostgres()
    return processor


def test_group_assignments_resolve_base_cluster_ids_to_participants():
    processor = _processor()

    assignments = processor._extract_group_assignments(SNAPSHOT)

    assert assignments == {"101": 0, "102": 0, "103": 1, "104": 1}


def test_snapshot_group_votes_are_used_instead_of_live_votes():
    processor = _processor()

    result = processor.get_vote_data_by_groups(73, math_data=SNAPSHOT)

    assert result["vote_data"][1] == {
        "total_votes": 7,
        "total_agrees": 4,
        "total_disagrees": 2,
        "total_passes": 1,
        "groups": {
            0: {"votes": 4, "agrees": 3, "disagrees": 0, "passes": 1},
            1: {"votes": 3, "agrees": 1, "disagrees": 2, "passes": 0},
        },
        "comment_extremity": 0.5,
        "group_aware_consensus": 0.8,
        "num_groups": 2,
    }
    assert result["vote_data"][2]["comment_extremity"] == 0.7
    assert result["vote_data"][2]["group_aware_consensus"] == 0.4
    assert result["n_groups"] == 2
    assert result["group_assignments"] == {"101": 0, "102": 0, "103": 1, "104": 1}


def test_export_data_uses_snapshot_counts_and_still_drops_removed_comments():
    processor = _processor()

    export = processor.get_export_data(73, include_moderation=False, math_data=SNAPSHOT)

    assert [row["comment-id"] for row in export["comments"]] == [1]
    assert export["comments"][0]["group-0-agrees"] == 3
    assert export["comments"][0]["group-1-disagrees"] == 2
    assert export["comments"][0]["group_aware_consensus"] == 0.8
    assert export["math_result"]["group_assignments"] == {
        "101": 0,
        "102": 0,
        "103": 1,
        "104": 1,
    }


def test_canonical_consensus_comments_keep_only_selected_ids_and_order():
    comments = [
        {"comment_id": 1, "comment": "first"},
        {"comment-id": "2", "comment": "second"},
        {"comment_id": 3, "comment": "third"},
    ]

    selected = GroupDataProcessor.select_comments_by_statement_ids(
        comments,
        ["3", 1, 3, 99],
    )

    assert [comment["comment"] for comment in selected] == ["third", "first"]


class _FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


def test_fetch_snapshot_uses_internal_key_and_returns_math(monkeypatch):
    captured = {}

    def fake_get(url, headers=None, timeout=None):
        captured.update({"url": url, "headers": headers, "timeout": timeout})
        return _FakeResponse(200, {"math_pca2": SNAPSHOT})

    monkeypatch.setenv("AGORA_BACKEND_URL", "http://agora-backend:3000/")
    monkeypatch.setenv("POLIS_INTERNAL_PROXY_SECRET", "secret")
    monkeypatch.setattr("umap_narrative.agora_math_snapshot.requests.get", fake_get)

    result = fetch_agora_math_snapshot("mux33xlpd6p2dev", timeout=5)

    assert result == SNAPSHOT
    assert captured["url"] == (
        "http://agora-backend:3000/api/v1/internal/deliberations/"
        "mux33xlpd6p2dev/polis-math-snapshot"
    )
    assert captured["headers"] == {"x-polis-internal-key": "secret"}
    assert captured["timeout"] == 5


def test_fetch_report_inputs_returns_agora_canonical_consensus_sets(monkeypatch):
    selection = {
        "groupCount": 2,
        "baseThreshold": 0.7,
        "smallSampleAdjusted": False,
        "agreement": [{"tid": 1, "score": 0.8}],
        "disagreement": [{"tid": 3, "score": 0.76}],
    }
    monkeypatch.setenv("AGORA_BACKEND_URL", "http://agora-backend:3000")
    monkeypatch.setenv("POLIS_INTERNAL_PROXY_SECRET", "secret")
    monkeypatch.setattr(
        "umap_narrative.agora_math_snapshot.requests.get",
        lambda *args, **kwargs: _FakeResponse(
            200,
            {"math_pca2": SNAPSHOT, "group_consensus_statements": selection},
        ),
    )

    assert fetch_agora_report_inputs("mux33xlpd6p2dev") == {
        "math_pca2": SNAPSHOT,
        "group_consensus_statements": selection,
        "group_division_statements": None,
        "uncertainty_statements": None,
    }


def test_fetch_report_inputs_returns_agora_mixed_view_statements(monkeypatch):
    divisions = [
        {
            "tid": 3,
            "score": 0.82,
            "totalAgree": 41,
            "totalDisagree": 32,
            "totalPass": 4,
            "totalShown": 77,
            "totalCast": 73,
            "totalParticipants": 100,
            "passRate": 4 / 77,
        }
    ]
    monkeypatch.setenv("AGORA_BACKEND_URL", "http://agora-backend:3000")
    monkeypatch.setenv("POLIS_INTERNAL_PROXY_SECRET", "secret")
    monkeypatch.setattr(
        "umap_narrative.agora_math_snapshot.requests.get",
        lambda *args, **kwargs: _FakeResponse(
            200,
            {"math_pca2": SNAPSHOT, "group_division_statements": divisions},
        ),
    )

    assert fetch_agora_report_inputs("mux33xlpd6p2dev") == {
        "math_pca2": SNAPSHOT,
        "group_consensus_statements": None,
        "group_division_statements": divisions,
        "uncertainty_statements": None,
    }


def test_fetch_report_inputs_returns_agora_uncertainty_statements(monkeypatch):
    uncertainty = [
        {
            "tid": 4,
            "spread": 0.5,
            "totalPass": 20,
            "totalSeen": 40,
            "tribes": [
                {"id": 0, "pass": 10, "seen": 20, "passShare": 0.5},
                {"id": 1, "pass": 10, "seen": 20, "passShare": 0.5},
            ],
        }
    ]
    monkeypatch.setenv("AGORA_BACKEND_URL", "http://agora-backend:3000")
    monkeypatch.setenv("POLIS_INTERNAL_PROXY_SECRET", "secret")
    monkeypatch.setattr(
        "umap_narrative.agora_math_snapshot.requests.get",
        lambda *args, **kwargs: _FakeResponse(
            200,
            {"math_pca2": SNAPSHOT, "uncertainty_statements": uncertainty},
        ),
    )

    assert fetch_agora_report_inputs("mux33xlpd6p2dev") == {
        "math_pca2": SNAPSHOT,
        "group_consensus_statements": None,
        "group_division_statements": None,
        "uncertainty_statements": uncertainty,
    }


def test_fetch_snapshot_returns_none_without_configuration(monkeypatch):
    monkeypatch.delenv("AGORA_BACKEND_URL", raising=False)
    monkeypatch.delenv("AGORA_API_URL", raising=False)
    monkeypatch.delenv("POLIS_INTERNAL_PROXY_SECRET", raising=False)
    monkeypatch.delenv("POLIS_INTERNAL_KEY", raising=False)

    assert fetch_agora_math_snapshot("mux33xlpd6p2dev") is None


def test_fetch_snapshot_returns_none_on_404(monkeypatch):
    monkeypatch.setenv("AGORA_BACKEND_URL", "http://agora-backend:3000")
    monkeypatch.setenv("POLIS_INTERNAL_PROXY_SECRET", "secret")
    monkeypatch.setattr(
        "umap_narrative.agora_math_snapshot.requests.get",
        lambda *args, **kwargs: _FakeResponse(404),
    )

    assert fetch_agora_math_snapshot("mux33xlpd6p2dev") is None


def test_fetch_snapshot_returns_none_on_transport_error(monkeypatch):
    import requests

    monkeypatch.setenv("AGORA_BACKEND_URL", "http://agora-backend:3000")
    monkeypatch.setenv("POLIS_INTERNAL_PROXY_SECRET", "secret")

    def boom(*args, **kwargs):
        raise requests.ConnectionError("no route")

    monkeypatch.setattr("umap_narrative.agora_math_snapshot.requests.get", boom)

    assert fetch_agora_math_snapshot("mux33xlpd6p2dev") is None


def test_resolve_deliberation_id_uses_existing_internal_lookup(monkeypatch):
    captured = {}

    def fake_get(url, headers=None, timeout=None):
        captured.update({"url": url, "headers": headers})
        return _FakeResponse(200, {"deliberation_id": "mux33xlpd6p2dev"})

    monkeypatch.setenv("AGORA_BACKEND_URL", "http://agora-backend:3000")
    monkeypatch.setenv("POLIS_INTERNAL_PROXY_SECRET", "secret")
    monkeypatch.setattr("umap_narrative.agora_math_snapshot.requests.get", fake_get)

    assert resolve_agora_deliberation_id("73") == "mux33xlpd6p2dev"
    assert captured["url"] == (
        "http://agora-backend:3000/api/v1/internal/deliberation-by-zid/73"
    )
    assert captured["headers"] == {"x-polis-internal-key": "secret"}


def test_report_batch_passes_the_snapshot_into_the_export():
    import os

    script = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "801_narrative_report_batch.py",
    )
    with open(script, encoding="utf-8") as handle:
        source = handle.read()

    assert "fetch_agora_report_inputs" in source
    assert "resolve_agora_deliberation_id" in source
    assert "math_data=math_data" in source
    assert "self._get_stored_math_snapshot()" in source
    assert "agora_selected_group_consensus" in source
    assert "is_canonical_selection" in source
    assert "select_comments_by_statement_ids" in source
