#!/usr/bin/env bash

# Proxmox VE LXC Container Script for IPTV-Manager
# Run this script on the Proxmox Host shell.

set -e

echo "========================================="
echo "   IPTV-Manager Proxmox LXC Installer"
echo "========================================="

# Helper functions for colored output
function msg_info() {
    local msg="$1"
    echo -e "\e[34m[INFO]\e[0m $msg"
}

function msg_ok() {
    local msg="$1"
    echo -e "\e[32m[OK]\e[0m $msg"
}

function msg_error() {
    local msg="$1"
    echo -e "\e[31m[ERROR]\e[0m $msg"
    exit 1
}

# Prerequisites check
if ! command -v pveam > /dev/null; then
    msg_error "This script must be run on a Proxmox VE node."
fi

# Variables
CTID=$(pvesh get /cluster/nextid)
CT_NAME="iptv-manager"
DISK_SIZE="8G"
CORES=2
MEMORY=2048

# Update templates list
msg_info "Updating Proxmox LXC templates..."
pveam update >/dev/null

# Find latest Ubuntu 22.04 template
TEMPLATE_NAME=$(pveam available -section system | grep "ubuntu-22.04" | awk '{print $2}' | head -n 1)

if [ -z "$TEMPLATE_NAME" ]; then
    msg_error "Failed to find an Ubuntu 22.04 template in the Proxmox repositories."
fi

TEMPLATE="local:vztmpl/$(basename "$TEMPLATE_NAME")"

if ! pveam list local | grep -q "$(basename "$TEMPLATE_NAME")"; then
    msg_info "Downloading $TEMPLATE_NAME..."
    pveam download local "$TEMPLATE_NAME" >/dev/null || msg_error "Failed to download template."
fi

# Create LXC container
msg_info "Creating LXC Container (ID: $CTID, OS: Ubuntu 22.04)..."
pct create "$CTID" "$TEMPLATE" \
    --hostname "$CT_NAME" \
    --cores "$CORES" \
    --memory "$MEMORY" \
    --net0 name=eth0,bridge=vmbr0,ip=dhcp \
    --rootfs local-lvm:"$DISK_SIZE" \
    --features nesting=1 \
    --unprivileged 1 \
    --start 1 >/dev/null || msg_error "Failed to create LXC container."

msg_ok "LXC Container $CTID created and started."

# Wait for network
msg_info "Waiting for container to get an IP address..."
sleep 10
IP_ADDRESS=""
for i in {1..30}; do
    IP_ADDRESS=$(pct exec "$CTID" -- ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}')
    if [ -n "$IP_ADDRESS" ]; then
        break
    fi
    sleep 2
done

if [ -z "$IP_ADDRESS" ]; then
    msg_error "Failed to obtain an IP address for the container."
fi

msg_ok "Container assigned IP: $IP_ADDRESS"

# Run installation script inside the LXC container
msg_info "Installing IPTV-Manager inside the container..."
pct exec "$CTID" -- bash -c "apt-get update >/dev/null 2>&1"
pct exec "$CTID" -- bash -c "apt-get install -y curl git >/dev/null 2>&1"

# Download and run the install script inside the container
pct exec "$CTID" -- bash -c "curl -fsSL https://raw.githubusercontent.com/Bladestar2105/IPTV-Manager/main/scripts/install.sh -o /tmp/install.sh"
pct exec "$CTID" -- bash -c "chmod +x /tmp/install.sh"
pct exec "$CTID" -- bash -c "/tmp/install.sh"

msg_ok "Installation complete inside LXC container $CTID."
echo "========================================="
echo "   IPTV-Manager Proxmox LXC Deployed!"
echo "========================================="
echo "Access your instance at: http://$IP_ADDRESS:3000"
echo "To update your instance in the future, access the LXC console and run:"
echo "/opt/iptv-manager/scripts/update.sh"
