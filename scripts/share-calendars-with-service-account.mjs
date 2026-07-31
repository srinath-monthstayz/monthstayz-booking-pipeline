#!/usr/bin/env node
/**
 * One-time helper: bulk-shares every property's Google Calendar (from the
 * Properties table) with the Calendar service account, so you don't have to
 * click through Google Calendar's sharing UI for each one by hand.
 *
 * This authenticates as YOUR Google account (not the service account) via a
 * one-off OAuth flow, since only the calendar's actual owner can grant
 * access to it. Nothing is stored after this script exits — it's a single
 * run, not something the deployed pipeline depends on.
 *
 * Usage:
 *   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... AIRTABLE_API_KEY=... \
 *   SERVICE_ACCOUNT_EMAIL=booking-pipeline-calendar@....iam.gserviceaccount.com \
 *   npm run share-calendars
 *
 * (Reuses the same OAuth client you created for the Gmail token script —
 * it's just requesting a different scope this time.)
 */
import { google } from "googleapis";
import http from "node:http";
import { URL } from "node:url";

const PORT = 53683; // different port than get-gmail-token.mjs so both can be used independently
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const BASE_ID = "appND9kP55cvkDX7V";
const PROPERTIES_TABLE_ID = "tblYsjDyc84qS0cSw";
const AIRBNB_LISTING_TITLE_FIELD = "fld9Tvr8mNpzy9lG7";
const GOOGLE_CALENDAR_ID_FIELD = "flds2Pkaxh2nx4Kjc";

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
const airtableApiKey = process.env.AIRTABLE_API_KEY;
const serviceAccountEmail = process.env.SERVICE_ACCOUNT_EMAIL;

for (const [name, value] of Object.entries({
  GMAIL_CLIENT_ID: clientId,
  GMAIL_CLIENT_SECRET: clientSecret,
  AIRTABLE_API_KEY: airtableApiKey,
  SERVICE_ACCOUNT_EMAIL: serviceAccountEmail,
})) {
  if (!value) {
    console.error(`Set ${name} before running this script.`);
    process.exit(1);
  }
}

async function fetchPropertiesWithCalendars() {
  const records = [];
  let offset;
  do {
    const params = new URLSearchParams();
    params.set("filterByFormula", `NOT({${GOOGLE_CALENDAR_ID_FIELD}} = "")`);
    params.append("fields[]", AIRBNB_LISTING_TITLE_FIELD);
    params.append("fields[]", GOOGLE_CALENDAR_ID_FIELD);
    if (offset) params.set("offset", offset);

    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${PROPERTIES_TABLE_ID}?${params}`, {
      headers: { Authorization: `Bearer ${airtableApiKey}` },
    });
    if (!res.ok) throw new Error(`Airtable list failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

function getOAuthCode(oauth2Client) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
  });

  console.log("\nOpen this URL in a browser, signed in as the account that OWNS the property calendars:\n");
  console.log(authUrl);
  console.log(`\nWaiting for the OAuth redirect on ${REDIRECT_URI} ...\n`);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, REDIRECT_URI);
        if (url.pathname !== "/oauth2callback") {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400).end("Missing ?code in redirect.");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" }).end("Success — you can close this tab.");
        server.close();
        resolve(code);
      } catch (err) {
        res.writeHead(500).end("Failed, see terminal.");
        server.close();
        reject(err);
      }
    });
    server.listen(PORT);
  });
}

async function shareCalendar(calendar, calendarId) {
  try {
    await calendar.acl.insert({
      calendarId,
      requestBody: { role: "writer", scope: { type: "user", value: serviceAccountEmail } },
    });
    return { ok: true };
  } catch (err) {
    const reason =
      err?.response?.data?.error?.errors?.[0]?.reason ||
      err?.errors?.[0]?.reason ||
      err?.response?.data?.error?.message ||
      err.message;
    return { ok: false, reason };
  }
}

async function main() {
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const code = await getOAuthCode(oauth2Client);
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  console.log("Fetching properties with a Google Calendar ID from Airtable...");
  const properties = await fetchPropertiesWithCalendars();
  console.log(`Found ${properties.length} properties with a calendar ID set.\n`);

  let shared = 0;
  let alreadyShared = 0;
  let failed = 0;

  for (const record of properties) {
    const calendarId = record.fields[GOOGLE_CALENDAR_ID_FIELD];
    const label = record.fields[AIRBNB_LISTING_TITLE_FIELD] || record.id;

    const result = await shareCalendar(calendar, calendarId);
    if (result.ok) {
      console.log(`✅ Shared: ${label} (${calendarId})`);
      shared++;
    } else if (result.reason === "duplicate") {
      console.log(`↷  Already shared: ${label} (${calendarId})`);
      alreadyShared++;
    } else {
      console.log(`❌ Failed: ${label} (${calendarId}) — ${result.reason}`);
      failed++;
    }
  }

  console.log(`\nDone. Shared: ${shared}, already shared: ${alreadyShared}, failed: ${failed}.`);
  if (failed > 0) {
    console.log(
      "Failures usually mean the signed-in account doesn't own that calendar (e.g. it belongs to a " +
        "property owner or a different team member) — those need to be shared manually by whoever does own them."
    );
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
