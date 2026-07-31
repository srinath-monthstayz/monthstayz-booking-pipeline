# MonthStayz Booking Pipeline

Automates Airbnb "Reservation confirmed" emails into:

1. An Airtable **✈️ Master Trips** record (base "Main", `appND9kP55cvkDX7V`)
2. An Airtable **🛃CRM** contact (linked if the guest already exists, created if not)
3. An all-day Google Calendar block on the matched property's calendar

Polls every 5 minutes via `/api/cron/process-bookings`, currently triggered
by a GitHub Actions workflow rather than Vercel's own cron — see
"Scheduling" below.

## ⚠️ Incident: 2026-07-31 — historical duplicates on first real run

The first live test run had no date bound on the Gmail search query. It
matched every historical "Reservation confirmed" email in the inbox, created
21 Master Trips records before timing out, and 14 of those turned out to be
exact duplicates of bookings already entered manually before this pipeline
existed (same property + same check-in/checkout dates). The GitHub Actions
schedule was disabled immediately (see `.github/workflows/cron.yml`) to stop
further runs.

**Root cause fixed**: `listNewBookingEmailIds` now bounds the Gmail search to
a rolling `newer_than:Nd` window (`GMAIL_LOOKBACK_DAYS`, default 3) instead
of unbounded history, and defaults to a smaller per-run batch
(`GMAIL_MAX_PER_RUN`, default 8) so a run can't time out partway through a
large batch.

**Before re-enabling the schedule**, resolve the 14 duplicate Master Trips
records (left in place pending review — this is a business decision, not
something the pipeline should do on its own) and confirm the fix above with
a manual test run (`workflow_dispatch` in GitHub Actions, or the `curl`
command under "Local testing" below) before turning `schedule:` back on in
`.github/workflows/cron.yml`.

## ⚠️ Guest phone number — Airbnb page scraper (unverified)

Real Airbnb "Reservation confirmed" emails contain no phone number anywhere.
It's only available on Airbnb's *authenticated* "Manage reservation" panel on
the hosting reservation-details page (`hosting/reservations/details/{code}`).

`src/lib/airbnbScraper.ts` fetches that page using a real, human-established
login session (`AIRBNB_SESSION_COOKIE` — copy the `cookie` request header
from Chrome DevTools while logged into Airbnb as the host) and heuristically
scans the HTML for a phone number. **This has not been verified against a
real logged-in session** — this environment had no way to inspect the actual
network request the "Manage reservation" dialog makes. If it doesn't find a
match in practice:

1. Open DevTools → Network tab on a real reservation page, click
   "Manage reservation", and find the XHR/fetch request that returns the
   phone number.
2. Share the request URL, headers, and response shape so
   `fetchGuestPhoneFromAirbnb` can be pointed at the real endpoint instead of
   scraping rendered HTML.

This code never automates login, solves a CAPTCHA, or otherwise bypasses bot
detection — it only reuses a cookie you exported from your own already
logged-in browser. That cookie **will expire periodically**; when phone
lookups start failing, re-export it. Scraping an authenticated Airbnb page
like this may also be against Airbnb's Terms of Service for automated
access — that's a call for you to make about your own host account, not
something this code enforces.

**Graceful degradation**: if the scraper isn't configured, the session has
expired, or Airbnb returns nothing recognizable, the pipeline never blocks
the booking on that account — it automatically falls back to matching CRM
contacts by exact (case-insensitive) First + Last Name instead. A name
collision across multiple existing contacts is treated as genuinely
ambiguous and skipped/logged, never guessed. Every processed booking's log
line records `crmMatchedBy: "phone" | "name-new" | "name-existing"` so you
can see which path was used.

## How matching works

- **Property**: the email's listing URL contains the numeric Airbnb room ID
  (`airbnb.co.in/rooms/12345678`). This is matched exactly against the
  Properties table's "Airbnb ID" field — chosen over fuzzy title matching
  because two differently-worded titles can point at the same unit, and two
  similarly-worded titles can point at *different* units in the same
  building. Zero or multiple matches → skipped and logged, never guessed.
- **CRM contact**: by normalized phone number when the scraper produces one
  (last-9-digit comparison, so `+66812345678`, `0812345678`, etc. compare
  equal); otherwise by exact name match (see above).
- **De-dup**: every run first searches Master Trips' Comments field for the
  booking's confirmation code. If found, the run treats it as already
  processed and only labels the email — no new records are created.
- **Idempotency**: successfully processed emails get the Gmail label
  `MonthStayz-Processed`; emails skipped for a data reason (unmatched
  property, missing phone, unparseable content) get
  `MonthStayz-Needs-Attention`. Both labels are excluded from the next poll,
  so the same booking is never logged/created twice. Genuine infrastructure
  errors (Airtable/Calendar API hiccups) get **no** label, so they retry
  automatically on the next cron run. Once you fix the underlying issue for a
  "needs attention" email, remove that label in Gmail to let it be retried.
- **Money fields**: Airbnb removed formal security deposits for most
  listings (replaced by AirCover), and the confirmation email has no deposit
  line — so **Security deposit is left blank**, never fabricated. The
  email's "TOTAL (THB)" guest-paid figure is written to both **Agreed cost**
  and **Actual amount paid** ("Actual advance paid by the customer" field),
  since Airbnb charges the guest in full at booking.
- **Missing Google Calendar ID**: about 1 in 3 properties that do resolve by
  Airbnb ID still have no Calendar ID on file. In that case the Master Trips
  + CRM records are still created and verified, but the calendar block is
  skipped with a clear log line — never guessed.

## Setup

### 1. Airtable

Create a Personal Access Token with `data.records:read` and
`data.records:write` scope on base `appND9kP55cvkDX7V`, covering the Master
Trips, Properties, and CRM tables. Set it as `AIRTABLE_API_KEY`.

### 2. Gmail + Calendar (one shared OAuth login)

Both Gmail (polling/labeling) and Calendar (creating booking blocks) are
accessed as **the same Google account** via OAuth — whichever mailbox
receives the Airbnb booking emails, which needs to already have write access
to the property calendars (no separate service account, no per-calendar
sharing step).

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select
   a project, enable **both** the **Gmail API** and the **Google Calendar
   API**, and create an OAuth 2.0 Client ID of type **Desktop app**.
2. Locally:
   ```bash
   npm install
   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... npm run get-gmail-token
   ```
3. Open the printed URL, sign in as the account that receives the Airbnb
   booking emails (the account this session found them in:
   `srinath@monthstayzthailand.com`) **and** already manages the property
   Google Calendars, and approve access (it'll ask for both Gmail and
   Calendar permissions in one screen).
4. Copy the printed `GMAIL_REFRESH_TOKEN` value.

This uses simple polling (Gmail `messages.list` on a cron schedule) — no
Pub/Sub push subscription, so no extra paid infra is required. If that
account doesn't already have access to a given property's calendar, calendar
creation for that booking will fail (logged as an error, retried next run)
until someone who does own that calendar shares it with this account the
normal way (Google Calendar → calendar settings → "Share with specific
people").

### 3. Cron auth

Set `CRON_SECRET` to any random string. Vercel Cron automatically sends
`Authorization: Bearer <CRON_SECRET>` to scheduled invocations when this env
var is set on the project, which `route.ts` checks.

### 4. Telegram notifications

After each Master Trips record (and calendar block, if applicable) is
created, a message is sent to a region-specific Telegram group — Pattaya or
Phuket, based on the matched property's **City** field in Airtable (a plain
`singleSelect` with just those two values, 100% populated for every property
with an Airbnb ID).

This reuses the existing Telegram bot ("My Claude Agent") rather than
creating a new one:

1. Get the bot token from `~/.claude/channels/telegram/.env` on the machine
   where it's already configured, and set it as `TELEGRAM_BOT_TOKEN`.
2. Add that bot to both destination group chats (Pattaya bookings group,
   Phuket bookings group) — invite it as a member the normal way.
3. Get each group's chat ID: send any message in the group, then call
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser — the
   `chat.id` for that group appears in the response (group chat IDs are
   negative numbers, e.g. `-1001234567890`).
4. Set `TELEGRAM_PATTAYA_CHAT_ID` and `TELEGRAM_PHUKET_CHAT_ID` accordingly.

If a matched property has no City set (shouldn't happen in practice — see
above), the notification is skipped and logged, never guessed. A
notification failure (bad token, bot not in the group, etc.) never undoes or
blocks the trip/calendar creation — it's a side effect, logged as part of
the run's `reason` string, not a reason to fail the booking.

## Required environment variables (set in Vercel Project Settings)

| Variable | Purpose |
|---|---|
| `AIRTABLE_API_KEY` | Airtable Personal Access Token |
| `GMAIL_CLIENT_ID` | OAuth client ID (Gmail + Calendar) |
| `GMAIL_CLIENT_SECRET` | OAuth client secret (Gmail + Calendar) |
| `GMAIL_REFRESH_TOKEN` | From `npm run get-gmail-token` — covers both Gmail and Calendar |
| `CRON_SECRET` | Shared secret Vercel Cron sends as a Bearer token |
| `TELEGRAM_BOT_TOKEN` | Existing bot token, from `~/.claude/channels/telegram/.env` |
| `TELEGRAM_PATTAYA_CHAT_ID` | Chat ID of the Pattaya bookings Telegram group |
| `TELEGRAM_PHUKET_CHAT_ID` | Chat ID of the Phuket bookings Telegram group |
| `AIRBNB_SESSION_COOKIE` *(optional)* | Cookie header from a logged-in Airbnb host session, for phone lookup — see above. Omitted = pipeline falls back to name-based CRM matching. |
| `GMAIL_SEARCH_QUERY` *(optional)* | Override the Gmail search query |
| `GMAIL_PROCESSED_LABEL` *(optional)* | Override the "done" label name |
| `GMAIL_NEEDS_ATTENTION_LABEL` *(optional)* | Override the "needs attention" label name |

## Deploying

```bash
npm install
npm run typecheck
npm run build
```

The repo is connected to Vercel project `monthstayz/monthstayz-booking-pipeline`
for auto-deploy — every push to `main` deploys automatically. Set the
environment variables above in that project's Settings → Environment
Variables.

## Scheduling (Hobby plan workaround)

Vercel's **Hobby plan only allows cron jobs to run once per day** — a native
`vercel.json` cron running every 5 minutes gets rejected at deploy time. Since
this pipeline is currently on Hobby, scheduling is instead handled by
`.github/workflows/cron.yml`, a GitHub Actions workflow that hits the same
endpoint every 5 minutes. To finish wiring this up, in the GitHub repo
Settings → Secrets and variables → Actions:

- Add **repository variable** `BOOKING_PIPELINE_URL` = `https://monthstayz-booking-pipeline.vercel.app`
- Add **repository secret** `CRON_SECRET` = the exact same value you set for
  `CRON_SECRET` in Vercel's project env vars (the workflow sends it as the
  Bearer token; it has to match what `route.ts` checks).

**Once you upgrade the Vercel project to Pro**, you can switch back to
native scheduling: add a `crons` block back to `vercel.json`,

```json
{
  "crons": [{ "path": "/api/cron/process-bookings", "schedule": "*/5 * * * *" }]
}
```

and either delete `.github/workflows/cron.yml` or leave it running — the
pipeline is idempotent, so double-triggering a run is harmless.

Also confirm the function's `maxDuration` (currently 60s in `route.ts`) fits
your plan's limits.

## Local testing

There's no local trigger UI (this is a backend cron job, not a web app).
To test end-to-end before relying on the schedule, deploy to Vercel and
either wait for the next cron tick or hit the endpoint manually:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-deployment>/api/cron/process-bookings
```

The JSON response includes a per-email breakdown (`processed` / `skipped` /
`errored` with reasons) — check that before checking Vercel's log stream.
