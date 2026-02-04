#!/usr/bin/env python3
"""
Health check script for Delphi system.
Verifies all required services and configurations are accessible.
Returns exit code 0 if healthy, non-zero if issues found.
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

# Required DynamoDB tables
REQUIRED_TABLES = [
    'Delphi_JobQueue',
    'Delphi_PCAConversationConfig',
    'Delphi_PCAResults',
    'Delphi_KMeansClusters',
    'Delphi_CommentEmbeddings',
    'Delphi_CommentHierarchicalClusterAssignments',
    'Delphi_CommentClustersLLMTopicNames',
    'Delphi_NarrativeReports',
    'Delphi_UMAPConversationConfig',
    'Delphi_UMAPGraph',
]

def check_dynamodb():
    """Check DynamoDB connectivity and required tables."""
    logger.info("Checking DynamoDB connectivity...")
    issues = []
    
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
        
        # Test connection by listing tables
        try:
            tables = list(dynamodb.tables.all())
            logger.info(f"DynamoDB connection successful. Found {len(tables)} tables.")
        except Exception as e:
            issues.append(f"DynamoDB connection failed: {str(e)}")
            return issues
        
        # Check required tables
        table_names = [table.name for table in tables]
        missing_tables = [t for t in REQUIRED_TABLES if t not in table_names]
        
        if missing_tables:
            issues.append(f"Missing DynamoDB tables: {', '.join(missing_tables)}")
        else:
            logger.info(f"All {len(REQUIRED_TABLES)} required tables exist.")
        
    except NoCredentialsError:
        issues.append("DynamoDB credentials not configured")
    except Exception as e:
        issues.append(f"DynamoDB check failed: {str(e)}")
    
    return issues

def check_postgresql():
    """Check PostgreSQL connectivity."""
    logger.info("Checking PostgreSQL connectivity...")
    issues = []
    
    try:
        database_url = os.environ.get('DATABASE_URL')
        if not database_url:
            # Try individual components
            host = os.environ.get('DATABASE_HOST', 'localhost')
            port = os.environ.get('DATABASE_PORT', '5432')
            database = os.environ.get('DATABASE_NAME', 'polisDB_prod_local_mar14')
            user = os.environ.get('DATABASE_USER', 'postgres')
            password = os.environ.get('DATABASE_PASSWORD', '')
            ssl_mode = os.environ.get('DATABASE_SSL_MODE', 'disable')
            
            database_url = f"postgresql://{user}:{password}@{host}:{port}/{database}?sslmode={ssl_mode}"
        
        engine = sa.create_engine(database_url, connect_args={'connect_timeout': 5})
        
        with engine.connect() as conn:
            result = conn.execute(text("SELECT 1"))
            result.fetchone()
        
        logger.info("PostgreSQL connection successful.")
        engine.dispose()
        
    except Exception as e:
        issues.append(f"PostgreSQL connection failed: {str(e)}")
    
    return issues

def check_s3_minio():
    """Check S3/MinIO accessibility."""
    logger.info("Checking S3/MinIO accessibility...")
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
        
        # Try to head the bucket
        try:
            s3_client.head_bucket(Bucket=bucket_name)
            logger.info(f"S3/MinIO bucket '{bucket_name}' is accessible.")
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', 'Unknown')
            if error_code == '404':
                issues.append(f"S3/MinIO bucket '{bucket_name}' does not exist")
            else:
                issues.append(f"S3/MinIO bucket access failed: {error_code}")
        
    except Exception as e:
        issues.append(f"S3/MinIO check failed: {str(e)}")
    
    return issues

def check_environment_variables():
    """Check required environment variables."""
    logger.info("Checking environment variables...")
    issues = []
    
    required_vars = {
        'OLLAMA_MODEL': 'Required for pipeline jobs',
    }
    
    optional_vars = {
        'ANTHROPIC_MODEL': 'Required for CREATE_NARRATIVE_BATCH jobs',
        'ANTHROPIC_API_KEY': 'Required for narrative report generation',
    }
    
    for var, description in required_vars.items():
        if not os.environ.get(var):
            issues.append(f"Required environment variable {var} is not set ({description})")
    
    for var, description in optional_vars.items():
        if not os.environ.get(var):
            logger.warning(f"Optional environment variable {var} is not set ({description})")
    
    return issues

def check_ollama():
    """Check Ollama service connectivity (if configured)."""
    logger.info("Checking Ollama connectivity...")
    issues = []
    
    ollama_host = os.environ.get('OLLAMA_HOST', 'http://ollama:11434')
    model = os.environ.get('OLLAMA_MODEL')
    
    if not model:
        logger.info("OLLAMA_MODEL not set, skipping Ollama check")
        return issues
    
    try:
        import requests
        response = requests.get(f"{ollama_host}/api/tags", timeout=5)
        if response.status_code == 200:
            logger.info(f"Ollama service is accessible at {ollama_host}")
        else:
            issues.append(f"Ollama service returned status {response.status_code}")
    except ImportError:
        logger.warning("requests library not available, skipping Ollama check")
    except Exception as e:
        issues.append(f"Ollama connectivity check failed: {str(e)}")
    
    return issues

def main():
    """Run all health checks."""
    logger.info("Starting Delphi health check...")
    
    all_issues = []
    
    # Run all checks
    all_issues.extend(check_dynamodb())
    all_issues.extend(check_postgresql())
    all_issues.extend(check_s3_minio())
    all_issues.extend(check_environment_variables())
    all_issues.extend(check_ollama())
    
    # Report results
    if all_issues:
        logger.error("Health check found issues:")
        for issue in all_issues:
            logger.error(f"  - {issue}")
        logger.error(f"Total issues: {len(all_issues)}")
        return 1
    else:
        logger.info("All health checks passed!")
        return 0

if __name__ == "__main__":
    sys.exit(main())








