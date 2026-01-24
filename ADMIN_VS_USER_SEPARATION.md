# Admin vs User Separation in IPTV-Manager v2.5.0

## Overview

Starting with v2.5.0, IPTV-Manager implements a clear separation between **Admin Users** (for WebGUI management) and **IPTV Users** (for stream access).

## Architecture

### Two Separate User Tables

1. **`admin_users`** - For WebGUI Management
   - Used for logging into the web interface
   - Can manage providers, users, categories, channels, EPG sources
   - Cannot access IPTV streams via player_api.php
   - Stored with bcrypt-hashed passwords
   - JWT authentication for API access

2. **`users`** - For IPTV Stream Access
   - Used for IPTV player authentication (player_api.php)
   - Can access assigned channels and categories
   - Cannot login to WebGUI
   - Stored with bcrypt-hashed passwords
   - Basic authentication for Xtream API compatibility

## Default Admin User

On first startup, a default admin user is automatically created:

```
Username: admin
Password: <randomly generated 16-character hex string>
```

**Important Notes:**
- Credentials are displayed in console on first start
- Credentials are saved to `ADMIN_CREDENTIALS.txt`
- This admin user is for WebGUI only
- Change the password immediately after first login
- Delete `ADMIN_CREDENTIALS.txt` after noting credentials

## User Management Workflow

### Creating Admin Users (WebGUI Access)

Admin users are created automatically on first start. Additional admin users can be added by modifying the database directly:

```sql
INSERT INTO admin_users (username, password, is_active) 
VALUES ('newadmin', '<bcrypt_hash>', 1);
```

### Creating IPTV Users (Stream Access)

IPTV users are created via the WebGUI:

1. Login to WebGUI with admin credentials
2. Navigate to Users section
3. Click "Add User"
4. Enter username and password
5. User can now access streams via player_api.php

## Authentication Flow

### WebGUI Login (Admin Users)

```
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
    "is_admin": true
  },
  "expiresIn": "24h"
}
```

### IPTV Player Authentication (IPTV Users)

```
GET /player_api.php?username=testuser&password=testpass123

Response:
{
  "user_info": {
    "username": "testuser",
    "password": "testpass123",
    "auth": 1,
    "status": "Active",
    ...
  },
  "server_info": {
    ...
  }
}
```

## Security Features

### Admin Users
- Bcrypt password hashing (10 rounds)
- JWT token-based authentication
- Rate limiting (5 attempts per 15 minutes)
- Token expiration (24 hours)
- Cannot access IPTV streams

### IPTV Users
- Bcrypt password hashing (10 rounds)
- Basic authentication for Xtream API compatibility
- Can only access assigned channels and categories
- Cannot access WebGUI

## Database Schema

### admin_users Table

```sql
CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
```

### users Table

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  is_active INTEGER DEFAULT 1
);
```

## Migration from v2.0.0

If you're upgrading from v2.0.0:

1. **Backup your database** before upgrading
2. The old `users` table will be used for IPTV users
3. A new `admin_users` table will be created
4. Default admin user will be created automatically
5. Existing users in `users` table remain as IPTV users
6. You may need to migrate admin users manually if needed

## API Endpoints

### Admin-Only Endpoints (Require JWT Token)

- `POST /api/login` - Admin login
- `GET /api/verify-token` - Verify JWT token
- `POST /api/change-password` - Change admin password
- `GET /api/users` - List IPTV users
- `POST /api/users` - Create IPTV user
- `PUT /api/users/:id` - Update IPTV user
- `DELETE /api/users/:id` - Delete IPTV user
- `GET /api/providers` - List providers
- `POST /api/providers` - Create provider
- All other management endpoints

### IPTV User Endpoints (Basic Auth)

- `GET /player_api.php` - Xtream API endpoint
- `GET /live/:username/:password/:stream_id.ts` - Stream proxy

## Troubleshooting

### Admin Cannot Login to WebGUI

1. Check credentials in `ADMIN_CREDENTIALS.txt`
2. Verify admin user exists in `admin_users` table
3. Check console logs for errors
4. Ensure JWT_SECRET is set in .env

### IPTV User Cannot Access Streams

1. Verify user exists in `users` table (not `admin_users`)
2. Check user has assigned categories and channels
3. Test authentication via player_api.php
4. Check provider configuration

### Admin Can Access IPTV Streams

This should NOT be possible. If it happens:
1. Check that `authUser()` function uses `users` table
2. Verify admin is in `admin_users` table, not `users` table
3. Check player_api.php authentication logic

## Best Practices

1. **Never use admin credentials for IPTV players**
2. **Create separate IPTV users for each client**
3. **Change default admin password immediately**
4. **Delete ADMIN_CREDENTIALS.txt after setup**
5. **Use strong passwords for both admin and IPTV users**
6. **Regularly review user access and permissions**
7. **Keep admin and IPTV user credentials separate**

## Security Considerations

- Admin users have full system access via WebGUI
- IPTV users have limited access to assigned content only
- Never share admin credentials with IPTV clients
- Use environment variables for sensitive configuration
- Enable HTTPS in production environments
- Regularly update passwords and review access logs