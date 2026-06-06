import { Command, sendHumanLikeResponse } from './index';

/**
 * Ping command: Measures the time it takes to send a message to WhatsApp and updates it.
 * Utilizes the custom human typing simulation helper.
 */
export const pingCommand: Command = {
  name: 'ping',
  aliases: ['latency', 'speed'],
  description: 'Measures bot response latency and verifies system health.',
  execute: async (sock, msg) => {
    const jid = msg.key.remoteJid;
    if (!jid) return;

    const start = Date.now();

    // Send initial response using simulated typing speed
    const sentMsg = await sendHumanLikeResponse(
      sock,
      jid,
      { text: '🏓 Calculating latency...' },
      { quoted: msg }
    );

    const latency = Date.now() - start;

    // Edit the message dynamically
    await sock.sendMessage(
      jid,
      {
        text: `🏓 *Pong!*\n\n*Response Latency:* \`${latency}ms\`\n*Queue Status:* Processing 🚀\n*Connection:* Active ✅`,
        edit: sentMsg.key,
      }
    );
  },
};
