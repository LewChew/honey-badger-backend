const twilio = require('twilio');

class TwilioService {
    constructor() {
        if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_ACCOUNT_SID.startsWith('AC')) {
            console.warn('⚠️  Twilio credentials not found or invalid. SMS functionality will be disabled.');
            this.client = null;
            return;
        }

        try {
            this.client = twilio(
                process.env.TWILIO_ACCOUNT_SID,
                process.env.TWILIO_AUTH_TOKEN
            );
            this.phoneNumber = process.env.TWILIO_PHONE_NUMBER;
            console.log('✅ Twilio service initialized');
        } catch (error) {
            console.error('❌ Failed to initialize Twilio service:', error.message);
            this.client = null;
        }
    }

    /**
     * Send SMS message
     * @param {string} to - Recipient phone number (E.164 format)
     * @param {string} body - Message body
     * @param {object} options - Additional options (mediaUrl, statusCallback, etc.)
     * @returns {Promise} - Twilio message response
     */
    async sendSMS(to, body, options = {}) {
        if (!this.client) {
            throw new Error('Twilio service not initialized. Check your credentials.');
        }

        if (!to || !body) {
            throw new Error('Recipient phone number and message body are required.');
        }

        try {
            const message = await this.client.messages.create({
                to,
                from: this.phoneNumber,
                body,
                ...options
            });

            console.log(`✅ SMS sent successfully: ${message.sid}`);
            return message;
        } catch (error) {
            console.error('❌ Failed to send SMS:', error.message);
            throw error;
        }
    }

    /**
     * Send Honey Badger notification
     * @param {object} params - Notification parameters
     * @returns {Promise} - Twilio message response
     */
    async sendHoneyBadgerNotification(params) {
        const { recipientPhone, recipientName, giftType, challenge, trackingId } = params;

        const message = `🍯 HONEY BADGER ALERT! 🍯\n\n` +
            `Hey ${recipientName}! Someone special has sent you a gift!\n\n` +
            `🎁 Gift: ${giftType}\n` +
            `🎯 Your Challenge: ${challenge}\n\n` +
            `Complete your challenge to unlock your reward!\n\n` +
            `Track your progress: ${process.env.BASE_URL}/track/${trackingId}\n\n` +
            `The Honey Badger is watching... 👀`;

        return this.sendSMS(recipientPhone, message);
    }

    /**
     * Send reminder message
     * @param {object} params - Reminder parameters
     * @returns {Promise} - Twilio message response
     */
    async sendReminder(params) {
        const { recipientPhone, recipientName, challenge, daysLeft } = params;

        const message = `🍯 HONEY BADGER REMINDER! 🍯\n\n` +
            `${recipientName}, don't forget about your challenge!\n\n` +
            `🎯 ${challenge}\n\n` +
            `⏰ You have ${daysLeft} days left to complete it!\n\n` +
            `The Honey Badger doesn't give up... neither should you! 💪`;

        return this.sendSMS(recipientPhone, message);
    }

    /**
     * Send completion congratulations
     * @param {object} params - Completion parameters
     * @returns {Promise} - Twilio message response
     */
    async sendCompletionMessage(params) {
        const { recipientPhone, recipientName, giftType, rewardCode } = params;

        const message = `🎉 CONGRATULATIONS ${recipientName.toUpperCase()}! 🎉\n\n` +
            `You've completed your Honey Badger challenge!\n\n` +
            `🏆 Your ${giftType} is ready!\n` +
            `🎁 Reward Code: ${rewardCode}\n\n` +
            `The Honey Badger is proud of you! 🍯\n\n` +
            `Claim your reward: ${process.env.BASE_URL}/claim/${rewardCode}`;

        return this.sendSMS(recipientPhone, message);
    }

    /**
     * Validate phone number format
     * @param {string} phoneNumber - Phone number to validate
     * @returns {string} - Formatted phone number in E.164 format
     */
    formatPhoneNumber(phoneNumber) {
        // Remove all non-numeric characters
        const cleaned = phoneNumber.replace(/\D/g, '');

        // Check if it's a valid US phone number (10 digits)
        if (cleaned.length === 10) {
            return `+1${cleaned}`;
        }

        // Check if it already has country code
        if (cleaned.length === 11 && cleaned.startsWith('1')) {
            return `+${cleaned}`;
        }

        // If it already has the + sign, return as is
        if (phoneNumber.startsWith('+')) {
            return phoneNumber;
        }

        throw new Error('Invalid phone number format. Please use format: +1234567890');
    }

    /**
     * Handle incoming SMS webhook
     * @param {object} twilioData - Webhook data from Twilio
     * @returns {object} - Response data
     */
    async handleIncomingSMS(twilioData) {
        const { From, Body, MessageSid } = twilioData;

        console.log(`📱 Incoming SMS from ${From}: ${Body}`);

        // Process the incoming message based on keywords
        const lowerBody = Body.toLowerCase().trim();

        if (lowerBody.includes('status') || lowerBody.includes('progress')) {
            // Send status update
            return this.sendStatusUpdate(From);
        }

        if (lowerBody.includes('help') || lowerBody.includes('commands')) {
            // Send help message
            return this.sendHelpMessage(From);
        }

        if (lowerBody.includes('stop') || lowerBody.includes('unsubscribe')) {
            // Handle unsubscribe
            return this.handleUnsubscribe(From);
        }

        // Default response
        return this.sendSMS(From, 
            `🍯 Honey Badger received your message!\n\n` +
            `Reply with:\n` +
            `STATUS - Check your challenge progress\n` +
            `HELP - Get available commands\n` +
            `STOP - Unsubscribe from messages`
        );
    }

    /**
     * Send status update
     * @param {string} phoneNumber - Recipient phone number
     * @returns {Promise} - Twilio message response
     */
    async sendStatusUpdate(phoneNumber) {
        // In a real implementation, you would query the database for user's challenge status
        const message = `📊 CHALLENGE STATUS\n\n` +
            `Days Active: 3/7\n` +
            `Progress: 43%\n` +
            `Keep going! The Honey Badger believes in you! 💪`;

        return this.sendSMS(phoneNumber, message);
    }

    /**
     * Send help message
     * @param {string} phoneNumber - Recipient phone number
     * @returns {Promise} - Twilio message response
     */
    async sendHelpMessage(phoneNumber) {
        const message = `🍯 HONEY BADGER HELP 🍯\n\n` +
            `Available commands:\n` +
            `STATUS - Check progress\n` +
            `PAUSE - Pause challenge\n` +
            `RESUME - Resume challenge\n` +
            `HELP - Show this message\n` +
            `STOP - Unsubscribe\n\n` +
            `Questions? Visit ${process.env.BASE_URL}/help`;

        return this.sendSMS(phoneNumber, message);
    }

    /**
     * Handle unsubscribe request
     * @param {string} phoneNumber - Phone number to unsubscribe
     * @returns {Promise} - Twilio message response
     */
    async handleUnsubscribe(phoneNumber) {
        // In a real implementation, update database to mark user as unsubscribed
        const message = `You've been unsubscribed from Honey Badger messages. ` +
            `We'll miss you! 🍯\n\n` +
            `To resubscribe, visit ${process.env.BASE_URL}`;

        return this.sendSMS(phoneNumber, message);
    }

    /**
     * Send approval request SMS to sender
     * @param {string} senderPhone - Sender's phone number
     * @param {string} recipientName - Name of the gift recipient
     * @returns {Promise} - Twilio message response
     */
    async sendApprovalRequestSMS(senderPhone, recipientName) {
        const message = `🦡 ${recipientName} just submitted a photo for their Honey Badger challenge!\n\n` +
            `Open the app to review and approve their submission. 📸\n\n` +
            `Once approved, their gift will be unlocked!`;

        return this.sendSMS(senderPhone, message);
    }

    /**
     * Send gift unlocked SMS to recipient
     * @param {string} recipientPhone - Recipient's phone number
     * @param {string} giftType - Type of gift
     * @param {string} giftValue - Value/description of gift
     * @returns {Promise} - Twilio message response
     */
    async sendGiftUnlockedSMS(recipientPhone, giftType, giftValue) {
        const message = `🎉 CONGRATULATIONS! 🎉\n\n` +
            `🦡 Your photo has been approved!\n\n` +
            `🎁 Your ${giftType} gift is now UNLOCKED!\n` +
            `${giftValue ? `Value: ${giftValue}` : ''}\n\n` +
            `The Honey Badger is proud of you! 💪`;

        return this.sendSMS(recipientPhone, message);
    }

    /**
     * Send submission rejected SMS to recipient
     * @param {string} recipientPhone - Recipient's phone number
     * @param {string} reason - Rejection reason (optional)
     * @returns {Promise} - Twilio message response
     */
    async sendSubmissionRejectedSMS(recipientPhone, reason = null) {
        const reasonText = reason ? `\n\nReason: ${reason}` : '';
        const message = `🦡 Your photo submission wasn't approved this time.${reasonText}\n\n` +
            `Don't give up! Send another photo to complete your challenge.\n\n` +
            `The Honey Badger believes in you! 💪`;

        return this.sendSMS(recipientPhone, message);
    }

    /**
     * Send photo received confirmation to recipient
     * @param {string} recipientPhone - Recipient's phone number
     * @returns {Promise} - Twilio message response
     */
    async sendPhotoReceivedSMS(recipientPhone) {
        const message = `🦡 Photo received! 📸\n\n` +
            `Your submission has been sent to the gift sender for approval.\n\n` +
            `You'll be notified once it's reviewed. Hang tight!`;

        return this.sendSMS(recipientPhone, message);
    }
}

// Export singleton instance
module.exports = new TwilioService();
