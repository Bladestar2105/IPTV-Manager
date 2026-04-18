#!/bin/sh
set -eu

APP_USER="${APP_USER:-app}"
APP_GROUP="${APP_GROUP:-app}"
APP_UID="$(id -u "$APP_USER")"
APP_GID="$(id -g "$APP_GROUP")"

# Backward compatibility:
# Existing setups may have /data files owned by root from older images.
# If container starts as root, fix ownership once and then drop privileges.
if [ "$(id -u)" -eq 0 ]; then
  if [ -d /data ]; then
    chown -R "$APP_UID:$APP_GID" /data || true
  fi
  chown -R "$APP_UID:$APP_GID" /app || true
  exec su-exec "$APP_USER:$APP_GROUP" "$@"
fi

exec "$@"
