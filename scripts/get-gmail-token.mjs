#!/usr/bin/env node
/**
 * One-time helper: run this LOCALLY to obtain a refresh token covering both
 * Gmail (to poll/label booking emails) and Calendar (to create booking
 * blocks) — the same account handles both, so one consent flow is enough.
 *
 * Usage:
 *   1. In Google Cloud Console, create an OAuth 2.0 Client ID of type
 *      "Desktop app" (or "Web application" with the redirect URI below
 *      added), and enable both the Gmail API and Google Calendar API on
 *      the project.
 *   2. GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... npm run get-gmail-token
 *   3. Open the printed URL, sign in with the Gmail account that (a)
 *      receives the Airbnb booking emails and (b) already has write access
 *      to the property Google Calendars, and approve access.
 *   4. Copy the printed refresh token into GMAIL_REFRESH_TOKEN in Vercel.
 */
import { google } from "googleapis";
import http from "node:http";
import { URL } from "node:url";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET env vars before running this script.");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // forces a refresh_token to be issued even on repeat runs
  scope: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
  ],
});

console.log(
  "\nOpen this URL in a browser, signed in as the account that receives Airbnb booking emails " +
    "AND already manages the property Google Calendars:\n"
);
console.log(authUrl);
console.log(`\nWaiting for the OAuth redirect on ${REDIRECT_URI} ...\n`);

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

    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Success — you can close this tab.");
    server.close();

    if (!tokens.refresh_token) {
      console.error(
        "\nNo refresh_token was returned. This usually means you've already granted access before. " +
          "Revoke access at https://myaccount.google.com/permissions and re-run this script."
      );
      process.exit(1);
    }

    console.log("\nGMAIL_REFRESH_TOKEN=" + tokens.refresh_token);
    console.log("\nCopy the value above into your Vercel project's environment variables.");
    process.exit(0);
  } catch (err) {
    console.error("Token exchange failed:", err);
    res.writeHead(500).end("Token exchange failed, see terminal.");
    server.close();
    process.exit(1);
  }
});

server.listen(PORT);
