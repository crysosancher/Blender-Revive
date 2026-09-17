import { proto } from '@whiskeysockets/baileys';
import { Command, sendHumanLikeResponse, isSenderGroupAdmin } from './index';
import { frameTechnicalQuestion } from '../services/question-framer';

const prefix = process.env.BOT_PREFIX || '/';

function getQuotedText(quotedMessage: any): string {
  if (!quotedMessage) return '';
  if (quotedMessage.conversation) return quotedMessage.conversation;
  if (quotedMessage.extendedTextMessage?.text) return quotedMessage.extendedTextMessage.text;
  if (quotedMessage.imageMessage?.caption) return quotedMessage.imageMessage.caption;
  if (quotedMessage.videoMessage?.caption) return quotedMessage.videoMessage.caption;
  return '';
}

export const questionCommand: Command = {
  name: 'question',
  aliases: ['askbetter', 'betterquestion'],
  description: 'Helps rewrite vague technical questions into clear, specific requests.',
  execute: async (sock, msg) => {
    const jid = msg.key.remoteJid;
    if (!jid) return;

    if (!jid.endsWith('@g.us')) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: 'This command can only be used in a group.' },
        { quoted: msg }
      );
      return;
    }

    if (!(await isSenderGroupAdmin(sock, msg))) {
      await sendHumanLikeResponse(
        sock,
        jid,
        { text: 'Only group admins can use this command.' },
        { quoted: msg }
      );
      return;
    }

    const ctxInfo: any = (msg.message as any)?.extendedTextMessage?.contextInfo
      || (msg.message as any)?.imageMessage?.contextInfo
      || (msg.message as any)?.videoMessage?.contextInfo
      || null;
    const quotedUser = ctxInfo?.participant;
    const quotedText = getQuotedText(ctxInfo?.quotedMessage);

    if (!quotedText || !quotedUser) {
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          text: `⚠️ Reply to a vague question with \`${prefix}question\` so I can help improve it.`
        },
        { quoted: msg }
      );
      return;
    }

    const framedQuestion = await frameTechnicalQuestion(quotedText);
    const compact = (text: string) => text.replace(/\s*\n+\s*/g, ' ').trim();
    const assessment = compact(framedQuestion.assessment);
    const improvedQuestion = compact(framedQuestion.improvedQuestion);
    const examples = framedQuestion.examples
      .slice(0, 2)
      .map((example) => compact(example));

    await sendHumanLikeResponse(
      sock,
      jid,
      {
        text: `${framedQuestion.emoji} Hey @${quotedUser.split('@')[0]}!\nThis question is missing context: ${assessment}\nReframe it with the subject, exact issue, and details needed for a useful answer.\nTry: _${improvedQuestion}_\nExample: _${examples[0]}_\nExample: _${examples[1]}_`,
        mentions: [quotedUser]
      },
      { quoted: msg }
    );
  }
};
