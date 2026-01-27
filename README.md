<!--
  Author: Bladestar2105
  License: MIT
-->
# IPTV-Manager

A comprehensive IPTV management system with automatic provider synchronization, intelligent category mapping, and multi-user support.

**⚠️ DISCLAIMER: This project is for educational purposes only.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 🚀 Features

### Core Functionality
- **Multi-User Management**: Support for multiple users with individual channel configurations.
- **Provider Management**: Connect to multiple IPTV providers (Xtream Codes API).
- **Category Organization**: Create and organize custom categories with drag & drop sorting.
- **Channel Assignment**: Assign channels to categories with a visual interface.
- **EPG Integration**: Support for Electronic Program Guide (EPG) data.

### Advanced Features
- **Automatic Provider Synchronization**: Configurable sync intervals (hourly, daily, weekly).
- **Intelligent Category Mapping**:
  - First sync: Creates mappings without auto-creating categories (user control).
  - Subsequent syncs: Automatically creates new categories and assigns channels.
- **Background Sync Scheduler**: Automatic synchronization runs in the background.
- **Comprehensive Sync Logging**: Detailed logs of all sync operations.
- **Category Import**: Import provider categories with or without channels.
- **Adult Content Filtering**: Automatic detection and marking of adult content.

### Security
- **🔐 Password Hashing**: Bcrypt-based password hashing.
- **🎫 JWT Authentication**: Token-based authentication with configurable expiration.
- **🛡️ Rate Limiting**: Protection against brute force attacks.
- **🔒 Security Headers**: Helmet.js for comprehensive security headers.
- **🚪 Login System**: Secure login modal with session management.

## 📋 Requirements

- **Node.js**: 20.x or higher
- **npm**: 9.x or higher
- **SQLite**: 3.x (included)

## 🔧 Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/Bladestar2105/IPTV-Manager.git
    cd IPTV-Manager
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  (Optional) Configure environment variables:
    ```bash
    cp .env.example .env
    # Edit .env with your preferred settings
    ```

4.  Start the server:
    ```bash
    node server.js
    ```

The application will be available at `http://localhost:3000`.

### First Time Setup
- On first start, a default admin user is automatically created.
- Credentials are displayed in the console and saved to `ADMIN_CREDENTIALS.txt`.
- **Default Username**: `admin`
- **Default Password**: Random 16-character hex string.
- ⚠️ **IMPORTANT**: Change the password immediately after first login!

## 📄 License

This project is licensed under the MIT License.

## 👤 Author

**Bladestar2105**
