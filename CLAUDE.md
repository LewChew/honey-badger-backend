# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Honey Badger AI Gifts is an AI-powered gift delivery service with motivational challenges. It allows users to send gifts (gift cards, cash, photos, messages, etc.) that recipients unlock by completing fun challenges. The Honey Badger acts as a persistent motivational coach via SMS messages.

## Core Architecture

### Server Setup
- **Main Entry**: `server.js` - Express server with JWT authentication and Twilio integration
- **Port**: 3000 (default, configurable via PORT env var)
- **Authentication**: JWT tokens with bcrypt password hashing (12 salt rounds)
- **Data Storage**: Currently uses in-memory Maps for users, gifts, challenges, and recipients (database integration planned)

### Service Layer
1. **authService.js** - Handles JWT generation, validation, user signup/login, session management
2. **twilioService.js** - Manages SMS notifications, reminders, and incoming message webhooks
3. **databaseService.js** - SQLite database abstraction (not currently integrated with main server)

### API Structure
- **Authentication**: In-memory Map in `server.js` (lines 27-28)
- **Gift Management**: `api/routes/gifts.js` router using in-memory Maps
- **Middleware**: Helmet for security, CORS enabled, express-validator for input validation

## Development Commands

### Running the Server
```bash
# Production mode
npm start

# Development mode with auto-reload
npm run dev
```

### Environment Setup
1. Copy `.env.example` to `.env`
2. **Required variables**:
   - `JWT_SECRET` - For token signing (critical for security)
3. **Optional for SMS features**:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_PHONE_NUMBER`
4. **Feature flags**:
   - `ENABLE_SMS=true` - Enables Twilio SMS
   - `ENABLE_SCHEDULED_REMINDERS=true` - Enables cron-based reminders
   - `REMINDER_CRON_SCHEDULE` - Defaults to `0 * * * *` (hourly)

### Testing Endpoints
```bash
# Health check
curl http://localhost:3000/health

# API documentation
curl http://localhost:3000/api
```

## Data Flow & Key Patterns

### Authentication Flow
1. User signup/login → `server.js` validation → bcrypt hash → JWT generation
2. Protected routes use `authenticateToken` middleware (server.js:60-75)
3. Token extracted from `Authorization: Bearer <token>` header
4. User info attached to `req.user` for downstream handlers

### Gift Creation & Challenge System
1. **Gift Creation**: POST `/api/gifts` → Creates gift + challenge + recipient tracking
2. **Storage**: Three Maps in `api/routes/gifts.js`:
   - `gifts` - Gift details, status, unlock state
   - `challenges` - Challenge type, requirements, progress tracking
   - `recipients` - Phone-based recipient info with active/completed gift arrays
3. **Initial Message**: Automatically sent via `sendInitialMessage()` on gift creation
4. **Progress Tracking**: PUT `/api/challenges/:challengeId/progress` updates steps, submissions
5. **Completion**: When `currentStep >= totalSteps`, gift unlocks and completion message sent

### Twilio SMS Integration
1. **Outbound**: `twilioService.sendSMS()`, notification templates for gift/reminder/completion
2. **Inbound Webhook**: POST `/api/webhooks/twilio/incoming`
   - Parses SMS from recipients
   - Validates against challenge requirements
   - Updates progress and sends appropriate response
3. **Phone Formatting**: `formatPhoneNumber()` ensures E.164 format (+1XXXXXXXXXX for US)

### Scheduled Tasks
- Uses `node-cron` for reminder scheduling
- Configured at server startup (server.js:410-418)
- Only runs if `ENABLE_SCHEDULED_REMINDERS=true`

## Important Constraints & Gotchas

### Data Persistence
- **Current**: In-memory storage (data lost on restart)
- **Implication**: All users, gifts, challenges cleared on server restart
- **Future**: SQLite schema defined in `databaseService.js` but not integrated
- When migrating to database: Update server.js Map operations to use databaseService methods

### Dual Storage Systems
- `server.js` has its own users Map (line 27)
- `api/routes/gifts.js` has separate gifts/challenges/recipients Maps (lines 13-15)
- `databaseService.js` has SQLite schemas but is not connected
- **Important**: When reading/modifying user data, check which storage system is active

### SMS Feature Toggle
- SMS functionality gracefully degrades if Twilio not configured
- Check pattern at server.js:14-24 for validation
- Gift routes only load if `api/routes/gifts.js` exists (server.js:50-57)
- Fallback responses provided when SMS disabled (server.js:315-322)

### Authentication Middleware
- `authenticateToken` - Requires valid JWT, fails with 401/403 (server.js:60-75)
- Used for: `/api/send-honey-badger`, `/api/honey-badgers`, `/api/auth/me`, `/api/auth/logout`
- Token format: `Authorization: Bearer <jwt_token>`

## API Endpoint Reference

### Core Authentication
- `POST /api/signup` - Validates: name (2+ chars), email, password (6+ chars with upper/lower/number), optional phone
- `POST /api/login` - Returns JWT token (7-day expiry)
- `GET /api/auth/me` - Requires auth token
- `POST /api/auth/logout` - Logs action, client-side token removal

### Gift & Challenge Management
- `POST /api/gifts` - Creates gift+challenge pair, sends initial SMS
- `GET /api/honey-badgers` - List user's sent gifts (currently returns mock data)
- `POST /api/messages/send-initial` - Resend initial notification
- `POST /api/messages/send-reminder` - Send motivational reminder
- `GET /api/challenges/:challengeId/progress` - Get completion percentage
- `PUT /api/challenges/:challengeId/progress` - Update steps, unlocks gift when complete
- `GET /api/recipients/:phone/gifts` - View active/completed gifts for phone number

### Webhooks
- `POST /api/webhooks/twilio/incoming` - Process recipient SMS responses
  - Expects: `From`, `Body`, `NumMedia`, `MediaUrl0`, `MediaContentType0`
  - Returns: TwiML XML response

## Challenge Types & Validation

Supported challenge types (validated in `validateResponse()` at gifts.js:512-526):
- `photo` - Requires media attachment (NumMedia > 0)
- `video` - Requires media attachment
- `text` - Requires body text > 10 chars
- `keyword` - Body must contain specific keyword (case-insensitive)
- `multi-day` - Uses totalSteps for day count
- `custom` - Always validates true

## Frontend Integration

- Static files served from `public/` directory (server.js:47)
- Assets served from `assets/` directory (server.js:48)
- Main HTML: `public/index.html`
- Client-side JavaScript: `public/app.js`, `public/script.js`
- Styles: `public/styles.css`

## Security Considerations

- Bcrypt salt rounds: 12 (configurable via BCRYPT_ROUNDS env var)
- JWT expiry: 7 days (configurable via TOKEN_EXPIRY or JWT_EXPIRY)
- Helmet middleware with CSP disabled for inline styles
- Password requirements: Min 6 chars, must have uppercase, lowercase, and number
- Environment variables for all secrets (never hardcode)
- Input validation via express-validator on signup/login

## Error Handling

- 404 handler at server.js:421-428 for unknown routes
- Global error handler at server.js:431-438 with stack traces in development
- Graceful shutdown handlers for SIGTERM/SIGINT (server.js:441-449)
- Service initialization checks with warnings (e.g., Twilio credentials)
