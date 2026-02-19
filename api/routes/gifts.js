const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');
const sendGridService = require('../../services/sendGridService');
const db = require('../../services/databaseService');
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

    const message = await twilioClient.messages.create({
      body: reminderMessage,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: gift.recipientPhone
    });

    // Update last reminder sent in database
    await db.updateChallengeReminderSent(challengeId);

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

    // Check if challenge is completed
    let giftUnlocked = false;
    if (challenge.progress.currentStep >= challenge.progress.totalSteps) {
      challenge.progress.completed = true;
      giftUnlocked = true;

      // Unlock the gift in database
      const giftOrder = await db.getGiftOrderByTrackingId(challenge.gift_id);
      if (giftOrder) {
        await db.unlockGiftOrder(challenge.gift_id);

        // Send completion message
        const gift = {
          senderName: giftOrder.sender_name || 'Someone special',
          recipientPhone: giftOrder.recipient_phone,
          recipientEmail: giftOrder.recipient_email,
          type: giftOrder.gift_type,
          details: { redemptionInstructions: giftOrder.personal_note || giftOrder.message }
        };
        await sendCompletionMessage(gift, challenge);
      }
    }

    // Update challenge progress in database
    await db.updateChallengeProgress(challengeId, challenge.progress);

    res.json({
      success: true,
      data: {
        challengeId,
        progress: challenge.progress,
        completed: challenge.progress.completed,
        giftUnlocked
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

    // Find active gifts for this recipient from database
    const activeGifts = await db.getActiveGiftsByRecipientPhone(From);

    if (!activeGifts || activeGifts.length === 0) {
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
              await twilioClient.messages.create({
                body: `🦡 ${giftOrder.recipient_name || 'Your gift recipient'} just submitted a photo for their challenge! Open the Honey Badger app to review and approve it.`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: giftOrder.sender_phone
              });
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

    // Get gift order for notifications
    const giftOrder = await db.getGiftOrderByTrackingId(submission.gift_id);

    if (action === 'approve') {
      // Update submission status
      await db.updatePhotoSubmissionStatus(submissionId, 'approved');

      // Unlock the gift
      await db.unlockGiftOrder(submission.gift_id, submission.photo_url);

      // Notify recipient
      if (giftOrder && giftOrder.recipient_phone && twilioClient) {
        try {
          await twilioClient.messages.create({
            body: `🎉 CONGRATULATIONS! 🎉\n\nYour photo has been approved! Your ${giftOrder.gift_type} gift is now unlocked!\n\n${giftOrder.personal_note || giftOrder.message || 'Enjoy your gift!'}`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: giftOrder.recipient_phone
          });
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
      if (giftOrder && giftOrder.recipient_phone && twilioClient) {
        try {
          const reason = rejectionReason ? `Reason: ${rejectionReason}` : 'Please try submitting a new photo.';
          await twilioClient.messages.create({
            body: `🦡 Your photo submission wasn't approved this time. ${reason}\n\nDon't give up! Send another photo to complete your challenge!`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: giftOrder.recipient_phone
          });
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
