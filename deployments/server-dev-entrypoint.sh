#!/bin/sh
set -eu

cat >/tmp/config.yaml <<EOF
server:
  port: 8080
  base_url: "${PUBLIC_URL:-http://localhost:5173}"
  mode: dev
database:
  host: "${MYSQL_HOST:-mysql}"
  port: ${MYSQL_PORT:-3306}
  user: "${MYSQL_USER:-tgemoji}"
  password: "${MYSQL_PASSWORD:?MYSQL_PASSWORD 未设置}"
  name: "${MYSQL_DATABASE:-tg_emoji_hub}"
log:
  level: ${LOG_LEVEL:-debug}
  format: console
mcp:
  enabled: true
  path: /mcp
paths:
  signals_dir: /var/signals
  thumbnail_dir: /var/thumbnails
  media_dir: /var/media
EOF

export CONFIG_PATH=/tmp/config.yaml
cd /workspace
exec go run ./cmd/server
