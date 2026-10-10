<!-- README.md — Explain how to run and customize the personal vocabulary sender. -->
<!-- Cloudflare schedules deliveries and D1 preserves content history independently of the computer. -->
<!-- Author: Pasquale Marzaioli -->
# Millantare

A personal Telegram bot that sends one uncommon word in each selected language and one original literary reading every day. Definitions and examples use the word's own language. Readings retain their original language, spelling, punctuation, and verse structure; excerpts are explicitly identified.

The collection includes **2,936 words** (367 in each of eight languages) and **977 original readings** (123 Italian and 122 in each other language). Italian, French, and English remain the active defaults; German, Traditional Chinese, Japanese, Spanish, and Dutch are available to select. A fresh installation using the default languages has **367 complete days** with all registers, `READING_KIND="any"`, and the 3,500-character reading limit. An installation that has already consumed the initial day's three words and Italian reading has **366 complete days remaining**. Definitions and examples use their own language; readings include complete poems, short prose, and explicitly marked excerpts.

All previously bundled words and readings retain their identities and text, so updating an existing installation preserves its delivery history. Capacity depends on actual reservations and preferences: narrowing the language, register, reading kind, or length can reduce it. A single optional language has 367 words and 122 readings; its readings therefore cover 122 days before that selection pauses. This is a finite collection; add verified entries before it runs out.

## How it runs

Cloudflare Workers runs a short task every 15 minutes. After your chosen local time, the task reserves that day's words and reading in D1, sends them to your private Telegram chat, and exits. Your computer can be switched off. With the default languages, Telegram on your phone receives four messages: three word cards and one reading.

The first run after `SEND_TIME` sends the daily selection, normally within 15 minutes. Scheduling uses the configured time zone and follows daylight saving time. Missed dates are not backfilled. A date can be claimed only once; moving the delivery time or changing preferences does not create a second delivery that day.

Words are sampled randomly from eligible unused entries in each selected language. Readings favor languages with fewer previous reading reservations, then choose randomly among the eligible texts tied at that count. Neither selection follows alphabetical or file order. Random selection can still produce consecutive words beginning with the same letter; it never makes an already reserved word, example, or passage eligible again.

There are no runtime application dependencies, public sending endpoints, accounts for subscribers, or webhooks. Preferences live in `wrangler.toml`. Every person deploys a separate copy with their own secrets and database.

## Permanent history and delivery failures

- A word's identity is its language and normalized lemma. Changing its definition or example does not make it eligible again.
- Normalized examples cannot be reused, even under a different word.
- Readings are checked both by normalized text and by ranges within a stable work identity. Complete works cover the entire range, blocking all later excerpts from that work.
- Batch transactions and unique keys prevent concurrent jobs from reserving the same content.
- Catalog imports update content without deleting delivery history. Never delete or recreate D1 when adding entries or updating the worker.

**The delivery policy prioritizes avoiding duplicates over guaranteed receipt.** Content is reserved before calling Telegram. If a request times out, Telegram might already have delivered it, so the bot does not retry. A crash can leave some reserved messages undelivered; those words and readings are also never recycled. Failed days remain claimed. Inspect the delivery tables rather than deleting reservations or rerunning a date.

When a selected language runs out of unused words, other languages continue. If no eligible reading remains, readings pause. One exhaustion notice is attempted per selection; subsequent empty days stay quiet. Adding content automatically resumes the affected selection on the next unclaimed day. Original poems may contain the author's own repetitions: the bot prevents repeat **selections**, not repetitions inherent in an original text.

## Requirements

- Node.js **22.13 or newer** and npm for the initial setup.
- A free Cloudflare account with a verified email address, using **Workers Free**, with D1 enabled. Follow [Cloudflare's email verification steps](https://developers.cloudflare.com/fundamentals/user-profiles/verify-email-address/) before deploying.
- A Telegram account and a new bot created through [BotFather](https://t.me/BotFather).

The development tools are pinned in `package-lock.json`; the worker uses platform APIs directly. Workers and D1 have free usage quotas that comfortably accommodate this personal sender. On the D1 Free plan, exceeding a quota stops queries instead of charging overages. Do not upgrade to a paid plan if you require a strict zero-cost setup. No purchased domain is required. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## Initial setup

### Install Node.js and npm

Node.js runs the setup tools; npm installs the project's pinned dependencies. Install them once on the computer you use for setup:

1. Open the official [Node.js download page](https://nodejs.org/en/download), select a version marked **LTS**, and choose your operating system. Millantare requires Node.js **22.13 or newer**.
2. On **Windows**, download the `.msi` installer, open it, and complete the installation with npm and the PATH option enabled. On **macOS**, download the `.pkg` installer and follow its prompts. Both installers include npm, so you do not need a separate npm download. On **Linux**, select Linux on the download page and follow its installation instructions with npm selected. See the [official Node.js and npm installation guide](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/).
3. Close and reopen your terminal after installation: use **Command Prompt** on Windows, **Terminal** on macOS, or your terminal app on Linux. Check both commands:

   ```sh
   node --version
   npm --version
   ```

   Each command should print a version number. If a command is not found, restart the terminal or reinstall Node.js with npm included. If Node.js is older than 22.13, install a supported LTS version before continuing.

You can skip installation if both commands already work and Node.js meets the minimum version. No npm account or global Wrangler installation is needed; the project uses `npm ci` and `npx` below.

### Create a Cloudflare account

1. Open [Cloudflare's sign-up page](https://dash.cloudflare.com/sign-up), enter your email address and a password, and select **Create Account**. If you already have an account, sign in instead. See the [official account instructions](https://developers.cloudflare.com/fundamentals/account/create-account/).
2. Open the latest verification email from Cloudflare, follow its confirmation link, and sign in if prompted. Check your spam folder if the email is missing.
3. In the dashboard, open **My Profile** and check that your email is marked **verified**. If it is not, select **Send verification email** and use the new link. Follow the [email verification guide](https://developers.cloudflare.com/fundamentals/user-profiles/verify-email-address/) if verification fails.
4. Use **Workers Free** for this installation. You can continue with the CLI steps below without buying a domain or adding an existing website. Wrangler creates the Worker and D1 database in your own account.

### Create a Telegram account and bot

1. If needed, install Telegram, create your own account, and complete its sign-in prompts.
2. Open the official [@BotFather](https://t.me/BotFather) chat in Telegram and press **Start**.
3. Send `/newbot`. Choose a display name, then an available username ending in `bot`, such as `MyVocabulary_bot`. Use your own username; another person's bot is a separate installation.
4. BotFather returns a token. Save the token privately; copy only the token line when a hidden terminal prompt requests it. See [Telegram's bot creation instructions](https://core.telegram.org/bots/features#creating-a-new-bot).
5. Open the link to your new bot and press **Start**, or send `/start`. Leave this private chat available for the setup command below. The bot can remain silent until scheduled delivery is configured.

If the token is exposed, send `/revoke` to BotFather, choose the affected bot, and follow its instructions for a replacement token (`/token` retrieves a token if needed). Use the replacement in the hidden setup and Cloudflare secret prompts below. Updating a secret does not reset delivery history.

### Install and connect Millantare

1. Complete the Node.js and npm installation above, then download or clone [the Millantare repository](https://github.com/PasqualeMarzaioli/Millantare). On its GitHub page, select **Code → Download ZIP**, extract the archive, and open a terminal in its root folder, the directory containing `package.json`. To change folders from a terminal, type `cd`, a space, and the full path to the extracted folder in double quotes, then press Enter. All eight catalogs are already in `data/catalog.json`; no separate catalog download is needed. Install the pinned tools and run all subsequent commands from this project folder:

   ```sh
   npm ci
   ```

2. Finish the Cloudflare and Telegram steps above. Keep the bot token private; do not paste it into a repository, URL in a browser, screenshot, or chat.

3. Find your chat ID with the hidden-token prompt:

   ```sh
   npm run telegram:setup
   ```

   Run the command first. Wait for `Bot token (hidden):`, then paste only the token line from BotFather and press Enter. Do not paste the entire BotFather message or the token into the shell's command prompt. The hidden prompt displays no characters.

   The command shows the link to the bot associated with that token. Open that exact chat and send `/start`; it waits up to 60 seconds for a message, then prints available private chat IDs. Choose your own chat. If no ID appears, send `/start` again and rerun the command. A bot does not need to reply for this step to work. Use a dedicated new bot: this sender does not manage or remove existing webhooks.

4. Connect Wrangler, the deployment CLI, to your Cloudflare account:

   ```sh
   npx wrangler login
   ```

   In the browser tab that opens, sign in to your own Cloudflare account and select **Allow** to authorize Wrangler. Wait for the terminal to confirm login before continuing. If you receive an authentication error later, rerun `npx wrangler login` and complete that browser step again.

   Create your own database:

   ```sh
   npm run db:create
   ```

   Copy the resulting `database_id` into `wrangler.toml`, replacing its existing value with your own database ID. Keep the binding named `DB`. Do this once for each person's installation, not for updates; do not reuse another installation's database ID.

5. Apply the schema and import all eight catalogs into your remote D1 database:

   ```sh
   npm run db:migrate:remote
   npm run db:seed:remote
   ```

   Wait for both commands to finish successfully. The import includes all 2,936 words and 977 readings, including the five optional languages. It makes the content available without enabling those languages: only the tags in `LANGUAGES` are sent. For an existing installation, use its current database ID and run `npm run db:seed:remote` to add the catalogs; existing delivery history is preserved.

6. Store the credentials through the CLI's private prompts:

   ```sh
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```

   For `TELEGRAM_BOT_TOKEN`, enter the token from your own BotFather chat. For `TELEGRAM_CHAT_ID`, enter only the numeric ID printed by the setup command, without the `TELEGRAM_CHAT_ID=` prefix. Secret creation can ask to create the Worker before its first deployment; allow this for your own installation. Keep the credentials out of `wrangler.toml` and `data/catalog.json`.

7. Review your preferences in `wrangler.toml`, run the checks, and deploy:

   ```sh
   npm run lint
   npm test
   npm run build
   npm run deploy
   ```

   If the first deployment asks for a `workers.dev` subdomain, choose an available name for your account. This provides a project URL without a purchased domain; see [Cloudflare's subdomain instructions](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

   New cron settings can take up to 15 minutes to propagate. The bot sends at the first scheduled check after the configured local time. If you install after that time, it can send on the same day. No public URL can force an extra delivery. See [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

Once deployed, your computer is no longer needed for daily delivery. Initial CLI setup requires a computer or a terminal environment; this project does not include a phone-only installation wizard.

## Preferences

Edit `[vars]` in `wrangler.toml`, then deploy again.
If you change variables in the Cloudflare dashboard, copy those changes into `wrangler.toml` before the next deployment; deploying replaces dashboard values with the local configuration.

| Setting | Default | Meaning |
| --- | --- | --- |
| `LANGUAGES` | `it,fr,en` | One word per selected lowercase language tag; 1–10 distinct languages. Each needs catalog content. |
| `TIME_ZONE` | `Europe/Berlin` | IANA time zone, such as `Europe/Rome`. |
| `SEND_TIME` | `06:30` | Earliest daily sending time, in the selected local time zone. |
| `REGISTERS` | `literary,rare,archaic` | Include one or more of these editorial categories. |
| `READING_KIND` | `any` | `any`, `poetry`, or `prose`. |
| `MAX_READING_CHARACTERS` | `3500` | Maximum text length, excluding attribution; 100–3500. |
| `PAUSED` | `false` | Set `true` to suspend all sending without changing history. |

Reading languages are balanced among available unused readings in the selected languages, with random selection breaking ties. With the default languages, if the initial Italian reading has already been reserved, the next 366 readings supply 122 unused texts per language. A language that has no remaining eligible reading is skipped. No previous selection is used as a fallback.

## Choose another language or import a shared catalog

All eight catalogs arrive together in `data/catalog.json` when you download the project. Importing them makes their content available in D1; only tags listed in `LANGUAGES` are sent. The five optional catalogs are not enabled automatically.

| Language | Tag | Words | Original readings | Active by default |
| --- | --- | ---: | ---: | --- |
| Italian | `it` | 367 | 123 | Yes |
| French | `fr` | 367 | 122 | Yes |
| English | `en` | 367 | 122 | Yes |
| German | `de` | 367 | 122 | No |
| Traditional Chinese | `zh-hant` | 367 | 122 | No |
| Japanese | `ja` | 367 | 122 | No |
| Spanish | `es` | 367 | 122 | No |
| Dutch | `nl` | 367 | 122 | No |

Use the lowercase tag `zh-hant` for the bundled Traditional Chinese text. Selecting `zh` or `zh-hans` does not match it. Word definitions and examples use traditional characters; readings retain the traditional script and historical variants of the cited Chinese originals. The other new catalogs contain native-language definitions and examples and original literary readings.

To keep only Italian and English, set `LANGUAGES = "it,en"` in `[vars]` in `wrangler.toml`, then run `npm run deploy`. This setting applies to both words and the language of the daily reading. Previously imported French content can stay in D1; it will not be selected while `fr` is disabled.

To replace French with the bundled Spanish catalog, set `LANGUAGES = "it,es,en"` in `[vars]` in `wrangler.toml`, then import the enlarged collection into your existing database and deploy:

```sh
npm run db:seed:remote
npm run deploy
```

To make all five optional catalogs available while keeping the active languages unchanged, run `npm run db:seed:remote` with `LANGUAGES = "it,fr,en"`. Content-only additions do not require a worker deployment.

To import an additional shared catalog:

1. Obtain or prepare a reviewed JSON catalog with `words` and `readings` arrays, following the fields documented below. Definitions and examples must use the word's language. Readings must be original works in that language, with their literary author, edition, source, rights information, and passage ranges. Keep `language`, `definitionLanguage`, and `originalLanguage` consistent. Relabeling existing entries does not translate them or satisfy these requirements.
2. Save that JSON file as `additional-catalog.json` in the project folder. Review its sources and licensing before importing. You can prepare new entries from dictionaries and original-language editions; a dictionary or literary website is not automatically a ready-to-import Millantare catalog.
3. Make a backup of your current `data/catalog.json`, then merge the shared entries using this command from the project folder. It parses JSON as data and runs the existing validator before writing:

   ```sh
   node --input-type=module - <<'JS'
   // Merge a reviewed catalog only after validating the combined collection.
   // Author: Pasquale Marzaioli
   import { readFile, writeFile } from "node:fs/promises";
   import { compileCatalog } from "./scripts/catalog.js";
   const current = JSON.parse(await readFile("data/catalog.json", "utf8"));
   const added = JSON.parse(await readFile("additional-catalog.json", "utf8"));
   const merged = {
     ...current,
     words: [...current.words, ...added.words],
     readings: [...current.readings, ...added.readings],
   };
   compileCatalog(merged);
   await writeFile("data/catalog.json", `${JSON.stringify(merged, null, 2)}\n`);
   console.log(`Merged ${added.words.length} words and ${added.readings.length} readings.`);
   JS
   ```

   Malformed entries, repeated words/examples, and overlapping passages stop the merge before the original catalog is overwritten. Do not merge the same pack twice. For corrections to existing entries, edit the existing entries rather than append duplicates.
4. Import with `npm run db:seed:remote`. To activate another language, add its tag to `LANGUAGES` in `[vars]` in `wrangler.toml`, then run `npm run deploy`.

Use the **existing** D1 database when changing languages. Its history continues to block previous selections if you enable a language again. Complete daily capacity is limited by unused words in each selected language and the supply of eligible original readings across those languages; changing the setting alone does not provide a year's content. Missing content for a selected tag produces a shortage notice while other available selections continue.

## Add words, languages, or readings

Edit `data/catalog.json`, run `npm run catalog:build`, and import the result with `npm run db:seed:remote`. The worker does not need redeployment for content-only additions.

For words, follow an existing entry. Provide the lowercase `language`, matching `definitionLanguage`, lemma, grammatical category, register, definition, usage example, and a public HTTPS dictionary source. Write the definition and example in that language. Labels and editorial documentation use English. The original 27 words retain independently worded definitions and examples. Added definitions and examples are adapted from linked native-language Wiktionary revisions, with quoted examples retaining their attribution. [Kaikki's native-edition extracts](https://kaikki.org/) support lexical selection; selected text is checked against the cited revision. Sources allow a reader to verify the selected sense. Register labels are editorial guidance rather than a universal frequency ranking; an archaic sense can coexist with another current meaning. Literary and poetic labels map to `literary`, rare to `rare`, and dated or obsolete to `archaic`. Formal usages and Japanese four-character idioms may also be grouped as `literary`.

Reused lexical text declares `license: "CC-BY-SA-4.0"` and a `rightsNote`. Its source URL identifies the revision and links to the page history for contributor attribution, as permitted by the [Wikimedia reuse terms](https://foundation.wikimedia.org/wiki/Terms_of_Use#7._Licensing_of_Content). Cards retain that source and the [CC BY-SA 4.0 license link](https://creativecommons.org/licenses/by-sa/4.0/). Formatting, usage-label extraction, and minor transcription corrections are adaptations. Quoted examples retain `exampleAttribution`; their historical source is identified on the dictionary page. Keep attribution and license information when editing or redistributing these lexical entries.

For readings, provide:

- Matching `language` and `originalLanguage`, with `isTranslation: false`.
- A stable `workId` shared by all editions and excerpts of the same original work. Do not rename it to make old content appear new.
- The real literary author, title, edition, source, and `originalLanguageSource` establishing the work's original language. The language of a website alone does not establish this.
- `kind: "poetry"` or `"prose"`, and an explicit `excerpt` boolean.
- A documented range: zero-based, start-inclusive/end-exclusive paragraph ordinals for prose, or verse ordinals for poetry. Use one consistent coordinate system across all excerpts and editions of a work. Include chapter offsets for a novel; exclude front matter consistently.
- For a complete work, use `start: 0` and `end: 9007199254740991`, covering its entire range.
- `license: "public-domain"`, a `rightsNote` documenting the rights basis and range convention, and the exact original text.

The validator checks required metadata, duplicate identities, overlapping ranges, source URL format, lexical license declarations, control characters, and Telegram's message length. **It cannot independently establish original language, copyright status, or dictionary accuracy.** Check those against the cited edition before importing. Keep historic spellings rather than silently modernizing them. Transcriptions remove page and verse numbers, repeated headings, and invisible layout characters; verse boundaries remain intact. Translation notices outside the poem must also be checked. The collection excludes the translated poems in Carducci's eighth book and the Heine translations among his third book, Pascoli's *Tre versi dell'Ascreo*, Leopardi's *Imitazione* and Simonides translations, and Baudelaire's Latin *Franciscæ meæ laudes*.

Reimporting is safe for history. Catalog imports are additive: removing an entry from the JSON does not remove an older imported row. To withdraw an erroneous unused entry, explicitly delete that catalog row from `words` or `readings` through D1 after reviewing its identity; never delete its `used_words` or `used_readings` reservation.

The included literary texts retain author and provenance in each entry. Authors include Pascoli, Carducci, Leopardi, Baudelaire, Verlaine, Renard, Shakespeare, Dickinson, and Keats, alongside the original starter authors. The optional catalogs add Goethe's German poetry, poems listed in *Three Hundred Tang Poems*, the medieval Japanese *Ogura Hyakunin Isshu* and excerpts from Natsume Sōseki's *Kokoro*, Bécquer's *Rimas* and excerpts from Unamuno's *Niebla*, and Gorter's *Verzen* with excerpts from Multatuli's *Max Havelaar*. Original verse and prose are transcribed from Wikisource and Project Gutenberg; each entry identifies its edition and passage range. Only the literary text is reproduced; modern commentary, introductions, translations, and editorial notes are excluded. The MIT license covers project code and original explanatory content. The licensed dictionary material and public-domain literary works retain their separate rights and attribution.

## Local verification

```sh
npm run lint
npm test
npm run build
npm run preview
npm run db:migrate:local
npm run db:seed:local
```

Tests use Node's bundled SQLite engine and intercept outgoing Telegram requests. They exercise the actual SQL, concurrent scheduling, daylight saving time, exhaustion, preferences, reimported content, overlapping excerpts, batch rollback, and uncertain network outcomes. A controlled SQLite random function verifies shuffled selection without relying on chance; reading-language counts stay balanced. A full simulation reserves the starter day, imports the enlarged catalog, and runs 366 future days: 1,468 distinct messages across 367 days, including 1,101 distinct words and examples and 367 readings. It checks that the previously consumed day remains blocked and exhaustion never recycles content. No production credentials or real messages are needed. Node 22 may print an experimental SQLite warning during tests; SQLite is only a test adapter here, while production uses D1.

`npm run preview` prints one word card in each available language and a reading without consuming history, changing preferences, or sending messages. Tests also check the five optional catalogs, their language tags, unchanged active defaults, and complete verse/stanza counts for representative German poems. A second simulation selects only the five optional languages for 367 days, producing 2,202 distinct messages without consuming disabled-language content. `npm run build` validates the catalog and creates a Cloudflare deployment bundle without deploying it.

For a real local delivery test, copy `.dev.vars.example` to `.dev.vars`, enter a separate test bot's token and private chat ID, initialize local D1, and run `npm run dev`. Trigger its schedule locally:

```sh
curl 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'
```

This performs a real Telegram send only when the configured local time has been reached. Local and remote D1 histories are separate, so testing with a production bot can repeat content already sent remotely. Use a dedicated test bot.

## Inspect operation

Watch Cloudflare's worker logs with `npx wrangler tail`. Inspect history without changing it:

```sh
npx wrangler d1 execute millantare --remote --command "SELECT day, status FROM deliveries ORDER BY day DESC LIMIT 10"
npx wrangler d1 execute millantare --remote --command "SELECT day, position, status, telegram_message_id FROM messages ORDER BY day DESC, position LIMIT 20"
```

`reserved` means the content was claimed but delivery was not completed. `uncertain` means sending stopped without confirming the whole day's delivery. Per-message `attempted` records may have reached Telegram, even if no message ID was recorded. Do not clear them to force a retry. Exhaustion notices are also reserved before sending, so a lost notice is not repeatedly attempted; inspect history and catalog capacity if messages stop.
