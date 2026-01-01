const sgMail = require('@sendgrid/mail');

class SendGridService {
    constructor() {
        this.initialized = false;
        this.fromEmail = null;
        this.fromName = null;
        this.init();
    }

    init() {
        const apiKey = process.env.SENDGRID_API_KEY;
        this.fromEmail = process.env.SENDGRID_FROM_EMAIL;
        this.fromName = process.env.SENDGRID_FROM_NAME || 'Honey Badger AI Gifts';

        if (!apiKey) {
            console.warn('⚠️  SendGrid API key not configured. Email functionality will be disabled.');
            console.warn('   Set SENDGRID_API_KEY in your .env file to enable email sending.');
            return;
        }

        if (!this.fromEmail) {
            console.warn('⚠️  SendGrid from email not configured. Email functionality will be disabled.');
            console.warn('   Set SENDGRID_FROM_EMAIL in your .env file to enable email sending.');
            return;
        }

        try {
            sgMail.setApiKey(apiKey);
            this.initialized = true;
            console.log('✅ SendGrid service initialized successfully');
        } catch (error) {
            console.error('❌ Failed to initialize SendGrid service:', error.message);
        }
    }

    isInitialized() {
        return this.initialized;
    }

    /**
     * Send initial gift notification email to recipient
     */
    async sendInitialGiftEmail(recipientEmail, giftData) {
        if (!this.initialized) {
            console.log('SendGrid not initialized, skipping email send');
            return { success: false, message: 'SendGrid not configured' };
        }

        try {
            const { recipientName, giftType, giftValue, challenge, senderName } = giftData;

            const msg = {
                to: recipientEmail,
                from: {
                    email: this.fromEmail,
                    name: this.fromName
                },
                subject: `🍯 ${senderName} sent you a Honey Badger Gift!`,
                text: this.createInitialEmailText(giftData),
                html: this.createInitialEmailHtml(giftData)
            };

            await sgMail.send(msg);
            console.log(`✅ Initial gift email sent to ${recipientEmail}`);
            return { success: true, message: 'Email sent successfully' };
        } catch (error) {
            console.error('❌ Failed to send initial gift email:', error.message);
            if (error.response) {
                console.error('SendGrid error details:', error.response.body);
            }
            return { success: false, message: error.message };
        }
    }

    /**
     * Send reminder email to recipient
     */
    async sendReminderEmail(recipientEmail, giftData) {
        if (!this.initialized) {
            console.log('SendGrid not initialized, skipping email send');
            return { success: false, message: 'SendGrid not configured' };
        }

        try {
            const { recipientName, challenge, progress } = giftData;

            const msg = {
                to: recipientEmail,
                from: {
                    email: this.fromEmail,
                    name: this.fromName
                },
                subject: `🍯 Reminder: Your Honey Badger is waiting!`,
                text: this.createReminderEmailText(giftData),
                html: this.createReminderEmailHtml(giftData)
            };

            await sgMail.send(msg);
            console.log(`✅ Reminder email sent to ${recipientEmail}`);
            return { success: true, message: 'Reminder email sent successfully' };
        } catch (error) {
            console.error('❌ Failed to send reminder email:', error.message);
            if (error.response) {
                console.error('SendGrid error details:', error.response.body);
            }
            return { success: false, message: error.message };
        }
    }

    /**
     * Send gift unlock/completion email
     */
    async sendCompletionEmail(recipientEmail, giftData) {
        if (!this.initialized) {
            console.log('SendGrid not initialized, skipping email send');
            return { success: false, message: 'SendGrid not configured' };
        }

        try {
            const { recipientName, giftType, giftValue } = giftData;

            const msg = {
                to: recipientEmail,
                from: {
                    email: this.fromEmail,
                    name: this.fromName
                },
                subject: `🎉 Congratulations! You've unlocked your Honey Badger Gift!`,
                text: this.createCompletionEmailText(giftData),
                html: this.createCompletionEmailHtml(giftData)
            };

            await sgMail.send(msg);
            console.log(`✅ Completion email sent to ${recipientEmail}`);
            return { success: true, message: 'Completion email sent successfully' };
        } catch (error) {
            console.error('❌ Failed to send completion email:', error.message);
            if (error.response) {
                console.error('SendGrid error details:', error.response.body);
            }
            return { success: false, message: error.message };
        }
    }

    // Text email templates
    createInitialEmailText(giftData) {
        const { recipientName, senderName, giftType, giftValue, challenge, message, giftId } = giftData;
        const giftUrl = giftId ? `https://honeybadgerapp.com/gift/${giftId}` : 'https://honeybadgerapp.com';

        return `
Hi ${recipientName}!

${senderName} has sent you a special Honey Badger Gift! 🍯

Your Gift: ${giftType} - ${giftValue}

To unlock your gift, you need to complete this challenge:
${challenge}

${message ? `Personal message from ${senderName}: "${message}"` : ''}

Your Honey Badger AI coach will be with you every step of the way to help you earn this gift!

View your gift and track your progress:
${giftUrl}

Let's get started! 💪

Best regards,
The Honey Badger Team
        `.trim();
    }

    createReminderEmailText(giftData) {
        const { recipientName, challenge, progress, giftId } = giftData;
        const giftUrl = giftId ? `https://honeybadgerapp.com/gift/${giftId}` : 'https://honeybadgerapp.com';

        return `
Hi ${recipientName}!

Your Honey Badger here with a friendly reminder! 🍯

You're making progress on your challenge: ${challenge}

${progress ? `Progress: ${progress}` : 'Keep going! You can do this!'}

Don't give up now - your gift is waiting for you! 💪

View your gift and progress:
${giftUrl}

Best regards,
Your Honey Badger Coach
        `.trim();
    }

    createCompletionEmailText(giftData) {
        const { recipientName, giftType, giftValue, senderName, giftId } = giftData;
        const giftUrl = giftId ? `https://honeybadgerapp.com/gift/${giftId}` : 'https://honeybadgerapp.com';

        return `
Hi ${recipientName}!

🎉 CONGRATULATIONS! 🎉

You did it! You've completed your challenge and unlocked your gift!

Your Gift: ${giftType} - ${giftValue}

${senderName} is so proud of you! Your Honey Badger coach knew you could do it! 💪

View and claim your gift:
${giftUrl}

Keep up the amazing work!

Best regards,
Your Honey Badger Coach
        `.trim();
    }

    // HTML email templates
    createInitialEmailHtml(giftData) {
        const { recipientName, senderName, giftType, giftValue, challenge, message, giftId } = giftData;
        const giftUrl = giftId ? `https://honeybadgerapp.com/gift/${giftId}` : 'https://honeybadgerapp.com';

        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%); color: #E2FF00; padding: 30px; text-align: center; }
        .header h1 { margin: 0; font-size: 28px; }
        .content { padding: 30px; }
        .gift-box { background: linear-gradient(135deg, #E2FF00 0%, #B8CC00 100%); color: #1a1a1a; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center; }
        .gift-box h2 { margin: 0 0 10px 0; }
        .challenge-box { background: #f9f9f9; border-left: 4px solid #E2FF00; padding: 15px; margin: 20px 0; }
        .message-box { background: #fff9e6; border: 1px solid #E2FF00; padding: 15px; margin: 20px 0; border-radius: 5px; }
        .footer { background: #f4f4f4; padding: 20px; text-align: center; font-size: 12px; color: #666; }
        .button { display: inline-block; background: #E2FF00; color: #1a1a1a; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🍯 Honey Badger Gift!</h1>
        </div>
        <div class="content">
            <h2>Hi ${recipientName}!</h2>
            <p><strong>${senderName}</strong> has sent you a special Honey Badger Gift!</p>

            <div class="gift-box">
                <h2>Your Gift</h2>
                <p style="font-size: 20px; margin: 5px 0;"><strong>${giftType}</strong></p>
                <p style="font-size: 18px; margin: 5px 0;">${giftValue}</p>
            </div>

            <div class="challenge-box">
                <h3>🎯 Your Challenge</h3>
                <p>${challenge}</p>
            </div>

            ${message ? `
            <div class="message-box">
                <h3>💌 Personal Message</h3>
                <p><em>"${message}"</em></p>
                <p style="text-align: right; margin: 0;">- ${senderName}</p>
            </div>
            ` : ''}

            <p>Your Honey Badger AI coach will be with you every step of the way to help you earn this gift!</p>

            <div style="text-align: center; margin: 30px 0;">
                <a href="${giftUrl}" class="button">Unlock Your Gift 🎁</a>
            </div>

            <p><strong>Let's get started! 💪</strong></p>
        </div>
        <div class="footer">
            <p>Best regards,<br>The Honey Badger Team</p>
            <p style="margin-top: 20px;">🍯 Honey Badger AI Gifts - Motivation meets rewards</p>
        </div>
    </div>
</body>
</html>
        `.trim();
    }

    createReminderEmailHtml(giftData) {
        const { recipientName, challenge, progress, giftId } = giftData;
        const giftUrl = giftId ? `https://honeybadgerapp.com/gift/${giftId}` : 'https://honeybadgerapp.com';

        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%); color: #E2FF00; padding: 30px; text-align: center; }
        .header h1 { margin: 0; font-size: 28px; }
        .content { padding: 30px; }
        .challenge-box { background: #f9f9f9; border-left: 4px solid #E2FF00; padding: 15px; margin: 20px 0; }
        .progress-box { background: linear-gradient(135deg, #E2FF00 0%, #B8CC00 100%); color: #1a1a1a; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: center; }
        .footer { background: #f4f4f4; padding: 20px; text-align: center; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🍯 Reminder from Your Honey Badger!</h1>
        </div>
        <div class="content">
            <h2>Hi ${recipientName}!</h2>
            <p>Your Honey Badger coach here with a friendly reminder!</p>

            <div class="challenge-box">
                <h3>🎯 Your Challenge</h3>
                <p>${challenge}</p>
            </div>

            ${progress ? `
            <div class="progress-box">
                <h3>📊 Your Progress</h3>
                <p>${progress}</p>
            </div>
            ` : ''}

            <div style="text-align: center; margin: 30px 0;">
                <a href="${giftUrl}" class="button">Unlock Your Gift 🎁</a>
            </div>

            <p><strong>Don't give up now - your gift is waiting for you! 💪</strong></p>
            <p>You've got this!</p>
        </div>
        <div class="footer">
            <p>Best regards,<br>Your Honey Badger Coach</p>
            <p style="margin-top: 20px;">🍯 Keep going! You can do this!</p>
        </div>
    </div>
</body>
</html>
        `.trim();
    }

    createCompletionEmailHtml(giftData) {
        const { recipientName, giftType, giftValue, senderName, giftId } = giftData;
        const giftUrl = giftId ? `https://honeybadgerapp.com/gift/${giftId}` : 'https://honeybadgerapp.com';

        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #E2FF00 0%, #B8CC00 100%); color: #1a1a1a; padding: 30px; text-align: center; }
        .header h1 { margin: 0; font-size: 32px; }
        .content { padding: 30px; text-align: center; }
        .gift-box { background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%); color: #E2FF00; padding: 30px; border-radius: 8px; margin: 20px 0; }
        .gift-box h2 { margin: 0 0 10px 0; font-size: 28px; }
        .celebration { font-size: 48px; margin: 20px 0; }
        .footer { background: #f4f4f4; padding: 20px; text-align: center; font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎉 CONGRATULATIONS! 🎉</h1>
        </div>
        <div class="content">
            <div class="celebration">🎊 🏆 🎊</div>

            <h2>Amazing Work, ${recipientName}!</h2>
            <p style="font-size: 18px;"><strong>You did it! You've completed your challenge!</strong></p>

            <div class="gift-box">
                <h2>Your Unlocked Gift</h2>
                <p style="font-size: 20px; margin: 10px 0;"><strong>${giftType}</strong></p>
                <p style="font-size: 18px; margin: 10px 0;">${giftValue}</p>
            </div>

            <p style="font-size: 16px;"><strong>${senderName}</strong> is so proud of you!</p>
            <p>Your Honey Badger coach knew you could do it! 💪</p>

            <div style="text-align: center; margin: 30px 0;">
                <a href="${giftUrl}" class="button">Unlock Your Gift 🎁</a>
            </div>

            <p><strong>Keep up the amazing work!</strong></p>
        </div>
        <div class="footer">
            <p>Best regards,<br>Your Honey Badger Coach</p>
            <p style="margin-top: 20px;">🍯 You're a champion! 🏆</p>
        </div>
    </div>
</body>
</html>
        `.trim();
    }
}

module.exports = new SendGridService();
