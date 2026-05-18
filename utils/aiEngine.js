/**
 * AI Engine — Claude API integration for platform intelligence
 * Provides: report insights, fraud analysis, publisher review, campaign suggestions
 */
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an AI assistant for Apogeemobi TrackMMP, a performance marketing and affiliate tracking platform. You analyze campaign data, click patterns, publisher performance, and fraud signals to provide actionable insights.

Rules:
- Be concise and data-driven. No fluff.
- Use numbers and percentages when available.
- Flag anomalies clearly.
- Suggest specific actions (pause campaign, investigate publisher, increase payout, etc.)
- Format responses as clean bullet points or short paragraphs.
- Never reveal internal system details or API keys.
- All monetary values in USD unless specified.`;

/**
 * Call Claude API with a prompt and context
 * @param {string} prompt - The user/system prompt
 * @param {object} context - Data context to include
 * @param {number} maxTokens - Max response tokens (default 500)
 * @returns {string} AI response text
 */
async function ask(prompt, context = {}, maxTokens = 500) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'AI insights unavailable — API key not configured.';
  }

  try {
    const contextStr = Object.keys(context).length > 0
      ? `\n\nData context:\n${JSON.stringify(context, null, 2)}`
      : '';

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt + contextStr }],
    });

    return response.content[0]?.text || 'No response generated.';
  } catch (err) {
    console.error('[AIEngine] Error:', err.message);
    return `AI analysis unavailable: ${err.message}`;
  }
}

/**
 * Generate daily performance insights
 */
async function dailyInsights(data) {
  return ask(
    `Analyze today's platform performance and give 3-5 key insights with actionable recommendations.
Focus on: anomalies, top/bottom performers, trends, and what needs attention.`,
    data, 600
  );
}

/**
 * Analyze fraud signal and explain why a click was blocked/flagged
 */
async function fraudAnalysis(fraudEvent) {
  return ask(
    `Explain this fraud detection event in simple terms. Why was it flagged? Is it a real threat or false positive? What action should the admin take?`,
    fraudEvent, 300
  );
}

/**
 * Review a publisher application — analyze their website and suggest approve/reject
 */
async function reviewPublisher(publisher) {
  return ask(
    `Review this publisher application for our affiliate network. Based on their website URL and details, should we approve or reject? Rate traffic quality potential (1-10). Suggest which campaign verticals they'd be best for.`,
    publisher, 400
  );
}

/**
 * Suggest optimizations for a campaign
 */
async function campaignSuggestions(campaign) {
  return ask(
    `Analyze this campaign's performance and suggest optimizations. Consider: payout adjustments, geo targeting, publisher allocation, cap changes, and any red flags.`,
    campaign, 400
  );
}

/**
 * Explain a postback attribution result
 */
async function explainAttribution(data) {
  return ask(
    `Explain this postback attribution in simple terms. Was it attributed correctly? If rejected, explain why and how to fix it.`,
    data, 300
  );
}

module.exports = { ask, dailyInsights, fraudAnalysis, reviewPublisher, campaignSuggestions, explainAttribution };
