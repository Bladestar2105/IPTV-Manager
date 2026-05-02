#!/bin/sh
set -eu

APP_USER="${APP_USER:-app}"
APP_GROUP="${APP_GROUP:-app}"
APP_UID="$(id -u "$APP_USER")"
APP_GID="$(id -g "$APP_GROUP")"
APP_OWNER="$APP_UID:$APP_GID"

owner_of() {
  stat -c '%u:%g' "$1" 2>/dev/null || echo ''
}

persist_geoip_data() {
  GEOIP_PACKAGE_DIR="/app/node_modules/geoip-lite/data"
  GEOIP_DATA_DIR="${GEOIP_DATA_DIR:-/data/geoip}"

  if [ ! -d /data ] || { [ ! -d "$GEOIP_PACKAGE_DIR" ] && [ ! -L "$GEOIP_PACKAGE_DIR" ]; }; then
    return
  fi

  mkdir -p "$GEOIP_DATA_DIR"

  if [ -d "$GEOIP_PACKAGE_DIR" ] && [ ! -L "$GEOIP_PACKAGE_DIR" ]; then
    if [ -z "$(ls -A "$GEOIP_DATA_DIR" 2>/dev/null)" ]; then
      cp -a "$GEOIP_PACKAGE_DIR"/. "$GEOIP_DATA_DIR"/
    fi
    rm -rf "$GEOIP_PACKAGE_DIR"
    ln -s "$GEOIP_DATA_DIR" "$GEOIP_PACKAGE_DIR"
  fi

  if [ "$(owner_of "$GEOIP_DATA_DIR")" != "$APP_OWNER" ]; then
    chown -R "$APP_OWNER" "$GEOIP_DATA_DIR" || true
  fi
}

# Backward compatibility:
# Existing setups may have /data files owned by root from older images.
# If container starts as root, fix ownership only when needed and then drop privileges.
if [ "$(id -u)" -eq 0 ]; then
  persist_geoip_data

  if [ -d /data ]; then
    if [ "$(owner_of /data)" != "$APP_OWNER" ]; then
      chown -R "$APP_OWNER" /data || true
    fi
  fi
  if [ -d /app ]; then
    if [ "$(owner_of /app)" != "$APP_OWNER" ]; then
      chown "$APP_OWNER" /app || true
    fi
  fi
  exec su-exec "$APP_USER:$APP_GROUP" "$@"
fi

exec "$@"
