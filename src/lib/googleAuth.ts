import { google } from "googleapis";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Shared OAuth client for Gmail + Calendar — both are accessed as the same
 * Google account (whichever mailbox receives Airbnb booking emails, which
 * also needs to already have write access to the property calendars this
 * pipeline blocks). One refresh token, obtained via
 * `npm run get-gmail-token`, covers both scopes.
 */
export function getGoogleOAuthClient() {
  const client = new google.auth.OAuth2(
    requireEnv("GMAIL_CLIENT_ID"),
    requireEnv("GMAIL_CLIENT_SECRET")
  );
  client.setCredentials({ refresh_token: requireEnv("GMAIL_REFRESH_TOKEN") });
  return client;
}
