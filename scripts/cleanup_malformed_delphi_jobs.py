#!/usr/bin/env python3

import argparse
import os
import sys

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError


ERROR_MESSAGE = "Malformed job schema - missing version field"


def scan_malformed_pending_jobs(table):
    filter_expression = Attr("status").eq("PENDING")

    malformed_job_ids = []
    exclusive_start_key = None

    while True:
        scan_kwargs = {
            "FilterExpression": filter_expression,
            "ProjectionExpression": "job_id, #s, version",
            "ExpressionAttributeNames": {"#s": "status"},
        }
        if exclusive_start_key is not None:
            scan_kwargs["ExclusiveStartKey"] = exclusive_start_key

        response = table.scan(**scan_kwargs)
        for item in response.get("Items", []):
            job_id = item.get("job_id")
            if not job_id:
                continue
            version_is_missing = "version" not in item
            version_is_null = item.get("version") is None
            if version_is_missing or version_is_null:
                malformed_job_ids.append(job_id)

        exclusive_start_key = response.get("LastEvaluatedKey")
        if not exclusive_start_key:
            return malformed_job_ids


def quarantine_job(table, job_id):
    try:
        table.update_item(
            Key={"job_id": job_id},
            UpdateExpression="SET #s = :failed, #err = :msg",
            ExpressionAttributeNames={"#s": "status", "#err": "error", "#v": "version"},
            ExpressionAttributeValues={":failed": "FAILED", ":msg": ERROR_MESSAGE, ":pending": "PENDING"},
            ConditionExpression="#s = :pending AND (attribute_not_exists(#v) OR attribute_type(#v, NULL))",
        )
        return True, None
    except ClientError as exc:
        code = (exc.response.get("Error") or {}).get("Code")
        if code == "ConditionalCheckFailedException":
            return False, "no longer malformed"
        return False, f"{code}: {(exc.response.get('Error') or {}).get('Message')}"
    except Exception as exc:  # pragma: no cover
        return False, repr(exc)


def main(argv):
    parser = argparse.ArgumentParser(description="Quarantine malformed Delphi PENDING jobs missing the 'version' field")
    parser.add_argument("--endpoint", default=os.environ.get("DYNAMODB_ENDPOINT") or "http://dynamodb-local:8000")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--table", default="Delphi_JobQueue")
    parser.add_argument("--access-key", default="dummy")
    parser.add_argument("--secret-key", default="dummy")
    args = parser.parse_args(argv)

    ddb = boto3.resource(
        "dynamodb",
        endpoint_url=args.endpoint,
        region_name=args.region,
        aws_access_key_id=args.access_key,
        aws_secret_access_key=args.secret_key,
    )
    table = ddb.Table(args.table)

    malformed_job_ids = scan_malformed_pending_jobs(table)
    print(f"Found {len(malformed_job_ids)} malformed jobs")

    cleaned = 0
    for job_id in malformed_job_ids:
        ok, err = quarantine_job(table, job_id)
        if ok:
            cleaned += 1
            print(f"Quarantined job: {job_id}")
        else:
            print(f"Skipped job: {job_id} ({err})")

    print(f"Cleaned {cleaned} jobs total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
