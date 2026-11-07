#!/bin/bash

# IPTV-Manager Update Script for Debian/Ubuntu
# This script pulls the latest changes, updates dependencies, and restarts the service.

set -e
set -o pipefail

# Ensure script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root (e.g., sudo ./update.sh)"
  exit 1
fi

echo "========================================="
echo "   IPTV-Manager Bare Metal Updater"
echo "========================================="

INSTALL_DIR="/opt/iptv-manager"
SERVICE_NAME="iptv-manager"

ensure_node_24() {
    local current_major=0

    if command -v node >/dev/null 2>&1; then
        current_major=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
    fi

    if [ "$current_major" -lt 24 ]; then
        echo ">> Installing/upgrading Node.js 24.x..."
        curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
        apt-get install -y nodejs
    else
        echo ">> Node.js $(node -v) already satisfies the minimum version."
    fi

    echo ">> npm installed: $(npm -v)"
}

if [ ! -d "$INSTALL_DIR" ]; then
    echo ">> Error: IPTV-Manager installation directory not found at $INSTALL_DIR."
    echo ">> Please ensure you installed the application using the install.sh script."
    exit 1
fi

cd "$INSTALL_DIR"

ensure_node_24

echo ">> Fetching latest changes from repository..."
runuser -u iptv-manager -- git fetch origin main
target_commit=$(runuser -u iptv-manager -- git rev-parse --verify 'FETCH_HEAD^{commit}')
starting_commit=$(runuser -u iptv-manager -- git rev-parse HEAD)
if ! runuser -u iptv-manager -- git diff --quiet || ! runuser -u iptv-manager -- git diff --cached --quiet; then
    echo ">> ERROR: Local tracked changes found. Preserve or commit them before updating." >&2
    exit 1
fi
if ! runuser -u iptv-manager -- git merge-base --is-ancestor HEAD "$target_commit"; then
    echo ">> ERROR: The fetched update cannot fast-forward this checkout." >&2
    exit 1
fi

service_was_running=false
if systemctl is-active --quiet "$SERVICE_NAME"; then
    service_was_running=true
fi
staging_dir=$(mktemp -d "$INSTALL_DIR/.update.XXXXXXXX")
service_stopped=false
update_applied=false
new_modules_installed=false
cleanup_update() {
    local status=$?
    local retain_staging=false
    trap - EXIT
    if [ "$status" -ne 0 ] && [ "$update_applied" = false ] && [ "$new_modules_installed" = true ]; then
        if ! mv "$INSTALL_DIR/node_modules" "$staging_dir/failed-node_modules"; then
            retain_staging=true
            echo ">> ERROR: Could not move prepared dependencies aside." >&2
        fi
    fi
    if [ "$status" -ne 0 ] && [ "$update_applied" = false ] && { [ -e "$staging_dir/previous-node_modules" ] || [ -L "$staging_dir/previous-node_modules" ]; }; then
        if [ ! -e "$INSTALL_DIR/node_modules" ] && [ ! -L "$INSTALL_DIR/node_modules" ] && mv "$staging_dir/previous-node_modules" "$INSTALL_DIR/node_modules"; then
            echo ">> Restored previous application dependencies." >&2
        else
            retain_staging=true
            echo ">> ERROR: Could not restore previous dependencies." >&2
        fi
    fi
    if [ "$status" -ne 0 ] && [ "$service_stopped" = true ] && [ "$service_was_running" = true ]; then
        echo ">> Update failed; attempting to restart the service..." >&2
        if ! systemctl start "$SERVICE_NAME"; then
            retain_staging=true
            echo ">> ERROR: Service restart failed. Check journalctl -u $SERVICE_NAME." >&2
        fi
    fi
    if [ "$retain_staging" = true ]; then
        echo ">> Recovery files retained in $staging_dir." >&2
    else
        rm -rf -- "$staging_dir" || echo ">> WARNING: Could not remove staging directory $staging_dir." >&2
    fi
    return "$status"
}
trap cleanup_update EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

chown iptv-manager:iptv-manager "$staging_dir"
runuser -u iptv-manager -- git archive "$target_commit" | runuser -u iptv-manager -- tar -x -C "$staging_dir"
echo ">> Preparing application dependencies before stopping the service..."
(
    cd "$staging_dir"
    runuser -u iptv-manager -- npm ci --omit=dev
)
test -d "$staging_dir/node_modules"
if [ "$(runuser -u iptv-manager -- git rev-parse HEAD)" != "$starting_commit" ] || ! runuser -u iptv-manager -- git diff --quiet || ! runuser -u iptv-manager -- git diff --cached --quiet; then
    echo ">> ERROR: Checkout changed while dependencies were being prepared; update cancelled." >&2
    exit 1
fi

echo ">> Stopping the service..."
service_stopped=true
systemctl stop "$SERVICE_NAME"

if [ -e "$INSTALL_DIR/node_modules" ] || [ -L "$INSTALL_DIR/node_modules" ]; then
    mv "$INSTALL_DIR/node_modules" "$staging_dir/previous-node_modules"
fi
mv "$staging_dir/node_modules" "$INSTALL_DIR/node_modules"
new_modules_installed=true
echo ">> Applying prepared commit $target_commit..."
runuser -u iptv-manager -- git merge --ff-only "$target_commit"
update_applied=true
if ! bash scripts/install-ai-runtime.sh; then
    echo ">> WARNING: ChatGPT setup could not be completed; continuing the IPTV-Manager update. Review the errors above."
fi
# Enable newly provisioned ChatGPT support without replacing explicit choices.
if ! grep -Eq '^[[:space:]]*(export[[:space:]]+)?AI_CODEX_ENABLED([[:space:]]*=|:[[:space:]]+)' .env 2>/dev/null; then
    printf '\nAI_CODEX_ENABLED=true\n' >> .env
    chown iptv-manager:iptv-manager .env
fi
chmod 600 .env

echo ">> Checking ChatGPT availability as the service user..."
if ! runuser -u iptv-manager -- node scripts/check-ai-runtime.mjs --if-enabled; then
    echo ">> WARNING: ChatGPT is unavailable; API connections remain usable. Review the runtime check above."
fi

echo ">> Restarting the service..."
systemctl start "$SERVICE_NAME"

echo "========================================="
echo "   Update Finished"
echo "========================================="
echo ">> You can check the logs using: sudo journalctl -u $SERVICE_NAME -f"
echo ">> The application is running at http://$(hostname -I | awk '{print $1}'):3000"
