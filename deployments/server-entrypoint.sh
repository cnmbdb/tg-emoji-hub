#!/bin/sh
# 用 deployments/.env 里的变量现拼一份 config.yaml，省得数据库密码在三个文件里手工对齐
set -eu

: "${MYSQL_PASSWORD:?MYSQL_PASSWORD 未设置}"

cat > /tmp/config.yaml <<EOF
server:
  port: 8080
  base_url: "${PUBLIC_URL:-http://localhost:8080}"
  mode: prod

database:
  host: "${MYSQL_HOST:-mysql}"
  port: ${MYSQL_PORT:-3306}
  user: "${MYSQL_USER:-tgemoji}"
  password: "${MYSQL_PASSWORD}"
  name: "${MYSQL_DATABASE:-tg_emoji_hub}"

log:
  level: ${LOG_LEVEL:-info}
  format: json

mcp:
  enabled: true
  path: /mcp

paths:
  signals_dir: /var/signals
  thumbnail_dir: /var/thumbnails
  media_dir: /var/media
  r2_base_url: "${R2_BASE_URL:-}"
EOF

export CONFIG_PATH=/tmp/config.yaml
exec /app/server "$@"
