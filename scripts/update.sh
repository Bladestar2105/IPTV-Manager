#!/bin/bash

# IPTV-Manager Update Script for Debian/Ubuntu
# This script pulls the latest changes, updates dependencies, and restarts the service.

set -e

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

if [ ! -d "$INSTALL_DIR" ]; then
    echo ">> Error: IPTV-Manager installation directory not found at $INSTALL_DIR."
    echo ">> Please ensure you installed the application using the install.sh script."
    exit 1
fi

cd "$INSTALL_DIR"

echo ">> Stopping the service..."
systemctl stop "$SERVICE_NAME"

echo ">> Pulling latest changes from repository..."
sudo -u iptv-manager git fetch origin main
sudo -u iptv-manager git pull origin main

echo ">> Updating application dependencies..."
sudo -u iptv-manager npm install

echo ">> Restarting the service..."
systemctl start "$SERVICE_NAME"

echo "========================================="
echo "   Update Completed Successfully!"
echo "========================================="
echo ">> You can check the logs using: sudo journalctl -u $SERVICE_NAME -f"
echo ">> The application is running at http://$(hostname -I | awk '{print $1}'):3000"
