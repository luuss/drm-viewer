#!/usr/bin/env bash
# Naechtliche Sicherung: Datenbank als Dump, Dateien aus MinIO gespiegelt.
# Aufruf per Cron:  0 3 * * * /opt/emagazin/deploy/backup.sh >> /var/log/emagazin-backup.log 2>&1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${BACKUP_DIR:-/var/backups/emagazin}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H%M)"

mkdir -p "$TARGET"

echo "[$(date -Is)] Datenbank sichern"
docker compose -f "$ROOT/docker-compose.selfhost.yml" exec -T postgres \
	pg_dumpall -U convex | gzip -9 > "$TARGET/db_$STAMP.sql.gz"

echo "[$(date -Is)] Dateien sichern"
docker compose -f "$ROOT/docker-compose.selfhost.yml" exec -T minio \
	sh -c 'tar -cf - -C /data .' | gzip -9 > "$TARGET/files_$STAMP.tar.gz"

echo "[$(date -Is)] Alte Sicherungen aufraeumen (aelter als ${KEEP_DAYS} Tage)"
find "$TARGET" -name 'db_*.sql.gz' -mtime "+$KEEP_DAYS" -delete
find "$TARGET" -name 'files_*.tar.gz' -mtime "+$KEEP_DAYS" -delete

echo "[$(date -Is)] fertig: $(du -sh "$TARGET" | cut -f1) belegt"
