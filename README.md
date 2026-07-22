# Reward Seat Pinger

A small Node.js watcher for Qantas Flight Reward Finder calendar availability.

It polls:

- `https://flightrewardfinder.qantas.com/api/availability`

Then applies your filters and alerts only when new matching seats appear.

Alert lines include:

- Date
- Departure time
- Cabin class
- Destination airport name/code
- Points required
- Out-of-pocket tax/cash amount

## What It Can Filter

- Origin and destination airports/regions
- Passenger count
- Stops (`direct`, etc.)
- Start month + month window
- Cabin seat minimums (`Economy`, `PremiumEconomy`, `Business`, `First`)
- Specific dates (`watchDates`)
- Date ranges (`watchDateRanges`)
- Weekdays only
- Excluded dates

## Quick Start

1. Use Node.js 18+.
2. Run:

```bash
npm start
```

For one check only:

```bash
npm run start:once
```

Open the local dashboard:

```bash
npm run dev
```

This starts:

- API/backend server on `http://localhost:8787`
- React dev server on `http://localhost:5173` (with `/api` proxied to port `8787`)

Then visit `http://localhost:5173`.

For production-style static serving:

```bash
npm run serve
```

Use a custom config file:

```bash
node src/index.mjs --config ./config.json --once
```

## Config

Main file: `config.json`

Important fields:

- `startMonth`: `YYYY-MM` or `"auto"`
- `monthCount`: how many months to request from start month
- `seatFilters`: minimum seats per cabin, for example:

```json
"seatFilters": {
  "Business": 2,
  "PremiumEconomy": 2
}
```

- `seatFilterMode`:
  - `"any"`: alert if any cabin filter matches
  - `"all"`: alert only if all cabin filters match

Date filter behavior:

- If both `watchDates` and `watchDateRanges` are empty, all dates in API response are checked.
- If either is set, a date must be in at least one of them.
- `excludeDates` always removes a date.

### Alert Sinks

In `alertSinks`:

- `console`: prints alerts in terminal
- `discordWebhookUrl`: post alerts to a Discord webhook URL
- `ntfyTopicUrl`: post alerts to an ntfy topic (for example `https://ntfy.sh/your-topic`)
- `macOsNotification`: local macOS notification via `osascript`
- `telegram`: send alerts to a Telegram bot chat using environment variables
- `email`: send alerts using SMTP
- `emailTo`: comma-separated recipient emails (used when `email` is `true`)

For Telegram alerts, set:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Then enable in `config.json`:

```json
"alertSinks": {
  "telegram": true
}
```

Telegram alert lines are formatted for readability per date and include:

- Date and weekday
- Departure time
- Cabin class
- Seats available
- Points and tax
- Destination name/code

For email alerts, enable this in `config.json`:

```json
"alertSinks": {
  "email": true,
  "emailTo": "you@example.com"
}
```

Then configure SMTP via environment variables:

- Option 1: `SMTP_URL` (for example `smtps://user:pass@smtp.example.com:465`)
- Option 2: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- Optional: `SMTP_SECURE=true` (for implicit TLS), `SMTP_FROM=alerts@example.com`

## Dashboard

The dashboard lets users update filters without editing JSON manually.

Features:

- Edit route, month window, seat filters, date rules, and alert sinks.
- Save changes directly to `config.json`.
- Run a one-off check and view output.
- Start and stop the background watcher process.

Use:

```bash
npm run dev
```

Optional custom port:

```bash
PORT=9090 npm run dev
```

## De-duplication

Seen alerts are stored in `.state/seen.json`.

With `alertOnChangesOnly: true`, you only get notified for newly observed seat/cabin/date combinations.

## Notes

- This uses an undocumented API endpoint from Flight Reward Finder. If they change parameters or response shape, update `src/index.mjs`.
- Polling too frequently may trigger rate limits. Start with 10-30 minutes.

## Free Scheduled Hosting (GitHub Actions)

This repository includes a scheduled workflow at `.github/workflows/reward-seat-check.yml`.

It runs:

- Every 15 minutes
- One-off checker command: `node src/index.mjs --once`

It also caches `.state/` between runs so duplicate alert suppression still works.

### Enable It

1. Push this repository to GitHub.
2. In GitHub, open **Actions** and enable workflows.
3. In **Settings -> Secrets and variables -> Actions**, add any secrets you use:
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
  - `SMTP_URL` or SMTP host/user/password fields
4. Keep your runtime config in `config.json` committed to the repository.
5. Run the workflow once manually via **Actions -> Reward Seat Check -> Run workflow**.

### Free Tier Notes

- GitHub Actions free minutes are limited by account/repo type.
- If your free minutes are exhausted, scheduled runs pause until minutes reset or billing is enabled.
# reward-flight-pinger
