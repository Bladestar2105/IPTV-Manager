# Changelog

All notable changes to IPTV-Manager will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - v3.0.0

### Planned
- Enhanced user management with roles and permissions
- Multi-language EPG support
- Channel favorites and custom playlists
- Performance optimizations
- Mobile-responsive design
- Two-factor authentication
- API documentation with Swagger

---

## [2.5.1] - 2024-01-24

### Fixed
- **Stream Proxy Timeout**: Removed 30-second timeout that was causing AbortError in logs
  - Streams can now run indefinitely without timeout
  - Improved error logging to ignore normal client disconnects
  - Only real errors are logged now
- **Category Auto-Creation**: Fixed logic that was creating categories on every sync
  - Categories are now only auto-created when provider adds NEW categories
  - Existing mappings with NULL user_category_id are left alone
  - User must manually import categories as intended
- **Category Deletion**: Fixed 500 error when deleting categories
  - Properly handles category_mappings foreign key constraints
  - Updates mappings to NULL instead of causing constraint errors
  - Preserves mappings for future use

### Changed
- Updated User-Agent to IPTV-Manager/2.5.1
- Improved error handling and logging throughout

---

## [2.5.0] - 2024-01-24

### Added
- **Admin/IPTV User Separation**: Complete architectural separation between admin and IPTV users
- **JWT Authentication**: Token-based authentication with 24h expiration
- **Bcrypt Password Hashing**: Secure password storage with 10 rounds
- **Rate Limiting**: Protection against brute force attacks (5 auth attempts per 15min, 100 API requests per min)
- **Security Headers**: Helmet.js implementation for comprehensive security
- **Stream Proxy Optimizations**: Improved headers, timeout handling, and error management
- **Default Admin User**: Automatically created on first start with random password
- **Password Change Feature**: WebGUI modal for changing admin password
- **Environment Variables**: Secure configuration via .env file

### Changed
- **Breaking**: Admin users can no longer authenticate via player_api.php
- **Breaking**: IPTV users can no longer login to WebGUI
- **Breaking**: Separate authentication mechanisms for admin and IPTV users
- Improved error handling with structured messages
- Enhanced UI/UX with hidden content before login
- Better category auto-creation logic

### Fixed
- Stream proxy authentication (missing await)
- Category auto-creation from existing mappings
- XMLTV authentication (missing await)
- Error message structure and display
- UI login flow and content visibility

### Security
- Complete separation of admin and IPTV user authentication
- JWT-based session management
- Bcrypt password hashing for all users
- Rate limiting on authentication and API endpoints
- Security headers via Helmet.js

### Documentation
- Added ADMIN_VS_USER_SEPARATION.md
- Added MIGRATION_GUIDE_v2.5.0.md
- Added RELEASE_NOTES_v2.5.0.md
- Updated README.md with v2.5.0 features
- Updated SECURITY_ANALYSIS.md

---

## [2.0.0] - 2024-01-20

### Added
- **Automatic Provider Synchronization**: Configurable sync intervals (hourly, daily, weekly)
- **Intelligent Category Mapping**: Two-phase approach for optimal category management
- **Background Sync Scheduler**: Automatic synchronization in background
- **Comprehensive Sync Logging**: Detailed logs of all sync operations
- **Category Import**: Import provider categories with or without channels
- **Adult Content Filtering**: Automatic detection and marking

### Changed
- Improved category organization
- Enhanced channel assignment workflow
- Better EPG integration

### Fixed
- Channel assignment persistence
- Category sorting issues
- Sync reliability improvements

---

## [1.0.0] - 2024-01-15

### Added
- Initial release
- Multi-user management
- Provider management (Xtream Codes API)
- Category organization with drag & drop
- Channel assignment
- EPG integration
- RESTful API
- Responsive UI with dark theme
- Multi-language support (EN, DE, FR)

---

## Version History

- **v3.0.0** (Planned) - Enhanced features and performance
- **v2.5.1** (2024-01-24) - Bug fixes for stream proxy and category management
- **v2.5.0** (2024-01-24) - Security and stability release
- **v2.0.0** (2024-01-20) - Automatic synchronization
- **v1.0.0** (2024-01-15) - Initial release