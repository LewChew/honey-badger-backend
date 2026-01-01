# Database Migration: In-Memory to SQLite

## Overview

The Honey Badger AI Gifts application has been migrated from in-memory Map() storage to SQLite for persistent data storage.

## Changes Made

### Before (In-Memory)
- User data stored in `Map()` - lost on server restart
- No session persistence
- No gift order history

### After (SQLite)
- User data persisted to `data/users.db`
- Session management with automatic cleanup
- Gift order tracking
- Data survives server restarts

## What's Stored in the Database

1. **Users** - Authentication and profile information
2. **Sessions** - Active JWT tokens with expiration
3. **Gift Orders** - History of sent honey badgers

## Database File Location

`data/users.db` (auto-created on first run)

## First Run Instructions

The database is automatically created when you start the server:

```bash
npm install  # Install sqlite3 dependency
npm start    # Database auto-created at data/users.db
```

## Backup Instructions

```bash
# Create backup
cp data/users.db data/users.db.backup

# Restore from backup
cp data/users.db.backup data/users.db
```

## Reset Database

To start fresh:

```bash
# Stop the server (Ctrl+C)
rm data/users.db
npm start  # Database recreated with empty tables
```

## Migration Notes

- All existing users will need to re-register (in-memory data not migrated)
- Sessions are now persisted - users stay logged in across server restarts
- Password reset tokens still use in-memory storage (will be migrated later)

## Database Schema

See `services/databaseService.js` for complete schema details.

### Users Table
- id, name, email, password (hashed), phone
- created_at, updated_at, is_active
- email_verified, phone_verified

### Sessions Table
- id, user_id, token, expires_at
- Automatically cleaned up on expiration

### Gift Orders Table
- id, user_id, tracking_id
- recipient details, gift details
- status, timestamps

## Troubleshooting

**Issue:** `Error opening database`
- Solution: Ensure `data/` directory exists, check file permissions

**Issue:** Database locked
- Solution: Stop all server instances, check for zombie processes

**Issue:** Lost all users after migration
- Solution: Expected behavior - users need to re-register

## Future Enhancements

- [ ] Migrate password reset tokens to database
- [ ] Add database cleanup cron job
- [ ] Implement database migrations system
- [ ] Add PostgreSQL option for production
