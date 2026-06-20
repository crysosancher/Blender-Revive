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
 * Helper to format uptime in months, days, hours and minutes.
 */
function formatUptime(seconds: number): string {
  const totalHours = Math.floor(seconds / 3600);
  if (totalHours < 24) {
    const m = Math.floor((seconds % 3600) / 60);
    return `${totalHours}h ${m}m`;
  } else {
    const totalDays = Math.floor(totalHours / 24);
    const h = totalHours % 24;
    const months = Math.floor(totalDays / 30);
    const d = totalDays % 30;

    let parts: string[] = [];
    if (months > 0) {
      parts.push(`${months}mo`);
    }
    if (d > 0 || months > 0) {
      parts.push(`${d}d`);
    }
    parts.push(`${h}h`);
    return parts.join(' ');
  }
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
    const queueCount = Math.max(0, (await getQueueCount()) - 1);
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
