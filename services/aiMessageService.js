const Anthropic = require('@anthropic-ai/sdk');

let client = null;

function getClient() {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const HONEY_BADGER_SYSTEM = `You are the Honey Badger — a persistent, funny, and relentlessly motivational coach who delivers messages via SMS.

Personality:
- Tough love with a heart of gold. You're the friend who won't let someone quit.
- Use humor and energy. You're scrappy, fearless, and a little wild — like a real honey badger.
- Reference honey badger traits: tenacity, fearlessness, never giving up.
- Use the 🦡 emoji once per message. You may use 1-2 other emojis sparingly.

Constraints:
- Keep messages under 300 characters (SMS friendly — 2 segments max).
- Never use hashtags, links, or markdown.
- Write in a casual, texting-friendly tone.
- Do NOT mention being an AI or language model.
- Always be encouraging, even when being pushy.`;

/**
 * Generate a message using Claude, with a fallback if the API is unavailable.
 */
async function generateMessage(userPrompt, fallback) {
  const anthropic = getClient();
  if (!anthropic) return fallback;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      system: HONEY_BADGER_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0]?.text;
    return text || fallback;
  } catch (error) {
    console.error('AI message generation failed, using fallback:', error.message);
    return fallback;
  }
}

/**
 * AI-powered initial gift notification message.
 */
async function generateInitialMessage(gift, challenge) {
  const fallback = `🦡 HONEY BADGER HERE! ${gift.senderName} sent you a special gift!\n\n` +
    `🎁 Gift: ${gift.type}\n\n` +
    `🎯 Your challenge: ${challenge.description}\n\n` +
    `Complete it to unlock your gift! I'll be here to help and motivate you. Let's do this!\n\n` +
    `Reply START when you're ready to begin!`;

  const prompt = `Write an exciting SMS notification for a gift recipient.

Sender: ${gift.senderName}
Gift type: ${gift.type}
Challenge: ${challenge.description}

This is their FIRST message from you. Introduce yourself as the Honey Badger, hype up the gift, explain the challenge, and tell them to reply START when ready. End with: "Reply STOP to opt out."`;

  return generateMessage(prompt, fallback);
}

/**
 * AI-powered motivational reminder message.
 */
async function generateReminderMessage(gift, challenge) {
  const progress = challenge.progress || {};
  const current = progress.currentStep || 0;
  const total = progress.totalSteps || 1;

  const fallback = `🦡 Honey Badger doesn't give up, and neither should you!\n\n` +
    `Progress: ${current}/${total} steps\n\nChallenge: ${challenge.description}`;

  const prompt = `Write a motivational reminder SMS to someone who hasn't completed their challenge yet.

Sender name: ${gift.senderName}
Challenge: ${challenge.description}
Progress: ${current} of ${total} steps completed
Challenge type: ${challenge.type || 'general'}

Be creative, funny, and pushy. Mention their progress and the challenge. Make them want to finish RIGHT NOW.`;

  return generateMessage(prompt, fallback);
}

/**
 * AI-powered progress message after completing a step.
 */
async function generateProgressMessage(gift, challenge) {
  const remaining = (challenge.progress?.totalSteps || 1) - (challenge.progress?.currentStep || 0);

  const fallback = `🦡 Great job! You're making progress!\n\n` +
    `${remaining} more step${remaining > 1 ? 's' : ''} to go!\n` +
    `Keep it up - your ${gift.type} is almost yours!`;

  const prompt = `Write a short celebratory SMS for someone who just completed a challenge step.

Gift type: ${gift.type}
Steps remaining: ${remaining}
Challenge: ${challenge.description || 'a fun challenge'}

Celebrate their progress and hype them up to finish the remaining steps.`;

  return generateMessage(prompt, fallback);
}

/**
 * AI-powered completion/celebration message.
 */
async function generateCompletionMessage(gift, challenge) {
  const redemptionNote = gift.details?.redemptionInstructions || gift.details?.personalMessage || '';

  const fallback = `🎊 YOU DID IT! 🎊\n\nChallenge COMPLETE! Your ${gift.type} is unlocked!\n\n` +
    `${redemptionNote || 'Congratulations on your achievement!'}`;

  const prompt = `Write an EPIC celebration SMS for someone who just completed their challenge and unlocked their gift!

Gift type: ${gift.type}
Sender: ${gift.senderName || 'their friend'}
Challenge they completed: ${challenge.description || 'a fun challenge'}
${redemptionNote ? `Include this redemption info: ${redemptionNote}` : ''}

Go wild with celebration energy. This is the big payoff moment!`;

  return generateMessage(prompt, fallback);
}

/**
 * AI-powered nudge message from sender.
 */
async function generateNudgeMessage(senderName, challenge) {
  const progress = challenge?.progress || {};
  const current = progress.currentStep || 0;
  const total = progress.totalSteps || 1;

  const fallback = `🦡 Hey! ${senderName} is waiting for you to complete your challenge and claim your gift! Open Honey Badger to get started.`;

  const prompt = `Write a nudge SMS on behalf of a gift sender who wants the recipient to complete their challenge.

Sender name: ${senderName}
Challenge: ${challenge?.description || 'a fun challenge'}
Progress: ${current} of ${total} steps completed

The sender specifically asked us to nudge this person. Make it feel personal — like ${senderName} really cares. Be playfully persistent.`;

  return generateMessage(prompt, fallback);
}

/**
 * AI-powered response to an invalid challenge submission.
 */
async function generateInvalidResponseMessage(challenge) {
  const fallback = "🦡 Hmm, that doesn't seem right for your challenge. Try again! Reply HELP for hints.";

  const prompt = `Write a short, encouraging SMS telling someone their challenge response wasn't valid.

Challenge type: ${challenge?.type || 'general'}
Challenge description: ${challenge?.description || 'a challenge'}

Be kind but clear. Tell them what they need to do (e.g., send a photo, include a keyword, write more). End with "Reply HELP for hints."`;

  return generateMessage(prompt, fallback);
}

module.exports = {
  generateInitialMessage,
  generateReminderMessage,
  generateProgressMessage,
  generateCompletionMessage,
  generateNudgeMessage,
  generateInvalidResponseMessage,
};
