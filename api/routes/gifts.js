const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');
const sendGridService = require('../../services/sendGridService');

// Initialize Twilio client (conditional)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
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

// In-memory storage (replace with database in production)
const gifts = new Map();
const challenges = new Map();
const recipients = new Map();

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

    // Create gift object
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

    // Create challenge object
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
      reminderFrequency: reminderFrequency || 'daily',
      lastReminderSent: null
    };

    // Store in memory (replace with database)
    gifts.set(giftId, gift);
    challenges.set(challengeId, challenge);

    // Store recipient info
    if (!recipients.has(recipientPhone)) {
      recipients.set(recipientPhone, {
        phone: recipientPhone,
        name: recipientName,
        activeGifts: [],
        completedGifts: []
      });
    }
    recipients.get(recipientPhone).activeGifts.push(giftId);

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
    
    const gift = gifts.get(giftId);
    if (!gift) {
      return res.status(404).json({
        success: false,
        message: 'Gift not found'
      });
    }

    const challenge = challenges.get(gift.challengeId);
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
    
    const challenge = challenges.get(challengeId);
    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    const gift = gifts.get(challenge.giftId);
    const reminderMessage = customMessage || generateReminderMessage(gift, challenge);

    const message = await twilioClient.messages.create({
      body: reminderMessage,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: gift.recipientPhone
    });

    // Update last reminder sent
    challenge.lastReminderSent = new Date();
    challenges.set(challengeId, challenge);

    res.json({
      success: true,
      data: {
        messageId: message.sid,
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
 * Track challenge progress
 * GET /api/challenges/:challengeId/progress
 */
router.get('/challenges/:challengeId/progress', (req, res) => {
  try {
    const { challengeId } = req.params;
    
    const challenge = challenges.get(challengeId);
    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Challenge not found'
      });
    }

    const gift = gifts.get(challenge.giftId);

    res.json({
      success: true,
      data: {
        challengeId,
        giftId: challenge.giftId,
        type: challenge.type,
        description: challenge.description,
        progress: challenge.progress,
        giftStatus: gift.status,
        unlocked: gift.unlocked,
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
    const { challengeId } = req.params;
    const { stepCompleted, submission, metadata } = req.body;
    
    const challenge = challenges.get(challengeId);
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

    // Check if challenge is completed
    if (challenge.progress.currentStep >= challenge.progress.totalSteps) {
      challenge.progress.completed = true;
      
      // Unlock the gift
      const gift = gifts.get(challenge.giftId);
      gift.unlocked = true;
      gift.status = 'completed';
      gift.unlockedAt = new Date();
      gifts.set(challenge.giftId, gift);

      // Send completion message
      await sendCompletionMessage(gift, challenge);

      // Update recipient records
      const recipient = recipients.get(gift.recipientPhone);
      if (recipient) {
        recipient.activeGifts = recipient.activeGifts.filter(id => id !== challenge.giftId);
        recipient.completedGifts.push(challenge.giftId);
        recipients.set(gift.recipientPhone, recipient);
      }
    }

    challenges.set(challengeId, challenge);

    res.json({
      success: true,
      data: {
        challengeId,
        progress: challenge.progress,
        completed: challenge.progress.completed,
        giftUnlocked: challenge.progress.completed
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
    
    console.log('Received message from:', From);
    console.log('Message body:', Body);

    // Find recipient and their active challenges
    const recipient = recipients.get(From);
    if (!recipient || recipient.activeGifts.length === 0) {
      // No active challenges for this number
      await twilioClient.messages.create({
        body: "🦡 Hi! You don't have any active challenges right now. Ask your friend to send you a Honey Badger gift!",
        from: process.env.TWILIO_PHONE_NUMBER,
        to: From
      });
      
      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }

    // Process the response based on active challenges
    let responseMessage = '';
    
    for (const giftId of recipient.activeGifts) {
      const gift = gifts.get(giftId);
      const challenge = challenges.get(gift.challengeId);
      
      // Check if response matches challenge requirements
      const validResponse = await validateResponse(challenge, Body, NumMedia, MediaUrl0);
      
      if (validResponse) {
        // Update progress
        challenge.progress.currentStep++;
        challenge.progress.submissions.push({
          timestamp: new Date(),
          type: NumMedia > 0 ? 'media' : 'text',
          data: {
            body: Body,
            mediaUrl: MediaUrl0,
            mediaType: MediaContentType0
          }
        });

        if (challenge.progress.currentStep >= challenge.progress.totalSteps) {
          // Challenge completed!
          challenge.progress.completed = true;
          gift.unlocked = true;
          gift.status = 'completed';
          gifts.set(giftId, gift);
          
          responseMessage = await getCompletionMessage(gift, challenge);
          
          // Update recipient records
          recipient.activeGifts = recipient.activeGifts.filter(id => id !== giftId);
          recipient.completedGifts.push(giftId);
        } else {
          // Progress made but not complete
          responseMessage = await getProgressMessage(gift, challenge);
        }
        
        challenges.set(gift.challengeId, challenge);
        recipients.set(From, recipient);
        break; // Process only one challenge per message
      }
    }

    if (!responseMessage) {
      responseMessage = "🦡 Hmm, that doesn't seem right for your challenge. Try again! Reply HELP for hints.";
    }

    // Send response
    await twilioClient.messages.create({
      body: responseMessage,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: From
    });

    res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (error) {
    console.error('Error processing incoming message:', error);
    res.status(500).send('Error processing message');
  }
});

/**
 * Get all gifts for a recipient
 * GET /api/recipients/:phone/gifts
 */
router.get('/recipients/:phone/gifts', (req, res) => {
  try {
    const { phone } = req.params;
    const recipient = recipients.get(phone);
    
    if (!recipient) {
      return res.status(404).json({
        success: false,
        message: 'Recipient not found'
      });
    }

    const activeGifts = recipient.activeGifts.map(id => gifts.get(id));
    const completedGifts = recipient.completedGifts.map(id => gifts.get(id));

    res.json({
      success: true,
      data: {
        recipient: {
          phone: recipient.phone,
          name: recipient.name
        },
        activeGifts,
        completedGifts,
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
          const messageBody = `🦡 HONEY BADGER HERE! ${gift.senderName} sent you a special gift!\n\n` +
            `🎁 Gift: ${gift.type} - ${giftData.giftValue}\n\n` +
            `🎯 Your challenge: ${challenge.description}\n\n` +
            `Complete it to unlock your gift! I'll be here to help and motivate you. Let's do this!\n\n` +
            `Reply START when you're ready to begin!`;

          const message = await twilioClient.messages.create({
            body: messageBody,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: gift.recipientPhone
          });

          results.sms = {
            success: true,
            messageId: message.sid,
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

function generateReminderMessage(gift, challenge) {
  const motivationalMessages = [
    "🦡 Honey Badger doesn't give up, and neither should you!",
    "🦡 Still working on that challenge? You've got this!",
    "🦡 Your gift is waiting! Let's crush this challenge!",
    "🦡 Honey Badger believes in you! Keep going!",
    "🦡 Remember: " + gift.senderName + " is rooting for you!"
  ];
  
  const randomMessage = motivationalMessages[Math.floor(Math.random() * motivationalMessages.length)];
  const progress = `Progress: ${challenge.progress.currentStep}/${challenge.progress.totalSteps} steps`;
  
  return `${randomMessage}\n\n${progress}\n\nChallenge: ${challenge.description}`;
}

async function sendCompletionMessage(gift, challenge) {
  const messageBody = `🎉 CONGRATULATIONS! 🎉\n\n` +
    `🦡 Honey Badger is SO PROUD of you!\n\n` +
    `You've completed the challenge and unlocked your gift!\n\n` +
    `🎁 Your ${gift.type} is now available!\n` +
    `${gift.details?.redemptionInstructions || 'Check your email for redemption details.'}\n\n` +
    `${gift.senderName} will be so happy to hear about your success!`;

  await twilioClient.messages.create({
    body: messageBody,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: gift.recipientPhone
  });
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
  const remaining = challenge.progress.totalSteps - challenge.progress.currentStep;
  return `🦡 Great job! You're making progress!\n\n` +
    `${remaining} more step${remaining > 1 ? 's' : ''} to go!\n` +
    `Keep it up - your ${gift.type} is almost yours!`;
}

async function getCompletionMessage(gift, challenge) {
  return `🎊 YOU DID IT! 🎊\n\n` +
    `Challenge COMPLETE! Your ${gift.type} is unlocked!\n\n` +
    `${gift.details?.redemptionInstructions || 'Congratulations on your achievement!'}`;
}

module.exports = router;
