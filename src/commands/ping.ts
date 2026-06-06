import { Command, sendHumanLikeResponse } from './index';
import os from 'os';
import { getQueueCount } from '../queue/message-queue';

/**
 * Helper to convert bytes to Gigabytes.
 */
function toGB(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(2)} GB`;
}

/**
 * Helper to format uptime in hours and minutes.
 */
function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * Ping command: Measures the time it takes to send a message to WhatsApp and updates it
 * with a customized, premium Neofetch-style system status card showing resource usage.
 */
export const pingCommand: Command = {
  name: 'ping',
  aliases: ['latency', 'speed', 'alive', 'a'],
  description: 'Measures bot response latency and prints a neofetch-style system report.',
  execute: async (sock, msg) => {
    const jid = msg.key.remoteJid;
    if (!jid) return;

    const start = Date.now();

    // Send initial response simulating typing
    const sentMsg = await sendHumanLikeResponse(
      sock,
      jid,
      { text: '🏓 Calculating latency...' },
      { quoted: msg }
    );

    const latency = Date.now() - start;

    // Gather System Stats for the Neofetch display
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = ((usedMem / totalMem) * 100).toFixed(1);

    const uptime = formatUptime(os.uptime());
    const queueCount = await getQueueCount();
    const rawCpu = os.cpus()[0]?.model || 'Apple Silicon';
    const cpu = rawCpu.trim().replace(/\s+/g, ' '); // Clean up duplicate spacing

    const platform = os.platform();
    const osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';

    // Format Neofetch Layout
    let responseText = `🏓 *Pong!*\n\n`;
    responseText += `   /\\_/\\     *OS:* ${osName}\n`;
    responseText += `  ( o.o )    *CPU:* ${cpu}\n`;
    responseText += `   > ^ <     *Memory:* ${toGB(usedMem)} / ${toGB(totalMem)} (${memPercent}% used)\n`;
    responseText += `             *Uptime:* ${uptime}\n`;
    responseText += `             *Latency:* \`${latency}ms\`\n`;
    responseText += `             *Queue Status:* Processing 🚀 (${queueCount} in queue)\n`;
    responseText += `             *Connection:* Active ✅`;

    // Edit the message with the detailed report
    await sock.sendMessage(
      jid,
      {
        text: responseText,
        edit: sentMsg.key,
      }
    );
  },
};
