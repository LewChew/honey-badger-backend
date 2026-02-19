require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const cron = require('node-cron');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./services/databaseService');
const sendGridService = require('./services/sendGridService');

const app = express();
const PORT = process.env.PORT || 3000;

// Validate Twilio environment variables
if (process.env.ENABLE_SMS === 'true') {
    const requiredTwilioVars = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'];
    const missingVars = requiredTwilioVars.filter(varName => !process.env[varName]);

    if (missingVars.length > 0) {
        console.warn('⚠️ Warning: Missing Twilio environment variables:', missingVars.join(', '));
        console.warn('   SMS functionality will be disabled.');
        process.env.ENABLE_SMS = 'false';
    } else if (!process.env.TWILIO_ACCOUNT_SID.startsWith('AC')) {
        console.warn('⚠️ Warning: TWILIO_ACCOUNT_SID must start with "AC". SMS functionality will be disabled.');
        process.env.ENABLE_SMS = 'false';
    }
}

// Validate SendGrid environment variables
if (process.env.ENABLE_EMAIL === 'true') {
    const requiredSendGridVars = ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'];
    const missingVars = requiredSendGridVars.filter(varName => !process.env[varName]);

    if (missingVars.length > 0) {
        console.warn('⚠️ Warning: Missing SendGrid environment variables:', missingVars.join(', '));
        console.warn('   Email functionality will be disabled.');
        process.env.ENABLE_EMAIL = 'false';
    }
}

// SQLite database for persistent storage
// Database service handles: users, sessions, gift_orders, contacts, special_dates
// Database file located at: data/users.db

// Verify database connection
if (!db || !db.db) {
    console.error('❌ Database service failed to initialize!');
    console.error('   Make sure sqlite3 is installed: npm install');
    process.exit(1);
}

// JWT secret (use environment variable in production)
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Initialize Anthropic client for AI chatbot
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
}) : null;

// Middleware
app.use(helmet({
    contentSecurityPolicy: false // Allow inline styles for this demo
}));

// CORS configuration - allow frontend URLs
const corsOptions = {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files (photos)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve static files from public directory (consent pages, legal docs, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// SMS terms/consent page
app.get('/sms-terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sms-consent.html'));
});

// Password reset page
app.get('/reset-password', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

// Request logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Import gift routes (only if file exists)
let giftsRouter;
try {
    giftsRouter = require('./api/routes/gifts');
    console.log('✅ Gift routes loaded successfully');
} catch (error) {
    console.warn('⚠️ Gift routes not found. Some API functionality may be limited.');
}

// Auth middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// Mount gift routes if available
if (giftsRouter) {
    app.use('/api', giftsRouter);
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// User registration
app.post('/api/signup', [
    body('signupName').trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
    body('signupEmail').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('signupPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('Password must contain uppercase, lowercase, and number'),
    body('signupPhone').optional().isMobilePhone().withMessage('Valid phone number required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { signupName, signupEmail, signupPassword, signupPhone } = req.body;

        // Check if user already exists in database
        const existingUser = await db.getUserByEmail(signupEmail);
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'User already exists with this email'
            });
        }

        // Create user in database (password hashing handled by databaseService)
        const user = await db.createUser({
            name: signupName,
            email: signupEmail,
            password: signupPassword,
            phone: signupPhone || null
        });

        // Generate JWT token
        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                name: user.name
            },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Save session to database
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
        await db.saveSession(user.id, token, expiresAt);

        // Return success response
        res.status(201).json({
            success: true,
            message: 'Account created successfully',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone
            }
        });

        console.log('✅ New user registered:', signupEmail);

    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error during registration'
        });
    }
});

// User login
app.post('/api/login', [
    body('loginEmail').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('loginPassword').notEmpty().withMessage('Password is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Please provide valid email and password',
                errors: errors.array()
            });
        }

        const { loginEmail, loginPassword } = req.body;

        // Find user in database
        const user = await db.getUserByEmail(loginEmail);
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        // Check if user is active
        if (!user.is_active) {
            return res.status(401).json({
                success: false,
                message: 'Account has been disabled'
            });
        }

        // Verify password using database service
        const isPasswordValid = await db.verifyPassword(loginPassword, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        // Generate JWT token
        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                name: user.name
            },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Save session to database
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
        await db.saveSession(user.id, token, expiresAt);

        // Return success response (don't send password)
        const userWithoutPassword = {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            createdAt: user.created_at,
            isActive: user.is_active
        };
        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: userWithoutPassword
        });

        console.log('✅ User logged in:', loginEmail);

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error during login'
        });
    }
});

// Get current user profile
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const user = await db.getUserById(req.user.id);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                createdAt: user.created_at,
                emailVerified: user.email_verified,
                phoneVerified: user.phone_verified
            }
        });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching user profile'
        });
    }
});

// Logout (invalidate session in database)
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (token) {
            await db.deleteSession(token);
        }

        console.log('✅ User logged out:', req.user.email);
        res.json({
            success: true,
            message: 'Logged out successfully'
        });
    } catch (error) {
        console.error('Logout error:', error);
        res.json({
            success: true,
            message: 'Logged out successfully'
        });
    }
});

// Update user profile
app.put('/api/auth/profile', authenticateToken, [
    body('name').trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { name } = req.body;
        const userId = req.user.id;

        await db.updateUserProfile(userId, { name });

        console.log('✅ Profile updated for user:', req.user.email);
        res.json({
            success: true,
            message: 'Profile updated successfully'
        });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error updating profile'
        });
    }
});

// Change password
app.put('/api/auth/password', authenticateToken, [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('Password must contain uppercase, lowercase, and number')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { currentPassword, newPassword } = req.body;
        const userId = req.user.id;

        await db.changePasswordById(userId, currentPassword, newPassword);

        console.log('✅ Password changed for user:', req.user.email);
        res.json({
            success: true,
            message: 'Password changed successfully'
        });
    } catch (error) {
        console.error('Password change error:', error);

        if (error.message === 'Current password is incorrect') {
            return res.status(401).json({
                success: false,
                message: 'Current password is incorrect'
            });
        }

        res.status(500).json({
            success: false,
            message: error.message || 'Error changing password'
        });
    }
});

// AI Chatbot endpoint - Powered by Claude 3.5 Haiku
app.post('/api/chat', authenticateToken, [
    body('message').trim().notEmpty().withMessage('Message is required'),
    body('conversationHistory').optional().isArray().withMessage('Conversation history must be an array')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        // Check if Anthropic API is configured
        if (!anthropic) {
            return res.status(503).json({
                success: false,
                message: 'AI chatbot is not configured. Please set ANTHROPIC_API_KEY in environment variables.',
                fallbackResponse: getFallbackResponse(req.body.message)
            });
        }

        const { message, conversationHistory = [] } = req.body;

        // Build the conversation for Claude
        const messages = [
            ...conversationHistory.map(msg => ({
                role: msg.role,
                content: msg.content
            })),
            {
                role: 'user',
                content: message
            }
        ];

        // System prompt for the Honey Badger assistant
        const systemPrompt = `You are the Honey Badger AI assistant, a helpful and enthusiastic guide for the Honey Badger gift delivery platform. Your personality is friendly, motivating, and slightly playful - embodying the fearless and persistent spirit of a honey badger.

=== PLATFORM OVERVIEW ===
Honey Badger is an AI-powered gift delivery platform that makes gifting meaningful through challenges. Users send gifts that recipients unlock by completing motivational challenges, turning gifts into engaging experiences.

=== CORE FEATURES ===

1. GIFT TYPES:
   - Gift Cards (Amazon, Starbucks, etc.)
   - Cash Transfers (Venmo, PayPal, Zelle)
   - Digital Content (photos, videos, custom messages)
   - Physical Items (with delivery tracking)
   - Custom Gifts (personalized experiences)

2. CHALLENGE TYPES:
   - Simple Task: Quick one-time action (e.g., "Call your mom")
   - Photo Challenge: Upload a photo proving completion (e.g., "Post a selfie at the gym")
   - Video Challenge: Record a video (e.g., "Film yourself trying a new recipe")
   - Fitness Goal: Track physical activity (e.g., "Run 5 miles this week")
   - Multi-Day Goal: Sustained commitment (e.g., "Meditate for 7 days straight")
   - Creative Challenge: Make or create something (e.g., "Write a thank you note")
   - Learning Challenge: Acquire new knowledge (e.g., "Complete a coding tutorial")

3. DELIVERY METHODS:
   - SMS/Text Message (via Twilio)
   - Email (via SendGrid)
   - In-Platform Notification
   - QR Code for in-person delivery

4. NETWORK FEATURES:
   - "Badgers In the Wild": See challenges your friends are completing
   - "Your Network": Connect with other users
   - Challenge inspiration from community
   - Share accomplishments

=== COMMON USE CASES ===

Birthday Gifts:
- Send gift card for restaurant, challenge: "Share a photo of you enjoying the meal"
- Cash for celebration, challenge: "Post a video of your birthday toast"

Motivation/Wellness:
- Fitness gift card, challenge: "Complete 3 workouts this week"
- Spa gift card, challenge: "Practice self-care and share what you learned"

Congratulations:
- Amazon gift card for new job, challenge: "Share your first-day selfie"
- Cash bonus, challenge: "Write down 3 goals for your new role"

Just Because:
- Coffee gift card, challenge: "Try a new drink and tell me about it"
- Small cash, challenge: "Do something nice for someone else and share the story"

Encouragement:
- Gift during tough times, challenge: "List 3 things you're grateful for"
- Support gift, challenge: "Take a break and do something you love"

=== PLATFORM TERMINOLOGY ===
- "Send a Badger": Create and send a gift with challenge
- "Badgers In the Wild": Activity feed of ongoing challenges
- "Your Network": Your connections on the platform
- "Unlock": Complete challenge to receive gift
- "Honey Badger Spirit": Never give up, persistent, fearless attitude

=== USER GUIDANCE ===

When users ask about creating challenges:
- Match challenge difficulty to relationship (easy for acquaintances, harder for close friends)
- Make challenges achievable and fun, not stressful
- Photo/video challenges are most engaging
- Multi-day challenges work best for close relationships
- Fitness challenges should be realistic

When recipients need motivation:
- Remind them of the "honey badger spirit" - persistence wins
- Break down multi-day challenges into daily steps
- Celebrate progress, not just completion
- Emphasize the thoughtfulness behind the gift

Common Questions to Answer:
- "How do I send a gift?" → Guide to Send a Badger form on right panel
- "What if recipient doesn't complete challenge?" → Explain they can still access gift, but challenges make it meaningful
- "Can I see what others are doing?" → Point to "Badgers In the Wild" section
- "How do recipients get notified?" → Explain SMS/email delivery options
- "Can I send to multiple people?" → Yes, each gets individual challenge
- "What makes a good challenge?" → Personal, achievable, fun, meaningful

=== YOUR COMMUNICATION STYLE ===
- Be enthusiastic but not over-the-top
- Use "we" and "let's" to be collaborative
- Reference honey badger traits (persistent, fearless, determined) when motivating
- Keep responses 2-3 sentences unless explaining complex features
- Use emojis very sparingly (only when truly enhancing the message)
- Never give up on helping users - you're a honey badger!

=== EXAMPLE INTERACTIONS ===

User: "I want to send my friend a gift for finishing her marathon"
You: "That's amazing! How about a gift card to a sports store or massage spa? For the challenge, you could have her share a photo with her finisher's medal or post her race time. It'll be a great way to celebrate her accomplishment!"

User: "What's a good beginner challenge?"
You: "Start simple! Photo challenges are perfect for beginners. Something like 'Share a selfie enjoying your gift' or 'Post a pic of you trying something new.' These are fun, easy, and personal without being intimidating."

User: "My recipient isn't completing the challenge"
You: "No worries! They can still access their gift - challenges are meant to add meaning, not stress. Want to send them a friendly reminder through the platform? Or you could suggest an easier alternative challenge. The honey badger spirit is about persistence, not pressure!"

Keep responses helpful, specific, and actionable.`;

        // Call Claude API
        const response = await anthropic.messages.create({
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 300,
            system: systemPrompt,
            messages: messages
        });

        const aiResponse = response.content[0].text;

        res.json({
            success: true,
            message: aiResponse,
            model: 'claude-3-5-haiku-20241022'
        });

        console.log(`🤖 AI Chat - User: ${req.user.email} - Message: "${message.substring(0, 50)}..."`);

    } catch (error) {
        console.error('AI Chat error:', error);

        // Provide fallback response if API fails
        const fallbackResponse = getFallbackResponse(req.body.message);

        res.status(200).json({
            success: true,
            message: fallbackResponse,
            fallback: true,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Fallback responses when AI is unavailable
function getFallbackResponse(userMessage) {
    const lowerMessage = userMessage.toLowerCase();

    if (lowerMessage.includes('hello') || lowerMessage.includes('hi')) {
        return "Hey there! How can I help you with your Honey Badger experience today?";
    } else if (lowerMessage.includes('help')) {
        return "I can help you with sending gifts, tracking challenges, managing your network, and more. What would you like to know?";
    } else if (lowerMessage.includes('send') || lowerMessage.includes('gift')) {
        return "To send a gift, click on the 'Send a Honey Badger' section on the right. You can choose the gift type, recipient, and challenge!";
    } else if (lowerMessage.includes('challenge')) {
        return "Challenges are fun tasks your recipients complete to unlock their gifts. You can set photo challenges, fitness goals, multi-day tasks, and more!";
    } else if (lowerMessage.includes('thank')) {
        return "You're welcome! Happy to help. Let me know if you need anything else!";
    } else {
        return "That's an interesting question! I'm here to help with your Honey Badger gifts. Feel free to ask me about sending gifts, challenges, or managing your account.";
    }
}

// Contact management endpoints
// Add a contact to user's network
app.post('/api/contacts', authenticateToken, [
    body('name').trim().notEmpty().withMessage('Contact name is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { name, email, phone, relationship, birthday } = req.body;

        // Create contact in database
        const contact = await db.createContact(req.user.id, {
            name,
            email,
            phone,
            relationship,
            birthday
        });

        res.status(201).json({
            success: true,
            message: 'Contact added successfully',
            contact
        });

        console.log('✅ Contact added for user:', req.user.email, '- Contact:', name);

    } catch (error) {
        console.error('Add contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Error adding contact',
            error: error.message || 'Unknown error'
        });
    }
});

// Get user's contacts
app.get('/api/contacts', authenticateToken, async (req, res) => {
    try {
        const contacts = await db.getUserContacts(req.user.id);

        res.json({
            success: true,
            contacts
        });

    } catch (error) {
        console.error('Get contacts error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching contacts'
        });
    }
});

// Delete a contact
app.delete('/api/contacts/:contactId', authenticateToken, async (req, res) => {
    try {
        const { contactId } = req.params;
        const deleted = await db.deleteContact(req.user.id, contactId);

        if (!deleted) {
            return res.status(404).json({
                success: false,
                message: 'Contact not found'
            });
        }

        res.json({
            success: true,
            message: 'Contact deleted successfully'
        });

        console.log('✅ Contact deleted for user:', req.user.email, '- Contact ID:', contactId);

    } catch (error) {
        console.error('Delete contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting contact'
        });
    }
});

// Special dates management endpoints
// Add a special date to a contact
app.post('/api/contacts/:contactId/special-dates', authenticateToken, [
    body('dateName').trim().notEmpty().withMessage('Date name is required'),
    body('dateValue').trim().notEmpty().withMessage('Date value is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { contactId } = req.params;
        const { dateName, dateValue, notes } = req.body;

        // Verify contact belongs to user
        const ownsContact = await db.verifyContactOwnership(req.user.id, contactId);
        if (!ownsContact) {
            return res.status(404).json({
                success: false,
                message: 'Contact not found'
            });
        }

        // Create special date
        const specialDate = await db.createSpecialDate(contactId, {
            dateName,
            dateValue,
            notes
        });

        res.status(201).json({
            success: true,
            message: 'Special date added successfully',
            specialDate
        });

        console.log('✅ Special date added for contact ID:', contactId, '- Date:', dateName);

    } catch (error) {
        console.error('Add special date error:', error);
        res.status(500).json({
            success: false,
            message: 'Error adding special date'
        });
    }
});

// Get special dates for a contact
app.get('/api/contacts/:contactId/special-dates', authenticateToken, async (req, res) => {
    try {
        const { contactId } = req.params;

        // Verify contact belongs to user
        const ownsContact = await db.verifyContactOwnership(req.user.id, contactId);
        if (!ownsContact) {
            return res.status(404).json({
                success: false,
                message: 'Contact not found'
            });
        }

        const specialDates = await db.getContactSpecialDates(contactId);

        res.json({
            success: true,
            specialDates
        });

    } catch (error) {
        console.error('Get special dates error:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching special dates'
        });
    }
});

// Delete a special date
app.delete('/api/special-dates/:specialDateId', authenticateToken, async (req, res) => {
    try {
        const { specialDateId } = req.params;

        // Note: We could add ownership verification by joining with contacts table
        // For now, we'll trust the frontend to only show user's own special dates
        const deleted = await db.deleteSpecialDate(specialDateId);

        if (!deleted) {
            return res.status(404).json({
                success: false,
                message: 'Special date not found'
            });
        }

        res.json({
            success: true,
            message: 'Special date deleted successfully'
        });

        console.log('✅ Special date deleted - ID:', specialDateId);

    } catch (error) {
        console.error('Delete special date error:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting special date'
        });
    }
});

// Request password reset token
app.post('/api/auth/forgot-password', [
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid email address',
                errors: errors.array()
            });
        }

        const { email } = req.body;

        // Check if user exists
        const user = await db.getUserByEmail(email);
        if (!user) {
            // For security, return success even if user doesn't exist
            // This prevents email enumeration attacks
            return res.json({
                success: true,
                message: 'If an account exists with that email, a password reset link has been sent.'
            });
        }

        // Generate secure reset token (64-char hex string)
        const resetToken = crypto.randomBytes(32).toString('hex');

        // Store token with 15-minute expiration
        const expiresInMinutes = 15;
        const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();
        await db.saveResetToken(email, resetToken, expiresAt);

        // Build reset URL
        const backendUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
        const resetUrl = `${backendUrl}/reset-password?token=${resetToken}`;

        // Send reset email via SendGrid
        const emailResult = await sendGridService.sendPasswordResetEmail(email, {
            resetUrl,
            expiresInMinutes
        });

        if (emailResult.success) {
            console.log(`✅ Password reset email sent to ${email}`);
        } else {
            console.warn(`⚠️  Password reset email failed for ${email}: ${emailResult.message}`);
        }

        // Log token to console for development
        console.log('🔐 Password Reset Token Generated');
        console.log('================================');
        console.log(`Email: ${email}`);
        console.log(`Token: ${resetToken}`);
        console.log(`Reset URL: ${resetUrl}`);
        console.log(`Expires: ${expiresAt}`);
        console.log('================================');

        res.json({
            success: true,
            message: 'If an account exists with that email, a password reset link has been sent.',
            // In development, include the token in response
            ...(process.env.NODE_ENV === 'development' && { token: resetToken })
        });

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Reset password with token
app.post('/api/auth/reset-password', [
    body('token').notEmpty().withMessage('Reset token is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('Password must contain uppercase, lowercase, and number')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { token, newPassword } = req.body;

        // Look up token in database (handles expiry + used check in SQL)
        const resetData = await db.getResetToken(token);
        if (!resetData) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or expired reset token'
            });
        }

        // Update user password
        const passwordUpdated = await db.updatePassword(resetData.email, newPassword);
        if (!passwordUpdated) {
            return res.status(500).json({
                success: false,
                message: 'Failed to update password'
            });
        }

        // Mark token as used (preserves audit trail)
        await db.markResetTokenUsed(token);

        console.log('✅ Password reset successful for:', resetData.email);

        res.json({
            success: true,
            message: 'Password has been reset successfully. You can now login with your new password.'
        });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Protected route: Send Honey Badger (requires authentication)
app.post('/api/send-honey-badger', authenticateToken, async (req, res) => {
    const {
        recipientName,
        recipientEmail,
        recipientPhone,
        recipientContact, // Legacy field
        deliveryMethod,
        giftType,
        giftValue,
        giftAmount, // iOS app sends this
        challengeType,
        challengeDescription,
        challenge, // Legacy field
        personalNote,
        message, // Legacy field
        duration
    } = req.body;

    // Use giftAmount if giftValue is not provided (for iOS app compatibility)
    const finalGiftValue = giftValue || giftAmount || 'A special gift';

    console.log('New Honey Badger request from:', req.user.email, req.body);

    // If gift routes are available and email or SMS is enabled, use the new system
    if (giftsRouter && (process.env.ENABLE_EMAIL === 'true' || process.env.ENABLE_SMS === 'true')) {
        try {
            // Make internal API call to /api/gifts
            const axios = require('axios');
            const giftPayload = {
                recipientPhone: recipientPhone || recipientContact,
                recipientEmail: recipientEmail,
                recipientName,
                senderName: req.user.name,
                deliveryMethod: deliveryMethod || (recipientEmail ? 'email' : 'sms'),
                giftType,
                giftDetails: {
                    value: finalGiftValue,
                    description: finalGiftValue,
                    personalMessage: personalNote || message
                },
                challengeType: challengeType || 'custom',
                challengeDescription: challengeDescription || challenge,
                challengeRequirements: {
                    totalSteps: duration || 1
                }
            };

            const response = await axios.post(`http://localhost:${PORT}/api/gifts`, giftPayload, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const result = response.data;

            if (result.success) {
                // Save to database for persistent storage
                const trackingId = result.data?.giftId || 'HB' + Date.now();
                try {
                    await db.createGiftOrder(req.user.id, {
                        trackingId,
                        recipientName,
                        recipientEmail,
                        recipientPhone: recipientPhone || recipientContact,
                        deliveryMethod: deliveryMethod || (recipientEmail ? 'email' : 'sms'),
                        giftType,
                        giftValue: finalGiftValue,
                        challenge: challengeDescription || challenge,
                        challengeType: challengeType || 'custom',
                        challengeDescription: challengeDescription || challenge,
                        personalNote: personalNote || message,
                        duration: duration || 1
                    });
                    console.log('✅ Gift saved to database with tracking ID:', trackingId);
                } catch (dbError) {
                    console.error('⚠️  Failed to save gift to database:', dbError.message);
                    // Don't fail the request if database save fails
                }

                return res.json({
                    success: true,
                    message: 'Honey Badger sent successfully!',
                    giftId: result.data?.giftId || trackingId,
                    challengeId: result.data?.challengeId,
                    trackingId,
                    sender: req.user.name,
                    deliveryResults: result.data?.messageSent
                });
            } else {
                return res.status(response.status).json({
                    success: false,
                    message: result.message || 'Failed to send Honey Badger'
                });
            }
        } catch (error) {
            console.error('Error forwarding to gift routes:', error);
            const errorMessage = error.response?.data?.message || error.message;
            return res.status(500).json({
                success: false,
                message: 'Failed to send Honey Badger: ' + errorMessage
            });
        }
    }

    // Fallback: Save to database even if SMS/Email not configured
    try {
        const trackingId = 'HB' + Date.now();
        const orderData = {
            trackingId,
            recipientName,
            recipientEmail: recipientEmail || null,
            recipientPhone: recipientPhone || recipientContact || null,
            recipientContact: recipientContact || recipientPhone || recipientEmail,
            deliveryMethod: deliveryMethod || 'email',
            giftType,
            giftValue: giftValue || '',
            challengeType: challengeType || 'custom',
            challengeDescription: challengeDescription || challenge || '',
            challenge: challenge || challengeDescription || '',
            verificationType: req.body.verificationType || null,
            reminderFrequency: req.body.reminderFrequency || 'none',
            personalNote: personalNote || message || '',
            message: message || personalNote || '',
            duration: duration || 1,
            notifyOnComplete: req.body.notifyOnComplete !== undefined ? req.body.notifyOnComplete : true
        };

        await db.createGiftOrder(req.user.id, orderData);

        res.json({
            success: true,
            message: 'Honey Badger sent successfully!',
            trackingId,
            sender: req.user.name,
            note: process.env.ENABLE_SMS !== 'true' && process.env.ENABLE_EMAIL !== 'true'
                ? 'Email and SMS not configured. Gift created but recipient will not be notified.'
                : null
        });
    } catch (error) {
        console.error('Error saving gift order:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save gift order: ' + error.message
        });
    }
});

// Get user's sent honey badgers
app.get('/api/honey-badgers', authenticateToken, async (req, res) => {
    try {
        const orders = await db.getUserOrders(req.user.id);

        // Format orders for frontend
        const honeyBadgers = orders.map(order => ({
            id: order.tracking_id,
            recipientName: order.recipient_name,
            recipientEmail: order.recipient_email,
            recipientPhone: order.recipient_phone,
            giftType: order.gift_type,
            giftValue: order.gift_value,
            challenge: order.challenge_description || order.challenge,
            challengeType: order.challenge_type,
            challengeDescription: order.challenge_description || order.challenge,
            verificationType: order.verification_type,
            status: order.status,
            createdAt: order.created_at,
            deliveryMethod: order.delivery_method,
            duration: order.duration,
            reminderFrequency: order.reminder_frequency,
            personalNote: order.personal_note,
            message: order.message
        }));

        res.json({
            success: true,
            gifts: honeyBadgers  // iOS app expects 'gifts' field
        });
    } catch (error) {
        console.error('Error fetching honey badgers:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch honey badgers: ' + error.message
        });
    }
});

// Get gifts received by the current user
app.get('/api/my-received-gifts', authenticateToken, async (req, res) => {
    try {
        // Get user details to match against recipient info
        const user = await db.getUserById(req.user.id);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Pass userId to exclude self-sent gifts from received gifts
        const receivedGifts = await db.getReceivedGifts(user.email, user.phone, req.user.id);

        // Format gifts for frontend
        const formattedGifts = receivedGifts.map(gift => ({
            id: gift.tracking_id,
            senderName: gift.sender_name,
            senderEmail: gift.sender_email,
            recipientName: gift.recipient_name,
            recipientEmail: gift.recipient_email,
            recipientPhone: gift.recipient_phone,
            giftType: gift.gift_type,
            giftValue: gift.gift_value,
            challenge: gift.challenge_description || gift.challenge,
            challengeType: gift.challenge_type,
            challengeDescription: gift.challenge_description || gift.challenge,
            verificationType: gift.verification_type,
            status: gift.status,
            createdAt: gift.created_at,
            deliveryMethod: gift.delivery_method,
            duration: gift.duration,
            reminderFrequency: gift.reminder_frequency,
            personalNote: gift.personal_note,
            message: gift.message
        }));

        res.json({
            success: true,
            gifts: formattedGifts
        });
    } catch (error) {
        console.error('Error fetching received gifts:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch received gifts: ' + error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        database: 'SQLite',
        features: {
            authentication: 'enabled',
            encryption: 'bcrypt',
            tokenAuth: 'JWT',
            sms: process.env.ENABLE_SMS === 'true' ? 'enabled' : 'disabled',
            twilio: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'not configured'
        }
    });
});

// API documentation endpoint
app.get('/api', (req, res) => {
    res.json({
        message: '🦡 Honey Badger AI Gifts API',
        version: '1.0.0',
        endpoints: {
            auth: {
                signup: 'POST /api/signup',
                login: 'POST /api/login',
                profile: 'GET /api/auth/me',
                logout: 'POST /api/auth/logout',
                forgotPassword: 'POST /api/auth/forgot-password',
                resetPassword: 'POST /api/auth/reset-password'
            },
            chat: {
                sendMessage: 'POST /api/chat (AI-powered by Claude 3.5 Haiku)'
            },
            contacts: {
                add: 'POST /api/contacts',
                list: 'GET /api/contacts',
                delete: 'DELETE /api/contacts/:contactId',
                specialDates: {
                    add: 'POST /api/contacts/:contactId/special-dates',
                    list: 'GET /api/contacts/:contactId/special-dates',
                    delete: 'DELETE /api/special-dates/:specialDateId'
                }
            },
            honeyBadgers: {
                send: 'POST /api/send-honey-badger',
                list: 'GET /api/honey-badgers'
            },
            gifts: giftsRouter ? {
                create: 'POST /api/gifts',
                messages: {
                    sendInitial: 'POST /api/messages/send-initial',
                    sendReminder: 'POST /api/messages/send-reminder'
                },
                challenges: {
                    getProgress: 'GET /api/challenges/:challengeId/progress',
                    updateProgress: 'PUT /api/challenges/:challengeId/progress'
                },
                recipients: {
                    getGifts: 'GET /api/recipients/:phone/gifts'
                },
                webhooks: {
                    twilioIncoming: 'POST /api/webhooks/twilio/incoming'
                }
            } : 'Gift routes not configured',
            health: 'GET /health'
        }
    });
});

// Scheduled task for sending reminders (runs every hour)
if (process.env.ENABLE_SCHEDULED_REMINDERS === 'true') {
    const cronSchedule = process.env.REMINDER_CRON_SCHEDULE || '0 * * * *';
    cron.schedule(cronSchedule, async () => {
        console.log('🔔 Running scheduled reminder check...');
        // This would check all active challenges and send reminders as needed
        // Implementation would depend on your database setup
    });
    console.log('📅 Scheduled reminders enabled with cron:', cronSchedule);
}

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false,
        error: 'Route not found',
        path: req.path,
        method: req.method
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('❌ Error:', err);
    res.status(err.status || 500).json({ 
        success: false,
        error: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received. Shutting down gracefully...');
    process.exit(0);
});

app.listen(PORT, () => {
    console.log('');
    console.log('🦡 Honey Badger AI Gifts Server');
    console.log('================================');
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Visit http://localhost:${PORT} to see your app`);
    console.log(`📡 API endpoint: http://localhost:${PORT}/api`);
    console.log('');
    console.log('Features:');
    console.log(`  🔐 Authentication: Enabled (JWT + bcrypt)`);
    console.log(`  💾 Database: SQLite (data/users.db)`);
    console.log(`  📱 SMS (Twilio): ${process.env.ENABLE_SMS === 'true' ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`  📧 Email: ${process.env.ENABLE_EMAIL === 'true' ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`  🔔 Scheduled Reminders: ${process.env.ENABLE_SCHEDULED_REMINDERS === 'true' ? '✅ Enabled' : '❌ Disabled'}`);
    
    if (process.env.ENABLE_SMS === 'true' && process.env.TWILIO_ACCOUNT_SID) {
        console.log('');
        console.log('Twilio Configuration:');
        console.log(`  📞 Phone Number: ${process.env.TWILIO_PHONE_NUMBER}`);
        console.log(`  🔗 Webhook URL: ${process.env.WEBHOOK_BASE_URL}${process.env.TWILIO_WEBHOOK_PATH || '/api/webhooks/twilio/incoming'}`);
    }
    
    console.log('================================');
});

module.exports = app;
