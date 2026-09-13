#!/usr/bin/env bash

# Shared Debian/Ubuntu prerequisites for manual, systemd and Proxmox installs.
set -e

if [ "$(id -u)" -ne 0 ]; then
    echo "Please run this script as root (e.g., sudo bash scripts/install-ai-runtime.sh)"
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends bubblewrap

if [ -r /sys/module/apparmor/parameters/enabled ] && grep -q '^Y' /sys/module/apparmor/parameters/enabled; then
    if ! command -v apparmor_parser >/dev/null 2>&1; then
        apt-get install -y --no-install-recommends apparmor
    fi
    SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    install -D -o root -g root -m 0755 /usr/bin/bwrap /usr/local/lib/iptv-manager/bwrap
    install -D -o root -g root -m 0644 "$SCRIPT_DIR/ai-bwrap.apparmor" /etc/apparmor.d/iptv-manager-bwrap
    if ! apparmor_parser -r /etc/apparmor.d/iptv-manager-bwrap; then
        echo ">> WARNING: Could not load the ChatGPT sandbox policy. The host administrator must permit the sandbox before ChatGPT can be used."
    fi
fi

npm install --global @openai/codex@0.154.0
