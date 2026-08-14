import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser } from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const CONFIG_FILE = path.join(ROOT_DIR, "config.json");
const LOG_FILE = path.join(ROOT_DIR, "district.log");

interface MovieDetails {
  name: string;
  slug_name: string;
  code: string;
  city: string;
  dates: string[];
  languages: string[];
  found: boolean;
  failing: boolean;
  // date -> theatre name -> session id -> human readable label
  theatres: Record<string, Record<string, Record<string, string>>>;
}

interface ScrapedTheatre {
  name: string;
  // session id -> human readable label
  sessions: Record<string, string>;
}

interface LanguageGroup {
  language: string;
  fmtGrpId: string;
}

interface TelegramKeyboard {
  inline_keyboard: { text: string; url: string }[][];
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function log(level: string, message: string, fields?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const fieldsStr = fields ? " " + JSON.stringify(fields) : "";
  const line = `${timestamp} [${level}] ${message}${fieldsStr}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function loadMovies(): MovieDetails[] {
  const data = fs.readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(data);
}

function saveMovies(movies: MovieDetails[]) {
  for (const movie of movies) {
    const kept: MovieDetails["theatres"] = {};
    for (const date of movie.dates) {
      if (movie.theatres[date]) kept[date] = movie.theatres[date];
    }
    movie.theatres = kept;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(movies, null, 4) + "\n");
}

function describeError(err: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = { error: String(err) };
  if (err instanceof Error && err.stack) {
    details.stack = err.stack;
  }
  const causes: string[] = [];
  let current: unknown = err;
  while (current instanceof Error && current.cause !== undefined) {
    const cause = current.cause;
    if (cause instanceof Error) {
      const code = (cause as NodeJS.ErrnoException).code;
      causes.push(code ? `${code}: ${cause.message}` : String(cause));
    } else {
      causes.push(String(cause));
    }
    current = cause;
  }
  if (causes.length > 0) {
    details.causes = causes;
  }
  return details;
}

const TELEGRAM_MAX_ATTEMPTS = 3;
const TELEGRAM_RETRY_DELAY_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Telegram's legacy Markdown rejects the whole message with HTTP 400 on an
// unbalanced entity character, so every interpolated value gets escaped.
function escapeMarkdown(text: string): string {
  return text.trim().replace(/([_*[\]`])/g, "\\$1");
}

async function sendTelegramNotificationOnce(
  chatId: string,
  message: string,
  parseMode: string,
  keyboard: TelegramKeyboard
) {
  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: parseMode,
    reply_markup: keyboard,
  };

  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = (await response.json()) as {
    ok: boolean;
    description?: string;
    error_code?: number;
  };
  if (!result.ok) {
    throw new Error(
      `Telegram API error (HTTP ${response.status}, code ${result.error_code}): ${result.description}`
    );
  }
}

async function sendTelegramNotification(
  chatId: string,
  message: string,
  parseMode: string,
  keyboard: TelegramKeyboard
) {
  if (DRY_RUN) {
    log("info", "DRY_RUN notification", {
      message,
      url: keyboard.inline_keyboard[0]?.[0]?.url,
    });
    return;
  }

  for (let attempt = 1; attempt <= TELEGRAM_MAX_ATTEMPTS; attempt++) {
    try {
      await sendTelegramNotificationOnce(chatId, message, parseMode, keyboard);
      return;
    } catch (err) {
      if (attempt === TELEGRAM_MAX_ATTEMPTS) throw err;
      log("warn", "Telegram send failed, retrying", {
        attempt,
        maxAttempts: TELEGRAM_MAX_ATTEMPTS,
        ...describeError(err),
      });
      await sleep(TELEGRAM_RETRY_DELAY_MS * attempt);
    }
  }
}

// District serves showtimes in the server rendered __NEXT_DATA__ blob, so a
// plain fetch is enough. Puppeteer is only spun up when that fails, which is
// what a bot challenge would look like.
let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });
  }
  return browser;
}

function isBotChallenge(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

// Raised for responses a browser would not fix, so the fallback is skipped.
class PermanentHttpError extends Error {}

async function fetchHtml(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-IN,en;q=0.9" },
    });
    if (response.ok) {
      const html = await response.text();
      if (html.includes("__NEXT_DATA__")) return html;
      log("warn", "Response had no __NEXT_DATA__, falling back to puppeteer", { url });
    } else if (isBotChallenge(response.status)) {
      log("warn", "Blocked response, falling back to puppeteer", {
        url,
        status: response.status,
      });
    } else {
      // A plain 404 means the movie code or city is wrong, not that we are being
      // blocked. Retrying it in a browser would just burn a launch every run.
      throw new PermanentHttpError(`District returned HTTP ${response.status}`);
    }
  } catch (err) {
    if (err instanceof PermanentHttpError) throw err;
    log("warn", "Fetch failed, falling back to puppeteer", { url, ...describeError(err) });
  }

  const page = await (await getBrowser()).newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    return await page.content();
  } finally {
    await page.close();
  }
}

function extractNextData(html: string): any | null {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function buildUrl(movie: MovieDetails, frmtid?: string, fromdate?: string): string {
  const base = `https://www.district.in/movies/${movie.slug_name}-movie-tickets-in-${movie.city}-${movie.code}`;
  if (!frmtid && !fromdate) return base;
  const params = new URLSearchParams();
  if (frmtid) params.set("frmtid", frmtid);
  if (fromdate) params.set("fromdate", fromdate);
  return `${base}?${params.toString()}`;
}

async function loadPageData(url: string): Promise<any | null> {
  const nextData = extractNextData(await fetchHtml(url));
  return nextData?.props?.pageProps?.data ?? null;
}

// showTime is naive UTC ("2026-08-14T16:00" renders as 09:30 PM on the site),
// converted with a fixed offset so a VPS and a laptop agree.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTTime(showTime: string): string {
  const ist = new Date(new Date(`${showTime}:00Z`).getTime() + IST_OFFSET_MS);
  const minutes = ist.getUTCMinutes();
  const suffix = ist.getUTCHours() >= 12 ? "PM" : "AM";
  let hours = ist.getUTCHours() % 12;
  if (hours === 0) hours = 12;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function formatDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}-${month}-${year}`;
}

// The label is both the message text and the fallback identity used to
// suppress re-alerts when a cinema recreates a show under a fresh session id.
function buildSessionLabel(session: any): string {
  const parts = [toISTTime(session.showTime)];
  for (const value of [session.audi, session.scrnFmt, session.premiumLabel]) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.join(" · ");
}

function readLanguageGroups(serverState: any): LanguageGroup[] {
  const contents = Object.values(serverState?.movieContents ?? {})[0] as any;
  const groups = (contents?.languageFormatGroups ?? []) as any[];
  return groups
    .filter((group) => group?.fmtGrpId)
    .map((group) => ({ language: String(group.language ?? ""), fmtGrpId: group.fmtGrpId }));
}

function readSessionPage(serverState: any): any | null {
  return Object.values(serverState?.movieSessions ?? {})[0] ?? null;
}

function scrapeTheatres(sessionPage: any): ScrapedTheatre[] {
  const theatres: ScrapedTheatre[] = [];
  for (const entry of sessionPage.arrangedSessions ?? []) {
    const name = String(entry?.entityName ?? "").trim();
    if (!name) continue;
    const sessions: Record<string, string> = {};
    for (const session of entry.sessions ?? []) {
      if (!session?.sid || !session?.showTime) continue;
      sessions[String(session.sid)] = buildSessionLabel(session);
    }
    if (Object.keys(sessions).length > 0) theatres.push({ name, sessions });
  }
  return theatres;
}

async function notifyFailure(movie: MovieDetails, reason: string) {
  const message = `⚠️ *District Scraper Error*\n\n🎥 Movie: *${escapeMarkdown(movie.name)}*\n❗ ${escapeMarkdown(reason)}\n\nCould not tell whether bookings are open. Alerts for this movie are unreliable until this is fixed.`;
  const keyboard: TelegramKeyboard = {
    inline_keyboard: [[{ text: "🎟️ Book on District", url: buildUrl(movie) }]],
  };
  try {
    await sendTelegramNotification(TELEGRAM_CHAT_ID!, message, "Markdown", keyboard);
  } catch (err) {
    log("error", "Error sending failure notification", {
      movie: movie.name,
      ...describeError(err),
    });
  }
}

async function handleAnomaly(movie: MovieDetails, reason: string, fields: Record<string, unknown>) {
  log("error", reason, { movie: movie.name, ...fields });
  if (!movie.failing) {
    movie.failing = true;
    await notifyFailure(movie, reason);
  }
}

function clearFailing(movie: MovieDetails) {
  if (movie.failing) {
    movie.failing = false;
    log("info", "Recovered, page is readable again", { movie: movie.name });
  }
}

async function processDate(
  movie: MovieDetails,
  group: LanguageGroup,
  showLanguage: boolean,
  date: string
) {
  const url = buildUrl(movie, group.fmtGrpId, date);
  const data = await loadPageData(url);
  const sessionPage = readSessionPage(data?.serverState);

  if (!sessionPage) {
    log("info", "Shows not yet available for requested date", {
      movie: movie.name,
      language: group.language,
      requestedDate: date,
    });
    return;
  }

  const showDates: string[] = sessionPage.meta?.showDates ?? [];
  if (!showDates.includes(date)) {
    log("info", "Shows not yet available for requested date", {
      movie: movie.name,
      language: group.language,
      requestedDate: date,
      openDates: showDates,
    });
    return;
  }

  // District ignores an out-of-range fromdate rather than erroring, so confirm
  // the page really is showing the date we asked for before diffing it.
  const selected = sessionPage.meta?.selectedShowDate;
  if (selected && selected !== date) {
    log("warn", "Page returned a different date than requested", {
      movie: movie.name,
      requestedDate: date,
      actualDate: selected,
    });
    return;
  }

  const formattedDate = formatDate(date);
  const languageLine = showLanguage ? `🗣 Language: *${escapeMarkdown(group.language)}*\n` : "";
  const keyboard: TelegramKeyboard = {
    inline_keyboard: [[{ text: "🎟️ Book on District", url }]],
  };

  if (!movie.theatres[date]) movie.theatres[date] = {};
  const recordedForDate = movie.theatres[date];

  for (const theatre of scrapeTheatres(sessionPage)) {
    const recorded = recordedForDate[theatre.name];
    const isNewTheatre = recorded === undefined;
    const existing = recorded ?? {};
    const knownLabels = new Set(Object.values(existing));

    const newSids = Object.keys(theatre.sessions).filter((sid) => !(sid in existing));
    // A fresh sid whose label we have already seen is the same show recreated
    // by the cinema, not a new one, so it updates state without an alert.
    const alertable = newSids.filter((sid) => !knownLabels.has(theatre.sessions[sid]));
    const recreated = newSids.filter((sid) => knownLabels.has(theatre.sessions[sid]));

    recordedForDate[theatre.name] = { ...existing, ...theatre.sessions };

    if (recreated.length > 0) {
      log("info", "Session ids changed for already known shows", {
        movie: movie.name,
        date: formattedDate,
        theatre: theatre.name,
        labels: recreated.map((sid) => theatre.sessions[sid]),
      });
    }

    if (alertable.length === 0) continue;

    const labels = alertable.map((sid) => theatre.sessions[sid]);
    const timings = labels.map((label) => `*${escapeMarkdown(label)}*`).join("\n");

    const notificationMsg = isNewTheatre
      ? `🎬 *New Show Added!*\n\n🎥 Movie: *${escapeMarkdown(movie.name)}*\n${languageLine}📅 Date: *${formattedDate}*\n🏟️ Theatre: *${escapeMarkdown(theatre.name)}*\n🕐 Shows: *${labels.length}*\n⏰ ${timings}`
      : `🎬 *New Timing Added!*\n\n🎥 Movie: *${escapeMarkdown(movie.name)}*\n${languageLine}📅 Date: *${formattedDate}*\n🏟️ Theatre: *${escapeMarkdown(theatre.name)}*\n⏰ New:\n${timings}`;

    try {
      await sendTelegramNotification(TELEGRAM_CHAT_ID!, notificationMsg, "Markdown", keyboard);
    } catch (err) {
      log("error", "Error sending Telegram notification", {
        movie: movie.name,
        theatre: theatre.name,
        ...describeError(err),
      });
    }

    log("info", isNewTheatre ? "Found new theatre" : "Found new timings", {
      movie: movie.name,
      language: group.language,
      date: formattedDate,
      theatre: theatre.name,
      timings: labels,
      url,
    });
  }
}

async function processMovie(movie: MovieDetails) {
  if (movie.dates.length === 0) {
    log("warn", "No dates configured, skipping movie", { movie: movie.name });
    return;
  }

  const data = await loadPageData(buildUrl(movie));
  const serverState = data?.serverState;

  const hasSessions = Object.keys(serverState?.movieSessions ?? {}).length > 0;
  const hasMovieData =
    Object.keys(serverState?.movieData ?? {}).length > 0 ||
    Object.keys(serverState?.mdpV2MovieData ?? {}).length > 0;

  if (!hasSessions && !hasMovieData) {
    await handleAnomaly(movie, "Could not read the District page", {
      url: buildUrl(movie),
      serverStateKeys: Object.keys(serverState ?? {}),
    });
    return;
  }

  clearFailing(movie);

  if (!hasSessions) {
    log("info", "Bookings not open yet", { movie: movie.name, dates: movie.dates });
    return;
  }

  const allGroups = readLanguageGroups(serverState);
  const wanted = movie.languages.map((language) => language.toLowerCase());
  const groups =
    wanted.length === 0
      ? allGroups
      : allGroups.filter((group) => wanted.includes(group.language.toLowerCase()));

  if (groups.length === 0) {
    log("warn", "No language groups matched the configured filter", {
      movie: movie.name,
      configured: movie.languages,
      available: allGroups.map((group) => group.language),
    });
    return;
  }

  // The language line only carries information when a movie actually runs in
  // more than one language, so single language releases omit it.
  const showLanguage = allGroups.length > 1;

  for (const group of groups) {
    for (const date of movie.dates) {
      await processDate(movie, group, showLanguage, date);
    }
  }
}

async function main() {
  const startTime = Date.now();

  if (!DRY_RUN) {
    if (!TELEGRAM_BOT_TOKEN) {
      log("error", "TELEGRAM_BOT_TOKEN environment variable not set");
      process.exit(1);
    }
    if (!TELEGRAM_CHAT_ID) {
      log("error", "TELEGRAM_CHAT_ID environment variable not set");
      process.exit(1);
    }
  }

  const moviesList = loadMovies();

  try {
    for (const movie of moviesList) {
      if (movie.found) continue;

      try {
        await processMovie(movie);
      } catch (err) {
        await handleAnomaly(movie, "Error processing movie", describeError(err));
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  saveMovies(moviesList);

  const duration = (Date.now() - startTime) / 1000;
  log("info", "cron completed", { duration_in_seconds: duration });
}

main().catch((err) => {
  log("error", "Unhandled error", { error: String(err), stack: (err as Error).stack });
  process.exit(1);
});
