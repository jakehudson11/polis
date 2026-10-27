"""Statements the moderator removed must never reach a Delphi narrative.

A removed statement keeps its `active = false` row, and the maths keeps its tid (the PCA was
computed before the removal). Any narrative built from those rows cites a statement the reader
cannot resolve and counts it as if it were still part of the survey — which is exactly what the
production report did before these fixes.
"""

import os
import re
import xml.etree.ElementTree as ET

import pytest

from polismath_commentgraph.utils.group_data import GroupDataProcessor
from polismath_commentgraph.utils.storage import PostgresClient

PROMPT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "report_experimental",
    "subtaskPrompts",
)

BATCH_SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "801_narrative_report_batch.py",
)


def test_get_comments_by_conversation_excludes_removed(monkeypatch):
    captured = {}

    def fake_query(self, sql, params=None):
        captured["sql"] = sql
        return []

    monkeypatch.setattr(PostgresClient, "query", fake_query)

    PostgresClient().get_comments_by_conversation(1)

    assert "active = true" in captured["sql"]
    assert "zid = :zid" in captured["sql"]


class _FakePostgresClient:
    """Returns a mix of live and removed comments, as the real table does."""

    def __init__(self, comments):
        self._comments = comments

    def get_comments_by_conversation(self, zid):
        return list(self._comments)


def _vote_data(tids):
    return {
        tid: {
            "total_votes": 5,
            "total_agrees": 3,
            "total_disagrees": 1,
            "total_passes": 1,
            "groups": {
                0: {"votes": 3, "agrees": 2, "disagrees": 1, "passes": 0},
                1: {"votes": 2, "agrees": 1, "disagrees": 0, "passes": 1},
            },
            "group_aware_consensus": 0.5,
            "comment_extremity": 1.0,
            "num_groups": 2,
        }
        for tid in tids
    }


def test_get_export_data_drops_removed_comments_even_if_the_client_returns_them():
    comments = [
        {"tid": 3, "txt": "live", "mod": 1, "active": True},
        {"tid": 24, "txt": "removed", "mod": 0, "active": False},
    ]
    processor = GroupDataProcessor(_FakePostgresClient(comments))
    processor.get_vote_data_by_groups = lambda zid, math_data=None: {
        "vote_data": _vote_data([3, 24]),
        "group_assignments": {},
        "n_groups": 2,
    }

    export = processor.get_export_data(1, include_moderation=False)

    assert [row["comment-id"] for row in export["comments"]] == [3]


def test_tribe_consensus_prompt_uses_the_same_bar_both_ways():
    tree = ET.parse(os.path.join(PROMPT_DIR, "tribe_consensus.xml"))
    thresholds = [
        term.findtext("threshold")
        for term in tree.getroot().iter("term")
        if term.get("name") in {"strong_agreement", "strong_disagreement"}
    ]

    assert thresholds == ["60", "60"]


def test_topic_prompt_describes_the_subject_rather_than_the_groups():
    with open(os.path.join(PROMPT_DIR, "topics.xml"), encoding="utf-8") as handle:
        prompt = handle.read()

    assert "topic_by_groups" not in prompt
    # The old prompt asked for "Group [A] demonstrated..." paragraphs.
    assert not re.search(r"Group \[A\]", prompt)
    assert "DO NOT compare opinion groups" in prompt


def test_groups_prompt_describes_the_cross_tribe_gap_not_extremity():
    with open(os.path.join(PROMPT_DIR, "groups.xml"), encoding="utf-8") as handle:
        prompt = handle.read()

    assert "comments that divide opinion tribes (high extremity)" not in prompt
    assert "most distinctive statements (high extremity)" not in prompt
    assert "gap between the most and least agreeing tribe" in prompt


def test_group_divisions_section_uses_the_cross_tribe_gap():
    """The narrative must select statements the same way the UI card does."""
    with open(BATCH_SCRIPT, encoding="utf-8") as handle:
        source = handle.read()

    assert '"name": "groups"' in source
    assert '"filter_type": "cross_tribe_gap"' in source
    assert 'elif filter_type == "cross_tribe_gap":' in source
    assert "disagree_threshold: float = 0.6" in source

def test_tribe_characteristics_use_repness_with_a_significance_gate():
    """Repness (a smoothed ratio) is the measure for every tribe size, with pass scored too."""
    with open(BATCH_SCRIPT, encoding="utf-8") as handle:
        source = handle.read()

    assert "TRIBE_CHARACTERISTIC_RATIO = 1.5" in source
    assert "TRIBE_CHARACTERISTIC_Z = 1.2816" in source
    # Laplace-smoothed ratio, the same expression Pol.is uses for repness.
    assert "(successes + 1.0) / (shown + 2.0)" in source
    # Pass is scored alongside agreement and disagreement rather than folded into either.
    assert "'pass': (mine_pass, rest_pass)" in source
    assert "above_floor = [item for item in candidates if item[\"ratio\"] >= TRIBE_CHARACTERISTIC_RATIO]" in source
    assert "qualifying = [item for item in above_floor if item[\"z\"] > TRIBE_CHARACTERISTIC_Z]" in source