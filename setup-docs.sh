#!/bin/bash

# IPTV-Manager - Automatisches Setup Script
# Dieses Script erstellt alle notwendigen Dateien

echo "🚀 IPTV-Manager - File Setup"
echo "================================"
echo ""

# Prüfe ob wir im richtigen Verzeichnis sind
if [ ! -f "server.js" ]; then
    echo "❌ Fehler: server.js nicht gefunden!"
    echo "   Bitte führe dieses Script im IPTV-Manager Root-Verzeichnis aus"
    exit 1
fi

# Backup erstellen falls Dateien existieren
if [ -f "README.md" ]; then
    echo "📦 Backup existierender Dateien..."
    mkdir -p .backup_$(date +%Y%m%d_%H%M%S)
    [ -f "README.md" ] && cp README.md .backup_*/
    [ -f ".gitignore" ] && cp .gitignore .backup_*/
    [ -f "LICENSE" ] && cp LICENSE .backup_*/
    [ -f "package.json" ] && cp package.json .backup_*/
    echo "✅ Backup erstellt in .backup_*/"
fi

echo ""
echo "📝 Erstelle Dateien..."

# README.md erstellen
cat > README.md << 'EOFREADME'
# IPTV-Manager

A powerful IPTV management panel that aggregates multiple IPTV providers into customized playlists for end users. Built with Node.js, Express, and SQLite.

## ✨ Features

### Core Functionality
- 🔄 **Multi-Provider Support** - Aggregate channels from multiple Xtream Codes providers
- 👥 **User Management** - Create and manage multiple end users with individual playlists
- 📁 **Custom Categories** - Import or create custom categories with drag & drop sorting
- 📺 **Channel Management** - Select and organize channels per user with full control
- 🔞 **Adult Content Protection** - Automatic detection and marking of adult content
- 🌍 **Multi-Language** - English, German, French, Greek (auto-detection + manual switcher)
- 📊 **EPG Support** - Automatic EPG passthrough from providers

### Technical Features
- 🎯 **Xtream Codes API Compatible** - Works with TiviMate, IPTV Smarters, and other players
- 🔒 **Stream Proxy** - Built-in proxy for secure stream delivery
- 💾 **SQLite Database** - Lightweight, file-based storage
- 🖱️ **Drag & Drop UI** - Intuitive sorting for categories and channels
- 📦 **Self-Contained** - All assets bundled locally (Bootstrap, SortableJS)
- 🚀 **Fast & Lightweight** - Minimal resource usage

## 📋 Requirements

- Node.js 18+ (ES Modules support)
- npm or yarn
- Linux/Windows/macOS

## 🚀 Installation

### 1. Clone Repository

```bash
git clone https://github.com/Bladestar2105/IPTV-Manager.git
cd IPTV-Manager
```

### 2. Install Dependencies

```bash
npm install
```

This will automatically:
- Install all required packages
- Copy Bootstrap and SortableJS to `public/vendor/`
- Create the SQLite database on first run

### 3. Start Server

```bash
npm start
```

Server runs on: `http://localhost:3000`

## 🎯 Quick Start Guide

### 1. Add a Provider

1. Navigate to **Provider Management**
2. Enter provider details:
   - Name (e.g., "Provider A")
   - URL (e.g., `http://provider.com:8080`)
   - Username
   - Password
   - EPG URL (optional)
3. Click **Add Provider**
4. Click **Sync** to download channel list

### 2. Create a User

1. Go to **User Management**
2. Enter username and password
3. Click **Add User**
4. Select the user from the list

### 3. Import Categories

1. Select a user
2. Select a provider from dropdown
3. Click **📥 Import Provider Categories**
4. Choose categories to import:
   - **📥 Category Only** - Creates empty category
   - **📥 With Channels** - Imports all channels

### 4. Organize Channels

1. Select a category
2. Provider channels appear on the left
3. Use search to filter channels
4. Click **+** to add channels
5. Drag & drop to reorder (⋮⋮ handle)

### 5. Connect IPTV Player

Use these credentials in TiviMate, IPTV Smarters, etc.:

```
URL:      http://your-server:3000
Username: <your-user>
Password: <your-password>
EPG URL:  http://your-server:3000/xmltv.php?username=<user>&password=<pass>
```

## 🔧 Configuration

### Port Configuration

Edit `server.js`:

```javascript
const PORT = 3000; // Change to your preferred port
```

### Database Location

Default: `db.sqlite` in project root

To change location, edit `server.js`:

```javascript
const db = new Database('/path/to/your/database.sqlite');
```

## 📡 API Documentation

### Xtream Codes API Endpoints

#### Get Server Info
```
GET /player_api.php?username=<user>&password=<pass>
```

#### Get Categories
```
GET /player_api.php?username=<user>&password=<pass>&action=get_live_categories
```

#### Get Streams
```
GET /player_api.php?username=<user>&password=<pass>&action=get_live_streams
```

#### Stream Playback
```
GET /live/<username>/<password>/<stream_id>.ts
```

#### EPG Data
```
GET /xmltv.php?username=<user>&password=<pass>
```

### Management API Endpoints

#### Users
```
GET    /api/users                     # List users
POST   /api/users                     # Create user
DELETE /api/users/:id                 # Delete user
```

#### Providers
```
GET    /api/providers                 # List providers
POST   /api/providers                 # Create provider
DELETE /api/providers/:id             # Delete provider
POST   /api/providers/:id/sync        # Sync channels
GET    /api/providers/:id/channels    # Get channels
GET    /api/providers/:id/categories  # Get categories
```

#### Categories
```
GET    /api/users/:userId/categories                    # List categories
POST   /api/users/:userId/categories                    # Create category
PUT    /api/user-categories/:id                         # Update category
DELETE /api/user-categories/:id                         # Delete category
PUT    /api/user-categories/:id/adult                   # Toggle adult flag
PUT    /api/users/:userId/categories/reorder            # Reorder categories
```

#### Channels
```
GET    /api/user-categories/:catId/channels             # List channels
POST   /api/user-categories/:catId/channels             # Add channel
DELETE /api/user-channels/:id                           # Remove channel
PUT    /api/user-categories/:catId/channels/reorder     # Reorder channels
```

## 🌍 Internationalization

### Supported Languages

| Language | Code | Status |
|----------|------|--------|
| English  | `en` | ✅ Complete |
| German   | `de` | ✅ Complete |
| French   | `fr` | ✅ Complete |
| Greek    | `el` | ✅ Complete |

### Adding New Languages

1. Edit `public/i18n.js`
2. Add new language object
3. Update language switcher in `public/index.html`

Language auto-detects from browser settings with fallback to English.

## 🔒 Security Considerations

### Production Deployment

⚠️ **Important Security Notes:**

1. **Change Default Port** - Don't expose port 3000 directly
2. **Use Reverse Proxy** - nginx/Apache with SSL/TLS
3. **Strong Passwords** - Enforce strong user passwords
4. **Firewall Rules** - Restrict access to management interface
5. **Database Backup** - Regular backups of `db.sqlite`
6. **HTTPS Only** - Never use HTTP in production

### Recommended nginx Configuration

```nginx
server {
    listen 443 ssl http2;
    server_name iptv.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 🗄️ Database Schema

```sql
-- Users
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  is_active INTEGER DEFAULT 1
);

-- Providers
CREATE TABLE providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  epg_url TEXT
);

-- Provider Channels
CREATE TABLE provider_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  remote_stream_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  original_category_id INTEGER DEFAULT 0,
  logo TEXT DEFAULT '',
  stream_type TEXT DEFAULT 'live',
  epg_channel_id TEXT DEFAULT '',
  UNIQUE(provider_id, remote_stream_id)
);

-- User Categories
CREATE TABLE user_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_adult INTEGER DEFAULT 0
);

-- User Channels
CREATE TABLE user_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_category_id INTEGER NOT NULL,
  provider_channel_id INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0
);
```

## 🛠️ Development

### Project Structure

```
IPTV-Manager/
├── server.js              # Main server application
├── setup-assets.js        # Asset copy script
├── package.json           # Dependencies
├── db.sqlite              # Database (created on first run)
├── public/
│   ├── index.html         # Frontend UI
│   ├── app.js             # Frontend logic
│   ├── i18n.js            # Translations
│   └── vendor/            # Local assets
└── README.md
```

## 🐛 Troubleshooting

### Database Locked Error

```bash
pkill -f "node server.js"
rm -f db.sqlite-wal db.sqlite-shm
```

### Provider Sync Fails

1. Check provider URL format: `http://host:port`
2. Verify credentials
3. Test API manually

### Channels Not Playing

1. Check stream URL in console
2. Verify provider credentials
3. Check firewall/network

## 📝 Changelog

### Version 1.0.0 (2026-01)
- ✅ Initial release
- ✅ Multi-provider support
- ✅ User management
- ✅ Category/channel management
- ✅ Drag & drop sorting
- ✅ Adult content detection
- ✅ Multi-language (EN, DE, FR, EL)
- ✅ Xtream API compatibility
- ✅ Local assets (no CDN)

## 📄 License

MIT License - Copyright (c) 2026 IPTV-Manager

## 🤝 Contributing

Contributions are welcome! Fork, create feature branch, commit, push, and open PR.

## 🙏 Acknowledgments

- [Xtream Codes API](https://github.com/xtream-codes)
- [Bootstrap](https://getbootstrap.com/)
- [SortableJS](https://sortablejs.github.io/Sortable/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

---

**⭐ Star this project if you find it useful!**
EOFREADME

echo "✅ README.md erstellt"

# .gitignore erstellen
cat > .gitignore << 'EOFGITIGNORE'
# Database
db.sqlite
db.sqlite-wal
db.sqlite-shm

# Node modules
node_modules/

# Vendor assets (will be auto-created)
public/vendor/

# Logs
*.log
npm-debug.log*

# Environment
.env
.env.local

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo
*~

# Build
dist/
build/
EOFGITIGNORE

echo "✅ .gitignore erstellt"

# LICENSE erstellen
cat > LICENSE << 'EOFLICENSE'
MIT License

Copyright (c) 2026 IPTV-Manager

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOFLICENSE

echo "✅ LICENSE erstellt"

# package.json updaten (nur die Repository-Felder ändern)
if [ -f "package.json" ]; then
    echo "📝 Aktualisiere package.json..."
    # Backup der Original package.json
    cp package.json package.json.backup

    # Nur Name und Repository aktualisieren, Rest behalten
    cat package.json |     sed 's/"name": "[^"]*"/"name": "iptv-manager"/' |     sed 's|"url": "[^"]*"|"url": "https://github.com/Bladestar2105/IPTV-Manager.git"|' > package.json.tmp

    mv package.json.tmp package.json
    echo "✅ package.json aktualisiert"
else
    echo "⚠️  package.json nicht gefunden - übersprungen"
fi

echo ""
echo "================================"
echo "✅ Alle Dateien erstellt!"
echo "================================"
echo ""
echo "📋 Erstellt:"
echo "  - README.md"
echo "  - .gitignore"
echo "  - LICENSE"
echo "  - package.json (aktualisiert)"
echo ""

# Git Status anzeigen
if [ -d ".git" ]; then
    echo "📊 Git Status:"
    git status --short
    echo ""
    echo "💡 Nächste Schritte:"
    echo ""
    echo "   # Branch wechseln (falls nicht schon auf stuff)"
    echo "   git checkout stuff"
    echo ""
    echo "   # Änderungen hinzufügen"
    echo "   git add README.md .gitignore LICENSE package.json"
    echo ""
    echo "   # Commit erstellen"
    echo "   git commit -m "docs: Add README, LICENSE, and .gitignore""
    echo ""
    echo "   # Push zum stuff Branch"
    echo "   git push origin stuff"
    echo ""
else
    echo "⚠️  Kein Git Repository gefunden"
    echo "   Falls du Git initialisieren möchtest:"
    echo "   git init"
    echo "   git remote add origin https://github.com/Bladestar2105/IPTV-Manager.git"
fi

echo "🎉 Fertig!"
