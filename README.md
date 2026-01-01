# Honey Badger AI Gifts - Backend API

Node.js/Express backend API for the Honey Badger AI Gifts platform.

## Overview

This is the backend API server that powers the Honey Badger AI Gifts application. It provides authentication, gift management, challenge tracking, and integrations with Twilio (SMS), SendGrid (email), and Anthropic AI (chatbot).

## Tech Stack

- **Runtime**: Node.js 16+
- **Framework**: Express.js
- **Database**: SQLite (local), Supabase (optional cloud sync)
- **Authentication**: JWT with bcrypt password hashing
- **Integrations**: Twilio, SendGrid, Anthropic AI

## Quick Start

### Prerequisites

- Node.js 16 or higher
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
# At minimum, set JWT_SECRET
nano .env
```

### Running the Server

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

Server will run on `http://localhost:3000` by default.

## Environment Configuration

### Required Variables

- `JWT_SECRET` - Secret key for JWT token signing (CHANGE THIS!)

### Optional Variables

**Frontend Connection:**
- `FRONTEND_URL` - Frontend URL for CORS (default: `http://localhost:5173`)

**Twilio SMS:**
- `TWILIO_ACCOUNT_SID` - Twilio account SID
- `TWILIO_AUTH_TOKEN` - Twilio auth token
- `TWILIO_PHONE_NUMBER` - Twilio phone number (E.164 format)
- `ENABLE_SMS=true` - Enable SMS features

**SendGrid Email:**
- `SENDGRID_API_KEY` - SendGrid API key
- `SENDGRID_FROM_EMAIL` - Sender email address
- `SENDGRID_FROM_NAME` - Sender display name
- `ENABLE_EMAIL=true` - Enable email features

**Anthropic AI:**
- `ANTHROPIC_API_KEY` - Claude API key for chatbot

**Supabase (optional):**
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_KEY` - Supabase service role key
- `SUPABASE_JWT_SECRET` - Supabase JWT secret
- `ENABLE_SUPABASE=true` - Enable Supabase integration

See `.env.example` for complete configuration options.

## API Endpoints

### Authentication

**POST** `/api/signup`
- Create new user account
- Body: `{ name, email, password, phone (optional) }`
- Returns: `{ token, user }`

**POST** `/api/login`
- Login with email and password
- Body: `{ email, password }`
- Returns: `{ token, user }`

**GET** `/api/auth/me` (Protected)
- Get current user info
- Headers: `Authorization: Bearer <token>`
- Returns: `{ user }`

**POST** `/api/auth/logout` (Protected)
- Logout current user
- Headers: `Authorization: Bearer <token>`

**POST** `/api/auth/forgot-password`
- Request password reset
- Body: `{ email }`

**POST** `/api/auth/reset-password`
- Complete password reset
- Body: `{ token, newPassword }`

### Gifts & Challenges

**POST** `/api/send-honey-badger` (Protected)
- Create and send a new gift with challenge
- Body: `{ recipientPhone, giftType, challengeType, ... }`
- Returns: `{ giftId, challengeId }`

**GET** `/api/honey-badgers` (Protected)
- List user's sent gifts
- Returns: `{ gifts: [] }`

**GET** `/api/challenges/:challengeId/progress`
- Get challenge completion status
- Returns: `{ currentStep, totalSteps, percentage }`

**PUT** `/api/challenges/:challengeId/progress`
- Update challenge progress
- Body: `{ currentStep, submissions }`

**GET** `/api/recipients/:phone/gifts`
- View gifts for a recipient
- Returns: `{ activeGifts: [], completedGifts: [] }`

### Contacts

**POST** `/api/contacts` (Protected)
- Add new contact
- Body: `{ name, phone, email (optional), ... }`

**GET** `/api/contacts` (Protected)
- List user's contacts

**DELETE** `/api/contacts/:id` (Protected)
- Delete a contact

**POST** `/api/contacts/:id/special-dates` (Protected)
- Add special date for contact
- Body: `{ type, date, description }`

**GET** `/api/contacts/:id/special-dates` (Protected)
- List special dates for contact

**DELETE** `/api/special-dates/:id` (Protected)
- Delete a special date

### Chat

**POST** `/api/chat`
- Send message to AI chatbot
- Body: `{ message, conversationHistory (optional) }`
- Returns: `{ response }`

### Webhooks

**POST** `/api/webhooks/twilio/incoming`
- Twilio SMS webhook
- Processes incoming SMS from recipients
- Returns: TwiML response

### Health Check

**GET** `/health`
- Server health check
- Returns: `{ status: 'healthy', timestamp }`

**GET** `/api`
- API documentation
- Returns: List of available endpoints

## Architecture

### Directory Structure

```
honey-badger-backend/
├── server.js              # Main server entry point
├── api/
│   └── routes/
│       └── gifts.js       # Gift & challenge routes
├── services/
│   ├── authService.js     # JWT & authentication
│   ├── databaseService.js # SQLite database
│   ├── twilioService.js   # SMS notifications
│   ├── sendGridService.js # Email notifications
│   └── supabaseService.js # Supabase integration
├── database/
│   └── schema.sql         # PostgreSQL schema
├── data/                  # SQLite database storage
├── package.json
├── .env.example
└── README.md
```

### Database

**SQLite (Local):**
- Users, sessions, gift orders, contacts, special dates
- Database file: `data/users.db`
- Auto-created on first run

**Supabase (Optional Cloud):**
- Cloud sync for iOS app
- Hybrid authentication
- Enable with `ENABLE_SUPABASE=true`

### Authentication Flow

1. User signup/login → bcrypt password hashing
2. JWT token generation (7-day expiry)
3. Token sent in `Authorization: Bearer <token>` header
4. Protected routes use `authenticateToken` middleware
5. User info attached to `req.user`

### Gift & Challenge System

1. **Gift Creation**: User creates gift with challenge
2. **Initial Notification**: SMS/email sent to recipient
3. **Progress Tracking**: Recipient completes challenge steps
4. **Unlock**: When complete, gift unlocks
5. **Completion Message**: Notification sent

### Challenge Types

- `photo` - Requires photo upload
- `video` - Requires video upload
- `text` - Requires text response (10+ chars)
- `keyword` - Must contain specific keyword
- `multi-day` - Multi-day challenge
- `custom` - Custom validation

## Development

### Project Structure

- **server.js** - Main entry point, middleware setup
- **api/routes/** - Express route handlers
- **services/** - Business logic and external integrations

### Adding New Routes

1. Create route handler in `api/routes/`
2. Import in `server.js`
3. Mount with `app.use('/api/path', router)`

### Testing Endpoints

```bash
# Health check
curl http://localhost:3000/health

# Signup
curl -X POST http://localhost:3000/api/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com","password":"Test123"}'

# Login
curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123"}'

# Protected route (replace TOKEN)
curl http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer <TOKEN>"
```

## Security

- **Password Hashing**: bcrypt with 12 salt rounds
- **JWT Expiry**: 7 days (configurable)
- **Helmet**: Security headers enabled
- **CORS**: Restricted to frontend URL
- **Input Validation**: express-validator on critical endpoints
- **Environment Secrets**: Never commit `.env` files

## Deployment

### Recommended Platforms

- **Heroku**: Easy deployment, add-ons for database
- **Railway**: Modern platform, simple setup
- **Render**: Free tier available
- **AWS Elastic Beanstalk**: Scalable, production-ready

### Deployment Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set strong `JWT_SECRET`
- [ ] Configure `FRONTEND_URL` to production frontend
- [ ] Add Twilio credentials (if using SMS)
- [ ] Add SendGrid credentials (if using email)
- [ ] Set up database (SQLite or PostgreSQL)
- [ ] Configure scheduled tasks/cron

## Troubleshooting

### Database errors
- Ensure `data/` directory exists and is writable
- Check SQLite installation: `npm install sqlite3 --build-from-source`

### CORS errors
- Verify `FRONTEND_URL` matches your frontend domain
- Check CORS preflight requests in network tab

### SMS not sending
- Verify Twilio credentials in `.env`
- Check `ENABLE_SMS=true`
- Ensure phone numbers in E.164 format (+1XXXXXXXXXX)

### Email not sending
- Verify SendGrid API key
- Check `ENABLE_EMAIL=true`
- Verify sender email is authenticated in SendGrid

## License

Proprietary - Honey Badger AI Gifts

## Support

For issues or questions, contact: [support contact]
