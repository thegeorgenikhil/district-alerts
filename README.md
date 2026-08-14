# District Bookings Open Telegram Alert System

A TypeScript/Node.js scraper that monitors [District](https://www.district.in) for when a new movie's bookings open and sends Telegram notifications.

## Overview

Get notified when new movie bookings open up.

The system:
- Periodically checks District for booking availability using cron
- Sends immediate Telegram notifications when bookings open
- Provides direct booking links in notifications
- Supports multiple movies, cities and dates through a simple JSON configuration

District server-renders its showtime data into the page, so the scraper reads
that JSON directly instead of scraping the DOM. A plain HTTP request is enough;
Puppeteer is only launched as a fallback if District blocks the request.

## Prerequisites

- Node.js 20 or higher
- pnpm
- Telegram Bot Token and Chat ID (for sending notifications)

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. Install the browser used by the Puppeteer fallback:
```bash
pnpm browser:install
```

3. Build the project:
```bash
pnpm build
```

4. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your Telegram bot token and chat ID
```

5. Configure movies in `config.json` (see [Configuration](#configuration))

6. Set up a cron job:
```bash
crontab -e
```

Add one of the following lines depending on your desired frequency:

```bash
# Every 1 minute
* * * * * cd /path/to/district-alerts && /bin/bash run.sh >> /path/to/district-alerts/district-cron-error.log 2>&1

# Every 2 minutes
*/2 * * * * cd /path/to/district-alerts && /bin/bash run.sh >> /path/to/district-alerts/district-cron-error.log 2>&1

# Every 5 minutes
*/5 * * * * cd /path/to/district-alerts && /bin/bash run.sh >> /path/to/district-alerts/district-cron-error.log 2>&1

# Every 10 minutes
*/10 * * * * cd /path/to/district-alerts && /bin/bash run.sh >> /path/to/district-alerts/district-cron-error.log 2>&1

# Every 15 minutes
*/15 * * * * cd /path/to/district-alerts && /bin/bash run.sh >> /path/to/district-alerts/district-cron-error.log 2>&1

# Every 30 minutes
*/30 * * * * cd /path/to/district-alerts && /bin/bash run.sh >> /path/to/district-alerts/district-cron-error.log 2>&1

# Every hour
0 * * * * cd /path/to/district-alerts && /bin/bash run.sh >> /path/to/district-alerts/district-cron-error.log 2>&1
```

## Configuration

### Movie Configuration (config.json)

Movies are configured in `config.json`. Each movie entry contains:

```json
{
    "name": "Movie Name",
    "slug_name": "movie-name-slug",
    "code": "MVXXXXXX",
    "city": "city-name",
    "dates": ["YYYY-MM-DD"],
    "languages": [],
    "found": false,
    "failing": false,
    "theatres": {}
}
```

| Field | Meaning |
| --- | --- |
| `name` | Display name used in notifications |
| `slug_name` | Cosmetic only — District ignores it, but it keeps the booking link readable |
| `code` | The `MV` code from the URL |
| `city` | The city from the URL |
| `dates` | Show dates to watch. Must not be empty |
| `languages` | Languages to watch. Empty means all of them |
| `found` | Set to `true` by hand to stop watching a movie |
| `failing` | Managed by the script. Tracks whether an error alert has already been sent |
| `theatres` | Managed by the script. Records the shows already seen |

### How to Add New Movies

1. Visit the movie's District page. The URL will look like:

```
https://www.district.in/movies/[slug_name]-movie-tickets-in-[city]-[code]
```

2. Extract the following from the URL:

For example:
```
https://www.district.in/movies/khalifa-movie-tickets-in-kochi-MV157430

- slug_name: khalifa
- city: kochi
- code: MV157430
```

If a movie's bookings have not opened yet, District serves the URL without the
city in it (`.../khalifa-movie-tickets-MV157430`). Add the `-in-[city]` part
yourself — the page works either way.

3. Add the show `dates` (`YYYY-MM-DD` format) you want to track.

### Choosing Dates

`dates` must list every date you care about. A movie's first shows often open
for the release date before the following days, so for an unreleased movie it is
worth listing the release date and the days after it:

```json
"dates": ["2026-08-20", "2026-08-21", "2026-08-22"]
```

Dates with no shows yet are simply logged and retried on the next run. Removing a
date from `dates` also drops its recorded shows from `theatres`.

### Languages

A movie released in more than one language has separate showtimes per language.
Leaving `languages` empty watches all of them, which is what you usually want:

```json
"languages": []
```

To narrow it down, list the languages exactly as District names them:

```json
"languages": ["Malayalam"]
```

Notifications only mention the language when a movie actually runs in more than
one.

### IMAX and Other Formats

Nothing to configure. IMAX, 4DX and other formats are part of a movie's normal
showtimes on District, and each notification names the format alongside the
time, for example `05:50 PM · SCREEN 3 · IMAX 2D · IMAX`.

## Usage

1. Configure your movies in `config.json`
2. Make sure your `.env` file is properly configured
3. Run the script:
```bash
pnpm start
# or
./run.sh
```

The script will:
- Monitor each movie in the configuration
- Send Telegram notifications when bookings open
- Update the recorded shows in `config.json`
- Log all activities to `district.log`

### Dry Runs

Set `DRY_RUN=1` to write every notification to `district.log` instead of sending
it to Telegram. `config.json` is still updated, so a dry run seeds the recorded
shows without alerting you about them:

```bash
DRY_RUN=1 pnpm start
```

## Notifications

Two kinds of alert are sent, each with a **🎟️ Book on District** button linking
straight to the right date and language:

- **New Show Added** — a cinema is showing the movie for the first time
- **New Timing Added** — a cinema you already knew about added more shows

If the script cannot tell whether bookings are open — for example if District
changes its page structure — it sends a **District Scraper Error** alert once and
stays quiet until it recovers. Without this, a broken scraper would look exactly
like a movie whose bookings simply have not opened yet.
