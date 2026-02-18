<!--
  Author: Bladestar2105
  License: MIT
-->
<div align="center">
  <img src="public/logo.png" alt="IPTV-Manager Logo" width="120" />
  <h1>IPTV-Manager</h1>
  <p>A comprehensive IPTV management system with automatic provider synchronization, intelligent category mapping, and multi-user support.</p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  </p>
  <p><strong>⚠️ DISCLAIMER: This project is for educational purposes only.</strong></p>
</div>

## 🚀 Features

### Core Functionality
- **Multi-User Management**: Support for multiple users with individual channel configurations and secure login.
- **Provider Management**: Connect to multiple IPTV providers via Xtream Codes API.
- **Category Organization**: Drag & drop sorting and visual channel assignment.
- **EPG Integration**: Comprehensive Electronic Program Guide (EPG) support with automatic updates.

### Advanced Features
- **Automatic Synchronization**: Configurable intervals (hourly, daily, weekly) with intelligent category mapping.
- **HDHomeRun Emulation**: Emulate HDHomeRun devices for seamless integration with Plex, Emby, and Jellyfin.
- **Shared Links**: Create public share links with customizable slugs (short URLs) and expiration dates.
- **Bulk Operations**: Optimized bulk category import and deletion for managing large playlists efficiently.
- **VOD & Series Support**: Full proxy support for Movies and TV Series.
- **Internationalization**: Localized UI (English, German, French, Greek).
- **M3U Playlist Generation**: Generate custom M3U playlists for external players.
- **Import/Export**: Secure, password-protected data migration.

### Security
- **🛡️ SSRF Protection**: Robust validation of upstream URLs (preventing access to private IPs, localhost, cloud metadata).
- **🔐 Rate Limiting**: Protection against brute force (Login) and DoS attacks (Client Logs).
- **🎫 Secure Authentication**: JWT-based auth with session management and Bcrypt password hashing.
- **🚫 IP Blocking**: Configurable IP blocking and whitelisting.
- **🔒 Security Headers**: Comprehensive Helmet.js security headers.

### Performance
- **🔥 Multi-Core Optimization**: Node.js Clustering utilizes all CPU cores.
- **⚡ Optional Redis**: High-performance tracking for active streams (recommended for >500 users).
- **🧵 Worker Threads**: Offloads CPU-intensive tasks like EPG mapping.
- **⚡ Optimized Channel Matching**: Fast channel matching algorithms using bitwise signatures.

## 📋 Requirements
- **Node.js**: 20.x+
- **npm**: 9.x+
- **SQLite**: 3.x (included)

## 🐳 Docker Installation (Recommended)

### Using Docker Compose
1.  Create `docker-compose.yml`:
    ```yaml
    services:
      iptv-manager:
        image: ghcr.io/bladestar2105/iptv-manager:latest
        container_name: iptv-manager
        restart: unless-stopped
        ports:
          - "3000:3000"
        volumes:
          - ./data:/data
        environment:
          - DATA_DIR=/data
    ```
2.  Run `docker-compose up -d`.
3.  Access at `http://localhost:3000`.

## 🔧 Manual Installation
1.  Clone repo: `git clone https://github.com/Bladestar2105/IPTV-Manager.git`
2.  Install: `npm install`
3.  Configure: `cp .env.example .env` (edit as needed)
4.  Run: `npm start`

### First Time Setup
- **Default Username**: `admin`
- **Default Password**: Random 16-char hex string (check console output).
- **Important**: Change password immediately after login.

## 📸 Screenshots

| Login | Dashboard |
|:---:|:---:|
| ![Login Page](docs/images/login.png) | ![Dashboard](docs/images/providers.png) |

| Categories | Channels |
|:---:|:---:|
| ![Category Management](docs/images/categories.png) | ![Channel Assignment](docs/images/channels.png) |

| Sync Logs |
|:---:|
| ![Sync Logs](docs/images/sync_logs.png) |

| EPG Sources | EPG Browse |
|:---:|:---:|
| ![EPG Sources](docs/images/epg_sources.png) | ![EPG Browse](docs/images/epg_browse.png) |

| EPG Mapping | Statistics |
|:---:|:---:|
| ![EPG Mapping](docs/images/epg_mapping.png) | ![Statistics](docs/images/statistics.png) |

| Security | Xtream Credentials |
|:---:|:---:|
| ![Security](docs/images/security.png) | ![Xtream Credentials](docs/images/xtream_view.png) |

| Web Player |
|:---:|
| ![Web Player](docs/images/web_player.png) |

## 📚 API Overview

### Main Endpoints
- **Auth**: `/api/login`, `/api/change-password`
- **Users**: `/api/users` (CRUD)
- **Providers**: `/api/providers` (CRUD, Sync, Import)
- **Categories**: `/api/user-categories` (Manage, Reorder)
- **EPG**: `/api/epg-sources` (Manage, Update)
- **Shares**: `/api/shares` (Create, Update, Delete)

### Xtream Codes / Player API
- `GET /player_api.php`: Auth & Metadata
- `GET /live/:user/:pass/:id.ts`: Live Stream
- `GET /movie/:user/:pass/:id.ext`: Movie Stream
- `GET /series/:user/:pass/:id.ext`: Series Stream
- `GET /xmltv.php`: XMLTV EPG

### HDHomeRun Emulation
- `GET /hdhr/:token/discover.json`
- `GET /hdhr/:token/lineup.json`
- `GET /hdhr/:token/auto/v:channelId`

## 📄 License
MIT License
