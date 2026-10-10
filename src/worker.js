// worker.js — Send one rare word per chosen language and one original reading each day.
// D1 reserves content before Telegram requests so retries and crashes cannot resend it.
// Author: Pasquale Marzaioli
export function settings(env) {
  const languages = (env.LANGUAGES ?? "it,fr,en").split(",").map((value) => value.trim());
  if (languages.length > 10 || new Set(languages).size !== languages.length ||
      languages.some((value) => !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(value))) {
    throw new Error("LANGUAGES must contain 1–10 unique lowercase language tags.");
  }
  const registers = (env.REGISTERS ?? "literary,rare,archaic").split(",").map((value) => value.trim());
  if (registers.some((value) => !["literary", "rare", "archaic"].includes(value))) {
    throw new Error("REGISTERS must contain literary, rare, or archaic.");
  }
  const sendTime = env.SEND_TIME ?? "09:00";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) {
    throw new Error("SEND_TIME must be a local time in HH:MM format.");
  }
  const timeZone = env.TIME_ZONE ?? "Europe/Berlin";
  new Intl.DateTimeFormat("en", { timeZone }).format();
  const readingKind = env.READING_KIND ?? "any";
  if (!["any", "poetry", "prose"].includes(readingKind)) {
    throw new Error("READING_KIND must be any, poetry, or prose.");
  }
  const maxCharacters = Number(env.MAX_READING_CHARACTERS ?? "3500");
  if (!Number.isInteger(maxCharacters) || maxCharacters < 100 || maxCharacters > 3500) {
    throw new Error("MAX_READING_CHARACTERS must be an integer between 100 and 3500.");
  }
  if (!["true", "false"].includes(env.PAUSED ?? "false")) {
    throw new Error("PAUSED must be true or false.");
  }
  return { languages, registers, sendTime, timeZone, readingKind, maxCharacters, paused: env.PAUSED === "true" };
}

export function localClock(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export async function sendTelegram(env, text) {
  if (!text || text.length > 4096) {
    throw new Error("Telegram messages must contain 1–4096 characters.");
  }
  // Plain text preserves literary punctuation and does not interpret catalog markup.
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true || !Number.isInteger(result.result?.message_id)) {
      throw new Error("Telegram did not confirm delivery.");
    }
    return result.result.message_id;
  } catch {
    // Network exceptions may contain the token URL; keep them out of logs and errors.
    throw new Error("Telegram delivery was not confirmed; automatic retry is disabled.");
  }
}

export async function sendDaily(env, date = new Date()) {
  const config = settings(env);
  const clock = localClock(date, config.timeZone);
  if (config.paused || clock.time < config.sendTime) {
    return "not-due";
  }
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(env.TELEGRAM_BOT_TOKEN ?? "") ||
      !/^\d+$/.test(env.TELEGRAM_CHAT_ID ?? "")) {
    throw new Error("Configure a bot token and a positive private Telegram chat ID as secrets.");
  }

  // A unique local date is the lock, including when two cron invocations overlap.
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO deliveries(day, status) VALUES (?, 'reserved')",
  ).bind(clock.day).run();
  if (claim.meta.changes === 0) {
    return "already-claimed";
  }

  const registerSlots = config.registers.map(() => "?").join(",");
  const languageSlots = config.languages.map(() => "?").join(",");
  // D1 samples unused content; permanent reservations exclude every previous selection.
  const selections = await env.DB.batch([
    ...config.languages.map((language) => env.DB.prepare(`
      SELECT * FROM words w WHERE language = ? AND register IN (${registerSlots})
      AND NOT EXISTS (SELECT 1 FROM used_words u WHERE u.language = w.language AND u.lemma_key = w.lemma_key)
      AND NOT EXISTS (SELECT 1 FROM used_words u WHERE u.example_key = w.example_key)
      ORDER BY random() LIMIT 1
    `).bind(language, ...config.registers)),
    env.DB.prepare(`
      SELECT * FROM readings r WHERE language IN (${languageSlots})
      AND original_language = language AND text_length <= ? AND (? = 'any' OR kind = ?)
      AND NOT EXISTS (SELECT 1 FROM used_readings u WHERE u.text_key = r.text_key
        OR (u.work_key = r.work_key AND u.range_start < r.range_end AND u.range_end > r.range_start))
      ORDER BY (SELECT COUNT(*) FROM used_readings u WHERE u.language = r.language), random() LIMIT 1
    `).bind(...config.languages, config.maxCharacters, config.readingKind, config.readingKind),
    env.DB.prepare("SELECT notice_key FROM notices"),
  ]);

  const seenNotices = new Set(selections.at(-1).results.map((row) => row.notice_key));
  const statements = [];
  const texts = [];
  const exhausted = [];
  const noticeLabels = new Map();
  for (const [index, language] of config.languages.entries()) {
    const word = selections[index].results[0];
    if (word) {
      texts.push(word.message);
      statements.push(env.DB.prepare("INSERT INTO used_words VALUES (?, ?, ?, ?)")
        .bind(word.language, word.lemma_key, word.example_key, clock.day));
    } else {
      const key = `word:${language}:${config.registers.join(",")}`;
      exhausted.push(key);
      noticeLabels.set(key, `Words in ${language.toUpperCase()}`);
    }
  }
  const reading = selections[config.languages.length].results[0];
  if (reading) {
    texts.push(reading.message);
    statements.push(env.DB.prepare("INSERT INTO used_readings VALUES (?, ?, ?, ?, ?, ?)")
      .bind(reading.text_key, reading.work_key, reading.range_start, reading.range_end, reading.language, clock.day));
  } else {
    const key = `reading:${config.languages.join(",")}:${config.readingKind}:${config.maxCharacters}`;
    exhausted.push(key);
    noticeLabels.set(key, "Readings matching your preferences");
  }
  const newNotices = exhausted.filter((key) => !seenNotices.has(key));
  if (newNotices.length) {
    texts.push(`Millantare · ${clock.day}\n\nNo unused content matches these selections:\n${newNotices.map((key) => noticeLabels.get(key)).join("\n")}\n\nAdd new words or original readings to continue. Previous content will never be recycled.`);
    statements.push(...newNotices.map((key) => env.DB.prepare("INSERT INTO notices VALUES (?, ?)").bind(key, clock.day)));
  }
  if (!texts.length) {
    await env.DB.prepare("UPDATE deliveries SET status = 'empty' WHERE day = ?").bind(clock.day).run();
    return "empty";
  }

  // The batch commits all identities together or rolls back, never a partial reservation.
  // shortcut: interrupted deliveries can skip reserved content; upgrade only with idempotent Telegram sends.
  statements.push(...texts.map((_, position) => env.DB.prepare(
    "INSERT INTO messages(day, position, status) VALUES (?, ?, 'reserved')",
  ).bind(clock.day, position)));
  await env.DB.batch(statements);
  try {
    for (const [position, text] of texts.entries()) {
      if (position) {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      await env.DB.prepare("UPDATE messages SET status = 'attempted' WHERE day = ? AND position = ?")
        .bind(clock.day, position).run();
      const messageId = await sendTelegram(env, text);
      await env.DB.prepare("UPDATE messages SET status = 'sent', telegram_message_id = ? WHERE day = ? AND position = ?")
        .bind(messageId, clock.day, position).run();
    }
    await env.DB.prepare("UPDATE deliveries SET status = 'sent' WHERE day = ?").bind(clock.day).run();
    return "sent";
  } catch {
    await env.DB.prepare("UPDATE deliveries SET status = 'uncertain' WHERE day = ?").bind(clock.day).run();
    throw new Error("Daily delivery stopped without retrying reserved content. Inspect delivery history.");
  }
}

export default {
  async scheduled(controller, env) {
    await sendDaily(env, new Date(controller.scheduledTime));
  },
  async fetch() {
    // No public route can send messages, change settings, or inspect private history.
    return new Response("Millantare uses scheduled delivery.\n", {
      status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
