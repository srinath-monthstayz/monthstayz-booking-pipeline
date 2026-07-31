# MonthStayz Booking Pipeline

Automates Airbnb "Reservation confirmed" emails into:

1. An Airtable **✈️ Master Trips** record (base "Main", `appND9kP55cvkDX7V`)
2. An Airtable **🛃CRM** contact (linked if the guest already exists, created if not)
3. An all-day Google Calendar block on the matched property's calendar

Runs on Vercel Cron every 5 minutes via `/api/cron/process-bookings`.

## ⚠️ Known limitation — guest phone number

Real Airbnb "Reservation confirmed" host-notification emails (verified against
live samples from this account on 2026-07-31) **do not contain the guest's
phone number anywhere** — not in the body, not in a `tel:` link, and not in
the same-day "reservation reminder" follow-up email either.

The pipeline's CRM matching is phone-based per spec, so until the phone
number's actual source is wired in (`extractGuestPhone` in
`src/lib/parseBooking.ts` currently always returns `null`), **every booking
will be skipped and logged** with reason "Guest phone number missing or
malformed", and the email will be labeled `MonthStayz-Needs-Attention` rather
than processed. This is intentional — the spec explicitly requires stopping
rather than guessing when the phone number is missing.

Once you show where Airbnb actually exposes the number (e.g. the hosting
reservation details page, a different email type, or an export), update
`extractGuestPhone` accordingly and this unblocks automatically — no other
code needs to change.

## How matching works

- **Property**: the email's listing URL contains the numeric Airbnb room ID
  (`airbnb.co.in/rooms/12345678`). This is matched exactly against the
  Properties table's "Airbnb ID" field — chosen over fuzzy title matching
  because two differently-worded titles can point at the same unit, and two
  similarly-worded titles can point at *different* units in the same
  building. Zero or multiple matches → skipped and logged, never guessed.
- **CRM contact**: by normalized phone number (last-9-digit comparison, so
  `+66812345678`, `0812345678`, etc. compare equal). Missing/unparseable
  phone → skipped and logged (see limitation above).
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

### 2. Gmail (OAuth)

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select
   a project, enable the **Gmail API**, and create an OAuth 2.0 Client ID of
   type **Desktop app**.
2. Locally:
   ```bash
   npm install
   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... npm run get-gmail-token
   ```
3. Open the printed URL, sign in as the mailbox that receives the Airbnb
   booking emails (the account this session found them in:
   `srinath@monthstayzthailand.com`), and approve access.
4. Copy the printed `GMAIL_REFRESH_TOKEN` value.

This uses simple polling (Gmail `messages.list` on a cron schedule) — no
Pub/Sub push subscription, so no extra paid infra is required.

### 3. Google Calendar (service account)

1. In the same (or another) Google Cloud project, create a **Service
   Account** and enable the **Google Calendar API**.
2. Create a JSON key for it and download the file.
3. Set `GOOGLE_SERVICE_ACCOUNT_KEY` to the **entire contents** of that JSON
   file (paste as-is; it's valid JSON so newlines inside `private_key` are
   already escaped).
4. For **every** property calendar the pipeline needs to write to: open that
   Google Calendar's settings → "Share with specific people" → add the
   service account's `client_email` with **"Make changes to events"**
   permission.

### 4. Cron auth

Set `CRON_SECRET` to any random string. Vercel Cron automatically sends
`Authorization: Bearer <CRON_SECRET>` to scheduled invocations when this env
var is set on the project, which `route.ts` checks.

## Required environment variables (set in Vercel Project Settings)

| Variable | Purpose |
|---|---|
| `AIRTABLE_API_KEY` | Airtable Personal Access Token |
| `GMAIL_CLIENT_ID` | OAuth client ID (Gmail) |
| `GMAIL_CLIENT_SECRET` | OAuth client secret (Gmail) |
| `GMAIL_REFRESH_TOKEN` | From `npm run get-gmail-token` |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Full JSON key file contents (Calendar) |
| `CRON_SECRET` | Shared secret Vercel Cron sends as a Bearer token |
| `GMAIL_SEARCH_QUERY` *(optional)* | Override the Gmail search query |
| `GMAIL_PROCESSED_LABEL` *(optional)* | Override the "done" label name |
| `GMAIL_NEEDS_ATTENTION_LABEL` *(optional)* | Override the "needs attention" label name |

## Deploying

```bash
npm install
npm run typecheck
npm run build
```

Then deploy to Vercel (`vercel --prod` or via the Git integration) and set
the environment variables above in Project Settings. `vercel.json` already
declares the every-5-minutes cron schedule.

**Note on Vercel plan limits**: confirm your Vercel plan supports 5-minute
cron intervals and the function's `maxDuration` (currently 60s) before
relying on this in production — plan-level cron/duration limits vary and
aren't something this codebase can control.

## Local testing

There's no local trigger UI (this is a backend cron job, not a web app).
To test end-to-end before relying on the schedule, deploy to Vercel and
either wait for the next cron tick or hit the endpoint manually:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-deployment>/api/cron/process-bookings
```

The JSON response includes a per-email breakdown (`processed` / `skipped` /
`errored` with reasons) — check that before checking Vercel's log stream.
