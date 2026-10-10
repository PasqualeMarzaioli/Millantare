// telegram.js — Find the owner's private chat ID without exposing a bot token.
// Read credentials through a hidden prompt, identify the bot, and await a private message.
// Author: Pasquale Marzaioli
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

const output = new Writable({ write(chunk, encoding, callback) { callback(); } });
const prompt = createInterface({ input: process.stdin, output, terminal: true });

// Keep API errors generic because request URLs contain the token.
async function telegram(token, method, body = {}, timeout = 15000) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json();
  if (!response.ok || data.ok !== true) {
    throw new Error("Telegram rejected the request. Check the token and ensure this bot has no webhook.");
  }
  return data.result;
}

try {
  process.stdout.write("Bot token (hidden): ");
  const token = (await prompt.question("")).trim();
  process.stdout.write("\n");
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error("Enter a valid Telegram bot token.");
  }
  const bot = await telegram(token, "getMe");
  if (bot?.is_bot !== true || typeof bot.username !== "string" || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username)) {
    throw new Error("Telegram returned an unexpected bot identity.");
  }
  console.log(`Open https://t.me/${bot.username} in Telegram and send /start. Waiting up to 60 seconds...`);
  const updates = await telegram(token, "getUpdates", { allowed_updates: ["message"], timeout: 60 }, 65000);
  if (!Array.isArray(updates)) {
    throw new Error("Telegram returned unexpected messages.");
  }
  const chats = new Map(updates.filter((update) => update.message?.chat?.type === "private")
    .map((update) => [update.message.chat.id, update.message.chat.first_name ?? "Private chat"]));
  if (!chats.size) {
    console.log(`No private message found. Send /start to @${bot.username}, then run this command again.`);
  }
  for (const [id, name] of chats) {
    console.log(`${name}: TELEGRAM_CHAT_ID=${id}`);
  }
} catch (error) {
  // Fetch exceptions can contain the credential URL; never print their raw messages.
  console.error(error.message.startsWith("Telegram") || error.message.startsWith("Enter") ? error.message : "Could not contact Telegram.");
  process.exitCode = 1;
} finally {
  prompt.close();
}
