# IPTV-Manager v2.5.0 Release Notes

**Release Date**: January 24, 2026
**Status**: Production Ready ✅

---

## 🎯 Overview

Version 2.5.0 is a major security and stability release that introduces complete separation between admin and IPTV users, comprehensive authentication improvements, and stream proxy optimizations.

---

## 🚀 Major Features

### 1. Admin/IPTV User Separation 🔐

**Breaking Change**: Complete architectural separation between admin and IPTV users.

- **Admin Users** (`admin_users` table):
  - For WebGUI management only
  - Cannot access IPTV streams via player_api.php
  - JWT-based authentication
  - Full system management capabilities

- **IPTV Users** (`users` table):
  - For stream access only
  - Cannot login to WebGUI
  - Basic authentication for Xtream API compatibility
  - Access to assigned channels and categories

**Benefits**:
- Enhanced security through role separation
- Clearer access control
- Better auditability
- Reduced attack surface

**Documentation**: See `ADMIN_VS_USER_SEPARATION.md`

### 2. Security Enhancements 🛡️

- **Bcrypt Password Hashing**: All passwords stored with bcrypt (10 rounds)
- **JWT Authentication**: Token-based auth with 24h expiration
- **Rate Limiting**:
  - Authentication: 5 attempts per 15 minutes
  - API: 100 requests per minute
- **Security Headers**: Helmet.js implementation
- **Environment Variables**: Secure configuration via .env

### 3. Stream Proxy Optimizations ⚡

- **Performance Improvements**:
  - Optimized headers for streaming (User-Agent, Cache-Control)
  - 30-second timeout for large streams
  - Content-Length forwarding
  - Proper keep-alive connections

- **Error Handling**:
  - Stream error detection and handling
  - Client disconnect cleanup
  - Better logging for debugging
  - Graceful failure handling

### 4. UI/UX Improvements 🎨

- **Login Flow**:
  - Main content hidden before login
  - Only login modal visible initially
  - Smooth transition after authentication

- **Error Handling**:
  - Structured error messages (error code + message)
  - User-friendly error display
  - Better validation feedback

### 5. Category Auto-Creation Fix 🔧

- Fixed logic to properly create categories from existing mappings
- Now handles mappings with NULL user_category_id
- Updates existing mappings instead of creating duplicates
- Proper category creation on subsequent syncs

---

## 📊 Testing Results

### Test Environment
- **Provider**: Production IPTV provider
- **Channels**: 4000+ synced successfully
- **Categories**: 50+ created automatically
- **Streams**: 4000+ available

### Test Coverage
✅ Admin login/logout
✅ IPTV user authentication
✅ Category retrieval (52 categories)
✅ Stream list (4168 streams)
✅ User creation with validation
✅ Password validation (minimum 8 characters)
✅ Stream proxy functionality
✅ WebUI login flow

---

## 🔄 Migration Guide

### From v2.0.0 to v2.5.0

#### 1. Backup Your Data
```bash
cp db.sqlite db.sqlite.backup
```

#### 2. Update Code
```bash
git pull origin v2.5.0
npm install
```

#### 3. Database Migration
The database will be automatically migrated on first start:
- New `admin_users` table created
- Default admin user created automatically
- Existing users in `users` table remain as IPTV users

#### 4. First Start
```bash
node server.js
```

**Important**: Note the admin credentials displayed in console!

#### 5. Change Admin Password
1. Login to WebGUI with generated credentials
2. Click "Change Password" button
3. Set a strong password

#### 6. Verify IPTV Users
- Existing IPTV users continue to work
- They can access streams via player_api.php
- They cannot login to WebGUI

---

## ⚠️ Breaking Changes

### 1. User Authentication
- **Admin users** can no longer authenticate via player_api.php
- **IPTV users** can no longer login to WebGUI
- Separate authentication mechanisms for each user type

### 2. Database Schema
- New `admin_users` table
- `users` table now exclusively for IPTV users
- Existing users automatically become IPTV users

### 3. API Changes
- `/api/login` now authenticates against `admin_users`
- `/api/change-password` updates `admin_users`
- `player_api.php` authenticates against `users`

---

## 📝 API Changes

### New Behavior

#### Admin Login
```bash
POST /api/login
{
  "username": "admin",
  "password": "your_password"
}

Response:
{
  "token": "JWT_TOKEN",
  "user": {
    "id": 1,
    "username": "admin",
    "is_active": 1,
    "is_admin": true  # New flag
  }
}
```

#### User Creation Errors
```bash
POST /api/users
{
  "username": "test",
  "password": "short"
}

Response (400):
{
  "error": "password_too_short",
  "message": "Password must be at least 8 characters"
}
```

---

## 🐛 Bug Fixes

1. **Stream Proxy Authentication**: Fixed missing `await` in authUser calls
2. **Category Auto-Creation**: Fixed logic to handle existing mappings
3. **XMLTV Authentication**: Fixed missing `await` in authUser call
4. **Error Messages**: Improved structure and user-friendliness
5. **UI Login Flow**: Fixed main content visibility before login

---

## 📚 Documentation

### New Documentation
- `ADMIN_VS_USER_SEPARATION.md` - Complete guide on user separation
- `BUGFIX_TEST_REPORT.md` - Detailed test report
- `RELEASE_NOTES_v2.5.0.md` - This file

### Updated Documentation
- `README.md` - Updated with v2.5.0 features
- `SECURITY_ANALYSIS.md` - Updated security assessment
- `MIGRATION_GUIDE_v2.5.0.md` - Migration instructions

---

## 🔮 Future Plans (v3.0.0)

- Multi-language EPG support
- Advanced user permissions
- Channel grouping and favorites
- Enhanced statistics and analytics
- Mobile app support
- Docker deployment improvements

---

## 🙏 Acknowledgments

- Tested with production IPTV provider
- Community feedback incorporated
- Security best practices implemented

---

## 📞 Support

For issues or questions:
1. Check documentation in `/docs` folder
2. Review `ADMIN_VS_USER_SEPARATION.md` for user management
3. See `MIGRATION_GUIDE_v2.5.0.md` for upgrade help
4. Open an issue on GitHub

---

## ✅ Checklist for Deployment

- [ ] Backup existing database
- [ ] Update code to v2.5.0
- [ ] Run `npm install`
- [ ] Start server and note admin credentials
- [ ] Change admin password
- [ ] Verify IPTV users can access streams
- [ ] Test WebGUI functionality
- [ ] Update any custom scripts or integrations

---

**Version**: 2.5.0
**Status**: Production Ready ✅
**Tested**: Yes, with production IPTV provider
**Breaking Changes**: Yes, see above
**Migration Required**: Yes, automatic on first start