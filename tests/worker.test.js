// worker.test.js — Exercise scheduling, permanent history, and Telegram failures.
// Real SQLite runs the production SQL; outbound requests are intercepted without credentials.
// Author: Pasquale Marzaioli
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { compileCatalog, normalize } from "../scripts/catalog.js";
import worker, { localClock, sendDaily, sendTelegram, settings } from "../src/worker.js";

const source = JSON.parse(readFileSync(new URL("../data/catalog.json", import.meta.url), "utf8"));
const fullCatalog = compileCatalog(source);
// Preserve the original small collection for focused scheduling and failure scenarios.
const starter = { words: source.words.slice(0, 27), readings: source.readings.slice(0, 9) };
const catalog = compileCatalog(starter);
const schema = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const date = new Date("2026-10-09T10:00:00Z");

// Adapt the D1 methods used by the worker to actual SQLite, including batch rollback.
class LocalD1 {
  constructor(t) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(schema);
    this.db.exec(catalog.sql);
    t.after(() => this.db.close());
  }
  prepare(sql, values = []) {
    const statement = this.db.prepare(sql);
    return {
      bind: (...bindings) => this.prepare(sql, bindings),
      run: async () => ({ meta: { changes: Number(statement.run(...values).changes) } }),
      all: async () => ({ results: statement.all(...values) }),
    };
  }
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.all());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function setup(t) {
  const sent = [];
  const env = {
    DB: new LocalD1(t), TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz",
    TELEGRAM_CHAT_ID: "12345", LANGUAGES: "it,fr,en", SEND_TIME: "09:00", TIME_ZONE: "Europe/Berlin",
  };
  t.mock.method(globalThis, "setTimeout", (callback) => { callback(); return 0; });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).hostname, "api.telegram.org");
    const body = JSON.parse(options.body);
    assert.equal(body.chat_id, env.TELEGRAM_CHAT_ID);
    assert.equal(body.parse_mode, undefined);
    assert.ok(body.text.length <= 4096);
    sent.push(body.text);
    return Response.json({ ok: true, result: { message_id: sent.length } });
  });
  return { env, sent };
}

test("the starter catalog contains nine days of words and original readings", () => {
  assert.equal(catalog.words.length, 27);
  assert.equal(catalog.readings.length, 9);
  for (const language of ["it", "fr", "en"]) {
    assert.equal(catalog.words.filter((word) => word.language === language).length, 9);
    assert.equal(catalog.readings.filter((reading) => reading.language === language).length, 3);
  }
  assert.equal(normalize("PERSPÍCUO!"), normalize("perspícuo"));
});

test("the expanded catalog retains the starter content and contains 367 complete days", () => {
  assert.equal(fullCatalog.words.length, 1101);
  assert.equal(fullCatalog.readings.length, 367);
  for (const language of ["it", "fr", "en"]) {
    assert.equal(fullCatalog.words.filter((word) => word.language === language).length, 367);
    assert.equal(fullCatalog.readings.filter((reading) => reading.language === language).length, language === "it" ? 123 : 122);
  }
  // Mixed collections include translated poems and whole-book pages that repeat individual works.
  for (const reading of fullCatalog.readings) {
    assert.doesNotMatch(reading.workId, /^carducci-(?:in-maggio|lungi-lungi|passa-la-nave-mia)$/);
    assert.doesNotMatch(decodeURIComponent(reading.source), /\/(?:Texte_entier|Texte_intégral)$/);
  }
  for (const reading of fullCatalog.readings.filter((item) => item.author === "William Shakespeare")) {
    assert.equal(reading.text.split("\n").filter(Boolean).length, 14, reading.title);
  }
  const nightingale = fullCatalog.readings.find((reading) => reading.title === "Ode to a Nightingale");
  assert.equal(nightingale.excerpt, false);
  assert.equal(nightingale.text.split("\n").filter(Boolean).length, 80);
  const readingTexts = fullCatalog.readings.map((reading) => ({ language: reading.language, text: normalize(reading.text) }));
  for (const word of fullCatalog.words.slice(27)) {
    assert.equal(word.license, "CC-BY-SA-4.0");
    assert.match(word.source, /wiktionary\.org\/w\/index\.php\?title=.+&oldid=\d+$/);
    assert.match(word.message, /https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\//);
    assert.ok(!readingTexts.some((reading) => reading.language === word.language &&
      reading.text.includes(normalize(word.example))), `Example repeats a bundled reading: ${word.lemma}`);
  }
});

test("additive import supplies 366 future days while preserving the already delivered day", async (t) => {
  const { env, sent } = setup(t);
  env.SEND_TIME = "06:30";
  assert.equal(await sendDaily(env, date), "sent");
  const history = env.DB.db.prepare("SELECT * FROM used_words ORDER BY language").all();
  const readings = env.DB.db.prepare("SELECT * FROM used_readings").all();
  env.DB.db.exec(fullCatalog.sql);
  assert.deepEqual(env.DB.db.prepare("SELECT * FROM used_words ORDER BY language").all(), history);
  assert.deepEqual(env.DB.db.prepare("SELECT * FROM used_readings").all(), readings);
  assert.equal(await sendDaily(env, date), "already-claimed");
  for (let day = 0; day < 366; day++) {
    const before = sent.length;
    assert.equal(await sendDaily(env, new Date(Date.UTC(2026, 9, 10 + day, 10))), "sent", `Future day ${day + 1}`);
    assert.equal(sent.length - before, 4);
  }
  assert.equal(sent.length, 1468);
  assert.equal(new Set(sent).size, 1468);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM used_words").get().n, 1101);
  assert.equal(env.DB.db.prepare("SELECT COUNT(DISTINCT example_key) AS n FROM used_words").get().n, 1101);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM used_readings").get().n, 367);
  assert.deepEqual(env.DB.db.prepare("SELECT language, COUNT(*) AS n FROM used_readings GROUP BY language ORDER BY language").all()
    .map((row) => ({ ...row })), [{ language: "en", n: 122 }, { language: "fr", n: 122 }, { language: "it", n: 123 }]);
  assert.equal(await sendDaily(env, new Date(Date.UTC(2026, 9, 376, 10))), "sent");
  assert.match(sent.at(-1), /No unused content/);
  assert.equal(await sendDaily(env, new Date(Date.UTC(2026, 9, 377, 10))), "empty");
});

test("catalog import rejects translated, oversized, overlapping, or duplicated content", () => {
  for (const mutate of [
    (copy) => { copy.readings[0].isTranslation = true; },
    (copy) => { copy.readings[0].originalLanguage = "ja"; },
    (copy) => { copy.words[0].definitionLanguage = "en"; },
    (copy) => { copy.words[0].source = "javascript:alert(1)"; },
    (copy) => { copy.words[0].license = "unsupported"; },
    (copy) => { copy.words[0].license = "CC-BY-SA-4.0"; },
    (copy) => { copy.words[0].exampleAttribution = ""; },
    (copy) => { copy.words.push({ ...copy.words[0], lemma: "PERSPI CUO" }); copy.words.at(-1).example = copy.words[1].example; },
    (copy) => { copy.readings[0].text = "x".repeat(3501); },
    (copy) => { copy.readings.push({ ...copy.readings[0], text: "A different excerpt.", excerpt: true, start: 1, end: 2 }); },
    (copy) => { copy.words.push({ ...copy.words[0], lemma: "PERSPICUO!", example: "A different example." }); },
  ]) {
    const copy = structuredClone(starter);
    mutate(copy);
    assert.throws(() => compileCatalog(copy));
  }
});

test("local scheduling follows daylight saving time and validates preferences", () => {
  assert.deepEqual(localClock(new Date("2026-10-24T07:00:00Z"), "Europe/Berlin"), { day: "2026-10-24", time: "09:00" });
  assert.deepEqual(localClock(new Date("2026-10-25T08:00:00Z"), "Europe/Berlin"), { day: "2026-10-25", time: "09:00" });
  assert.equal(localClock(new Date("2026-10-09T22:00:00Z"), "Europe/Berlin").day, "2026-10-10");
  assert.equal(localClock(new Date("2026-10-09T22:00:00Z"), "Europe/Berlin").time, "00:00");
  for (const bad of [{ LANGUAGES: "" }, { LANGUAGES: "it,it" }, { SEND_TIME: "25:00" },
    { TIME_ZONE: "Invalid/Zone" }, { REGISTERS: "common" }, { READING_KIND: "translation" },
    { MAX_READING_CHARACTERS: "4000" }, { PAUSED: "yes" }]) {
    assert.throws(() => settings(bad));
  }
});

test("the sender stays quiet before the chosen time and while paused", async (t) => {
  const { env, sent } = setup(t);
  assert.equal(await sendDaily(env, new Date("2026-10-09T06:30:00Z")), "not-due");
  assert.equal(await sendDaily({ ...env, PAUSED: "true" }, date), "not-due");
  assert.equal(sent.length, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n, 0);
});

test("one date produces three word messages and one reading, even with concurrent triggers", async (t) => {
  const { env, sent } = setup(t);
  const results = await Promise.all([sendDaily(env, date), sendDaily(env, date)]);
  assert.deepEqual(results.sort(), ["already-claimed", "sent"]);
  assert.equal(sent.length, 4);
  assert.match(sent[0], / · IT/);
  assert.match(sent[1], / · FR/);
  assert.match(sent[2], / · EN/);
  assert.match(sent[3], /Complete poem|Complete prose|Excerpt/);
  assert.equal(await sendDaily(env, date), "already-claimed");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM used_words").get().n, 3);
});

test("selection shuffles unused words and readings instead of taking alphabetic or catalog order", async (t) => {
  const { env } = setup(t);
  const alphabetic = env.DB.db.prepare("SELECT language, MIN(lemma_key) AS lemma_key FROM words GROUP BY language").all();
  // Control SQLite's random draws so the regression never depends on chance.
  let draws = 0;
  env.DB.db.function("random", () => -(++draws));
  await sendDaily(env, date);
  assert.equal(draws, catalog.words.length + catalog.readings.length);
  for (const first of alphabetic) {
    const chosen = env.DB.db.prepare("SELECT lemma_key FROM used_words WHERE language = ?").get(first.language);
    assert.notEqual(chosen.lemma_key, first.lemma_key);
  }
  assert.notEqual(env.DB.db.prepare("SELECT text_key FROM used_readings").get().text_key, catalog.readings[0].textKey);
});

test("nine daily runs never reuse a word, example, or reading and balance reading languages", async (t) => {
  const { env, sent } = setup(t);
  for (let day = 9; day <= 17; day++) {
    assert.equal(await sendDaily(env, new Date(`2026-10-${String(day).padStart(2, "0")}T10:00:00Z`)), "sent");
  }
  assert.equal(sent.length, 36);
  assert.equal(new Set(sent).size, 36);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM used_words").get().n, 27);
  assert.equal(env.DB.db.prepare("SELECT COUNT(DISTINCT example_key) AS n FROM used_words").get().n, 27);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM used_readings").get().n, 9);
  const rotation = env.DB.db.prepare("SELECT language FROM used_readings ORDER BY day").all().map((row) => row.language);
  for (let prefix = 1; prefix <= rotation.length; prefix++) {
    const counts = ["it", "fr", "en"].map((language) => rotation.slice(0, prefix).filter((item) => item === language).length);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  }
  assert.equal(await sendDaily(env, new Date("2026-10-18T10:00:00Z")), "sent");
  assert.match(sent.at(-1), /No unused content/);
  assert.equal(await sendDaily(env, new Date("2026-10-19T10:00:00Z")), "empty");
  assert.equal(sent.length, 37);
});

test("language, register, and prose preferences restrict the selection", async (t) => {
  const { env, sent } = setup(t);
  assert.equal(await sendDaily({ ...env, LANGUAGES: "fr", REGISTERS: "rare", READING_KIND: "prose" }, date), "sent");
  assert.equal(sent.length, 2);
  assert.match(sent[0], /rare/);
  assert.match(sent[1], /La Parure/);
  assert.match(sent[1], /Excerpt/);
});

test("missing language content does not stop other configured languages", async (t) => {
  const { env, sent } = setup(t);
  await sendDaily({ ...env, LANGUAGES: "it,de" }, date);
  assert.equal(sent.length, 3);
  assert.match(sent[0], / · IT/);
  assert.match(sent.at(-1), /Words in DE/);
});

test("reimporting an edited catalog preserves history and blocks overlapping extracts", async (t) => {
  const { env, sent } = setup(t);
  await sendDaily(env, date);
  const usedWord = env.DB.db.prepare("SELECT lemma_key FROM used_words WHERE language = 'it'").get().lemma_key;
  const usedReading = env.DB.db.prepare("SELECT text_key FROM used_readings").get().text_key;
  const previous = catalog.readings.find((reading) => reading.textKey === usedReading);
  const changed = structuredClone(starter);
  changed.words.find((word) => normalize(word.lemma) === usedWord).example = "Una nuova frase non rende nuova la parola già inviata.";
  const editedReading = changed.readings.find((reading) => reading.workId === previous.workId);
  editedReading.edition = "Corrected edition metadata";
  editedReading.excerpt = true;
  editedReading.end = 50;
  env.DB.db.exec(compileCatalog(changed).sql);
  const edited = env.DB.db.prepare("SELECT range_end, message FROM readings WHERE text_key = ?").get(previous.textKey);
  assert.equal(edited.range_end, 50);
  assert.match(edited.message, /Corrected edition metadata/);
  assert.equal(env.DB.db.prepare("SELECT range_end FROM used_readings WHERE text_key = ?").get(previous.textKey).range_end, previous.end);
  env.DB.db.prepare("INSERT INTO readings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "different-text-hash", previous.language, previous.language, previous.workKey, "prose", 0, 1, 20, "Previously covered passage",
  );
  await sendDaily(env, new Date("2026-10-10T10:00:00Z"));
  assert.equal(sent.length, 8);
  assert.equal(sent.filter((text) => normalize(text.split(" · ")[0]) === usedWord).length, 1);
  assert.ok(!sent.includes("Previously covered passage"));
  assert.throws(() => env.DB.db.prepare("INSERT INTO used_readings VALUES (?, ?, ?, ?, ?, ?)")
    .run("new-hash", previous.workKey, 0, 1, previous.language, "2026-10-10"), /overlaps/);
});

test("a failed batch rolls back every reservation", async (t) => {
  const db = new LocalD1(t);
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO deliveries VALUES ('2026-10-09', 'reserved', CURRENT_TIMESTAMP)"),
    db.prepare("INSERT INTO deliveries VALUES ('2026-10-09', 'reserved', CURRENT_TIMESTAMP)"),
  ]));
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n, 0);
});

test("uncertain Telegram delivery never retries or exposes credentials", async (t) => {
  const { env, sent } = setup(t);
  t.mock.method(globalThis, "fetch", async (url) => { throw new Error(`Network failure: ${url}`); });
  await assert.rejects(sendDaily(env, date), /stopped without retrying/);
  assert.equal(await sendDaily(env, date), "already-claimed");
  assert.equal(env.DB.db.prepare("SELECT status FROM deliveries").get().status, "uncertain");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM used_words").get().n, 3);
  assert.equal(sent.length, 0);
  await assert.rejects(sendTelegram(env, "A message"), (error) => !error.message.includes(env.TELEGRAM_BOT_TOKEN));
});

test("Telegram rejects, malformed responses, and missing tokens cannot bypass checks", async (t) => {
  const { env } = setup(t);
  await assert.rejects(sendDaily({ ...env, TELEGRAM_BOT_TOKEN: "" }, date), /Configure/);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n, 0);
  for (const response of [Response.json({ ok: false }, { status: 403 }), Response.json({ ok: true }), new Response("invalid")]) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(sendTelegram(env, "A message"), /not confirmed/);
  }
  await assert.rejects(sendTelegram(env, "x".repeat(4097)), /4096/);
});

test("public HTTP requests cannot trigger delivery or expose settings", async () => {
  const response = await worker.fetch(new Request("https://example.com/send"));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.ok(!(await response.text()).includes("TELEGRAM"));
});

test("the setup prompt hides tokens and lists only private chats without sending messages", () => {
  const token = "123456:abcdefghijklmnopqrstuvwxyz";
  const script = new URL("../scripts/telegram.js", import.meta.url);
  for (const [input, mock, expected, exitCode, identity = { ok: true, result: { is_bot: true, username: "Correct_bot" } }] of [
    [token, `return Response.json({ok:true,result:[
      {message:{chat:{id:12,type:"private",first_name:"Owner"}}},
      {message:{chat:{id:12,type:"private",first_name:"Owner"}}},
      {message:{chat:{id:-34,type:"group",first_name:"Group"}}}
    ]});`, /Owner: TELEGRAM_CHAT_ID=12/, 0],
    [token, "return Response.json({ok:true,result:[]});", /No private message found\. Send \/start to @Correct_bot/, 0],
    [token, "return Response.json({ok:true,result:null});", /Telegram returned unexpected messages/, 1],
    [token, "return Response.json({ok:false}, {status:401});", /Telegram rejected/, 1],
    [token, "throw new Error(url);", /Could not contact Telegram/, 1],
    [token, "throw new Error('Must not poll');", /Telegram returned an unexpected bot identity/, 1, { ok: true, result: { is_bot: true } }],
    [token, "throw new Error('Must not poll');", /Telegram rejected/, 1, { ok: false }],
    ["invalid-token", "throw new Error('Must not fetch');", /Enter a valid/, 1],
  ]) {
    // Inject a network stub before running the real CLI with piped private input.
    const stub = `globalThis.fetch = async (url, options) => {
      if (options.method !== 'POST') throw new Error('Unexpected request');
      if (url.endsWith('/getMe')) return Response.json(${JSON.stringify(identity)});
      if (!url.endsWith('/getUpdates')) throw new Error('Unexpected request');
      const body = JSON.parse(options.body);
      if (body.timeout !== 60 || body.allowed_updates.join(',') !== 'message') throw new Error('Unexpected polling settings');
      ${mock}
    };`;
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, script.pathname], {
      input: `${input}\n`, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, exitCode);
    const output = result.stdout + result.stderr;
    assert.match(output, expected);
    assert.ok(!output.includes(input));
    assert.ok(!output.includes("Group"));
    if (input === token && identity.result?.username) {
      assert.match(output, /Open https:\/\/t\.me\/Correct_bot/);
    }
    assert.equal((output.match(/TELEGRAM_CHAT_ID=/g) ?? []).length, exitCode === 0 && output.includes("Owner") ? 1 : 0);
  }
});
