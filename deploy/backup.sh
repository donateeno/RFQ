#!/usr/bin/env bash
# Daily database backup, keeps 14 days.   crontab:  15 2 * * * /opt/rfq/deploy/backup.sh >> /var/log/rfq-backup.log 2>&1
set -euo pipefail
DIR=${BACKUP_DIR:-/opt/rfq-backups}
mkdir -p "$DIR"
cd "$(dirname "$0")"
docker compose -f docker-compose.yml exec -T db pg_dump -U rfq -d rfq --format=custom > "$DIR/rfq-$(date +%Y%m%d-%H%M).dump"
find "$DIR" -name 'rfq-*.dump' -mtime +14 -delete
echo "$(date -Is) backup ok"
# Restore:  docker compose -f docker-compose.yml exec -T db pg_restore -U rfq -d rfq --clean < /opt/rfq-backups/rfq-YYYYMMDD-HHMM.dump
