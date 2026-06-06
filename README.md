# BlenderRevive WhatsApp Bot

A highly-optimized, queue-backed WhatsApp bot built with `@whiskeysockets/baileys`, using MongoDB for session storage, and Redis (via BullMQ) for asynchronous queue processing.

This setup is specifically designed to handle high-traffic environments, such as large group chats, without blocking the socket connection thread, causing message delay, or dropping connections.

## Key Features

- **Asynchronous Message Queueing (BullMQ)**: Every incoming message is immediately enqueued in Redis and processed asynchronously by worker threads.
- **Concurrent Processing**: Message worker processes up to 5 commands concurrently (configurable).
- **Custom MongoDB Auth State**: Stores session details, connection keys, and credentials directly in MongoDB using robust `BufferJSON` serialization.
- **Key Store Caching**: Memory caches keys via `makeCacheableSignalKeyStore` to minimize MongoDB read round-trips.
- **Automatic Reconnection**: Automatically restarts the connection loop if disconnected by WhatsApp servers.
- **Command Structure**: Simple, clean, and extensible command registry supporting command aliases, presence updates ("typing..."), and automatic error notifications.

---

## Infrastructure Stack (Docker)

The project includes a `docker-compose.yml` to run the complete database and queue stack locally. It includes:
1. **MongoDB**: Securely stores authentication states and sessions.
2. **Mongo Express**: Database manager GUI (accessible at http://localhost:8081).
3. **Redis**: Handles message queueing and concurrency.
4. **Redis Commander**: Redis inspector GUI (accessible at http://localhost:8082).

---

## Prerequisites

- Node.js (v18+)
- Docker and Docker Compose (for local database setup)

---

## Setup & Installation

1. **Clone the repository and go to the directory:**
   ```bash
   cd /Users/crysosancher/Documents/Cryso/Personal-Projects/BlenderRevive
   ```

2. **Start the database and queue servers:**
   ```bash
   docker compose up -d
   ```

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Verify / modify environment variables in `.env`:**
   ```env
   SESSION_ID=blender-revive-session
   BOT_PREFIX=/
   MONGO_URI=mongodb://root:rootpassword@localhost:27017/admin
   MONGO_DB_NAME=whatsapp_bot
   REDIS_HOST=localhost
   REDIS_PORT=6379
   ```

---

## Running the Bot

### Development Mode
Runs the TypeScript code directly using `ts-node`:
```bash
npm run dev
```

### Production Mode
Compiles the code to JavaScript first and runs the production build:
```bash
npm run build
npm start
```

---

## Authenticating

1. Start the bot: `npm run dev`.
2. A QR code will be generated and printed inside your terminal.
3. Open WhatsApp on your phone -> **Settings** -> **Linked Devices** -> **Link a Device**.
4. Scan the printed QR code.
5. Your authentication details will be securely saved into MongoDB. Subsequent restarts will log in automatically without showing the QR code.

---

## Creating New Commands

To create a new command:
1. Create a new command file in `src/commands/mycommand.ts`:
   ```typescript
   import { Command } from './index';

   export const myCommand: Command = {
     name: 'hello',
     aliases: ['hi', 'greet'],
     description: 'Responds with a friendly greeting',
     execute: async (sock, msg, args) => {
       const jid = msg.key.remoteJid!;
       await sock.sendMessage(jid, { text: 'Hello from BlenderRevive Bot! 👋' }, { quoted: msg });
     }
   };
   ```
2. Import and register it inside `src/commands/index.ts`:
   ```typescript
   import { myCommand } from './mycommand';
   registerCommand(myCommand);
   ```

---

## Architecture Flow

```mermaid
graph TD
    A[WhatsApp Socket] -->|messages.upsert| B[Fast Filter & Enqueue]
    B -->|Redis Queue| C[BullMQ Message Queue]
    C -->|Job Processor| D[Concurrency Workers]
    D -->|Get Active Socket| E[Command Dispatcher]
    E -->|Lookup Command| F[Command Registry]
    F -->|Execute Ping/Help| G[Execute Command]
    G -->|Socket send message| H[Reply to WhatsApp]
    D -->|Fetch/Store Auth Keys| I[makeCacheableSignalKeyStore]
    I -->|Cache Miss / Write| J[MongoDB Session State]
```
