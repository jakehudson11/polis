#!/usr/bin/env python3
"""Unit tests for JobProcessor.release_lock's AWAITING_RECHECK path.

Regression coverage for a staging bug (2026-10-04): an
``AWAITING_NARRATIVE_BATCH`` status-check job exits with code 3 while its Agora
batch is still running, the poller calls ``release_lock(is_still_processing=True)``
— and the update FAILS:

    ValidationException: The provided expression refers to an attribute that
    does not exist in the item

``retry_count = retry_count + :inc`` cannot reference an attribute the item
never had, and the status-check job (created by 801/803) is not given one. The
failed release left the job PROCESSING until its 15-minute lock expired, so the
re-check only happened via the zombie re-queue — every Agora-proxied run paid
that stall at its first status check.

These tests drive the real ``release_lock`` against a DynamoDB-shaped fake that
enforces the same update-expression rules as the service: arithmetic on a
missing attribute is rejected unless it is seeded with ``if_not_exists``.
"""

import os
import sys
import types

import pytest

DELPHI_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if DELPHI_ROOT not in sys.path:
    sys.path.insert(0, DELPHI_ROOT)


def _load_job_poller():
    """Import scripts.job_poller, standing in for third-party deps when absent."""
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


class ValidationException(Exception):
    """Stands in for botocore's ClientError on a malformed update expression."""


def _split_top_level(text):
    """Split on commas that are NOT inside parentheses.

    The assignment list is comma-separated, but values like
    ``if_not_exists(retry_count, :zero) + :inc`` contain their own commas.
    """
    parts, depth, current = [], 0, ''
    for char in text:
        if char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
        if char == ',' and depth == 0:
            parts.append(current.strip())
            current = ''
        else:
            current += char
    if current.strip():
        parts.append(current.strip())
    return parts


class DynamoLikeTable:
    """Minimal DynamoDB stand-in that enforces the service's update-expression rules."""

    def __init__(self, item=None):
        self.item = dict(item or {})

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames=None,
                    ExpressionAttributeValues=None):
        names = ExpressionAttributeNames or {}
        values = ExpressionAttributeValues or {}

        def resolve(token):
            return names.get(token, token)

        set_part, remove_part = UpdateExpression, ''
        if ' REMOVE ' in UpdateExpression:
            set_part, remove_part = UpdateExpression.split(' REMOVE ', 1)
        elif UpdateExpression.strip().startswith('REMOVE '):
            # A bare "REMOVE x" expression has no SET clause at all.
            set_part, remove_part = '', UpdateExpression.strip()[len('REMOVE '):]

        if set_part.strip():
            assert set_part.strip().startswith('SET '), set_part
            for assignment in _split_top_level(set_part.strip()[len('SET '):]):
                lhs, rhs = assignment.split('=', 1)
                lhs, rhs = lhs.strip(), rhs.strip()

                if_not_exists = None
                if_not_exists_attr = None
                if rhs.startswith('if_not_exists('):
                    inner, rest = rhs[len('if_not_exists('):].split(')', 1)
                    attr_token, seed = _split_top_level(inner)
                    if_not_exists_attr = resolve(attr_token)
                    if_not_exists = int(values[seed])
                    rhs = rest.strip()

                if '+' in rhs:
                    base_token, addend_token = rhs.rsplit('+', 1)[0].strip(), rhs.rsplit('+', 1)[1].strip()
                    # `if_not_exists(A, :zero) + :inc` takes its base from A, and
                    # writes the result to the left-hand side (A here).
                    base_name = resolve(base_token) if base_token else (if_not_exists_attr or resolve(lhs))
                    if base_name in self.item:
                        base = int(self.item[base_name])
                    elif if_not_exists is not None:
                        base = if_not_exists
                    else:
                        # Exactly what DynamoDB rejects for `x = x + :inc` on a
                        # missing attribute — the staging failure.
                        raise ValidationException(
                            'The provided expression refers to an attribute that does not exist in the item'
                        )
                    self.item[resolve(lhs)] = base + int(values[addend_token])
                else:
                    self.item[resolve(lhs)] = values[rhs]

        for attr in [a.strip() for a in remove_part.split(',') if a.strip()]:
            self.item.pop(resolve(attr), None)

        return {'Attributes': dict(self.item)}


class HarnessProcessor(job_poller.JobProcessor):
    """JobProcessor without __init__, so no DynamoDB/Postgres connection is opened."""

    def __init__(self, table):
        self.table = table


STATUS_CHECK_JOB = {
    'job_id': 'batch_check_auto_narrative_3be2936f_1791118944_7cb56873_1791118946',
    'status': 'PROCESSING',
    'job_type': 'AWAITING_NARRATIVE_BATCH',
    'batch_id': 'e7d446e9-979e-45de-a4e9-8af5be50bcb4',
    'lock_expires_at': '2026-10-04T13:17:27.813890+00:00',
}


def test_release_lock_succeeds_without_retry_count():
    """The status-check job has no retry_count; the release must still work."""
    table = DynamoLikeTable(STATUS_CHECK_JOB)
    processor = HarnessProcessor(table)

    processor.release_lock(STATUS_CHECK_JOB, is_still_processing=True)

    assert table.item['status'] == 'AWAITING_RECHECK'
    assert table.item['retry_count'] == 1
    assert 'lock_expires_at' not in table.item


def test_release_lock_increments_an_existing_retry_count():
    """Jobs that already carry retry_count keep counting up."""
    table = DynamoLikeTable({**STATUS_CHECK_JOB, 'retry_count': 2})
    processor = HarnessProcessor(table)

    processor.release_lock(STATUS_CHECK_JOB, is_still_processing=True)

    assert table.item['retry_count'] == 3
    assert table.item['status'] == 'AWAITING_RECHECK'


def test_fake_rejects_the_old_expression():
    """Prove the fake models the real failure: bare arithmetic on a missing attribute."""
    table = DynamoLikeTable(STATUS_CHECK_JOB)

    with pytest.raises(ValidationException):
        table.update_item(
            Key={'job_id': STATUS_CHECK_JOB['job_id']},
            UpdateExpression="SET #s = :recheck_status, retry_count = retry_count + :inc REMOVE lock_expires_at",
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':recheck_status': 'AWAITING_RECHECK', ':inc': 1},
        )


def test_release_lock_for_a_finished_job_only_removes_the_lock():
    """The not-still-processing branch is unchanged."""
    table = DynamoLikeTable(STATUS_CHECK_JOB)
    processor = HarnessProcessor(table)

    processor.release_lock(STATUS_CHECK_JOB, is_still_processing=False)

    assert 'lock_expires_at' not in table.item
    # Status and counters are untouched on the finished path.
    assert table.item['status'] == 'PROCESSING'
    assert 'retry_count' not in table.item
