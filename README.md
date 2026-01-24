# IPTV-Manager v2.5.0

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

### v2.0.0 Features
- **Automatic Provider Synchronization**: Configurable sync intervals (hourly, daily, weekly)
- **Intelligent Category Mapping**: Two-phase approach for optimal category management
  - First sync: Creates mappings without auto-creating categories (user control)
  - Subsequent syncs: Automatically creates new categories and assigns channels
- **Background Sync Scheduler**: Automatic synchronization runs in the background
- **Comprehensive Sync Logging**: Detailed logs of all sync operations
- **Category Import**: Import provider categories with or without channels
- **Adult Content Filtering**: Automatic detection and marking of adult content

### v2.5.0 Security Features (NEW!)
- **🔐 Password Hashing**: Bcrypt-based password hashing (BCRYPT_ROUNDS=10)
- **🎫 JWT Authentication**: Token-based authentication with configurable expiration
- **🛡️ Rate Limiting**: Protection against brute force attacks
  - Authentication: 5 attempts per 15 minutes
  - API: 100 requests per minute
- **🔒 Security Headers**: Helmet.js for comprehensive security headers
- **🚪 Login System**: Secure login modal with session management
- **⚙️ Environment Variables**: Secure configuration via .env file

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
git clone https://github.com/YOUR_USERNAME/IPTV-Manager.git
cd IPTV-Manager

# Checkout v2.5.0 branch (recommended)
git checkout v2.5.0

# Install dependencies
npm install

# (Optional) Configure environment variables
cp .env.example .env
# Edit .env with your preferred settings

# Start the server
node server.js
```

The application will be available at `http://localhost:3000`

**🔐 First Time Setup**:
- On first start, a default admin user is automatically created
- Credentials are displayed in the console and saved to `ADMIN_CREDENTIALS.txt`
- **Default Username**: `admin`
- **Default Password**: Random 16-character hex string
- ⚠️ **IMPORTANT**: Change the password immediately after first login!
- ℹ️ **NOTE**: Admin user is for WebGUI management only, NOT for IPTV streams!
- 📖 See [ADMIN_VS_USER_SEPARATION.md](ADMIN_VS_USER_SEPARATION.md) for details

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

### 1. First Login

1. Open the application in your browser: `http://localhost:3000`
2. A login modal will appear
3. Use the default admin credentials from the console or `ADMIN_CREDENTIALS.txt`:
   - Username: `admin`
   - Password: (16-character hex string from console)
4. Click "Login"
5. **IMPORTANT**: Change your password immediately!
   - Click "Change Password" button in the header
   - Enter old password, new password, and confirm
   - Click "Change Password"

### 2. Create IPTV Users (for Stream Access)

**IMPORTANT**: There are TWO types of users in IPTV-Manager v2.5.0:
- **Admin Users**: For WebGUI management (login to web interface)
- **IPTV Users**: For stream access (use in IPTV players)

To create IPTV users:
1. Navigate to "User Management"
2. Enter username and password
3. Click "Add User"
4. These users can access streams via IPTV players (player_api.php)
5. **NOTE**: IPTV users CANNOT login to the WebGUI

For more details, see [ADMIN_VS_USER_SEPARATION.md](ADMIN_VS_USER_SEPARATION.md)

### 3. Add a Provider

1. Navigate to "Provider Management"
2. Enter provider details:
   - Name: Your provider name
   - URL: Provider URL (e.g., `http://provider.com`)
   - Username: Your provider username
   - Password: Your provider password
   - EPG URL: (Optional) EPG data URL
3. Click "Add Provider"

### 4. Configure Automatic Sync

1. Click "Sync Config" button next to your provider
2. Configure sync settings:
   - **Enable Sync**: Toggle automatic synchronization
   - **Sync Interval**: Choose hourly, daily, or weekly
   - **Auto Add Categories**: Automatically create new categories
   - **Auto Add Channels**: Automatically assign channels to categories
3. Click "Save"

### 5. Initial Sync

1. Click "Sync" button next to your provider
2. Wait for sync to complete
3. Check "Sync Logs" to verify results

### 6. Organize Categories

1. Select a user from the dropdown
2. Create custom categories or import from provider
3. Use drag & drop to sort categories
4. Mark adult content categories if needed

### 7. Assign Channels

1. Navigate to "Channel Assignment"
2. Select a provider
3. Search for channels
4. Drag channels from provider list to your categories
5. Use drag & drop to sort channels within categories

### 8. Change Password (Recommended)

1. Click "Change Password" button in the header
2. Enter your current password
3. Enter new password (minimum 8 characters)
4. Confirm new password
5. Click "Change Password"
6. You'll receive a success message
7. Your new password is now active

**Security Tip**: Change the default admin password immediately after first login!

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

### Authentication
- `POST /api/login` - Login and get JWT token
- `GET /api/verify-token` - Verify token validity (requires auth)
- `POST /api/change-password` - Change user password (requires auth)

### Users
- `GET /api/users` - List all users (requires auth)
- `POST /api/users` - Create user (rate limited)
- `DELETE /api/users/:id` - Delete user (requires auth)

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

## ✅ Security Features (v2.5.0)

**IMPORTANT**: Version 2.5.0 addresses all critical security issues from v2.0.0!

### Implemented Security Measures
- ✅ **Password Hashing** - Bcrypt with configurable rounds (default: 10)
- ✅ **JWT Authentication** - Token-based auth with 24h expiration
- ✅ **Rate Limiting** - Brute force protection on all endpoints
- ✅ **Security Headers** - Helmet.js protection
- ✅ **Environment Variables** - Secure configuration management
- ✅ **Session Management** - Automatic token expiration and refresh

### Additional Production Recommendations

1. **Environment Variables** (REQUIRED):
   ```bash
   # Copy example file
   cp .env.example .env
   
   # Generate strong secrets
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   
   # Edit .env with your secrets
   JWT_SECRET=<generated-secret>
   SESSION_SECRET=<another-generated-secret>
   ```

2. **HTTPS Only** (REQUIRED):
   - Use reverse proxy (nginx/apache)
   - Enforce HTTPS in production
   - Set secure cookie flags

3. **Database Backups** (REQUIRED):
   ```bash
   # Automated daily backups
   0 2 * * * cp /path/to/db.sqlite /path/to/backups/db.sqlite.$(date +\%Y\%m\%d)
   ```

### Production Checklist
- [x] Password hashing implemented (bcrypt)
- [x] Rate limiting active
- [x] Security headers enabled (helmet)
- [x] JWT authentication implemented
- [ ] HTTPS configured (reverse proxy)
- [ ] Environment variables set (.env)
- [ ] Regular security updates (`npm audit`)
- [ ] Database backups automated
- [ ] Firewall configured

---

## 🐛 Known Issues

### Fixed in v2.0.0
- ✅ Channel assignments lost after sync (INSERT OR REPLACE issue)
- ✅ Text readability issues (dark text on dark background)
- ✅ Picon caching timeout errors

### Fixed in v2.5.0
- ✅ Plain text password storage (now using bcrypt)
- ✅ No session management (now using JWT)
- ✅ No rate limiting (now implemented)
- ✅ No security headers (now using helmet)

### Current Limitations
- None! All critical security issues resolved.

---

## 🔄 Changelog

### v2.5.0 (2026-01-24) - Security Release

**🔒 Security Features**:
- Implemented bcrypt password hashing (BCRYPT_ROUNDS=10)
- Added JWT-based authentication with 24h token expiration
- Implemented rate limiting (5 auth attempts per 15min, 100 API requests per min)
- Added helmet.js security headers
- Created secure login system with modal
- Added environment variable support (.env)
- Created password migration script

**🔧 Technical Improvements**:
- Protected sensitive API endpoints with JWT middleware
- Added token verification endpoint
- Implemented automatic token expiration handling
- Added logout functionality
- Enhanced error handling for authentication

**📚 Documentation**:
- Created comprehensive migration guide (MIGRATION_GUIDE_v2.5.0.md)
- Updated README with security features
- Updated SECURITY_ANALYSIS.md
- Added .env.example template

**🌐 i18n Updates**:
- Added authentication translations (EN, DE, FR)
- Added error message translations
- Added token expiration messages

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

- [MIGRATION_GUIDE_v2.5.0.md](MIGRATION_GUIDE_v2.5.0.md) - Migration guide from v2.0.0 to v2.5.0
- [SECURITY_ANALYSIS.md](SECURITY_ANALYSIS.md) - Comprehensive security analysis
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

### Completed in v2.5.0
- [x] Password hashing implementation (bcrypt)
- [x] JWT-based authentication
- [x] Rate limiting
- [x] Security headers (helmet)

### Planned Features
- [ ] Two-factor authentication (2FA)
- [ ] OAuth2 integration
- [ ] Advanced EPG features
- [ ] Channel search and filtering
- [ ] Bulk operations
- [ ] Export/import configurations
- [ ] API documentation (Swagger)
- [ ] Docker support
- [ ] WebSocket for real-time updates
- [ ] Mobile app (React Native)

---

**Version**: 2.5.0  
**Last Updated**: 2026-01-24  
**Status**: ✅ Production Ready (All critical security issues resolved)