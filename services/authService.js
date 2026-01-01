const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const databaseService = require('./databaseService');

class AuthService {
    constructor() {
        this.jwtSecret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
        this.jwtExpiry = process.env.JWT_EXPIRY || '7d'; // 7 days
    }

    // Generate JWT token
    generateToken(userId, email) {
        return jwt.sign(
            { 
                userId, 
                email,
                iat: Math.floor(Date.now() / 1000)
            },
            this.jwtSecret,
            { expiresIn: this.jwtExpiry }
        );
    }

    // Verify JWT token
    verifyToken(token) {
        try {
            return jwt.verify(token, this.jwtSecret);
        } catch (error) {
            throw new Error('Invalid or expired token');
        }
    }

    // Input validation middleware
    validateSignup() {
        return [
            body('signupName')
                .trim()
                .isLength({ min: 2, max: 50 })
                .withMessage('Name must be between 2 and 50 characters'),
            body('signupEmail')
                .isEmail()
                .normalizeEmail()
                .withMessage('Please provide a valid email address'),
            body('signupPassword')
                .isLength({ min: 6 })
                .withMessage('Password must be at least 6 characters long')
                .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
                .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
            body('signupPhone')
                .optional()
                .isMobilePhone()
                .withMessage('Please provide a valid phone number')
        ];
    }

    validateLogin() {
        return [
            body('loginEmail')
                .isEmail()
                .normalizeEmail()
                .withMessage('Please provide a valid email address'),
            body('loginPassword')
                .notEmpty()
                .withMessage('Password is required')
        ];
    }

    // Check validation results
    checkValidation(req, res, next) {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }
        next();
    }

    // Authentication middleware
    authenticateToken(req, res, next) {
        // Check for token in Authorization header or cookies
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1] || req.cookies?.authToken;

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Access token is required'
            });
        }

        try {
            const decoded = this.verifyToken(token);
            req.user = decoded;
            next();
        } catch (error) {
            return res.status(403).json({
                success: false,
                message: 'Invalid or expired token'
            });
        }
    }

    // Optional authentication middleware (doesn't fail if no token)
    optionalAuth(req, res, next) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1] || req.cookies?.authToken;

        if (token) {
            try {
                const decoded = this.verifyToken(token);
                req.user = decoded;
            } catch (error) {
                // Ignore token errors for optional auth
                req.user = null;
            }
        } else {
            req.user = null;
        }
        next();
    }

    // Sign up user
    async signup(userData) {
        try {
            // Create user in database
            const user = await databaseService.createUser(userData);
            
            // Generate token
            const token = this.generateToken(user.id, user.email);
            
            // Calculate expiry date
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 7); // 7 days from now

            // Save session to database
            await databaseService.saveSession(user.id, token, expiresAt.toISOString());

            return {
                success: true,
                message: 'Account created successfully',
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    phone: user.phone
                },
                token
            };
        } catch (error) {
            throw error;
        }
    }

    // Login user
    async login(email, password) {
        try {
            // Get user from database
            const user = await databaseService.getUserByEmail(email);
            
            if (!user) {
                throw new Error('Invalid email or password');
            }

            // Verify password
            const passwordValid = await databaseService.verifyPassword(password, user.password);
            
            if (!passwordValid) {
                throw new Error('Invalid email or password');
            }

            // Generate token
            const token = this.generateToken(user.id, user.email);
            
            // Calculate expiry date
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 7); // 7 days from now

            // Save session to database
            await databaseService.saveSession(user.id, token, expiresAt.toISOString());

            return {
                success: true,
                message: 'Login successful',
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                    emailVerified: user.email_verified,
                    phoneVerified: user.phone_verified
                },
                token
            };
        } catch (error) {
            throw error;
        }
    }

    // Logout user
    async logout(token) {
        try {
            await databaseService.deleteSession(token);
            return {
                success: true,
                message: 'Logged out successfully'
            };
        } catch (error) {
            throw error;
        }
    }

    // Get current user info
    async getCurrentUser(userId) {
        try {
            const user = await databaseService.getUserById(userId);
            
            if (!user) {
                throw new Error('User not found');
            }

            return {
                success: true,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                    emailVerified: user.email_verified,
                    phoneVerified: user.phone_verified,
                    createdAt: user.created_at
                }
            };
        } catch (error) {
            throw error;
        }
    }

    // Refresh token
    async refreshToken(oldToken) {
        try {
            // Verify old token (even if expired)
            let decoded;
            try {
                decoded = jwt.verify(oldToken, this.jwtSecret);
            } catch (error) {
                // If token is expired, try to decode without verification
                decoded = jwt.decode(oldToken);
                if (!decoded) {
                    throw new Error('Invalid token');
                }
            }

            // Check if session exists
            const session = await databaseService.getSession(oldToken);
            if (!session) {
                throw new Error('Session not found');
            }

            // Delete old session
            await databaseService.deleteSession(oldToken);

            // Generate new token
            const newToken = this.generateToken(decoded.userId, decoded.email);
            
            // Calculate expiry date
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 7); // 7 days from now

            // Save new session
            await databaseService.saveSession(decoded.userId, newToken, expiresAt.toISOString());

            return {
                success: true,
                token: newToken,
                message: 'Token refreshed successfully'
            };
        } catch (error) {
            throw error;
        }
    }

    // Cleanup expired sessions (should be called periodically)
    async cleanupExpiredSessions() {
        try {
            const deletedCount = await databaseService.cleanupExpiredSessions();
            console.log(`🧹 Cleaned up ${deletedCount} expired sessions`);
            return deletedCount;
        } catch (error) {
            console.error('Session cleanup error:', error.message);
        }
    }
}

module.exports = new AuthService();
