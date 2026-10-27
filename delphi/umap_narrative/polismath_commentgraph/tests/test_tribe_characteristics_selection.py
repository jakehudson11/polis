"""Focused tests for the updated tribe-characteristics selector.

The selector is shared by the tribe title and tribe characteristics payloads, so this
also pins the statement set those two narrative sections receive.
"""

import importlib
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# The report script lives one level above the namespace package's test tree.
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
report_module = importlib.import_module('umap_narrative.801_narrative_report_batch')
BatchReportGenerator = report_module.BatchReportGenerator


def comment(tid, group0, group1):
    """Build one processed-comment record with two tribes' vote counts."""
    return {
        'comment_id': tid,
        'comment': f'statement {tid}',
        'group-0-votes': group0[2],
        'group-0-agrees': group0[0],
        'group-0-disagrees': group0[1],
        'group-1-votes': group1[2],
        'group-1-agrees': group1[0],
        'group-1-disagrees': group1[1],
    }


def select(comments, group_id, tribe_size, limit=None):
    return BatchReportGenerator._select_comments_for_tribe_characteristics(
        None,
        comments,
        group_id,
        limit=limit,
        math_data=None,
        tribe_size=tribe_size,
    )


def test_repness_and_significance_choose_the_winning_direction():
    comments = [comment(1, (5, 0, 5), (0, 3, 3))]

    tribe0 = select(comments, 0, 5)
    tribe1 = select(comments, 1, 3)

    assert [(entry['comment_id'], entry['repful_for'], entry['significant']) for entry in tribe0] == [
        (1, 'agree', True)
    ]
    assert [(entry['comment_id'], entry['repful_for'], entry['significant']) for entry in tribe1] == [
        (1, 'disagree', True)
    ]


def test_pass_is_its_own_characteristic():
    comments = [comment(7, (5, 5, 10), (2, 3, 10))]

    tribe1 = select(comments, 1, 10)

    assert len(tribe1) == 1
    assert tribe1[0]['comment_id'] == 7
    assert tribe1[0]['repful_for'] == 'pass'
    assert tribe1[0]['significant'] is True


def test_turnout_below_half_is_excluded():
    # One of three tribe members voted; the other tribe voted on the same statement.
    comments = [comment(9, (5, 0, 5), (0, 1, 1))]

    assert select(comments, 1, 3) == []


def test_non_significant_above_floor_statement_is_kept_for_reference():
    # 60% against 20% agrees is 2.0x, but the two-proportion z is only ~1.15.
    comments = [comment(11, (3, 2, 5), (1, 4, 5))]

    tribe0 = select(comments, 0, 5)

    assert len(tribe0) == 1
    assert tribe0[0]['comment_id'] == 11
    assert tribe0[0]['significant'] is False


def test_ratio_is_gated_at_four_decimals():
    # 0.6 / 0.4 is 1.5; floating point yields 1.4999999999999998. The 4-decimal
    # gate must keep it, matching the frontend's buildTribeCharacteristics().
    comments = [comment(12, (2, 0, 3), (13, 9, 33))]

    tribe0 = select(comments, 0, 3)

    assert len(tribe0) == 1
    assert tribe0[0]['comment_id'] == 12
    assert tribe0[0]['repful_for'] == 'agree'
    assert tribe0[0]['distinctiveness_score'] == pytest.approx(1.5, abs=1e-4)


def test_limit_none_returns_every_qualifying_statement():
    comments = [
        comment(1, (0, 5, 5), (5, 0, 5)),
        comment(2, (0, 5, 5), (5, 0, 5)),
    ]

    tribe1 = select(comments, 1, 5, limit=None)

    assert [entry['comment_id'] for entry in tribe1] == [1, 2]


def test_global_filters_match_the_frontend_thresholds():
    assert report_module.MIN_POLARISATION_GAP == pytest.approx(0.25)
    assert report_module.UNCERTAINTY_PASS_RATE == pytest.approx(0.2)

    apply = BatchReportGenerator._apply_global_filter
    assert apply(None, {'cross_tribe_gap': 0.25}, 'cross_tribe_gap', report_module.MIN_POLARISATION_GAP) is True
    assert apply(None, {'cross_tribe_gap': 0.249}, 'cross_tribe_gap', report_module.MIN_POLARISATION_GAP) is False
    assert apply(None, {'passes': 3, 'votes': 10}, 'uncertainty_ratio', report_module.UNCERTAINTY_PASS_RATE) is True
    assert apply(None, {'passes': 1, 'votes': 10}, 'uncertainty_ratio', report_module.UNCERTAINTY_PASS_RATE) is False


def test_title_and_characteristics_payloads_share_the_full_statement_set():
    comments = [
        comment(1, (2, 0, 2), (0, 3, 3)),
        comment(2, (2, 0, 2), (0, 3, 3)),
    ]
    conversation_data = {
        'processed_comments': comments,
        'export_data': {
            'math_result': {
                'group_assignments': {'1': 0, '2': 0, '3': 1, '4': 1, '5': 1}
            }
        },
        'conversation': {'topic': 'test'},
        'math_data': {},
    }
    generator = object.__new__(BatchReportGenerator)
    generator.conversation_id = 'test-conversation'

    with patch.object(report_module.PolisConverter, 'convert_to_xml', return_value='<comments/>'):
        title_payload = generator._build_tribe_payload(
            conversation_data, 0, 'title', comment_limit=None
        )
        characteristics_payload = generator._build_tribe_payload(
            conversation_data, 0, 'characteristics', comment_limit=None
        )

    title_tids = [entry['comment_id'] for entry in title_payload['characteristic_comments']]
    characteristics_tids = [
        entry['comment_id'] for entry in characteristics_payload['characteristic_comments']
    ]

    assert title_tids == [1, 2]
    assert characteristics_tids == title_tids
