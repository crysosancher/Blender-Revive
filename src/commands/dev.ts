import { Command, sendHumanLikeResponse } from './index';

/**
 * Dev command: Displays developer information and repository source links.
 */
export const devCommand: Command = {
  name: 'dev',
  aliases: ['src', 'source'],
  description: 'Displays developer and repository source information.',
  execute: async (sock, msg) => {
    const jid = msg.key.remoteJid;
    if (!jid) return;

    let text = `🤖 *Developer & Source Info*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `👤 *Developer:* Virat Pandey\n`;
    text += `🔗 *LinkedIn:* https://linkedin.com/in/crysosancher\n`;
    text += `🐙 *GitHub:* https://github.com/crysosancher\n`;
    text += `📦 *Repository:* https://github.com/crysosancher/Blender-Revive\n\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `⚡ _Powered by BlenderRevive Bot Core_`;

    // Send response with the developer's GitHub avatar as media and description as caption
    try {
      await sendHumanLikeResponse(
        sock,
        jid,
        {
          image: { url: 'https://avatars.githubusercontent.com/u/77499291?s=400&u=9c45d7484e36a4d63d7ff0b73c8910f19982a54a&v=4' },
          caption: text
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error('[DevCommand] Failed to send GitHub avatar image:', err);
      // Fallback to text message if image sending fails
      await sendHumanLikeResponse(sock, jid, { text }, { quoted: msg });
    }
  },
};
