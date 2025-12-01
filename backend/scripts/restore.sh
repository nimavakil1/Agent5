#!/bin/bash
#
# Agent5 Database Restore Script
#
# Usage:
#   ./scripts/restore.sh backup_file.tar.gz           # Restore from local file
#   ./scripts/restore.sh --s3 bucket-name backup.tar.gz  # Restore from S3
#   ./scripts/restore.sh --list                       # List available backups
#
# Environment variables:
#   MONGO_URI          - MongoDB connection string (required)
#   BACKUP_DIR         - Default backup directory (default: ./backups)
#
# CAUTION: This will overwrite existing data!
#

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$BACKEND_DIR/backups}"
TEMP_DIR="/tmp/agent5_restore_$$"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Cleanup on exit
cleanup() {
    rm -rf "$TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Check dependencies
check_dependencies() {
    if ! command -v mongorestore &> /dev/null; then
        log_error "mongorestore not found. Please install MongoDB Database Tools."
        exit 1
    fi
}

# Parse MongoDB URI
parse_mongo_uri() {
    if [[ -z "$MONGO_URI" ]]; then
        if [[ -f "$BACKEND_DIR/.env" ]]; then
            source "$BACKEND_DIR/.env"
        fi
    fi

    if [[ -z "$MONGO_URI" ]]; then
        log_error "MONGO_URI environment variable is not set"
        exit 1
    fi
}

# List available backups
list_backups() {
    log_info "Available local backups:"
    echo ""

    if [[ -d "$BACKUP_DIR" ]]; then
        ls -lh "$BACKUP_DIR"/agent5_backup_*.tar.gz 2>/dev/null | \
            awk '{print "  " $9 " (" $5 ", " $6 " " $7 " " $8 ")"}'
    else
        echo "  No backups found in $BACKUP_DIR"
    fi

    echo ""
}

# Download from S3
download_from_s3() {
    local bucket="$1"
    local backup_name="$2"
    local local_path="$TEMP_DIR/$backup_name"

    mkdir -p "$TEMP_DIR"

    log_info "Downloading from S3: s3://$bucket/agent5/backups/$backup_name"

    aws s3 cp "s3://$bucket/agent5/backups/$backup_name" "$local_path"

    if [[ $? -eq 0 ]]; then
        log_info "Download completed"
        echo "$local_path"
    else
        log_error "Download failed"
        exit 1
    fi
}

# Extract backup
extract_backup() {
    local archive="$1"
    local extract_dir="$TEMP_DIR/extracted"

    mkdir -p "$extract_dir"

    log_info "Extracting backup: $archive"

    tar -xzf "$archive" -C "$extract_dir"

    # Find the backup directory
    local backup_dir=$(find "$extract_dir" -type d -name "agent5_backup_*" | head -1)

    if [[ -z "$backup_dir" ]]; then
        backup_dir=$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -1)
    fi

    echo "$backup_dir"
}

# Perform restore
do_restore() {
    local backup_dir="$1"

    log_warn "=== WARNING ==="
    log_warn "This will overwrite existing data in the database!"
    log_warn "Backup directory: $backup_dir"
    echo ""

    read -p "Are you sure you want to continue? (yes/no): " confirm

    if [[ "$confirm" != "yes" ]]; then
        log_info "Restore cancelled"
        exit 0
    fi

    log_info "Starting restore..."

    mongorestore \
        --uri="$MONGO_URI" \
        --drop \
        --gzip \
        "$backup_dir" \
        2>&1 | while read line; do
            log_info "$line"
        done

    if [[ $? -eq 0 ]]; then
        log_info "Restore completed successfully"
    else
        log_error "Restore failed"
        exit 1
    fi
}

# Main
main() {
    log_info "=== Agent5 Database Restore ==="

    check_dependencies
    parse_mongo_uri

    case "$1" in
        --list)
            list_backups
            exit 0
            ;;
        --s3)
            if [[ -z "$2" ]] || [[ -z "$3" ]]; then
                log_error "Usage: $0 --s3 bucket-name backup-file.tar.gz"
                exit 1
            fi
            local archive=$(download_from_s3 "$2" "$3")
            local backup_dir=$(extract_backup "$archive")
            do_restore "$backup_dir"
            ;;
        *)
            if [[ -z "$1" ]]; then
                log_error "Usage: $0 backup_file.tar.gz"
                log_info "Use --list to see available backups"
                exit 1
            fi

            if [[ ! -f "$1" ]]; then
                log_error "Backup file not found: $1"
                exit 1
            fi

            mkdir -p "$TEMP_DIR"
            local backup_dir=$(extract_backup "$1")
            do_restore "$backup_dir"
            ;;
    esac

    log_info "=== Restore Complete ==="
}

main "$@"
