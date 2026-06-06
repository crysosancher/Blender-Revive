import { Command, sendHumanLikeResponse } from './index';
import fs from 'fs';
import path from 'path';

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

    const localImagePath = path.join(process.cwd(), 'dev_avatar.jpg');

    // Check if we already have it downloaded, or download it dynamically
    let hasImage = fs.existsSync(localImagePath);
    if (!hasImage) {
      try {
        const response = await fetch('https://avatars.githubusercontent.com/u/77499291?s=400&u=9c45d7484e36a4d63d7ff0b73c8910f19982a54a&v=4');
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          fs.writeFileSync(localImagePath, buffer);
          hasImage = true;
        }
      } catch (err) {
        console.error('[DevCommand] Failed to download avatar image:', err);
      }
    }

    if (hasImage) {
      try {
        await sendHumanLikeResponse(
          sock,
          jid,
          {
            image: { url: localImagePath },
            caption: text
          },
          { quoted: msg }
        );
        return;
      } catch (err) {
        console.error('[DevCommand] Failed to send media response:', err);
      }
    }

    // Fallback to text message if image load/send fails
    await sendHumanLikeResponse(sock, jid, { text }, { quoted: msg });
  },
};
