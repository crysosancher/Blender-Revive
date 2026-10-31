import { GoogleGenerativeAI } from '@google/generative-ai';
import { getDb } from '../db/mongodb';
import { sendHumanLikeResponse } from '../commands';
import { saveDailySummary } from './daily-summary-store';

// Initialize the Google Gen AI SDK
const apiKey = process.env.GEMINI_API_KEY || '';
const ai = new GoogleGenerativeAI(apiKey);

interface GroupMessage {
  _id: string;
  groupId: string;
  senderJid: string;
  senderName: string;
  text: string;
  timestamp: Date;
}

export async function runGroupAnalytics(sock: any, groupId: string): Promise<void> {
  try {
    const db = getDb();
    const groupMessagesCol = db.collection<GroupMessage>('group_messages');

    // 1. Fetch messages from the last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const messages = await groupMessagesCol
      .find({
        groupId: groupId,
        timestamp: { $gte: oneDayAgo }
      })
      .sort({ timestamp: 1 })
      .toArray();

    if (messages.length < 15) {
      console.log(`[Analytics] Skipping group ${groupId} - only has ${messages.length} messages (minimum 15 required).`);
      if (messages.length > 0) {
        await sendHumanLikeResponse(sock, groupId, {
          text: `⚠️ *Not enough messages to generate daily analytics.* A minimum of 15 messages are required in the past 24 hours (Current: ${messages.length}).`
        });
      }
      return;
    }

    console.log(`[Analytics] Running Gemini analytics for group ${groupId} with ${messages.length} messages.`);

    // 2. Count messages per sender (Most messaged today is solely based on counts)
    const senderCounts: { [jid: string]: { name: string; count: number } } = {};
    for (const msg of messages) {
      if (!senderCounts[msg.senderJid]) {
        senderCounts[msg.senderJid] = { name: msg.senderName, count: 0 };
      }
      senderCounts[msg.senderJid].count++;
    }

    let mostMessagedJid = '';
    let maxCount = 0;
    for (const [jid, data] of Object.entries(senderCounts)) {
      if (data.count > maxCount) {
        maxCount = data.count;
        mostMessagedJid = jid;
      }
    }

    const mostMessagedTag = mostMessagedJid ? `@${mostMessagedJid.split('@')[0]}` : 'Not found today';

    // 3. Format messages history for Gemini
    const chatLog = messages
      .map(msg => `[${msg.senderName} (${msg.senderJid})]: ${msg.text}`)
      .join('\n');

    // 4. Construct prompt for Gemini
    const prompt = `
You are a witty, slightly sarcastic, and highly entertaining group chat analyst. You are analyzing a WhatsApp group chat from the past 24 hours.
Below is the chat transcript:
---
${chatLog}
---

IMPORTANT RULES:
- You MUST fill in ALL fields. NEVER return empty strings, "Not found today", or empty arrays.
- There are ${messages.length} messages from ${Object.keys(senderCounts).length} participants — there is ALWAYS something interesting to highlight.
- If the chat is casual/non-technical, adapt your analysis accordingly (humor, banter, hot takes, advice, and social dynamics ALL count).

Your task is to identify:
1. **Most valuable person (MVP)**: Select the user JID (in format "number@s.whatsapp.net" or "number@lid") who contributed the most value today. "Value" is broad — it could be answering questions, sharing useful info, giving advice, organizing plans, dropping knowledge, being the voice of reason, mediating drama, or even just keeping the group alive with great energy. Explain briefly and clearly why they were chosen.
2. **Most overblown / repetitive topic**: Identify a topic or theme that was beaten to death, got unnecessarily dramatic, went in circles, or was just plain cringe. Name the topic and identify the user JID who was most responsible for pushing it. Write the reason with a humorous/sarcastic pinch. If no single topic stands out as annoying, pick the most debated or controversial one and roast it lightly.
3. **Group Story / Summary**: Write a series of highly engaging, savage, witty, and humorous summary points (minimum 3, maximum 10 points) of the key discussions, events, drama, vibes, and moments that took place in the group today. Cover the actual conversations that happened — who said what, what topics were discussed, what was funny, what was awkward. Do NOT write generic filler like "The group was quiet today" — dig into the actual messages. Highlight arguments, funny remarks, hot takes, debates, or ridiculous statements with a lighthearted, sarcastic, or roast-like twist. Write from a third-person point of view. Use the real display names of users (e.g. "Virat Pandey asked about...") but do NOT include any JIDs, phone numbers, or @tags. Ensure it is captivating so group members are excited and curious to read it.

Please output the response exactly in this JSON format (ALL fields must be non-empty):
{
  "productive": {
    "jid": "user_jid_here (REQUIRED — pick someone)",
    "name": "user_display_name",
    "reason": "brief explanation of their contribution"
  },
  "annoying": {
    "topic": "topic name (REQUIRED — pick something)",
    "jid": "user_jid_here (REQUIRED — pick someone)",
    "name": "user_display_name",
    "reason": "humorous/sarcastic explanation"
  },
  "summary": [
    "Engaging story point 1 (REQUIRED — minimum 3 points)",
    "Engaging story point 2",
    "Engaging story point 3"
  ]
}
`;

    // 5. Query Gemini model with retry logic & fallback models for robustness
    const modelsToTry = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'];
    const MAX_RETRIES_PER_MODEL = 2;
    let aiResponseText = '';
    let lastError: any = null;

    modelLoop: for (const modelName of modelsToTry) {
      const model = ai.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json'
        }
      });

      console.log(`[Analytics] Trying Gemini model: ${modelName}`);

      for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
        try {
          const responseResult = await model.generateContent(prompt);
          aiResponseText = responseResult.response.text();
          console.log(`[Analytics] Success with model: ${modelName}`);
          break modelLoop; // Success! Exit both loops.
        } catch (apiErr: any) {
          lastError = apiErr;
          const status = apiErr?.status || apiErr?.response?.status;
          const errMsg = apiErr?.message || '';
          const isRetryable = status === 503 || status === 429 || 
                              errMsg.includes('503') || errMsg.includes('429') || 
                              errMsg.includes('Service Unavailable') || errMsg.includes('high demand');

          if (isRetryable && attempt < MAX_RETRIES_PER_MODEL) {
            const backoffMs = 3000 * Math.pow(2, attempt - 1); // 3s, 6s
            console.warn(`[Analytics] Model ${modelName} returned retryable error (status: ${status || 'unknown'}, msg: ${errMsg}), retrying in ${backoffMs / 1000}s (attempt ${attempt}/${MAX_RETRIES_PER_MODEL})...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          } else {
            console.warn(`[Analytics] Model ${modelName} failed on attempt ${attempt}. Error: ${errMsg}`);
            break; // Break retry loop, try next model in modelsToTry
          }
        }
      }
    }

    if (!aiResponseText) {
      console.error(`[Analytics] All Gemini models failed to generate content.`);
      throw lastError || new Error('All Gemini models failed');
    }

    console.log('[Analytics] Gemini raw response:', aiResponseText);

    // 6. Parse result
    let result = {
      productive: { jid: '', name: '', reason: '' },
      annoying: { topic: '', jid: '', name: '', reason: '' },
      summary: [] as string[]
    };

    try {
      result = JSON.parse(aiResponseText);
    } catch (parseErr) {
      console.error('[Analytics] Failed to parse Gemini response as JSON. Trying simple regex/cleanup...');
      const match = aiResponseText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          result = JSON.parse(match[0]);
        } catch (_) {
          console.error('[Analytics] Regex JSON extraction also failed. Raw text:', aiResponseText.substring(0, 500));
        }
      }
    }

    // 6b. Validate & log what Gemini returned — detect empty/default responses
    const hasProductivePerson = !!(result.productive?.jid && result.productive.jid.length > 5);
    const hasAnnoyingTopic = !!(result.annoying?.topic && result.annoying.topic !== 'Not found today' && result.annoying.topic.length > 0);
    const hasSummary = !!(result.summary && Array.isArray(result.summary) && result.summary.length > 0);

    console.log(`[Analytics] Parsed result quality — MVP: ${hasProductivePerson}, Annoying: ${hasAnnoyingTopic}, Summary: ${hasSummary} (${result.summary?.length || 0} points)`);

    // 6c. Generate fallback content from raw message data if Gemini returned empty fields
    if (!hasSummary) {
      console.warn('[Analytics] Gemini returned empty summary — generating fallback from message data.');
      // Build a basic summary from message activity
      const sortedSenders = Object.entries(senderCounts)
        .sort(([, a], [, b]) => b.count - a.count)
        .slice(0, 5);

      const fallbackPoints: string[] = [];
      fallbackPoints.push(`Today saw ${messages.length} messages from ${Object.keys(senderCounts).length} participants.`);

      if (sortedSenders.length >= 2) {
        fallbackPoints.push(`${sortedSenders[0][1].name} dominated the chat with ${sortedSenders[0][1].count} messages, while ${sortedSenders[1][1].name} followed with ${sortedSenders[1][1].count}.`);
      }

      // Find the quietest active participant
      const quietest = sortedSenders[sortedSenders.length - 1];
      if (quietest && sortedSenders.length > 2) {
        fallbackPoints.push(`${quietest[1].name} played it cool with just ${quietest[1].count} messages — quality over quantity, perhaps?`);
      }

      result.summary = fallbackPoints;
    }

    if (!hasProductivePerson && mostMessagedJid) {
      console.warn('[Analytics] Gemini returned no MVP — falling back to most active sender.');
      result.productive = {
        jid: mostMessagedJid,
        name: senderCounts[mostMessagedJid]?.name || 'Unknown',
        reason: `Most active participant with ${maxCount} messages — keeping the group alive counts as value!`
      };
    }

    // 6d. Persist this day's analytics so weekly/monthly/yearly leaderboards can aggregate it.
    await saveDailySummary({
      groupId,
      totalMessages: messages.length,
      participantCount: Object.keys(senderCounts).length,
      mvp: {
        jid: result.productive?.jid || mostMessagedJid || '',
        name:
          result.productive?.name ||
          (mostMessagedJid ? senderCounts[mostMessagedJid]?.name || 'Unknown' : 'Unknown'),
        reason: result.productive?.reason || '',
      },
      annoying: {
        topic: result.annoying?.topic || '',
        jid: result.annoying?.jid || '',
        name: result.annoying?.name || '',
        reason: result.annoying?.reason || '',
      },
      summary: Array.isArray(result.summary) ? result.summary : [],
      senderCounts: Object.entries(senderCounts).map(([jid, data]) => ({
        jid,
        name: data.name,
        count: data.count,
      })),
    });

    // 7. Format output report message
    const mentions: string[] = [];
    if (mostMessagedJid) mentions.push(mostMessagedJid);
    
    let productiveLine = 'Not found today';
    if (result.productive && result.productive.jid) {
      const pJid = result.productive.jid;
      mentions.push(pJid);
      productiveLine = `@${pJid.split('@')[0]} (${result.productive.name}) - ${result.productive.reason}`;
    } else if (result.productive && result.productive.reason) {
      productiveLine = result.productive.reason;
    }

    let annoyingLine = 'Not found today';
    if (result.annoying && result.annoying.topic && result.annoying.topic !== 'Not found today') {
      const aJid = result.annoying.jid;
      if (aJid) {
        mentions.push(aJid);
        annoyingLine = `*${result.annoying.topic}* by @${aJid.split('@')[0]} (${result.annoying.name}) ${result.annoying.reason ? `- ${result.annoying.reason}` : ''}`;
      } else {
        annoyingLine = `*${result.annoying.topic}* - ${result.annoying.reason || 'No specific person tagged.'}`;
      }
    }

    // Build group story summary (max 10 points, no user tags)
    let storySummary = '';
    if (result.summary && Array.isArray(result.summary) && result.summary.length > 0) {
      const points = result.summary.slice(0, 10);
      storySummary = points.map((point) => `🔹 ${point}`).join('\n\n');
    } else {
      storySummary = '🔹 _No notable stories today._';
    }

    const participantCount = Object.keys(senderCounts).length;
    const reportMessage = `📊 *Daily Group Analytics (Past 24 Hours)* 📊
━━━━━━━━━━━━━━━━━━━━━━━━━━

🏆 *Today's MVP:*
👉 ${productiveLine}

📈 *Most Active Today:*
👉 ${mostMessagedTag} (${maxCount} messages out of ${messages.length} total from ${participantCount} participants)

🙄 *Most Overblown Topic:*
👉 ${annoyingLine}

━━━━━━━━━━━━━━━━━━━━━━━━━━

📖 *Today's Group Story:*

${storySummary}

━━━━━━━━━━━━━━━━━━━━━━━━━━
_Generated automatically using Gemini AI_ 🤖`;

    // 8. Post to the group
    await sendHumanLikeResponse(sock, groupId, {
      text: reportMessage,
      mentions: mentions
    });

    console.log(`[Analytics] Successfully sent analytics report to group ${groupId}`);

  } catch (err) {
    console.error(`[Analytics] Error running group analytics for ${groupId}:`, err);
  }
}
