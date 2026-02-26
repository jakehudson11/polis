import argparse
import json
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.config import Config


@dataclass(frozen=True)
class CheckResult:
    full_pipeline_job: Dict[str, Any]
    report_stage_config: Dict[str, Any]
    wants_report: bool
    include_topics: Optional[bool]
    child_jobs: List[Dict[str, Any]]
    narrative_jobs_for_conversation: List[Dict[str, Any]]


def _coerce_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("1", "true", "t", "yes", "y", "on"):
            return True
        if v in ("0", "false", "f", "no", "n", "off"):
            return False
    return None


def _json_load_maybe(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return value
    return value


def _get_stage_config(job_config: Dict[str, Any], stage_name: str) -> Dict[str, Any]:
    stages = job_config.get("stages")
    if not isinstance(stages, list):
        return {}
    for stage in stages:
        if isinstance(stage, dict) and stage.get("stage") == stage_name:
            cfg = stage.get("config")
            return cfg if isinstance(cfg, dict) else {}
    return {}


def _scan_all(table, filter_expression, projection_expression: Optional[str] = None):
    items: List[Dict[str, Any]] = []
    start_key = None
    while True:
        kwargs: Dict[str, Any] = {"FilterExpression": filter_expression}
        if projection_expression:
            kwargs["ProjectionExpression"] = projection_expression
            kwargs["ExpressionAttributeNames"] = {"#id": "job_id", "#st": "status"}
        if start_key:
            kwargs["ExclusiveStartKey"] = start_key
        resp = table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        start_key = resp.get("LastEvaluatedKey")
        if not start_key:
            break
    return items


def check(
    *,
    endpoint_url: str,
    region: str,
    job_id: str,
    conversation_id: Optional[str],
    table_name: str = "Delphi_JobQueue",
) -> CheckResult:
    ddb = boto3.resource(
        "dynamodb",
        endpoint_url=endpoint_url,
        region_name=region,
        aws_access_key_id="dummy",
        aws_secret_access_key="dummy",
        config=Config(connect_timeout=2, read_timeout=15, retries={"max_attempts": 0}),
    )
    table = ddb.Table(table_name)

    full_pipeline_job = table.get_item(Key={"job_id": job_id}).get("Item")
    if not full_pipeline_job:
        raise SystemExit(f"Job not found in {table_name}: {job_id}")

    cfg_obj = _json_load_maybe(full_pipeline_job.get("job_config"))
    if not isinstance(cfg_obj, dict):
        cfg_obj = {}

    report_stage_config = _get_stage_config(cfg_obj, "REPORT")
    wants_report = bool(report_stage_config)
    include_topics = _coerce_bool(report_stage_config.get("include_topics"))

    child_jobs = _scan_all(
        table,
        Attr("parent_job_id").eq(job_id),
        projection_expression="#id, job_type, #st, conversation_id, parent_job_id, created_at, updated_at",
    )

    resolved_conv = conversation_id or str(full_pipeline_job.get("conversation_id") or "")
    narrative_jobs_for_conversation: List[Dict[str, Any]] = []
    if resolved_conv:
        narrative_jobs_for_conversation = _scan_all(
            table,
            Attr("job_type").eq("CREATE_NARRATIVE_BATCH")
            & Attr("conversation_id").eq(str(resolved_conv)),
            projection_expression="#id, job_type, #st, conversation_id, parent_job_id, created_at, updated_at",
        )

    return CheckResult(
        full_pipeline_job=full_pipeline_job,
        report_stage_config=report_stage_config,
        wants_report=wants_report,
        include_topics=include_topics,
        child_jobs=child_jobs,
        narrative_jobs_for_conversation=narrative_jobs_for_conversation,
    )


def _print_job_header(job: Dict[str, Any]) -> None:
    print(f"job_id: {job.get('job_id')}")
    print(f"job_type: {job.get('job_type')}")
    print(f"status: {job.get('status')}")
    print(f"conversation_id: {job.get('conversation_id')}")
    print(f"created_at: {job.get('created_at')}")
    print(f"updated_at: {job.get('updated_at')}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Check whether a FULL_PIPELINE job enqueued a CREATE_NARRATIVE_BATCH follow-up job (DynamoDB: Delphi_JobQueue)."
        )
    )
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--conversation-id", default=None)
    parser.add_argument(
        "--endpoint",
        default=None,
        help="DynamoDB endpoint URL (default: $DYNAMODB_ENDPOINT or http://dynamodb-local:8000)",
    )
    parser.add_argument("--region", default="us-east-1")
    args = parser.parse_args()

    endpoint = args.endpoint or os.environ.get("DYNAMODB_ENDPOINT") or "http://dynamodb-local:8000"

    result = check(
        endpoint_url=endpoint,
        region=args.region,
        job_id=args.job_id,
        conversation_id=args.conversation_id,
    )

    print("== FULL_PIPELINE job ==")
    _print_job_header(result.full_pipeline_job)

    print("\n== job_config REPORT stage ==")
    print(f"wants_report: {result.wants_report}")
    print(f"REPORT.config: {json.dumps(result.report_stage_config, indent=2, sort_keys=True)}")
    print(f"REPORT.include_topics: {result.include_topics}")

    print("\n== Child jobs (parent_job_id == this job) ==")
    if not result.child_jobs:
        print("(none)")
    else:
        for it in sorted(result.child_jobs, key=lambda x: x.get("created_at", "")):
            print(
                f"- {it.get('job_id')} type={it.get('job_type')} status={it.get('status')} conv={it.get('conversation_id')} created_at={it.get('created_at')}"
            )

    print("\n== CREATE_NARRATIVE_BATCH jobs for conversation ==")
    if not result.narrative_jobs_for_conversation:
        print("(none)")
    else:
        for it in sorted(result.narrative_jobs_for_conversation, key=lambda x: x.get("created_at", "")):
            print(
                f"- {it.get('job_id')} status={it.get('status')} parent={it.get('parent_job_id')} created_at={it.get('created_at')}"
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
