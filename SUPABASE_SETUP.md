# Supabase Hybrid Setup Guide

## Architecture Overview

**Hybrid Approach:**
- **Supabase**: Authentication, User/Gift data storage (PostgreSQL)
- **Node.js Backend**: Gift/Challenge business logic, Twilio SMS integration
- **iOS App**: Supabase Swift SDK for auth, HTTP calls to Node.js for operations

## Step 1: Create Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Sign up / Log in
3. Click **"New Project"**
4. Fill in:
   - **Name**: `honey-badger-gifts`
   - **Database Password**: (save this!)
   - **Region**: Choose closest to you
   - **Pricing Plan**: Free tier is fine to start
5. Wait ~2 minutes for project to initialize

## Step 2: Get Your Credentials

Once the project is ready:

1. Go to **Project Settings** (gear icon, bottom left)
2. Click **API** in the sidebar
3. Copy these values (you'll need them):
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon/public key**: `eyJhbGc...` (long JWT token)
   - **service_role key**: `eyJhbGc...` (for backend only - KEEP SECRET!)

## Step 3: Update Environment Variables

### For iOS App

You'll add these to Xcode in the next step:
```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
```

### For Node.js Backend

Add to your `.env` file:
```bash
# Supabase Configuration
SUPABASE_URL=https://xtrrvtveycmezbzpaaxk.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_a0Wu7mG0c1vWhQ0JG7XQFw_Z7uUrpw9
SUPABASE_JWT_SECRET=WZw17wTCJJ0f4yhrhdk4Xm6JjkfZ7+0n1Wl4ezs9gE2d9jy/z6lu2n2PN3hll769rbRLPxwYEHzTQt36CX1sQg==

# Keep existing Twilio vars
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
```

**To get JWT Secret:**
1. In Supabase Dashboard → Project Settings → API
2. Scroll down to **JWT Settings**
3. Copy the **JWT Secret** value

## Step 4: Set Up Database Schema

Run this SQL in Supabase SQL Editor (left sidebar → SQL Editor → New Query):

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (Supabase Auth handles most of this, but we add metadata)
CREATE TABLE public.user_profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Gifts table
CREATE TABLE public.gifts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id UUID REFERENCES public.user_profiles(id) NOT NULL,
  recipient_phone TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  gift_type TEXT NOT NULL,
  gift_value DECIMAL(10, 2),
  gift_card_brand TEXT,
  custom_message TEXT,
  status TEXT DEFAULT 'active',
  unlock_status TEXT DEFAULT 'locked',
  unlocked_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Challenges table
CREATE TABLE public.challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gift_id UUID REFERENCES public.gifts(id) ON DELETE CASCADE NOT NULL,
  challenge_type TEXT NOT NULL,
  description TEXT NOT NULL,
  total_steps INTEGER DEFAULT 1,
  current_step INTEGER DEFAULT 0,
  keyword TEXT,
  submissions JSONB DEFAULT '[]'::jsonb,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Recipients table (for tracking SMS interactions)
CREATE TABLE public.recipients (
  phone TEXT PRIMARY KEY,
  name TEXT,
  active_gifts UUID[] DEFAULT '{}',
  completed_gifts UUID[] DEFAULT '{}',
  last_message_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Row Level Security (RLS) Policies
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipients ENABLE ROW LEVEL SECURITY;

-- Users can read/update their own profile
CREATE POLICY "Users can view own profile"
  ON public.user_profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.user_profiles FOR UPDATE
  USING (auth.uid() = id);

-- Users can create their own profile on signup
CREATE POLICY "Users can insert own profile"
  ON public.user_profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- Users can view gifts they sent
CREATE POLICY "Users can view own gifts"
  ON public.gifts FOR SELECT
  USING (auth.uid() = sender_id);

-- Users can create gifts
CREATE POLICY "Users can create gifts"
  ON public.gifts FOR INSERT
  WITH CHECK (auth.uid() = sender_id);

-- Users can view challenges for their gifts
CREATE POLICY "Users can view own challenges"
  ON public.challenges FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.gifts
      WHERE gifts.id = challenges.gift_id
      AND gifts.sender_id = auth.uid()
    )
  );

-- Service role can access everything (for Node.js backend)
-- Recipients table accessible by service role only
CREATE POLICY "Service role full access to recipients"
  ON public.recipients FOR ALL
  USING (auth.jwt()->>'role' = 'service_role');

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add triggers for updated_at
CREATE TRIGGER update_user_profiles_updated_at BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_gifts_updated_at BEFORE UPDATE ON public.gifts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_challenges_updated_at BEFORE UPDATE ON public.challenges
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_recipients_updated_at BEFORE UPDATE ON public.recipients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

## Step 5: Enable Email Authentication

1. In Supabase Dashboard → **Authentication** → **Providers**
2. Make sure **Email** is enabled (it should be by default)
3. Optional: Configure email templates in **Email Templates** section

## Architecture Flow

```
┌─────────────┐
│   iOS App   │
└──────┬──────┘
       │
       │ 1. Auth (signup/login)
       ▼
┌─────────────────┐
│    Supabase     │
│   (Auth + DB)   │
└──────┬──────────┘
       │
       │ 2. Get JWT token
       │
       ▼
┌─────────────────┐          ┌──────────────┐
│   iOS App       │──────────▶│  Node.js     │
│                 │ 3. API    │  Backend     │
│  (with token)   │   calls   │              │
└─────────────────┘           └──────┬───────┘
                                     │
                                     │ 4. Twilio SMS
                                     ▼
                              ┌──────────────┐
                              │  Recipients  │
                              │   (SMS)      │
                              └──────────────┘
```

## Next Steps

After completing this setup:
1. ✅ Update iOS app with Supabase Swift SDK
2. ✅ Update Node.js backend to verify Supabase JWT tokens
3. ✅ Connect Node.js to Supabase database
4. ✅ Keep Twilio logic in Node.js

## Testing Your Setup

Once complete, you can test:
```bash
# In Supabase SQL Editor, run:
SELECT * FROM public.user_profiles;

# Should return empty table (ready for users!)
```

## Important Notes

- **anon key**: Safe to use in iOS app (public)
- **service_role key**: ONLY use in backend (bypass RLS, full access)
- **JWT Secret**: Used to verify tokens from Supabase auth
- Free tier limits: 50,000 monthly active users, 500MB database, 1GB file storage
