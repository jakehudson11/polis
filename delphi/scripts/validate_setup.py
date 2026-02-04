#!/usr/bin/env python3
"""
Comprehensive setup validation script for Delphi system.
Validates all required components are properly configured and accessible.
Reports all issues in a single run.
"""

import os
import sys
import logging
import boto3
from botocore.exceptions import ClientError, NoCredentialsError
import sqlalchemy as sa
from sqlalchemy.sql import text

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Required DynamoDB tables with their key schemas for validation
REQUIRED_TABLES = {
    'Delphi_JobQueue': {
        'key_schema': [{'AttributeName': 'job_id', 'KeyType': 'HASH'}],
        'description': 'Job queue for Delphi processing jobs'
    },
    'Delphi_PCAConversationConfig': {
        'key_schema': [{'AttributeName': 'zid', 'KeyType': 'HASH'}],
        'description': 'PCA conversation configuration'
    },
    'Delphi_PCAResults': {
        'key_schema': [{'AttributeName': 'zid', 'KeyType': 'HASH'}],
        'description': 'PCA analysis results'
    },
    'Delphi_KMeansClusters': {
        'key_schema': [{'AttributeName': 'zid', 'KeyType': 'HASH'}],
        'description': 'K-means clustering results'
    },
    'Delphi_CommentEmbeddings': {
        'key_schema': [{'AttributeName': 'zid', 'KeyType': 'HASH'}, {'AttributeName': 'tid', 'KeyType': 'RANGE'}],
        'description': 'Comment embeddings for UMAP'
    },
    'Delphi_CommentHierarchicalClusterAssignments': {
        'key_schema': [{'AttributeName': 'zid', 'KeyType': 'HASH'}, {'AttributeName': 'tid', 'KeyType': 'RANGE'}],
        'description': 'Hierarchical cluster assignments'
    },
    'Delphi_CommentClustersLLMTopicNames': {
        'key_schema': [{'AttributeName': 'conversation_id', 'KeyType': 'HASH'}, {'AttributeName': 'topic_key', 'KeyType': 'RANGE'}],
        'description': 'LLM-generated topic names'
    },
    'Delphi_NarrativeReports': {
        'key_schema': [{'AttributeName': 'rid_section_model', 'KeyType': 'HASH'}],
        'description': 'Narrative reports'
    },
    'Delphi_UMAPConversationConfig': {
        'key_schema': [{'AttributeName': 'zid', 'KeyType': 'HASH'}],
        'description': 'UMAP conversation configuration'
    },
    'Delphi_UMAPGraph': {
        'key_schema': [{'AttributeName': 'zid', 'KeyType': 'HASH'}],
        'description': 'UMAP graph data'
    },
}

def validate_dynamodb_tables():
    """Validate all required DynamoDB tables exist and have correct schemas."""
    logger.info("Validating DynamoDB tables...")
    issues = []
    warnings = []
    
    try:
        endpoint_url = os.environ.get('DYNAMODB_ENDPOINT')
        region = os.environ.get('AWS_REGION', 'us-east-1')
        
        dynamodb = boto3.resource(
            'dynamodb',
            endpoint_url=endpoint_url,
            region_name=region,
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID', 'DUMMY'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY', 'DUMMY')
        )
        
        client = boto3.client(
            'dynamodb',
            endpoint_url=endpoint_url,
            region_name=region,
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID', 'DUMMY'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY', 'DUMMY')
        )
        
        # Get list of existing tables
        try:
            response = client.list_tables()
            existing_tables = response.get('TableNames', [])
            logger.info(f"Found {len(existing_tables)} DynamoDB tables")
        except Exception as e:
            issues.append(f"Cannot list DynamoDB tables: {str(e)}")
            return issues, warnings
        
        # Check each required table
        for table_name, table_info in REQUIRED_TABLES.items():
            if table_name not in existing_tables:
                issues.append(f"Table '{table_name}' does not exist ({table_info['description']})")
            else:
                # Validate table schema
                try:
                    table_desc = client.describe_table(TableName=table_name)
                    table_status = table_desc['Table']['TableStatus']
                    if table_status != 'ACTIVE':
                        warnings.append(f"Table '{table_name}' exists but status is '{table_status}' (expected ACTIVE)")
                    
                    # Check key schema matches expected
                    actual_keys = table_desc['Table']['KeySchema']
                    expected_keys = table_info['key_schema']
                    if len(actual_keys) != len(expected_keys):
                        warnings.append(f"Table '{table_name}' key schema length mismatch (expected {len(expected_keys)}, got {len(actual_keys)})")
                    else:
                        logger.info(f"Table '{table_name}' exists and is ACTIVE")
                except Exception as e:
                    warnings.append(f"Cannot describe table '{table_name}': {str(e)}")
        
    except NoCredentialsError:
        issues.append("DynamoDB credentials not configured")
    except Exception as e:
        issues.append(f"DynamoDB validation failed: {str(e)}")
    
    return issues, warnings

def validate_postgresql():
    """Validate PostgreSQL connection and required tables."""
    logger.info("Validating PostgreSQL connection...")
    issues = []
    
    try:
        database_url = os.environ.get('DATABASE_URL')
        if not database_url:
            host = os.environ.get('DATABASE_HOST', 'localhost')
            port = os.environ.get('DATABASE_PORT', '5432')
            database = os.environ.get('DATABASE_NAME', 'polisDB_prod_local_mar14')
            user = os.environ.get('DATABASE_USER', 'postgres')
            password = os.environ.get('DATABASE_PASSWORD', '')
            ssl_mode = os.environ.get('DATABASE_SSL_MODE', 'disable')
            
            database_url = f"postgresql://{user}:{password}@{host}:{port}/{database}?sslmode={ssl_mode}"
        
        engine = sa.create_engine(database_url, connect_args={'connect_timeout': 5})
        
        # Test connection
        with engine.connect() as conn:
            result = conn.execute(text("SELECT version()"))
            version = result.fetchone()[0]
            logger.info(f"PostgreSQL connection successful. Version: {version[:50]}...")
        
        # Check for required tables
        required_pg_tables = ['conversations', 'comments', 'votes_latest_unique', 'reports']
        with engine.connect() as conn:
            for table_name in required_pg_tables:
                try:
                    result = conn.execute(text(f"SELECT COUNT(*) FROM {table_name} LIMIT 1"))
                    result.fetchone()
                    logger.info(f"PostgreSQL table '{table_name}' exists and is accessible")
                except Exception as e:
                    issues.append(f"PostgreSQL table '{table_name}' check failed: {str(e)}")
        
        engine.dispose()
        
    except Exception as e:
        issues.append(f"PostgreSQL validation failed: {str(e)}")
    
    return issues

def validate_environment_variables():
    """Validate required and recommended environment variables."""
    logger.info("Validating environment variables...")
    issues = []
    warnings = []
    
    required_vars = {
        'OLLAMA_MODEL': 'Required for all pipeline jobs',
    }
    
    recommended_vars = {
        'ANTHROPIC_MODEL': 'Required for CREATE_NARRATIVE_BATCH jobs',
        'ANTHROPIC_API_KEY': 'Required for narrative report generation',
        'AWS_S3_BUCKET_NAME': 'Required for storing visualizations',
        'DYNAMODB_ENDPOINT': 'Required for local development',
    }
    
    for var, description in required_vars.items():
        if not os.environ.get(var):
            issues.append(f"Required environment variable '{var}' is not set: {description}")
        else:
            logger.info(f"Required environment variable '{var}' is set")
    
    for var, description in recommended_vars.items():
        if not os.environ.get(var):
            warnings.append(f"Recommended environment variable '{var}' is not set: {description}")
        else:
            logger.info(f"Recommended environment variable '{var}' is set")
    
    return issues, warnings

def validate_s3_minio():
    """Validate S3/MinIO bucket exists and is accessible."""
    logger.info("Validating S3/MinIO bucket...")
    issues = []
    
    try:
        endpoint_url = os.environ.get('AWS_S3_ENDPOINT')
        bucket_name = os.environ.get('AWS_S3_BUCKET_NAME', 'polis-delphi')
        access_key = os.environ.get('AWS_ACCESS_KEY_ID', 'minioadmin')
        secret_key = os.environ.get('AWS_SECRET_ACCESS_KEY', 'minioadmin')
        region = os.environ.get('AWS_REGION', 'us-east-1')
        
        s3_client = boto3.client(
            's3',
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region
        )
        
        # Check bucket exists and is accessible
        try:
            s3_client.head_bucket(Bucket=bucket_name)
            logger.info(f"S3/MinIO bucket '{bucket_name}' exists and is accessible")
            
            # Try to list objects to verify read access
            s3_client.list_objects_v2(Bucket=bucket_name, MaxKeys=1)
            logger.info(f"S3/MinIO bucket '{bucket_name}' is readable")
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', 'Unknown')
            if error_code == '404':
                issues.append(f"S3/MinIO bucket '{bucket_name}' does not exist")
            elif error_code == '403':
                issues.append(f"S3/MinIO bucket '{bucket_name}' access denied (permissions issue)")
            else:
                issues.append(f"S3/MinIO bucket '{bucket_name}' check failed: {error_code}")
        
    except Exception as e:
        issues.append(f"S3/MinIO validation failed: {str(e)}")
    
    return issues

def main():
    """Run all validation checks and report results."""
    logger.info("=" * 80)
    logger.info("Starting comprehensive Delphi setup validation...")
    logger.info("=" * 80)
    
    all_issues = []
    all_warnings = []
    
    # Run all validations
    db_issues, db_warnings = validate_dynamodb_tables()
    all_issues.extend(db_issues)
    all_warnings.extend(db_warnings)
    
    all_issues.extend(validate_postgresql())
    
    env_issues, env_warnings = validate_environment_variables()
    all_issues.extend(env_issues)
    all_warnings.extend(env_warnings)
    
    all_issues.extend(validate_s3_minio())
    
    # Report results
    logger.info("=" * 80)
    logger.info("Validation Summary")
    logger.info("=" * 80)
    
    if all_warnings:
        logger.warning(f"Found {len(all_warnings)} warning(s):")
        for warning in all_warnings:
            logger.warning(f"  WARNING: {warning}")
    
    if all_issues:
        logger.error(f"Found {len(all_issues)} issue(s):")
        for issue in all_issues:
            logger.error(f"  ERROR: {issue}")
        logger.error("=" * 80)
        logger.error("Setup validation FAILED")
        logger.error("Please fix the issues above before running Delphi jobs.")
        return 1
    else:
        logger.info("=" * 80)
        logger.info("Setup validation PASSED")
        if all_warnings:
            logger.info(f"(with {len(all_warnings)} warning(s) - see above)")
        logger.info("=" * 80)
        return 0

if __name__ == "__main__":
    sys.exit(main())








