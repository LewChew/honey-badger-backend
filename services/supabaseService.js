/**
 * Supabase Service
 * Handles Supabase database connection and JWT verification for Node.js backend
 */

const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

class SupabaseService {
    constructor() {
        this.supabaseUrl = process.env.SUPABASE_URL;
        this.supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
        this.jwtSecret = process.env.SUPABASE_JWT_SECRET;

        if (!this.supabaseUrl || !this.supabaseServiceKey) {
            console.warn('⚠️  Supabase credentials not configured. Using local storage only.');
            this.enabled = false;
            return;
        }

        // Create Supabase client with service role key (bypass RLS)
        this.supabase = createClient(this.supabaseUrl, this.supabaseServiceKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });

        this.enabled = true;
        console.log('✅ Supabase service initialized');
    }

    /**
     * Verify Supabase JWT token
     * @param {string} token - JWT token from iOS app
     * @returns {Object|null} Decoded token payload or null if invalid
     */
    verifyToken(token) {
        if (!this.enabled || !this.jwtSecret) {
            console.warn('Supabase JWT verification not available');
            return null;
        }

        try {
            const decoded = jwt.verify(token, this.jwtSecret);
            return decoded;
        } catch (error) {
            console.error('Token verification failed:', error.message);
            return null;
        }
    }

    /**
     * Middleware to authenticate requests using Supabase JWT
     */
    authenticateToken() {
        return (req, res, next) => {
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

            if (!token) {
                return res.status(401).json({ error: 'No token provided' });
            }

            const decoded = this.verifyToken(token);

            if (!decoded) {
                return res.status(403).json({ error: 'Invalid or expired token' });
            }

            // Attach user info to request
            req.user = {
                id: decoded.sub, // Supabase user ID (UUID)
                email: decoded.email,
                role: decoded.role
            };

            next();
        };
    }

    // ==================== DATABASE METHODS ====================

    /**
     * Get user profile by ID
     */
    async getUserProfile(userId) {
        if (!this.enabled) throw new Error('Supabase not enabled');

        const { data, error } = await this.supabase
            .from('user_profiles')
            .select('*')
            .eq('id', userId)
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Create a new gift
     */
    async createGift(giftData) {
        if (!this.enabled) throw new Error('Supabase not enabled');

        const { data, error } = await this.supabase
            .from('gifts')
            .insert({
                sender_id: giftData.sender_id,
                recipient_phone: giftData.recipient_phone,
                recipient_name: giftData.recipient_name,
                gift_type: giftData.gift_type,
                gift_value: giftData.gift_value,
                gift_card_brand: giftData.gift_card_brand,
                custom_message: giftData.custom_message,
                status: 'active',
                unlock_status: 'locked'
            })
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Create a challenge for a gift
     */
    async createChallenge(challengeData) {
        if (!this.enabled) throw new Error('Supabase not enabled');

        const { data, error } = await this.supabase
            .from('challenges')
            .insert({
                gift_id: challengeData.gift_id,
                challenge_type: challengeData.challenge_type,
                description: challengeData.description,
                total_steps: challengeData.total_steps || 1,
                current_step: 0,
                keyword: challengeData.keyword,
                submissions: []
            })
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Get gifts for a user
     */
    async getUserGifts(userId) {
        if (!this.enabled) throw new Error('Supabase not enabled');

        const { data, error } = await this.supabase
            .from('gifts')
            .select(`
                *,
                challenges (*)
            `)
            .eq('sender_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        return data;
    }

    /**
     * Update challenge progress
     */
    async updateChallengeProgress(challengeId, currentStep, submissions = null) {
        if (!this.enabled) throw new Error('Supabase not enabled');

        const updateData = { current_step: currentStep };

        if (submissions) {
            updateData.submissions = submissions;
        }

        const { data, error } = await this.supabase
            .from('challenges')
            .update(updateData)
            .eq('id', challengeId)
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Get challenge by ID
     */
    async getChallenge(challengeId) {
        if (!this.enabled) throw new Error('Supabase not enabled');

        const { data, error } = await this.supabase
            .from('challenges')
            .select('*, gifts (*)')
            .eq('id', challengeId)
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Unlock a gift (mark as completed)
     */
    async unlockGift(giftId) {
        if (!this.enabled) throw new Error('Supabase not enabled');

        const { data, error } = await this.supabase
            .from('gifts')
            .update({
                unlock_status: 'unlocked',
                unlocked_at: new Date().toISOString()
            })
            .eq('id', giftId)
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Update or create recipient tracking
     */
    async upsertRecipient(phone, name, activeGiftId = null) {
        if (!this.enabled) throw new Error('Supabase not enabled');

        // First, try to get existing recipient
        const { data: existing } = await this.supabase
            .from('recipients')
            .select('*')
            .eq('phone', phone)
            .single();

        if (existing && activeGiftId) {
            // Add gift to active_gifts array
            const activeGifts = existing.active_gifts || [];
            if (!activeGifts.includes(activeGiftId)) {
                activeGifts.push(activeGiftId);
            }

            const { data, error } = await this.supabase
                .from('recipients')
                .update({
                    active_gifts: activeGifts,
                    last_message_at: new Date().toISOString()
                })
                .eq('phone', phone)
                .select()
                .single();

            if (error) throw error;
            return data;
        } else {
            // Create new recipient
            const { data, error } = await this.supabase
                .from('recipients')
                .insert({
                    phone,
                    name,
                    active_gifts: activeGiftId ? [activeGiftId] : [],
                    last_message_at: new Date().toISOString()
                })
                .select()
                .single();

            if (error) throw error;
            return data;
        }
    }

    /**
     * Get recipient by phone
     */
    async getRecipient(phone) {
        if (!this.enabled) throw new Error('Supabase not enabled');

        const { data, error } = await this.supabase
            .from('recipients')
            .select('*')
            .eq('phone', phone)
            .single();

        if (error && error.code !== 'PGRST116') { // Not found error
            throw error;
        }

        return data;
    }
}

// Export singleton instance
module.exports = new SupabaseService();
