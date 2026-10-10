// catalog.js — Validate multilingual content and produce an idempotent D1 import.
// Stable lexical and work identities preserve history when catalog entries are edited.
// Author: Pasquale Marzaioli
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const normalize = (text) => text.normalize("NFKC").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const hash = (text) => createHash("sha256").update(normalize(text)).digest("hex");
const quote = (value) => typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;

function requireText(value, name, max = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be nonempty text of at most ${max} characters without control characters.`);
  }
}

function requireSource(source) {
  requireText(source, "source", 300);
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Sources must be public HTTPS URLs without credentials.");
  }
}

export function compileCatalog(catalog) {
  if (!Array.isArray(catalog.words) || !Array.isArray(catalog.readings) ||
      !catalog.words.length || !catalog.readings.length) {
    throw new Error("A catalog must contain nonempty words and readings arrays.");
  }
  const words = [];
  const readings = [];
  const wordKeys = new Set();
  const exampleKeys = new Set();
  const textKeys = new Set();
  const sql = [
    "-- catalog.sql — Import verified content without replacing delivery history.",
    "-- Stable keys update catalog records; consumed identities remain untouched.",
    "-- Author: Pasquale Marzaioli",
  ];
  for (const word of catalog.words) {
    for (const field of ["language", "lemma", "partOfSpeech", "register", "definition", "example"]) {
      requireText(word[field], `word.${field}`);
    }
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(word.language) || word.definitionLanguage !== word.language) {
      throw new Error("Each word needs a lowercase language tag and a definition in that language.");
    }
    if (!["literary", "rare", "archaic"].includes(word.register)) {
      throw new Error("Word register must be literary, rare, or archaic.");
    }
    requireSource(word.source);
    if (word.license !== undefined && word.license !== "CC-BY-SA-4.0") {
      throw new Error("Reused lexical text must declare its supported CC-BY-SA-4.0 license.");
    }
    if (word.license) {
      requireText(word.rightsNote, "word.rightsNote");
    }
    if (word.exampleAttribution !== undefined) {
      requireText(word.exampleAttribution, "word.exampleAttribution");
    }
    const lemmaKey = normalize(word.lemma);
    const wordKey = `${word.language}:${lemmaKey}`;
    const exampleKey = hash(word.example);
    if (!lemmaKey || wordKeys.has(wordKey) || exampleKeys.has(exampleKey)) {
      throw new Error(`Duplicate word or example: ${wordKey}`);
    }
    wordKeys.add(wordKey);
    exampleKeys.add(exampleKey);
    // Keep source attribution and the reuse license with the text when a card is forwarded.
    const attribution = word.exampleAttribution ? `\nExample source: ${word.exampleAttribution}` : "";
    const license = word.license ? "\nLexical text adapted · CC BY-SA 4.0\nhttps://creativecommons.org/licenses/by-sa/4.0/" : "";
    const message = `${word.lemma} · ${word.language.toUpperCase()}\n${word.partOfSpeech} · ${word.register}\n\n${word.definition}\n\n“${word.example}”${attribution}\n\nSource: ${word.source}${license}`;
    requireText(message, "word.message", 4096);
    words.push({ ...word, lemmaKey, exampleKey, message });
    sql.push(`INSERT INTO words VALUES (${[word.language, lemmaKey, exampleKey, word.register, message].map(quote).join(", ")}) ON CONFLICT(language, lemma_key) DO UPDATE SET example_key=excluded.example_key, register=excluded.register, message=excluded.message;`);
  }
  for (const reading of catalog.readings) {
    for (const field of ["language", "originalLanguage", "workId", "title", "author", "edition", "rightsNote"]) {
      requireText(reading[field], `reading.${field}`);
    }
    requireText(reading.text, "reading.text", 3500);
    requireSource(reading.source);
    requireSource(reading.originalLanguageSource);
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(reading.language) ||
        reading.originalLanguage !== reading.language || reading.isTranslation !== false) {
      throw new Error(`Reading must be verified in its original language: ${reading.title}`);
    }
    if (!["poetry", "prose"].includes(reading.kind) || typeof reading.excerpt !== "boolean") {
      throw new Error("Readings need poetry/prose kind and an explicit excerpt flag.");
    }
    // Only public-domain texts are bundled; new licensing schemes require explicit review.
    if (reading.license !== "public-domain") {
      throw new Error("This catalog accepts public-domain readings only.");
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(reading.workId) || !Number.isSafeInteger(reading.start) ||
        !Number.isSafeInteger(reading.end) || reading.start < 0 || reading.end <= reading.start ||
        (!reading.excerpt && (reading.start !== 0 || reading.end !== Number.MAX_SAFE_INTEGER))) {
      throw new Error("Use stable work IDs and valid, consistent passage ranges; complete works cover the whole range.");
    }
    const workKey = `${reading.language}:${reading.workId}`;
    const textKey = hash(reading.text);
    if (textKeys.has(textKey) || readings.some((previous) => previous.workKey === workKey &&
        previous.start < reading.end && previous.end > reading.start)) {
      throw new Error(`Duplicate or overlapping reading: ${reading.title}`);
    }
    textKeys.add(textKey);
    const scope = reading.excerpt ? "Excerpt" : reading.kind === "poetry" ? "Complete poem" : "Complete prose";
    const message = `${reading.title} · ${reading.language.toUpperCase()}\n${reading.author}\n${scope} · ${reading.edition}\n\n${reading.text}\n\nSource: ${reading.source}\nRights: Public domain`;
    requireText(message, "reading.message", 4096);
    readings.push({ ...reading, textKey, workKey, message });
    sql.push(`INSERT INTO readings VALUES (${[
      textKey, reading.language, reading.originalLanguage, workKey, reading.kind,
      reading.start, reading.end, reading.text.length, message,
    ].map(quote).join(", ")}) ON CONFLICT(text_key) DO UPDATE SET language=excluded.language, original_language=excluded.original_language, work_key=excluded.work_key, kind=excluded.kind, range_start=excluded.range_start, range_end=excluded.range_end, text_length=excluded.text_length, message=excluded.message;`);
  }
  return { words, readings, sql: `${sql.join("\n")}\n` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const catalog = compileCatalog(JSON.parse(await readFile(new URL("../data/catalog.json", import.meta.url), "utf8")));
    if (process.argv.includes("--preview")) {
      for (const language of ["it", "fr", "en"]) {
        console.log(`${catalog.words.find((word) => word.language === language)?.message ?? ""}\n`);
      }
      console.log(catalog.readings[0].message);
    } else {
      await writeFile(new URL("../data/catalog.sql", import.meta.url), catalog.sql);
      console.log(`Catalog validated: ${catalog.words.length} words, ${catalog.readings.length} original readings.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
