#!/bin/bash

# IPTV-Manager Installation Script for Debian/Ubuntu
# This script installs Node.js, git, clones the repository, and sets up a systemd service.

set -e

# Ensure script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root (e.g., sudo ./install.sh)"
  exit 1
fi

echo "========================================="
echo "   IPTV-Manager Bare Metal Installer"
echo "========================================="

# Update and install dependencies
echo ">> Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git build-essential ufw systemd

# Install Node.js (v20 as required by IPTV-Manager)
echo ">> Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Verify Node.js installation
node_version=$(node -v)
npm_version=$(npm -v)
echo ">> Node.js installed: $node_version"
echo ">> npm installed: $npm_version"

# Set up installation directory
INSTALL_DIR="/opt/iptv-manager"

if [ -d "$INSTALL_DIR" ]; then
    echo ">> Error: Directory $INSTALL_DIR already exists."
    echo ">> This script is for a fresh installation only."
    echo ">> To update an existing installation, please use: sudo ./scripts/update.sh from the $INSTALL_DIR directory."
    exit 1
fi

echo ">> Cloning repository into $INSTALL_DIR..."
git clone https://github.com/Bladestar2105/IPTV-Manager.git "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Install application dependencies
echo ">> Installing application dependencies..."
npm install

# Setup environment variables
if [ ! -f ".env" ]; then
    echo ">> Setting up .env file..."
    cp .env.example .env

    # Ensure JWT secret is unique for this installation
    jwt_secret=$(openssl rand -hex 32)
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${jwt_secret}|" .env

    echo ">> .env file created with a generated JWT secret."
fi

# Create a dedicated user for security
echo ">> Creating iptv-manager user..."
if id "iptv-manager" &>/dev/null; then
    echo "User iptv-manager already exists."
else
    useradd -r -d "$INSTALL_DIR" -s /usr/sbin/nologin iptv-manager
fi

# Set permissions
echo ">> Setting correct permissions..."
chown -R iptv-manager:iptv-manager "$INSTALL_DIR"
chmod -R 755 "$INSTALL_DIR"

# Create systemd service
SERVICE_FILE="/etc/systemd/system/iptv-manager.service"

echo ">> Creating systemd service file at $SERVICE_FILE..."
cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=IPTV-Manager Service
After=network.target

[Service]
Type=simple
User=iptv-manager
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd, enable and start service
echo ">> Starting IPTV-Manager service..."
systemctl daemon-reload
systemctl enable iptv-manager
systemctl start iptv-manager

echo "========================================="
echo "   Installation Completed Successfully!"
echo "========================================="
echo ">> IPTV-Manager is now running as a background service."
echo ">> You can access the application at: http://$(hostname -I | awk '{print $1}'):3000"
echo ">> To check the logs, run: sudo journalctl -u iptv-manager -f"
echo ">> To update in the future, run: sudo ./scripts/update.sh from the $INSTALL_DIR directory."
echo ""
echo "Note: The default port is 3000. Ensure it is open in your firewall."
if command -v ufw > /dev/null; then
    echo ">> If you are using UFW, you can open the port with: sudo ufw allow 3000/tcp"
fi
