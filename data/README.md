# Data Directory

This directory contains the SQLite database file and other data storage.

- `users.db` - SQLite database containing user accounts, sessions, gift orders, contacts, and special dates
- Database is automatically created when the server starts
- Directory is created automatically if it doesn't exist

## Database Schema

### Users Table
- id (PRIMARY KEY)
- name
- email (UNIQUE)
- password (hashed)
- phone
- created_at
- updated_at
- is_active
- email_verified
- phone_verified

### Sessions Table
- id (PRIMARY KEY)
- user_id (FOREIGN KEY)
- token
- expires_at
- created_at

### Gift Orders Table
- id (PRIMARY KEY)
- user_id (FOREIGN KEY)
- tracking_id (UNIQUE)
- recipient_name
- recipient_contact
- gift_type
- gift_value
- challenge
- message
- duration
- status
- created_at
- updated_at

### Contacts Table (Network)
- id (PRIMARY KEY)
- user_id (FOREIGN KEY)
- name
- email
- phone
- relationship
- birthday
- created_at
- updated_at

### Special Dates Table
- id (PRIMARY KEY)
- contact_id (FOREIGN KEY, CASCADE DELETE)
- date_name
- date_value
- notes
- created_at
