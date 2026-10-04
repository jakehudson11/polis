#!/usr/bin/env python3
"""Unit tests for the narrative-batch follow-up job enqueued by the Delphi job poller.

Regression coverage for a staging bug: ``FULL_PIPELINE`` completions auto-enqueue a
``CREATE_NARRATIVE_BATCH`` child job, and that child item used to omit the parent's
``deliberation_id``. The poller then exported ``DELIBERATION_ID=<zid>`` (job_poller.py
``env['DELIBERATION_ID']``), the Agora batch client signed that zid into its
x-agora-budget-context header, and Agora's ``agora_ai_usage_log`` FK
(``REFERENCES agora_deliberations(deliberation_id)``) rejected the usage row - silently
losing cost accounting while also recording the wrong id on ``agora_batch_jobs``.

These tests exercise the real ``JobProcessor._enqueue_create_narrative_batch_job`` with a
fake DynamoDB table (no AWS/Postgres needed).
"""

import json
import os
import sys
import time
import types

import pytest

DELPHI_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if DELPHI_ROOT not in sys.path:
    sys.path.insert(0, DELPHI_ROOT)


def _load_job_poller():
    """Import scripts.job_poller, standing in for third-party deps when absent.

    job_poller imports boto3/botocore/sqlalchemy at module scope. They are only used to
    open connections, so minimal stand-ins let the enqueue logic be unit-tested in
    environments (like a bare checkout) where those packages are not installed.
    """
    try:
        import boto3  # noqa: F401
        import sqlalchemy  # noqa: F401
    except ImportError:
        pass
    else:
        import scripts.job_poller as job_poller  # noqa: F401
        return job_poller

    def _module(name, **attrs):
        module = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(module, key, value)
        sys.modules[name] = module
        return module

    conditions = _module('boto3.dynamodb.conditions', Attr=lambda name: types.SimpleNamespace(eq=lambda v: None))
    dynamodb = _module('boto3.dynamodb', conditions=conditions)
    boto3_stub = _module('boto3', resource=lambda *a, **k: None, dynamodb=dynamodb)
    boto3_stub.dynamodb = dynamodb

    class ClientError(Exception):
        pass

    exceptions = _module('botocore.exceptions', ClientError=ClientError)
    _module('botocore', exceptions=exceptions)

    class DeclarativeBase:
        pass

    orm = _module('sqlalchemy.orm', DeclarativeBase=DeclarativeBase,
                  sessionmaker=lambda *a, **k: None, scoped_session=lambda *a, **k: None)
    postgresql = _module('sqlalchemy.dialects.postgresql', JSON=object, JSONB=object)
    dialects = _module('sqlalchemy.dialects', postgresql=postgresql)
    pool = _module('sqlalchemy.pool', QueuePool=object)
    sql = _module('sqlalchemy.sql', text=lambda statement: statement)
    _module('sqlalchemy', create_engine=lambda *a, **k: None, orm=orm, dialects=dialects, pool=pool, sql=sql)

    import scripts.job_poller as job_poller
    return job_poller


job_poller = _load_job_poller()


class FakeTable:
    """Records items instead of writing to DynamoDB."""

    def __init__(self):
        self.items = []

    def put_item(self, Item):
        self.items.append(Item)

    def get_item(self, **kwargs):
        return {}


class HarnessProcessor(job_poller.JobProcessor):
    """JobProcessor without __init__, so no DynamoDB/Postgres connection is opened."""

    def __init__(self):
        self.table = FakeTable()
        self.logs = []

    def _get_ai_use_case_config(self, use_case_key):
        return {'primary_model': 'claude-sonnet-4', 'primary_provider': 'anthropic'}

    def update_job_logs(self, job, log_entry, mirror_to_console=True):
        self.logs.append(log_entry)


@pytest.fixture
def parent_job():
    return {
        'job_id': '77b358f3-aaaa-bbbb-cccc-dddddddddddd',
        'conversation_id': '3',
        'report_id': 'rid-77b358f3',
        'deliberation_id': 'mupusnozepcygeb0',
        'priority': 50,
    }


@pytest.fixture
def report_stage_config():
    return {'model': 'claude-sonnet-4'}


def test_child_job_copies_parent_deliberation_id(parent_job, report_stage_config):
    """The auto-enqueued CREATE_NARRATIVE_BATCH job must carry the parent's deliberation_id."""
    processor = HarnessProcessor()

    child_job_id = processor._enqueue_create_narrative_batch_job(parent_job, report_stage_config, False)

    assert child_job_id, 'expected the follow-up job to be enqueued'
    assert child_job_id.startswith('auto_narrative_77b358f3_')
    assert len(processor.table.items) == 1

    child = processor.table.items[0]
    assert child['job_type'] == 'CREATE_NARRATIVE_BATCH'
    assert child['deliberation_id'] == 'mupusnozepcygeb0'
    assert isinstance(child['deliberation_id'], str)
    # The polis zid must stay on conversation_id; it is not a valid Agora deliberation id.
    assert child['conversation_id'] == '3'
    assert child['report_id'] == parent_job['report_id']
    assert child['parent_job_id'] == parent_job['job_id']


def test_child_job_omits_deliberation_id_when_parent_has_none(report_stage_config):
    """DynamoDB rejects None, so the key must be absent rather than None/empty."""
    for missing_value in (None, '', 0):
        processor = HarnessProcessor()
        parent = {
            'job_id': '77b358f3-aaaa-bbbb-cccc-dddddddddddd',
            'conversation_id': '3',
            'deliberation_id': missing_value,
        }

        processor._enqueue_create_narrative_batch_job(parent, report_stage_config, False)

        child = processor.table.items[0]
        assert 'deliberation_id' not in child, f'unexpected deliberation_id for parent value {missing_value!r}'
        assert all(value is not None for value in child.values())

    # Also cover a parent item without the attribute at all.
    processor = HarnessProcessor()
    processor._enqueue_create_narrative_batch_job(
        {'job_id': '77b358f3-aaaa-bbbb-cccc-dddddddddddd', 'conversation_id': '3'},
        report_stage_config,
        False,
    )
    assert 'deliberation_id' not in processor.table.items[0]


def test_child_job_config_and_environment_unchanged(parent_job, report_stage_config):
    """The fix must not alter the existing child item shape beyond deliberation_id."""
    processor = HarnessProcessor()

    processor._enqueue_create_narrative_batch_job(parent_job, report_stage_config, True)

    child = processor.table.items[0]
    job_config = json.loads(child['job_config'])
    assert job_config['job_type'] == 'CREATE_NARRATIVE_BATCH'
    assert job_config['parent_job_id'] == parent_job['job_id']
    assert job_config['stages'][0]['stage'] == 'CREATE_NARRATIVE_BATCH_CONFIG_STAGE'
    assert job_config['stages'][0]['config']['report_id'] == parent_job['report_id']
    assert job_config['stages'][0]['config']['include_moderation'] is True
    assert 'deliberation_id' not in json.dumps(job_config)

    environment = json.loads(child['environment'])
    assert set(environment) == {
        'NARRATIVE_BATCH_MODEL',
        'NARRATIVE_BATCH_PROVIDER',
        'NARRATIVE_BATCH_BACKUP_MODEL',
        'NARRATIVE_BATCH_BACKUP_PROVIDER',
        'NARRATIVE_BATCH_FALLBACK_MODEL',
        'NARRATIVE_BATCH_FALLBACK_PROVIDER',
        'NARRATIVE_BATCH_MAX_SIZE',
        'NARRATIVE_BATCH_NO_CACHE',
    }
    assert child['status'] == 'PENDING'
    assert child['created_by'] == 'poller'


def test_enqueue_returns_none_without_conversation_id(parent_job, report_stage_config):
    """Unchanged guard: no conversation_id means no follow-up job."""
    processor = HarnessProcessor()

    result = processor._enqueue_create_narrative_batch_job({**parent_job, 'conversation_id': None}, report_stage_config, False)

    assert result is None
    assert processor.table.items == []
