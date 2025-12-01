#!/bin/bash
#
# Agent5 Database Backup Script
#
# Usage:
#   ./scripts/backup.sh                    # Full backup to default location
#   ./scripts/backup.sh /path/to/backup    # Full backup to custom location
#   ./scripts/backup.sh --s3 bucket-name   # Backup to S3
#
# Environment variables:
#   MONGO_URI          - MongoDB connection string (required)
#   BACKUP_DIR         - Default backup directory (default: ./backups)
#   AWS_ACCESS_KEY_ID  - AWS credentials for S3 upload
#   AWS_SECRET_ACCESS_KEY
#   BACKUP_RETENTION_DAYS - Days to keep local backups (default: 7)
#

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$BACKEND_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="agent5_backup_$TIMESTAMP"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check required tools
check_dependencies() {
    if ! command -v mongodump &> /dev/null; then
        log_error "mongodump not found. Please install MongoDB Database Tools."
        log_info "Install: https://www.mongodb.com/docs/database-tools/installation/"
        exit 1
    fi

    if [[ "$1" == "--s3" ]] && ! command -v aws &> /dev/null; then
        log_error "AWS CLI not found. Please install it for S3 uploads."
        exit 1
    fi
}

# Parse MongoDB URI
parse_mongo_uri() {
    if [[ -z "$MONGO_URI" ]]; then
        # Try to load from .env
        if [[ -f "$BACKEND_DIR/.env" ]]; then
            source "$BACKEND_DIR/.env"
        fi
    fi

    if [[ -z "$MONGO_URI" ]]; then
        log_error "MONGO_URI environment variable is not set"
        exit 1
    fi
}

# Create backup directory
setup_backup_dir() {
    local target_dir="${1:-$BACKUP_DIR}"

    if [[ ! -d "$target_dir" ]]; then
        log_info "Creating backup directory: $target_dir"
        mkdir -p "$target_dir"
    fi

    echo "$target_dir"
}

# Perform MongoDB backup
do_backup() {
    local backup_path="$1/$BACKUP_NAME"

    log_info "Starting backup to: $backup_path"
    log_info "Timestamp: $TIMESTAMP"

    # Create backup
    mongodump \
        --uri="$MONGO_URI" \
        --out="$backup_path" \
        --gzip \
        2>&1 | while read line; do
            log_info "$line"
        done

    # Check if backup was successful
    if [[ $? -eq 0 ]] && [[ -d "$backup_path" ]]; then
        # Create tar archive
        local archive_name="$backup_path.tar.gz"
        tar -czf "$archive_name" -C "$(dirname "$backup_path")" "$(basename "$backup_path")"
        rm -rf "$backup_path"

        local size=$(du -h "$archive_name" | cut -f1)
        log_info "Backup completed successfully"
        log_info "Archive: $archive_name"
        log_info "Size: $size"

        echo "$archive_name"
    else
        log_error "Backup failed"
        exit 1
    fi
}

# Upload to S3
upload_to_s3() {
    local archive="$1"
    local bucket="$2"
    local s3_path="s3://$bucket/agent5/backups/$(basename "$archive")"

    log_info "Uploading to S3: $s3_path"

    aws s3 cp "$archive" "$s3_path" \
        --storage-class STANDARD_IA \
        2>&1 | while read line; do
            log_info "$line"
        done

    if [[ $? -eq 0 ]]; then
        log_info "S3 upload completed successfully"
    else
        log_error "S3 upload failed"
        exit 1
    fi
}

# Cleanup old backups
cleanup_old_backups() {
    local backup_dir="$1"

    log_info "Cleaning up backups older than $RETENTION_DAYS days"

    find "$backup_dir" -name "agent5_backup_*.tar.gz" -mtime +$RETENTION_DAYS -delete 2>/dev/null || true

    local remaining=$(ls -1 "$backup_dir"/agent5_backup_*.tar.gz 2>/dev/null | wc -l)
    log_info "Remaining backups: $remaining"
}

# Main
main() {
    log_info "=== Agent5 Database Backup ==="

    check_dependencies "$@"
    parse_mongo_uri

    local backup_dir
    local s3_bucket=""

    # Parse arguments
    if [[ "$1" == "--s3" ]]; then
        s3_bucket="$2"
        backup_dir=$(setup_backup_dir)
    elif [[ -n "$1" ]]; then
        backup_dir=$(setup_backup_dir "$1")
    else
        backup_dir=$(setup_backup_dir)
    fi

    # Perform backup
    local archive=$(do_backup "$backup_dir")

    # Upload to S3 if requested
    if [[ -n "$s3_bucket" ]]; then
        upload_to_s3 "$archive" "$s3_bucket"
    fi

    # Cleanup old backups
    cleanup_old_backups "$backup_dir"

    log_info "=== Backup Complete ==="
}

main "$@"
