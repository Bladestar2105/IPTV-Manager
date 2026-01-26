# Migration Guide: v2.0.0 → v2.5.0

## Overview

Version 2.5.0 introduces critical security improvements including password hashing, JWT authentication, rate limiting, and security headers. This guide will help you migrate from v2.0.0 to v2.5.0.

---

## ⚠️ Breaking Changes

### 1. Authentication System
- **Old**: Plain text passwords, no token-based auth
- **New**: Bcrypt-hashed passwords, JWT tokens required

### 2. API Access
- **Old**: Direct API access without authentication
- **New**: Protected endpoints require JWT token in Authorization header

### 3. User Login
- **Old**: No login interface
- **New**: Login modal required on application start

---

## 📋 Migration Steps

### Step 1: Backup Your Database

```bash
# Create a backup of your database
cp db.sqlite db.sqlite.backup.$(date +%Y%m%d)
```

### Step 2: Update Dependencies

```bash
# Pull latest changes
git pull origin main

# Install new dependencies
npm install
```

New dependencies added:
- `bcrypt` - Password hashing
- `jsonwebtoken` - JWT authentication
- `express-rate-limit` - Rate limiting
- `helmet` - Security headers
- `dotenv` - Environment variables

### Step 3: Create Environment File

```bash
# Copy example environment file
cp .env.example .env

# Edit .env and set your secrets
nano .env
```

**Important**: Change the default secrets!

```env
JWT_SECRET=your-strong-random-secret-here
SESSION_SECRET=another-strong-random-secret
```

Generate strong secrets:
```bash
# Generate random secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4: Migrate Passwords

Run the migration script to hash existing passwords:

```bash
node migrate-passwords.js
```

Expected output:
```
🔄 Starting password migration...
Found X users to migrate
✅ Migrated password for user "username"
...
✅ Password migration completed successfully!
```

**Note**: Provider passwords are NOT hashed as they're needed for API calls to IPTV providers.

### Step 5: Restart Server

```bash
# Stop old server
pkill node

# Start new server
node server.js
```

### Step 6: Test Authentication

1. Open the application in your browser
2. You should see a login modal
3. Login with your existing credentials
4. Verify you can access all features

---

## 🔑 New Features

### JWT Authentication

All API requests to protected endpoints now require a JWT token:

```javascript
// Get token from login
const response = await fetch('/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password })
});

const { token } = await response.json();

// Use token in subsequent requests
const users = await fetch('/api/users', {
  headers: { 'Authorization': `Bearer ${token}` }
});
```

### Rate Limiting

- **Authentication endpoints**: 5 attempts per 15 minutes
- **General API**: 100 requests per minute

### Security Headers

Helmet adds the following security headers:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `X-XSS-Protection: 0`
- And more...

### Password Requirements

New passwords must meet these requirements:
- Minimum 8 characters
- Username: 3-50 alphanumeric characters + underscore

---

## 🔧 API Changes

### Protected Endpoints

These endpoints now require authentication:

- `GET /api/users` - List users
- `DELETE /api/users/:id` - Delete user

### New Endpoints

- `POST /api/login` - Login and get JWT token
- `GET /api/verify-token` - Verify token validity

### Example: Login Flow

```javascript
// 1. Login
const loginResponse = await fetch('/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'admin',
    password: 'admin123'
  })
});

const { token, user, expiresIn } = await loginResponse.json();

// 2. Store token
localStorage.setItem('jwt_token', token);

// 3. Use token for API calls
const usersResponse = await fetch('/api/users', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const users = await usersResponse.json();
```

---

## 🐛 Troubleshooting

### Issue: "Invalid credentials" after migration

**Cause**: Password migration failed or wasn't run

**Solution**:
```bash
# Run migration again
node migrate-passwords.js

# Or create a new user
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"username":"newuser","password":"newpass123"}'
```

### Issue: "No token provided" error

**Cause**: Frontend not sending JWT token

**Solution**:
1. Clear browser cache and localStorage
2. Login again to get new token
3. Verify token is stored in localStorage

### Issue: Rate limit blocking legitimate requests

**Cause**: Too many failed login attempts

**Solution**:
- Wait 15 minutes for rate limit to reset
- Or restart the server (resets rate limit counters)

### Issue: Token expired

**Cause**: JWT token expired (default: 24 hours)

**Solution**:
- Login again to get new token
- Tokens automatically expire for security

---

## 📊 Performance Impact

### Before (v2.0.0)
- No password hashing overhead
- No token verification
- No rate limiting checks

### After (v2.5.0)
- Password hashing: ~100ms per login (bcrypt)
- Token verification: <1ms per request
- Rate limiting: <1ms per request
- Overall impact: Minimal, only affects login

---

## 🔒 Security Improvements

| Feature | v2.0.0 | v2.5.0 |
|---------|--------|--------|
| Password Storage | Plain text ❌ | Bcrypt hashed ✅ |
| Authentication | None ❌ | JWT tokens ✅ |
| Rate Limiting | None ❌ | Yes ✅ |
| Security Headers | None ❌ | Helmet ✅ |
| Session Management | None ❌ | JWT (24h) ✅ |
| Brute Force Protection | None ❌ | Rate limiting ✅ |

---

## 📝 Rollback Instructions

If you need to rollback to v2.0.0:

```bash
# 1. Restore database backup
cp db.sqlite.backup.YYYYMMDD db.sqlite

# 2. Checkout v2.0.0
git checkout v2.0.0

# 3. Reinstall dependencies
npm install

# 4. Restart server
node server.js
```

**Warning**: You'll lose all security improvements!

---

## ✅ Post-Migration Checklist

- [ ] Database backup created
- [ ] Dependencies installed
- [ ] .env file created with strong secrets
- [ ] Password migration completed
- [ ] Server restarted
- [ ] Login tested successfully
- [ ] API access with token tested
- [ ] Rate limiting verified
- [ ] Security headers confirmed

---

## 🆘 Support

If you encounter issues:

1. Check server logs for errors
2. Verify .env file is configured
3. Ensure migration script ran successfully
4. Test with a new user account
5. Check browser console for frontend errors

---

**Migration completed successfully?** You're now running IPTV-Manager v2.5.0 with enterprise-grade security! 🎉