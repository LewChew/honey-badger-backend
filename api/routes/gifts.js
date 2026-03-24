const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');
const sendGridService = require('../../services/sendGridService');
const db = require('../../services/databaseService');
const aiMessage = require('../../services/aiMessageService');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// Initialize Twilio client (conditional)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_ACCOUNT_SID.startsWith('AC')) {
  try {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    console.log('✅ Twilio client initialized in gift routes');
  } catch (error) {
    console.error('❌ Failed to initialize Twilio client:', error.message);
  }
} else {
  console.log('ℹ️  Twilio not configured - SMS delivery will be disabled');
}

// Helper to send SMS/MMS with opt-out check
// Pass mediaUrl to send an MMS with an image
async function sendSmsWithOptOutCheck(to, body, mediaUrl) {
  if (!twilioClient) return null;
  try {
    const isOptedOut = await db.isPhoneOptedOut(to);
    if (isOptedOut) {
      console.log(`⛔ SMS blocked: ${to} has opted out`);
      return null;
    }
  } catch (err) {
    console.error('⚠️  Opt-out check failed, sending anyway:', err.message);
  }
  const actualTo = process.env.SMS_TEST_OVERRIDE_TO || to;
  if (process.env.SMS_TEST_OVERRIDE_TO) {
    console.log(`📱 SMS test mode: redirecting from ${to} → ${actualTo}`);
  }
  const messageParams = {
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: actualTo
  };
  if (mediaUrl) {
    messageParams.mediaUrl = [mediaUrl];
  }
  return twilioClient.messages.create(messageParams);
}

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../../uploads/photos');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('📁 Created uploads/photos directory');
}

/**
 * Create a new gift/challenge combination
 * POST /api/gifts
 */
router.post('/gifts', async (req, res) => {
  try {
    const {
      recipientPhone,
      recipientEmail,
      recipientName,
      senderName,
      giftType,
      giftDetails,
      challengeType,
      challengeDescription,
      challengeRequirements,
      expirationDate,
      reminderFrequency,
      deliveryMethod  // 'sms', 'email', or 'both'
    } = req.body;

    // Validate required fields
    if ((!recipientPhone && !recipientEmail) || !giftType || !challengeType) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields (need at least phone or email)'
      });
    }

    // Generate unique IDs
    const giftId = uuidv4();
    const challengeId = uuidv4();

    // Create gift object for response
    const gift = {
      id: giftId,
      senderName: senderName || 'Someone special',
      recipientName,
      recipientPhone,
      recipientEmail,
      deliveryMethod: deliveryMethod || (recipientEmail && !recipientPhone ? 'email' : 'sms'),
      type: giftType,
      details: giftDetails,
      challengeId,
      status: 'pending',
      createdAt: new Date(),
      expirationDate: expirationDate || null,
      unlocked: false
    };

    // Create challenge in database
    const challenge = {
      id: challengeId,
      giftId,
      type: challengeType,
      description: challengeDescription,
      requirements: challengeRequirements || {},
      progress: {
        started: false,
        completed: false,
        currentStep: 0,
        totalSteps: challengeRequirements?.totalSteps || 1,
        submissions: []
      },
      reminderFrequency: reminderFrequency || 'daily'
    };

    // Store challenge in database
    try {
      await db.createChallenge(challenge);
      console.log('✅ Challenge created in database:', challengeId);
    } catch (dbError) {
      console.error('⚠️ Failed to create challenge in database:', dbError.message);
      // Continue anyway - the gift can still be sent
    }

    // Send initial message
    const initialMessage = await sendInitialMessage(gift, challenge);

    res.status(201).json({
      success: true,
      data: {
        giftId,
        challengeId,
        gift,
        challenge,
        messageSent: initialMessage.success
      }
    });
  } catch (error) {
    console.error('Error creating gift/challenge:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create gift/challenge',
      error: error.message
    });
  }
});

/**
 * Send initial message to recipient
 * POST /api/messages/send-initial
 */
router.post('/messages/send-initial', async (req, res) => {
  try {
    const { giftId } = req.body;

    // Get gift from database
    const giftOrder = await db.getGiftOrderByTrackingId(giftId);
    if (!giftOrder) {
      return res.status(404).json({
        success: false,
        message: 'Gift not found'
      });
    }

    // Convert to gift format expected by sendInitialMessage
    const gift = {
      id: giftOrder.tracking_id,
      senderName: giftOrder.sender_name || 'Someone special',
      recipientName: giftOrder.recipient_name,
      recipientPhone: giftOrder.recipient_phone,
      recipientEmail: giftOrder.recipient_email,
      deliveryMethod: giftOrder.delivery_method || 'email',
      type: giftOrder.gift_type,
      details: {
        value: giftOrder.gift_value,
        description: giftOrder.gift_value,
        personalMessage: giftOrder.personal_note || giftOrder.message
      },
      challengeId: giftOrder.challenge_id
    };

    // Get challenge from database
    const challenge = giftOrder.challenge_id ? await db.getChallengeById(giftOrder.challenge_id) : {
      type: giftOrder.challenge_type || 'custom',
      description: giftOrder.challenge_description || giftOrder.challenge
    };

    const result = await sendInitialMessage(gift, challenge);

    res.json(result);
  } catch (error) {
    console.error('Error sending initial message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: error.message
    });
  }
});

/**
 * Send follow-up/reminder messages
 * POST /api/messages/send-reminder
 */
router.post('/messages/send-reminder', async (req, res) => {
  try {
    const { challengeId, customMessage } = req.body;

    // Get challenge from database
    const challenge = await db.getChallengeById(challengeId);
    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    // Get gift from database
    const giftOrder = await db.getGiftOrderByTrackingId(challenge.gift_id);
    if (!giftOrder) {
      return res.status(404).json({
        success: false,
        message: 'Gift not found'
      });
    }

    const gift = {
      senderName: giftOrder.sender_name || 'Someone special',
      recipientPhone: giftOrder.recipient_phone,
      type: giftOrder.gift_type
    };

    const reminderMessage = customMessage || generateReminderMessage(gift, challenge);

    if (!twilioClient) {
      return res.status(503).json({
        success: false,
        message: 'SMS service not configured'
      });
    }

    const message = await sendSmsWithOptOutCheck(gift.recipientPhone, reminderMessage);

    // Update last reminder sent in database
    await db.updateChallengeReminderSent(challengeId);

    res.json({
      success: true,
      data: {
        messageId: message ? message.sid : null,
        messageSent: reminderMessage,
        sentAt: new Date()
      }
    });
  } catch (error) {
    console.error('Error sending reminder:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send reminder',
      error: error.message
    });
  }
});

/**
 * Sender-initiated gift unlock
 * POST /api/gifts/:giftId/unlock
 */
router.post('/gifts/:giftId/unlock', async (req, res) => {
  try {
    const { giftId } = req.params;

    // Inline JWT auth
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'Authorization required' });
    }
    const jwt = require('jsonwebtoken');
    const token = authHeader.split(' ')[1];
    const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch (jwtError) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }

    // Fetch gift and verify sender ownership
    const giftOrder = await db.getGiftOrderByTrackingId(giftId);
    if (!giftOrder) {
      return res.status(404).json({ success: false, message: 'Gift not found' });
    }
    if (String(giftOrder.user_id) !== String(userId)) {
      return res.status(403).json({ success: false, message: 'You can only unlock gifts you sent' });
    }
    if (giftOrder.unlocked === 1) {
      return res.status(400).json({ success: false, message: 'Gift is already unlocked' });
    }

    // Unlock the gift
    await db.unlockGiftOrder(giftId);

    // Notify recipient via SMS
    if (giftOrder.recipient_phone) {
      const senderName = giftOrder.sender_name || 'Someone special';
      const unlockMessage = `🦡 Great news! ${senderName} has unlocked your gift! Open the Honey Badger app to claim it now.`;
      await sendSmsWithOptOutCheck(giftOrder.recipient_phone, unlockMessage);
    }

    res.json({
      success: true,
      data: {
        giftId,
        status: 'completed',
        unlocked: true,
        unlockedAt: new Date()
      }
    });
  } catch (error) {
    console.error('Error unlocking gift:', error);
    res.status(500).json({ success: false, message: 'Failed to unlock gift', error: error.message });
  }
});

/**
 * Recipient self-unlock a gift
 * POST /api/gifts/:giftId/recipient-unlock
 */
router.post('/gifts/:giftId/recipient-unlock', async (req, res) => {
  try {
    const { giftId } = req.params;

    // Inline JWT auth
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'Authorization required' });
    }
    const jwt = require('jsonwebtoken');
    const token = authHeader.split(' ')[1];
    const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch (jwtError) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }

    // Fetch gift
    const giftOrder = await db.getGiftOrderByTrackingId(giftId);
    if (!giftOrder) {
      return res.status(404).json({ success: false, message: 'Gift not found' });
    }
    if (giftOrder.unlocked === 1) {
      return res.status(400).json({ success: false, message: 'Gift is already unlocked' });
    }

    // Verify recipient ownership — match user email/phone to gift recipient
    const user = await db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isRecipient = (user.email && giftOrder.recipient_email && user.email.toLowerCase() === giftOrder.recipient_email.toLowerCase()) ||
                        (user.phone && giftOrder.recipient_phone && user.phone === giftOrder.recipient_phone);
    if (!isRecipient) {
      return res.status(403).json({ success: false, message: 'Only the gift recipient can unlock this gift' });
    }

    // Verify the sender's challenge has been completed before allowing unlock
    const challenge = giftOrder.challenge_id ? await db.getChallengeById(giftOrder.challenge_id) : null;
    const challengeType = (challenge && challenge.type) || giftOrder.challenge_type;

    if (challengeType) {
      const isPhotoChallenge = challengeType === 'photo' || challengeType === 'video';

      if (isPhotoChallenge) {
        // Photo/video challenges require sender approval — check for an approved submission
        const submissions = await db.getPhotoSubmissionsByGiftId(giftId);
        const hasApproved = submissions && submissions.some(s => s.status === 'approved');
        if (!hasApproved) {
          const hasPending = submissions && submissions.some(s => s.status === 'pending_approval');
          if (hasPending) {
            return res.status(403).json({ success: false, message: 'Your photo submission is awaiting sender approval. You\'ll be notified once it\'s reviewed!' });
          }
          return res.status(403).json({ success: false, message: 'You must complete the challenge before unlocking this gift. Submit a photo to get started!' });
        }
      } else {
        // Non-photo challenges require progress completion
        if (challenge && challenge.progress) {
          if (!challenge.progress.completed && challenge.progress.currentStep < challenge.progress.totalSteps) {
            return res.status(403).json({ success: false, message: 'You must complete the challenge before unlocking this gift.' });
          }
        }
      }
    }

    // Challenge verified — unlock the gift
    await db.unlockGiftOrder(giftId);

    // Notify sender via SMS or email
    const senderName = giftOrder.sender_name || 'Someone';
    const recipientName = giftOrder.recipient_name || 'The recipient';

    res.json({
      success: true,
      data: {
        giftId,
        status: 'completed',
        unlocked: true,
        unlockedAt: new Date()
      }
    });
  } catch (error) {
    console.error('Error recipient-unlocking gift:', error);
    res.status(500).json({ success: false, message: 'Failed to unlock gift', error: error.message });
  }
});

/**
 * Collect/redeem an unlocked gift
 * POST /api/gifts/:giftId/collect
 */
router.post('/gifts/:giftId/collect', async (req, res) => {
  try {
    const { giftId } = req.params;

    // Inline JWT auth
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'Authorization required' });
    }
    const jwt = require('jsonwebtoken');
    const token = authHeader.split(' ')[1];
    const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch (jwtError) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }

    // Fetch gift
    const giftOrder = await db.getGiftOrderByTrackingId(giftId);
    if (!giftOrder) {
      return res.status(404).json({ success: false, message: 'Gift not found' });
    }

    // Must be unlocked first
    if (giftOrder.unlocked !== 1) {
      return res.status(400).json({ success: false, message: 'Gift must be unlocked before it can be collected' });
    }

    // Already redeemed
    if (giftOrder.redeemed === 1) {
      return res.status(400).json({ success: false, message: 'Gift has already been collected' });
    }

    // Verify recipient ownership
    const user = await db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isRecipient = (user.email && giftOrder.recipient_email && user.email.toLowerCase() === giftOrder.recipient_email.toLowerCase()) ||
                        (user.phone && giftOrder.recipient_phone && user.phone === giftOrder.recipient_phone);
    if (!isRecipient) {
      return res.status(403).json({ success: false, message: 'Only the gift recipient can collect this gift' });
    }

    // Redeem the gift
    await db.redeemGiftOrder(giftId);

    res.json({
      success: true,
      data: {
        giftId,
        redeemed: true,
        redeemedAt: new Date()
      }
    });
  } catch (error) {
    console.error('Error collecting gift:', error);
    res.status(500).json({ success: false, message: 'Failed to collect gift', error: error.message });
  }
});

/**
 * Send nudge message to recipient
 * POST /api/gifts/:giftId/nudge
 */
router.post('/gifts/:giftId/nudge', async (req, res) => {
  try {
    const { giftId } = req.params;
    const { customMessage } = req.body;

    // Inline JWT auth
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'Authorization required' });
    }
    const jwt = require('jsonwebtoken');
    const token = authHeader.split(' ')[1];
    const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch (jwtError) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }

    // Fetch gift and verify sender ownership
    const giftOrder = await db.getGiftOrderByTrackingId(giftId);
    if (!giftOrder) {
      return res.status(404).json({ success: false, message: 'Gift not found' });
    }
    if (String(giftOrder.user_id) !== String(userId)) {
      return res.status(403).json({ success: false, message: 'You can only nudge gifts you sent' });
    }
    if (giftOrder.unlocked === 1) {
      return res.status(400).json({ success: false, message: 'Gift is already unlocked — no nudge needed' });
    }
    if (!giftOrder.recipient_phone) {
      return res.status(400).json({ success: false, message: 'No recipient phone number on this gift' });
    }

    // Build the nudge message
    let nudgeMessage;
    const senderName = giftOrder.sender_name || 'Someone special';

    if (customMessage) {
      nudgeMessage = `🦡 Message from ${senderName}: "${customMessage}" — Open Honey Badger to complete your challenge and claim your gift!`;
    } else {
      // Use AI-powered nudge message
      const challenge = giftOrder.challenge_id ? await db.getChallengeById(giftOrder.challenge_id) : null;
      if (challenge && challenge.progress) {
        const gift = {
          senderName,
          recipientPhone: giftOrder.recipient_phone,
          type: giftOrder.gift_type
        };
        nudgeMessage = await generateReminderMessage(gift, challenge);
      } else {
        nudgeMessage = await aiMessage.generateNudgeMessage(senderName, challenge);
      }
    }

    if (!twilioClient) {
      return res.status(503).json({ success: false, message: 'SMS service not configured' });
    }

    const message = await sendSmsWithOptOutCheck(giftOrder.recipient_phone, nudgeMessage);

    // Update last reminder sent if we have a challenge
    if (giftOrder.challenge_id) {
      await db.updateChallengeReminderSent(giftOrder.challenge_id);
    }

    res.json({
      success: true,
      data: {
        messageId: message ? message.sid : null,
        messageSent: nudgeMessage,
        sentAt: new Date()
      }
    });
  } catch (error) {
    console.error('Error sending nudge:', error);
    res.status(500).json({ success: false, message: 'Failed to send nudge', error: error.message });
  }
});

/**
 * Track challenge progress
 * GET /api/challenges/:challengeId/progress
 */
router.get('/challenges/:challengeId/progress', async (req, res) => {
  try {
    const { challengeId } = req.params;

    // Get challenge from database
    const challenge = await db.getChallengeById(challengeId);
    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    // Get gift from database
    const giftOrder = await db.getGiftOrderByTrackingId(challenge.gift_id);

    res.json({
      success: true,
      data: {
        challengeId,
        giftId: challenge.gift_id,
        type: challenge.type,
        description: challenge.description,
        progress: challenge.progress,
        giftStatus: giftOrder ? giftOrder.status : 'unknown',
        unlocked: giftOrder ? giftOrder.unlocked : false,
        percentComplete: (challenge.progress.currentStep / challenge.progress.totalSteps) * 100
      }
    });
  } catch (error) {
    console.error('Error getting progress:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get progress',
      error: error.message
    });
  }
});

/**
 * Update challenge progress
 * PUT /api/challenges/:challengeId/progress
 */
router.put('/challenges/:challengeId/progress', async (req, res) => {
  try {
    // Inline JWT auth
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'Authorization required' });
    }
    const jwt = require('jsonwebtoken');
    const token = authHeader.split(' ')[1];
    const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
    try {
      jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }

    const { challengeId } = req.params;
    const { stepCompleted, submission, metadata } = req.body;

    // Get challenge from database
    const challenge = await db.getChallengeById(challengeId);
    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    // Update progress
    if (!challenge.progress.started) {
      challenge.progress.started = true;
    }

    if (stepCompleted) {
      challenge.progress.currentStep = Math.min(
        challenge.progress.currentStep + 1,
        challenge.progress.totalSteps
      );
    }

    // Add submission record
    if (submission) {
      challenge.progress.submissions.push({
        timestamp: new Date(),
        type: submission.type,
        data: submission.data,
        metadata: metadata || {}
      });
    }

    // Mark completed if steps met, but do NOT unlock the gift here.
    // Gift unlock only happens via sender approval (submissions/:id/review)
    // or sender force-unlock (gifts/:id/unlock).
    if (challenge.progress.currentStep >= challenge.progress.totalSteps) {
      challenge.progress.completed = true;
    }

    // Update challenge progress in database
    await db.updateChallengeProgress(challengeId, challenge.progress);

    res.json({
      success: true,
      data: {
        challengeId,
        progress: challenge.progress,
        completed: challenge.progress.completed,
        giftUnlocked: false
      }
    });
  } catch (error) {
    console.error('Error updating progress:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update progress',
      error: error.message
    });
  }
});

/**
 * Process recipient responses (webhook for Twilio incoming messages)
 * POST /api/webhooks/twilio/incoming
 */
router.post('/webhooks/twilio/incoming', async (req, res) => {
  try {
    const { From, Body, NumMedia, MediaUrl0, MediaContentType0 } = req.body;

    console.log('📱 Received message from:', From);
    console.log('   Message body:', Body);
    console.log('   Media count:', NumMedia);

    if (!twilioClient) {
      console.error('❌ Twilio client not configured');
      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }

    // Handle opt-out/opt-in keywords before anything else
    const lowerBody = (Body || '').toLowerCase().trim();
    if (lowerBody === 'stop' || lowerBody === 'unsubscribe') {
      await db.addSmsOptOut(From);
      console.log(`✅ Phone ${From} opted out of SMS`);
      // Send final confirmation (bypass opt-out check)
      await twilioClient.messages.create({
        body: "You've been unsubscribed from Honey Badger messages. We'll miss you! 🍯\n\nReply START to resubscribe.",
        from: process.env.TWILIO_PHONE_NUMBER,
        to: From
      });
      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }

    if (lowerBody === 'start' || lowerBody === 'yes' || lowerBody === 'unstop') {
      await db.removeSmsOptOut(From);
      console.log(`✅ Phone ${From} re-subscribed to SMS`);

      // Look up active gifts for this recipient to build a deep link
      const activeGifts = await db.getActiveGiftsByRecipientPhone(From);
      const baseUrl = process.env.BASE_URL || 'https://honeybadgerapp.com';
      const badgerImageUrl = `${baseUrl}/images/honey-badger.png`;

      let messageBody;
      if (activeGifts && activeGifts.length > 0) {
        const gift = activeGifts[0];
        const giftLink = `https://honeybadgerapp.com/g/${gift.tracking_id}`;
        const senderName = gift.sender_name || 'Someone special';
        messageBody = `🦡 LET'S GO! The Honey Badger is fired up!\n\n` +
          `${senderName} sent you a gift — complete your challenge to unlock it!\n\n` +
          `👉 Open your gift: ${giftLink}\n\n` +
          `Don't have the app? Download it and tap the link above to get started!\n\n` +
          `Reply STOP at any time to opt out.`;
      } else {
        messageBody = `🦡 Welcome back! You've been re-subscribed to Honey Badger messages.\n\n` +
          `You'll receive notifications about your gift challenges.\n\n` +
          `Reply STOP at any time to opt out.`;
      }

      await sendSmsWithOptOutCheck(From, messageBody, badgerImageUrl);
      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }

    if (lowerBody === 'help') {
      await sendSmsWithOptOutCheck(From, "🍯 HONEY BADGER HELP 🍯\n\nAvailable commands:\nSTATUS - Check progress\nSTART - Re-subscribe to messages\nHELP - Show this message\nSTOP - Unsubscribe\n\nQuestions? Visit https://badgerbot.net");
      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }

    // Find active gifts for this recipient from database
    const activeGifts = await db.getActiveGiftsByRecipientPhone(From);

    if (!activeGifts || activeGifts.length === 0) {
      // No active challenges for this number
      await sendSmsWithOptOutCheck(From, "🦡 Hi! You don't have any active challenges right now. Ask your friend to send you a Honey Badger gift!");

      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }

    // Process the response based on active challenges
    let responseMessage = '';
    let lastChallenge = null;

    for (const giftOrder of activeGifts) {
      // Get challenge from database
      let challenge = giftOrder.challenge_id ? await db.getChallengeById(giftOrder.challenge_id) : null;

      // Create challenge object if it doesn't exist
      if (!challenge) {
        challenge = {
          id: uuidv4(),
          type: giftOrder.challenge_type || 'photo',
          description: giftOrder.challenge_description || giftOrder.challenge,
          progress: { started: false, completed: false, currentStep: 0, totalSteps: 1, submissions: [] }
        };
      }

      lastChallenge = challenge;

      // Check if response matches challenge requirements (photo challenges need media)
      const hasPhoto = parseInt(NumMedia) > 0;
      const validResponse = await validateResponse(challenge, Body, NumMedia, MediaUrl0);

      if (validResponse) {
        // Handle photo submission with approval workflow
        if (hasPhoto && (challenge.type === 'photo' || challenge.type === 'video')) {
          // Download the photo from Twilio
          const photoUrl = await downloadTwilioMedia(MediaUrl0, giftOrder.tracking_id);

          // Create photo submission record with pending_approval status
          const submissionId = uuidv4();
          await db.createPhotoSubmission({
            id: submissionId,
            challengeId: challenge.id || giftOrder.challenge_id,
            giftId: giftOrder.tracking_id,
            photoUrl: photoUrl,
            submitterPhone: From,
            status: 'pending_approval'
          });

          // Update gift status to pending_approval
          await db.updateGiftOrderStatus(giftOrder.tracking_id, 'pending_approval');

          // Notify the sender
          if (giftOrder.sender_phone) {
            try {
              await sendSmsWithOptOutCheck(giftOrder.sender_phone, `🦡 ${giftOrder.recipient_name || 'Your gift recipient'} just submitted a photo for their challenge! Open the Honey Badger app to review and approve it.`);
            } catch (smsError) {
              console.error('Failed to notify sender via SMS:', smsError.message);
            }
          }

          // Send email notification to sender
          if (giftOrder.sender_email) {
            try {
              await sendGridService.sendApprovalNotificationEmail(giftOrder.sender_email, {
                recipientName: giftOrder.recipient_name,
                photoUrl: photoUrl,
                giftType: giftOrder.gift_type,
                challengeDescription: challenge.description
              });
            } catch (emailError) {
              console.error('Failed to notify sender via email:', emailError.message);
            }
          }

          responseMessage = "🦡 Photo received! Your submission has been sent to the gift sender for approval. You'll be notified once it's reviewed!";
          break;
        } else {
          // Non-photo challenge - direct completion
          challenge.progress.currentStep++;
          challenge.progress.submissions.push({
            timestamp: new Date(),
            type: hasPhoto ? 'media' : 'text',
            data: { body: Body, mediaUrl: MediaUrl0, mediaType: MediaContentType0 }
          });

          if (challenge.progress.currentStep >= challenge.progress.totalSteps) {
            // Challenge completed!
            challenge.progress.completed = true;
            await db.unlockGiftOrder(giftOrder.tracking_id);

            const gift = {
              senderName: giftOrder.sender_name || 'Someone special',
              recipientPhone: giftOrder.recipient_phone,
              type: giftOrder.gift_type,
              details: { redemptionInstructions: giftOrder.personal_note || giftOrder.message }
            };
            responseMessage = await getCompletionMessage(gift, challenge);
          } else {
            const gift = { type: giftOrder.gift_type };
            responseMessage = await getProgressMessage(gift, challenge);
          }

          // Update challenge progress in database
          if (challenge.id && giftOrder.challenge_id) {
            await db.updateChallengeProgress(challenge.id, challenge.progress);
          }
          break;
        }
      }
    }

    if (!responseMessage) {
      responseMessage = await aiMessage.generateInvalidResponseMessage(lastChallenge);
    }

    // Send response
    await sendSmsWithOptOutCheck(From, responseMessage);

    res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (error) {
    console.error('Error processing incoming message:', error);
    res.status(500).send('Error processing message');
  }
});

/**
 * Download media from Twilio and save locally
 */
async function downloadTwilioMedia(mediaUrl, giftId) {
  return new Promise((resolve, reject) => {
    const filename = `photo-${giftId}-${Date.now()}.jpg`;
    const filepath = path.join(uploadsDir, filename);
    const file = fs.createWriteStream(filepath);

    // Twilio media URLs require auth
    const authString = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    const options = {
      headers: {
        'Authorization': `Basic ${authString}`
      }
    };

    const protocol = mediaUrl.startsWith('https') ? https : http;

    protocol.get(mediaUrl, options, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        return downloadTwilioMedia(response.headers.location, giftId)
          .then(resolve)
          .catch(reject);
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        // Return relative URL for serving
        const publicUrl = `/uploads/photos/${filename}`;
        console.log('✅ Downloaded photo to:', filepath);
        resolve(publicUrl);
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {}); // Delete incomplete file
      console.error('❌ Failed to download media:', err.message);
      reject(err);
    });
  });
}

/**
 * Get all gifts for a recipient
 * GET /api/recipients/:phone/gifts
 * Requires authentication - user's phone must match the requested phone
 */
router.get('/recipients/:phone/gifts', async (req, res) => {
  try {
    const { phone } = req.params;

    // Require authentication
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Authorization required'
      });
    }

    // Extract and verify JWT
    const jwt = require('jsonwebtoken');
    const token = authHeader.split(' ')[1];
    const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch (jwtError) {
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired token'
      });
    }

    // Get the authenticated user to verify phone ownership
    const user = await db.getUserById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify the user's phone matches the requested phone (normalize for comparison)
    const normalizePhone = (p) => p ? p.replace(/[^0-9+]/g, '') : '';
    const userPhone = normalizePhone(user.phone);
    const requestedPhone = normalizePhone(phone);

    if (!userPhone || userPhone !== requestedPhone) {
      return res.status(403).json({
        success: false,
        message: 'You can only access gifts for your own phone number'
      });
    }

    // Get active and completed gifts from database
    const activeGifts = await db.getActiveGiftsByRecipientPhone(phone);

    // Get completed gifts
    const sql = `
      SELECT g.*, u.name as sender_name, u.email as sender_email
      FROM gift_orders g
      LEFT JOIN users u ON g.user_id = u.id
      WHERE g.recipient_phone = ? AND g.status = 'completed'
      ORDER BY g.created_at DESC
    `;

    const completedGifts = await new Promise((resolve, reject) => {
      db.db.all(sql, [phone], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    res.json({
      success: true,
      data: {
        recipient: {
          phone: phone,
          name: activeGifts.length > 0 ? activeGifts[0].recipient_name : null
        },
        activeGifts: activeGifts.map(formatGiftForResponse),
        completedGifts: completedGifts.map(formatGiftForResponse),
        stats: {
          totalActive: activeGifts.length,
          totalCompleted: completedGifts.length
        }
      }
    });
  } catch (error) {
    console.error('Error getting recipient gifts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get recipient gifts',
      error: error.message
    });
  }
});

/**
 * Submit a photo for a challenge
 * POST /api/challenges/:id/submit-photo
 */
router.post('/challenges/:id/submit-photo', async (req, res) => {
  try {
    const { id: challengeId } = req.params;
    const { photoUrl, submitterPhone } = req.body;

    if (!photoUrl) {
      return res.status(400).json({
        success: false,
        message: 'Photo URL is required'
      });
    }

    // Get challenge from database
    const challenge = await db.getChallengeById(challengeId);
    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    // Get gift order
    const giftOrder = await db.getGiftOrderByTrackingId(challenge.gift_id);
    if (!giftOrder) {
      return res.status(404).json({
        success: false,
        message: 'Gift not found'
      });
    }

    // Create photo submission
    const submissionId = uuidv4();
    await db.createPhotoSubmission({
      id: submissionId,
      challengeId,
      giftId: challenge.gift_id,
      photoUrl,
      submitterPhone,
      status: 'pending_approval'
    });

    // Update gift status
    await db.updateGiftOrderStatus(challenge.gift_id, 'pending_approval');

    res.status(201).json({
      success: true,
      data: {
        submissionId,
        status: 'pending_approval',
        message: 'Photo submitted for approval'
      }
    });
  } catch (error) {
    console.error('Error submitting photo:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit photo',
      error: error.message
    });
  }
});

/**
 * Review (approve/reject) a photo submission
 * PUT /api/submissions/:id/review
 */
router.put('/submissions/:id/review', async (req, res) => {
  try {
    // Inline JWT auth
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'Authorization required' });
    }
    const jwt = require('jsonwebtoken');
    const token = authHeader.split(' ')[1];
    const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch (jwtError) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }

    const { id: submissionId } = req.params;
    const { action, rejectionReason } = req.body;

    if (!action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        message: 'Action must be "approve" or "reject"'
      });
    }

    // Get submission from database
    const submission = await db.getPhotoSubmissionById(submissionId);
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Get gift order for notifications and ownership check
    const giftOrder = await db.getGiftOrderByTrackingId(submission.gift_id);

    // Verify sender ownership — only the gift sender can approve/reject
    if (!giftOrder || String(giftOrder.user_id) !== String(userId)) {
      return res.status(403).json({
        success: false,
        message: 'Only the gift sender can review submissions'
      });
    }

    if (action === 'approve') {
      // Update submission status
      await db.updatePhotoSubmissionStatus(submissionId, 'approved');

      // Unlock the gift
      await db.unlockGiftOrder(submission.gift_id, submission.photo_url);

      // Notify recipient
      if (giftOrder && giftOrder.recipient_phone) {
        try {
          await sendSmsWithOptOutCheck(giftOrder.recipient_phone, `🎉 CONGRATULATIONS! 🎉\n\nYour photo has been approved! Your ${giftOrder.gift_type} gift is now unlocked!\n\n${giftOrder.personal_note || giftOrder.message || 'Enjoy your gift!'}`);
        } catch (smsError) {
          console.error('Failed to notify recipient:', smsError.message);
        }
      }

      // Send completion email
      if (giftOrder && giftOrder.recipient_email) {
        try {
          await sendGridService.sendCompletionEmail(giftOrder.recipient_email, {
            recipientName: giftOrder.recipient_name,
            giftType: giftOrder.gift_type,
            giftValue: giftOrder.gift_value,
            senderName: giftOrder.sender_name,
            giftId: giftOrder.tracking_id
          });
        } catch (emailError) {
          console.error('Failed to send completion email:', emailError.message);
        }
      }

      res.json({
        success: true,
        message: 'Photo approved and gift unlocked',
        data: { status: 'approved', giftUnlocked: true }
      });
    } else {
      // Reject submission
      await db.updatePhotoSubmissionStatus(submissionId, 'rejected', rejectionReason);

      // Update gift status back to pending
      await db.updateGiftOrderStatus(submission.gift_id, 'pending');

      // Notify recipient
      if (giftOrder && giftOrder.recipient_phone) {
        try {
          const reason = rejectionReason ? `Reason: ${rejectionReason}` : 'Please try submitting a new photo.';
          await sendSmsWithOptOutCheck(giftOrder.recipient_phone, `🦡 Your photo submission wasn't approved this time. ${reason}\n\nDon't give up! Send another photo to complete your challenge!`);
        } catch (smsError) {
          console.error('Failed to notify recipient:', smsError.message);
        }
      }

      res.json({
        success: true,
        message: 'Photo submission rejected',
        data: { status: 'rejected', rejectionReason }
      });
    }
  } catch (error) {
    console.error('Error reviewing submission:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to review submission',
      error: error.message
    });
  }
});

/**
 * Get pending approvals for the authenticated sender
 * GET /api/my-pending-approvals
 * Requires auth token - user ID extracted from token
 */
router.get('/my-pending-approvals', async (req, res) => {
  try {
    // Get user ID from auth token (passed by server.js middleware)
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Authorization required'
      });
    }

    // Extract and verify JWT
    const jwt = require('jsonwebtoken');
    const token = authHeader.split(' ')[1];
    const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch (jwtError) {
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired token'
      });
    }

    // Get pending approvals from database
    const pendingApprovals = await db.getPendingApprovalsBySenderId(userId);

    // Format response
    const formattedApprovals = pendingApprovals.map(approval => ({
      submissionId: approval.id,
      photoUrl: approval.photo_url,
      submittedAt: approval.submitted_at,
      recipientName: approval.recipient_name,
      recipientPhone: approval.recipient_phone,
      recipientEmail: approval.recipient_email,
      giftType: approval.gift_type,
      giftValue: approval.gift_value,
      giftId: approval.tracking_id,
      challengeDescription: approval.challenge_description
    }));

    res.json({
      success: true,
      pendingApprovals: formattedApprovals,
      count: formattedApprovals.length
    });
  } catch (error) {
    console.error('Error getting pending approvals:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get pending approvals',
      error: error.message
    });
  }
});

/**
 * Upload a photo for a challenge submission
 * POST /api/challenges/:id/upload-photo
 * Multipart form data with 'photo' field
 */
const upload = require('../../config/multerConfig');

router.post('/challenges/:id/upload-photo', upload.single('photo'), async (req, res) => {
  try {
    const { id: challengeId } = req.params;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No photo file provided'
      });
    }

    // Get challenge from database
    const challenge = await db.getChallengeById(challengeId);
    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    // Get gift order
    const giftOrder = await db.getGiftOrderByTrackingId(challenge.gift_id);
    if (!giftOrder) {
      return res.status(404).json({
        success: false,
        message: 'Gift not found'
      });
    }

    // Create photo URL
    const photoUrl = `/uploads/photos/${req.file.filename}`;

    // Create photo submission
    const submissionId = uuidv4();
    await db.createPhotoSubmission({
      id: submissionId,
      challengeId,
      giftId: challenge.gift_id,
      photoUrl,
      submitterPhone: req.body.submitterPhone || null,
      status: 'pending_approval'
    });

    // Update gift status
    await db.updateGiftOrderStatus(challenge.gift_id, 'pending_approval');

    // Notify sender
    if (giftOrder.sender_email) {
      await sendGridService.sendApprovalNotificationEmail(giftOrder.sender_email, {
        recipientName: giftOrder.recipient_name,
        photoUrl: photoUrl,
        giftType: giftOrder.gift_type,
        challengeDescription: challenge.description
      });
    }

    res.status(201).json({
      success: true,
      data: {
        submissionId,
        photoUrl,
        status: 'pending_approval',
        message: 'Photo uploaded and submitted for approval'
      }
    });
  } catch (error) {
    console.error('Error uploading photo:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload photo',
      error: error.message
    });
  }
});

/**
 * Submit a challenge photo for a received gift
 * POST /api/gifts/:trackingId/submit-challenge
 * Multipart form data with 'photo' field
 * Requires auth token - matches user to gift recipient
 */
router.post('/gifts/:trackingId/submit-challenge', upload.single('photo'), async (req, res) => {
  try {
    // Verify JWT auth
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'Authorization required' });
    }

    const jwt = require('jsonwebtoken');
    const token = authHeader.split(' ')[1];
    const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch (jwtError) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    }

    // Validate photo
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No photo file provided' });
    }

    const { trackingId } = req.params;

    // Get gift order
    const giftOrder = await db.getGiftOrderByTrackingId(trackingId);
    if (!giftOrder) {
      return res.status(404).json({ success: false, message: 'Gift not found' });
    }

    // Verify the authenticated user is the recipient
    const user = await db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userEmail = (user.email || '').toLowerCase();
    const userPhone = (user.phone || '').replace(/\D/g, '');
    const recipientEmail = (giftOrder.recipient_email || '').toLowerCase();
    const recipientPhone = (giftOrder.recipient_phone || '').replace(/\D/g, '');

    const isRecipient = (userEmail && recipientEmail && userEmail === recipientEmail) ||
                        (userPhone && recipientPhone && userPhone.endsWith(recipientPhone.slice(-10)));

    if (!isRecipient) {
      return res.status(403).json({ success: false, message: 'You are not the recipient of this gift' });
    }

    // Resolve challenge ID (from gift_orders or fallback to challenges table)
    let challengeId = giftOrder.challenge_id;
    if (!challengeId) {
      const challenge = await db.getChallengeByGiftId(trackingId);
      if (challenge) {
        challengeId = challenge.id;
        // Back-fill the link for future lookups
        await db.linkChallengeToGiftOrder(trackingId, challengeId);
      } else {
        // Create a challenge record for legacy gifts
        challengeId = 'CH' + Date.now();
        await db.createChallenge({
          id: challengeId,
          giftId: trackingId,
          type: giftOrder.challenge_type || 'custom',
          description: giftOrder.challenge_description || giftOrder.challenge || '',
          requirements: { totalSteps: giftOrder.duration || 1 }
        });
        await db.linkChallengeToGiftOrder(trackingId, challengeId);
      }
    }

    // Create photo submission
    const photoUrl = `/uploads/photos/${req.file.filename}`;
    const submissionId = uuidv4();
    await db.createPhotoSubmission({
      id: submissionId,
      challengeId,
      giftId: trackingId,
      photoUrl,
      submitterPhone: user.phone || null,
      status: 'pending_approval'
    });

    // Update gift status
    await db.updateGiftOrderStatus(trackingId, 'pending_approval');

    // Best-effort sender notification
    try {
      if (giftOrder.sender_email) {
        const sender = await db.getUserById(giftOrder.user_id);
        const senderEmail = sender?.email || giftOrder.sender_email;
        await sendGridService.sendApprovalNotificationEmail(senderEmail, {
          recipientName: giftOrder.recipient_name,
          photoUrl,
          giftType: giftOrder.gift_type,
          challengeDescription: giftOrder.challenge_description || giftOrder.challenge || ''
        });
      }
    } catch (emailError) {
      console.error('⚠️  Failed to send approval notification email:', emailError.message);
    }

    res.status(201).json({
      success: true,
      data: {
        submissionId,
        photoUrl,
        status: 'pending_approval'
      }
    });
  } catch (error) {
    console.error('Error submitting challenge photo:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit challenge photo',
      error: error.message
    });
  }
});

// Helper function to format gift order for response
function formatGiftForResponse(giftOrder) {
  return {
    id: giftOrder.tracking_id,
    senderName: giftOrder.sender_name,
    recipientName: giftOrder.recipient_name,
    recipientPhone: giftOrder.recipient_phone,
    recipientEmail: giftOrder.recipient_email,
    type: giftOrder.gift_type,
    value: giftOrder.gift_value,
    challenge: giftOrder.challenge_description || giftOrder.challenge,
    status: giftOrder.status,
    unlocked: giftOrder.unlocked,
    createdAt: giftOrder.created_at
  };
}

// Helper functions

async function sendInitialMessage(gift, challenge) {
  const results = { sms: null, email: null };

  try {
    const giftData = {
      recipientName: gift.recipientName,
      senderName: gift.senderName,
      giftType: gift.type,
      giftValue: gift.details?.description || 'A surprise!',
      challenge: challenge.description,
      message: gift.details?.personalMessage || null
    };

    // Send via SMS if phone number provided and delivery method allows
    if (gift.recipientPhone && (gift.deliveryMethod === 'sms' || gift.deliveryMethod === 'both')) {
      if (!twilioClient) {
        console.warn('⚠️  SMS requested but Twilio is not configured');
        results.sms = {
          success: false,
          error: 'Twilio not configured - SMS delivery unavailable'
        };
      } else {
        try {
          const giftLink = `https://honeybadgerapp.com/g/${gift.id}`;
          const messageBody = `🦡 HONEY BADGER HERE! ${gift.senderName} sent you a special gift!\n\n` +
            `🎁 Gift: ${gift.type} - ${giftData.giftValue}\n\n` +
            `🎯 Your challenge: ${challenge.description}\n\n` +
            `Complete it to unlock your gift! I'll be here to help and motivate you. Let's do this!\n\n` +
            `👉 Open your gift: ${giftLink}\n\n` +
            `Reply START when you're ready to begin!\n\n` +
            `Reply STOP to opt out. Msg & data rates may apply.`;

          const message = await sendSmsWithOptOutCheck(gift.recipientPhone, messageBody);

          results.sms = {
            success: !!message,
            messageId: message ? message.sid : null,
            sentAt: new Date()
          };
        } catch (smsError) {
          console.error('Error sending SMS:', smsError);
          results.sms = {
            success: false,
            error: smsError.message
          };
        }
      }
    }

    // Send via Email if email provided and delivery method allows
    if (gift.recipientEmail && (gift.deliveryMethod === 'email' || gift.deliveryMethod === 'both')) {
      const emailResult = await sendGridService.sendInitialGiftEmail(gift.recipientEmail, giftData);
      results.email = emailResult;
    }

    // Return success if at least one method succeeded
    const success = (results.sms?.success || results.email?.success);

    return {
      success,
      results,
      sentAt: new Date()
    };
  } catch (error) {
    console.error('Error sending initial message:', error);
    return {
      success: false,
      error: error.message,
      results
    };
  }
}

async function generateReminderMessage(gift, challenge) {
  return aiMessage.generateReminderMessage(gift, challenge);
}

async function sendCompletionMessage(gift, challenge) {
  const messageBody = await aiMessage.generateCompletionMessage(gift, challenge);
  await sendSmsWithOptOutCheck(gift.recipientPhone, messageBody);
}

async function validateResponse(challenge, body, numMedia, mediaUrl) {
  // Implement validation logic based on challenge type
  switch (challenge.type) {
    case 'photo':
      return numMedia > 0;
    case 'video':
      return numMedia > 0;
    case 'text':
      return body && body.length > 10;
    case 'keyword':
      return body && body.toLowerCase().includes(challenge.requirements.keyword?.toLowerCase());
    default:
      return true;
  }
}

async function getProgressMessage(gift, challenge) {
  return aiMessage.generateProgressMessage(gift, challenge);
}

async function getCompletionMessage(gift, challenge) {
  return aiMessage.generateCompletionMessage(gift, challenge);
}

module.exports = router;
