# IPTV-Manager v2.0.0

A comprehensive IPTV management system with automatic provider synchronization, intelligent category mapping, and multi-user support.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-3-blue.svg)](https://www.sqlite.org/)

---

## 🚀 Features

### Core Functionality
- **Multi-User Management**: Support for multiple users with individual channel configurations
- **Provider Management**: Connect to multiple IPTV providers (Xtream Codes API)
- **Category Organization**: Create and organize custom categories with drag & drop sorting
- **Channel Assignment**: Assign channels to categories with visual interface
- **EPG Integration**: Support for Electronic Program Guide (EPG) data

### v2.0.0 New Features
- **Automatic Provider Synchronization**: Configurable sync intervals (hourly, daily, weekly)
- **Intelligent Category Mapping**: Two-phase approach for optimal category management
  - First sync: Creates mappings without auto-creating categories (user control)
  - Subsequent syncs: Automatically creates new categories and assigns channels
- **Background Sync Scheduler**: Automatic synchronization runs in the background
- **Comprehensive Sync Logging**: Detailed logs of all sync operations
- **Category Import**: Import provider categories with or without channels
- **Adult Content Filtering**: Automatic detection and marking of adult content

### Technical Features
- **RESTful API**: Complete API for all operations
- **Responsive UI**: Modern, TV-inspired dark theme design
- **Multi-language Support**: English, German, French
- **Drag & Drop**: Intuitive sorting for categories and channels
- **Real-time Updates**: Live sync status and progress indicators

---

## 📋 Requirements

- **Node.js**: 20.x or higher
- **npm**: 9.x or higher
- **SQLite**: 3.x (included)
- **Operating System**: Linux, macOS, or Windows

---

## 🔧 Installation

### Quick Start

```bash
# Clone the repository
git clone https://github.com/Bladestar2105/IPTV-Manager.git
cd IPTV-Manager

# Checkout v2.0.0 branch
git checkout v2.0.0

# Install dependencies
npm install

# Start the server
node server.js
```

The application will be available at `http://localhost:3000`

### Production Deployment

For production deployment, see [SECURITY_ANALYSIS.md](SECURITY_ANALYSIS.md) for important security considerations.

```bash
# Set environment variables
export NODE_ENV=production
export PORT=3000

# Start with PM2 (recommended)
npm install -g pm2
pm2 start server.js --name iptv-manager

# Or use systemd service
sudo systemctl enable iptv-manager
sudo systemctl start iptv-manager
```

---

## 🎯 Usage

### 1. Create a User

1. Open the application in your browser
2. Navigate to "User Management"
3. Enter username and password
4. Click "Add User"

### 2. Add a Provider

1. Navigate to "Provider Management"
2. Enter provider details:
   - Name: Your provider name
   - URL: Provider URL (e.g., `http://provider.com`)
   - Username: Your provider username
   - Password: Your provider password
   - EPG URL: (Optional) EPG data URL
3. Click "Add Provider"

### 3. Configure Automatic Sync

1. Click "Sync Config" button next to your provider
2. Configure sync settings:
   - **Enable Sync**: Toggle automatic synchronization
   - **Sync Interval**: Choose hourly, daily, or weekly
   - **Auto Add Categories**: Automatically create new categories
   - **Auto Add Channels**: Automatically assign channels to categories
3. Click "Save"

### 4. Initial Sync

1. Click "Sync" button next to your provider
2. Wait for sync to complete
3. Check "Sync Logs" to verify results

### 5. Organize Categories

1. Select a user from the dropdown
2. Create custom categories or import from provider
3. Use drag & drop to sort categories
4. Mark adult content categories if needed

### 6. Assign Channels

1. Navigate to "Channel Assignment"
2. Select a provider
3. Search for channels
4. Drag channels from provider list to your categories
5. Use drag & drop to sort channels within categories

---

## 🔄 Automatic Synchronization

### How It Works

The automatic sync system runs in the background and checks every minute if a sync is due based on your configuration.

**First Sync Behavior**:
- Creates category mappings for all provider categories
- Does NOT automatically create user categories
- Allows you to manually organize categories first
- Prevents overwhelming you with 50+ categories

**Subsequent Syncs**:
- Automatically creates new categories (if enabled)
- Assigns channels to mapped categories (if enabled)
- Updates existing channel information
- Maintains your category structure

### Sync Intervals

- **Hourly**: Syncs every 60 minutes
- **Daily**: Syncs once per day at the same time
- **Weekly**: Syncs once per week on the same day

### Sync Logs

View detailed sync logs including:
- Timestamp
- Status (success/error)
- Channels added
- Channels updated
- Categories created
- Error messages (if any)

---

## 🗄️ Database Schema

### Tables

- **users**: User accounts
- **providers**: IPTV provider configurations
- **user_categories**: User-created categories
- **provider_channels**: All channels from providers
- **user_channels**: Channel assignments to categories
- **category_mappings**: Provider category to user category mappings
- **sync_configs**: Automatic sync configurations
- **sync_logs**: Sync operation history
- **epg_sources**: EPG data sources
- **epg_cache**: Cached EPG data

---

## 🔌 API Endpoints

### Users
- `GET /api/users` - List all users
- `POST /api/users` - Create user
- `DELETE /api/users/:id` - Delete user

### Providers
- `GET /api/providers` - List all providers
- `POST /api/providers` - Create provider
- `PUT /api/providers/:id` - Update provider
- `DELETE /api/providers/:id` - Delete provider
- `POST /api/providers/:id/sync` - Trigger manual sync

### Categories
- `GET /api/categories` - List user categories
- `POST /api/categories` - Create category
- `PUT /api/categories/:id` - Update category
- `DELETE /api/categories/:id` - Delete category
- `POST /api/categories/reorder` - Reorder categories

### Channels
- `GET /api/channels` - List user channels
- `POST /api/channels` - Assign channel to category
- `DELETE /api/channels/:id` - Remove channel from category
- `POST /api/channels/reorder` - Reorder channels

### Sync Management
- `GET /api/sync-configs` - List sync configurations
- `POST /api/sync-configs` - Create/update sync config
- `DELETE /api/sync-configs/:id` - Delete sync config
- `GET /api/sync-logs` - View sync history

### Category Mappings
- `GET /api/category-mappings` - List category mappings
- `POST /api/category-mappings` - Create mapping
- `PUT /api/category-mappings/:id` - Update mapping
- `DELETE /api/category-mappings/:id` - Delete mapping

### EPG
- `GET /api/epg-sources` - List EPG sources
- `POST /api/epg-sources` - Add EPG source
- `DELETE /api/epg-sources/:id` - Delete EPG source

### Streaming
- `GET /player_api.php` - Xtream Codes API compatibility
- `GET /live/:username/:password/:stream_id.ts` - Live stream
- `GET /xmltv.php` - EPG data in XMLTV format

---

## ⚠️ Security Considerations

**IMPORTANT**: This application currently has security limitations. Please review [SECURITY_ANALYSIS.md](SECURITY_ANALYSIS.md) before deploying to production.

### Critical Issues
- ⚠️ **Passwords stored in plain text** - Implement bcrypt hashing before production use
- ⚠️ **No rate limiting** - Add rate limiting on authentication endpoints
- ⚠️ **Basic authentication** - Implement JWT-based session management

### Recommended Security Measures

1. **Password Hashing**:
   ```bash
   npm install bcrypt
   ```
   Implement password hashing in authentication functions

2. **Environment Variables**:
   ```bash
   # Create .env file
   PORT=3000
   NODE_ENV=production
   JWT_SECRET=your-secret-key
   ```

3. **HTTPS Only**:
   - Use reverse proxy (nginx/apache)
   - Enforce HTTPS in production
   - Set secure cookie flags

4. **Rate Limiting**:
   ```bash
   npm install express-rate-limit
   ```
   Add rate limiting to prevent brute force attacks

5. **Security Headers**:
   ```bash
   npm install helmet
   ```
   Add security headers to all responses

### Production Checklist
- [ ] Implement password hashing
- [ ] Add rate limiting
- [ ] Use HTTPS only
- [ ] Set environment variables
- [ ] Add security headers
- [ ] Regular security updates (`npm audit`)
- [ ] Database backups
- [ ] Firewall configuration

---

## 🐛 Known Issues

### Fixed in v2.0.0
- ✅ Channel assignments lost after sync (INSERT OR REPLACE issue)
- ✅ Text readability issues (dark text on dark background)
- ✅ Picon caching timeout errors

### Current Limitations
- ⚠️ Plain text password storage (see Security section)
- ⚠️ No session management
- ⚠️ No rate limiting

---

## 🔄 Changelog

### v2.0.0 (2026-01-24)

**Major Features**:
- Automatic provider synchronization with configurable intervals
- Intelligent category mapping system
- Background sync scheduler
- Comprehensive sync logging
- Category import functionality

**Bug Fixes**:
- Fixed channel assignment persistence (INSERT OR REPLACE → INSERT OR IGNORE + UPDATE)
- Improved text readability across all UI elements
- Removed picon caching to eliminate timeout errors

**Improvements**:
- Enhanced UI with better contrast and visibility
- Improved CSS color variables
- Better modal and dropdown text visibility
- Enhanced table headers and data display

---

## 📚 Documentation

- [SECURITY_ANALYSIS.md](SECURITY_ANALYSIS.md) - Comprehensive security analysis and recommendations
- [LICENSE](LICENSE) - MIT License

---

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Setup

```bash
# Clone your fork
git clone https://github.com/your-username/IPTV-Manager.git
cd IPTV-Manager

# Install dependencies
npm install

# Start development server
node server.js
```

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- Xtream Codes API for IPTV provider integration
- Bootstrap for UI framework
- Sortable.js for drag & drop functionality
- SQLite for database management

---

## 📞 Support

For issues, questions, or suggestions:
- Open an issue on GitHub
- Check existing issues for solutions
- Review documentation before asking

---

## 🎯 Roadmap

### Planned Features
- [ ] Password hashing implementation
- [ ] JWT-based authentication
- [ ] Rate limiting
- [ ] Two-factor authentication
- [ ] Advanced EPG features
- [ ] Channel search and filtering
- [ ] Bulk operations
- [ ] Export/import configurations
- [ ] API documentation (Swagger)
- [ ] Docker support

---

**Version**: 2.0.0  
**Last Updated**: 2026-01-24  
**Status**: Production Ready (with security improvements needed)