-- Honey Badger AI Gifts Database Schema
-- PostgreSQL Database Setup

-- Create database (run this as superuser)
-- CREATE DATABASE honey_badger_db;
-- \c honey_badger_db;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    phone VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    email_verified BOOLEAN DEFAULT false,
    phone_verified BOOLEAN DEFAULT false
);

-- Create index on email for faster lookups
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);

-- Gifts table
CREATE TABLE gifts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
    recipient_phone VARCHAR(20) NOT NULL,
    recipient_name VARCHAR(255) NOT NULL,
    recipient_email VARCHAR(255),
    gift_type VARCHAR(50) NOT NULL, -- 'giftcard', 'cash', 'photo', 'message', 'item'
    gift_value DECIMAL(10, 2),
    gift_description TEXT,
    gift_details JSONB,
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'notified', 'in_progress', 'completed', 'expired', 'cancelled'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    redemption_code VARCHAR(100),
    redemption_instructions TEXT
);

-- Create indexes for gifts
CREATE INDEX idx_gifts_sender_id ON gifts(sender_id);
CREATE INDEX idx_gifts_recipient_phone ON gifts(recipient_phone);
CREATE INDEX idx_gifts_status ON gifts(status);

-- Challenges table
CREATE TABLE challenges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gift_id UUID REFERENCES gifts(id) ON DELETE CASCADE,
    challenge_type VARCHAR(50) NOT NULL, -- 'photo', 'video', 'task', 'workout', 'multi-day', 'custom'
    challenge_description TEXT NOT NULL,
    challenge_requirements JSONB,
    total_steps INTEGER DEFAULT 1,
    completed_steps INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'active', -- 'active', 'in_progress', 'completed', 'failed', 'expired'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    deadline TIMESTAMP WITH TIME ZONE
);

-- Create index for challenges
CREATE INDEX idx_challenges_gift_id ON challenges(gift_id);
CREATE INDEX idx_challenges_status ON challenges(status);

-- Messages table (for SMS history)
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gift_id UUID REFERENCES gifts(id) ON DELETE CASCADE,
    challenge_id UUID REFERENCES challenges(id) ON DELETE CASCADE,
    sender_phone VARCHAR(20),
    recipient_phone VARCHAR(20) NOT NULL,
    message_type VARCHAR(50), -- 'initial', 'reminder', 'progress', 'completion', 'user_response'
    message_content TEXT NOT NULL,
    twilio_message_sid VARCHAR(100),
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'sent', 'delivered', 'failed', 'read'
    direction VARCHAR(10), -- 'inbound', 'outbound'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    read_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT
);

-- Create indexes for messages
CREATE INDEX idx_messages_gift_id ON messages(gift_id);
CREATE INDEX idx_messages_challenge_id ON messages(challenge_id);
CREATE INDEX idx_messages_recipient_phone ON messages(recipient_phone);
CREATE INDEX idx_messages_twilio_sid ON messages(twilio_message_sid);

-- Challenge progress table (track individual progress entries)
CREATE TABLE challenge_progress (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    challenge_id UUID REFERENCES challenges(id) ON DELETE CASCADE,
    gift_id UUID REFERENCES gifts(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    submission_type VARCHAR(50), -- 'text', 'photo', 'video', 'confirmation'
    submission_data JSONB,
    submission_url TEXT,
    verified BOOLEAN DEFAULT false,
    verified_at TIMESTAMP WITH TIME ZONE,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

-- Create indexes for progress
CREATE INDEX idx_challenge_progress_challenge_id ON challenge_progress(challenge_id);
CREATE INDEX idx_challenge_progress_gift_id ON challenge_progress(gift_id);

-- Media uploads table (for photos/videos)
CREATE TABLE media_uploads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    challenge_progress_id UUID REFERENCES challenge_progress(id) ON DELETE CASCADE,
    gift_id UUID REFERENCES gifts(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_type VARCHAR(100),
    file_size INTEGER,
    file_url TEXT NOT NULL,
    thumbnail_url TEXT,
    uploaded_by_phone VARCHAR(20),
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB
);

-- Create index for media
CREATE INDEX idx_media_uploads_gift_id ON media_uploads(gift_id);
CREATE INDEX idx_media_uploads_progress_id ON media_uploads(challenge_progress_id);

-- Reminder schedules table
CREATE TABLE reminder_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gift_id UUID REFERENCES gifts(id) ON DELETE CASCADE,
    challenge_id UUID REFERENCES challenges(id) ON DELETE CASCADE,
    reminder_frequency VARCHAR(50), -- 'daily', 'every_other_day', 'weekly', 'custom'
    next_reminder_at TIMESTAMP WITH TIME ZONE,
    last_reminder_at TIMESTAMP WITH TIME ZONE,
    total_reminders_sent INTEGER DEFAULT 0,
    max_reminders INTEGER DEFAULT 10,
    is_active BOOLEAN DEFAULT true,
    custom_schedule JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for reminders
CREATE INDEX idx_reminder_schedules_gift_id ON reminder_schedules(gift_id);
CREATE INDEX idx_reminder_schedules_next_reminder ON reminder_schedules(next_reminder_at) WHERE is_active = true;

-- Auth tokens table (for JWT refresh tokens)
CREATE TABLE auth_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    token_type VARCHAR(50) DEFAULT 'refresh', -- 'refresh', 'reset_password', 'verify_email'
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    used_at TIMESTAMP WITH TIME ZONE,
    ip_address INET,
    user_agent TEXT
);

-- Create indexes for auth tokens
CREATE INDEX idx_auth_tokens_user_id ON auth_tokens(user_id);
CREATE INDEX idx_auth_tokens_token_hash ON auth_tokens(token_hash);
CREATE INDEX idx_auth_tokens_expires ON auth_tokens(expires_at);

-- Gift templates table (for common gift types)
CREATE TABLE gift_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    description TEXT,
    default_value DECIMAL(10, 2),
    suggested_challenges JSONB,
    icon_url TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Analytics events table
CREATE TABLE analytics_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(100) NOT NULL,
    event_data JSONB,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    gift_id UUID REFERENCES gifts(id) ON DELETE SET NULL,
    challenge_id UUID REFERENCES challenges(id) ON DELETE SET NULL,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for analytics
CREATE INDEX idx_analytics_events_type ON analytics_events(event_type);
CREATE INDEX idx_analytics_events_user_id ON analytics_events(user_id);
CREATE INDEX idx_analytics_events_created_at ON analytics_events(created_at);

-- Create update trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add update triggers to relevant tables
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_gifts_updated_at BEFORE UPDATE ON gifts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_challenges_updated_at BEFORE UPDATE ON challenges
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_reminder_schedules_updated_at BEFORE UPDATE ON reminder_schedules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_gift_templates_updated_at BEFORE UPDATE ON gift_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Sample gift templates
INSERT INTO gift_templates (name, category, description, default_value, suggested_challenges, icon_url) VALUES
('Starbucks Gift Card', 'giftcard', 'Coffee lover''s favorite', 25.00, 
 '{"challenges": ["Send a morning selfie", "Share your coffee order", "Visit 3 different Starbucks"]}', 
 '/assets/icons/starbucks.png'),
('Amazon Gift Card', 'giftcard', 'Shop for anything', 50.00, 
 '{"challenges": ["Write a thank you note", "Share what you''ll buy", "Send a photo of your purchase"]}', 
 '/assets/icons/amazon.png'),
('Fitness Challenge Reward', 'cash', 'Complete your fitness goals', 100.00, 
 '{"challenges": ["30 days of workouts", "10,000 steps daily", "Healthy meal prep photos"]}', 
 '/assets/icons/fitness.png'),
('Birthday Surprise', 'message', 'Special birthday message', null, 
 '{"challenges": ["Guess the surprise", "Share a childhood photo", "Record a birthday wish"]}', 
 '/assets/icons/birthday.png');

-- Create views for common queries
CREATE VIEW active_gifts AS
SELECT 
    g.*,
    c.challenge_type,
    c.challenge_description,
    c.total_steps,
    c.completed_steps,
    c.status as challenge_status
FROM gifts g
LEFT JOIN challenges c ON g.id = c.gift_id
WHERE g.status NOT IN ('completed', 'expired', 'cancelled');

CREATE VIEW recipient_summary AS
SELECT 
    recipient_phone,
    recipient_name,
    COUNT(*) as total_gifts,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_gifts,
    COUNT(CASE WHEN status IN ('pending', 'notified', 'in_progress') THEN 1 END) as active_gifts,
    MAX(created_at) as last_gift_date
FROM gifts
GROUP BY recipient_phone, recipient_name;

-- Grant permissions (adjust based on your database user)
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_app_user;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO your_app_user;
-- GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO your_app_user;