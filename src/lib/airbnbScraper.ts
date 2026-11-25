/**
 * Looks up the guest's phone number via Airbnb's internal GraphQL API
 * (StayHostingDetailsQuery), the same call the "Manage reservation" panel
 * makes. Captured and verified against a real request/response on
 * 2026-08-07 — see README "Phone lookup" for how this was discovered.
 *
 * Uses a pre-established, human-logged-in session cookie
 * (AIRBNB_SESSION_COOKIE) rather than ever automating an Airbnb login — this
 * code never attempts to authenticate, solve a CAPTCHA, or otherwise bypass
 * bot detection. If Airbnb challenges the session (expired cookie, bot
 * check), this fails closed and the caller falls back to name-based CRM
 * matching — it never blocks trip/CRM/calendar creation.
 *
 * The session cookie is a real, live Airbnb login and WILL expire — re-export
 * it from DevTools (Network tab → any airbnb.co.in request → copy the full
 * `cookie` request header) and update AIRBNB_SESSION_COOKIE when lookups
 * start failing. Treat that cookie value as sensitive as a password: it IS
 * an active login session, not just an API credential.
 */

// Airbnb's public web-client API key — static across all users' sessions,
// baked into their frontend JS bundle. Not a per-account secret.
const AIRBNB_API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20";

// Persisted-query hash for StayHostingDetailsQuery, captured from a real
// request. Persisted query hashes can go stale if Airbnb ships a new
// frontend build that changes this query's shape — if lookups start
// returning PERSISTED_QUERY_NOT_FOUND-style errors, re-capture this from a
// fresh DevTools session the same way it was found originally.
const QUERY_HASH = "c6555d613e936ebaaab24219d2c6ddd6973721ef3ebe91020c4449f7971ea824";

export type PhoneLookupResult = { ok: true; phone: string } | { ok: false; reason: string };

function buildUrl(confirmationCode: string): string {
  const variables = JSON.stringify({
    confirmationCode,
    requestSource: "MESSAGING",
    viewerTimeZoneOffset: 420, // Asia/Bangkok, UTC+7, in minutes
  });
  const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: QUERY_HASH } });
  const params = new URLSearchParams({
    operationName: "StayHostingDetailsQuery",
    locale: "en-IN",
    currency: "THB",
    variables,
    extensions,
  });
  return `https://www.airbnb.co.in/api/v3/StayHostingDetailsQuery/${QUERY_HASH}?${params.toString()}`;
}

/** Walks the response looking for the "Call" footer button, then falls back to the "Manage reservation" menu row. */
function extractPhoneNumber(body: any): string | null {
  const details = body?.data?.presentation?.hostingDetails?.stayHostingDetails;
  if (!details) return null;

  for (const section of details.footerPlacement ?? []) {
    if (section.sectionId !== "FLOATINGFOOTER_SECTION") continue;
    for (const button of section.sectionData?.buttons ?? []) {
      const phone = button.buttonAction?.phoneNumber;
      if (typeof phone === "string" && phone.trim()) return phone;
    }
  }

  for (const section of details.rootPlacement ?? []) {
    if (section.sectionId !== "MANAGE_RESERVATION_SECTION") continue;
    for (const row of section.sectionData?.rows ?? []) {
      for (const menuRow of row.action?.actionRowsForMenu ?? []) {
        if (menuRow.icon === "SYSTEM_MAKE_CALL" && typeof menuRow.action?.textToCopy === "string") {
          return menuRow.action.textToCopy;
        }
      }
    }
  }

  return null;
}

/**
 * Turns a raw GraphQL error object into a short, human-readable reason —
 * this flows straight into the Telegram notification, so it must never be
 * the full raw error blob (which can run to hundreds of lines of internal
 * Airbnb metadata/stack info).
 */
function summarizeGraphQlError(error: any): string {
  const type = error?.extensions?.errorType;
  const message: string = typeof error?.message === "string" ? error.message : "unknown error";

  if (type === "PERMISSION_DENIED" || /permission denied/i.test(message)) {
    return "no access to this listing";
  }

  const short = message.length > 80 ? `${message.slice(0, 80)}…` : message;
  return `Airbnb error: ${short}`;
}

/**
 * Every configured Airbnb login, in the order they're tried. A listing is
 * only readable by an account with host access to it, so covering listings
 * spread across several accounts means trying each until one succeeds.
 * AIRBNB_SESSION_COOKIE is account 1; AIRBNB_SESSION_COOKIE_2.._9 are extras.
 */
function configuredCookies(): string[] {
  const names = ["AIRBNB_SESSION_COOKIE", ...Array.from({ length: 8 }, (_, i) => `AIRBNB_SESSION_COOKIE_${i + 2}`)];
  return names.map((n) => process.env[n]).filter((v): v is string => !!v);
}

async function lookupWithCookie(cookie: string, confirmationCode: string): Promise<PhoneLookupResult> {
  let res: Response;
  try {
    res = await fetch(buildUrl(confirmationCode), {
      headers: {
        cookie,
        accept: "*/*",
        "content-type": "application/json",
        "x-airbnb-api-key": AIRBNB_API_KEY,
        "x-airbnb-graphql-platform": "web",
        "x-airbnb-graphql-platform-client": "minimalist-niobe",
        "x-csrf-without-token": "1",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
  } catch (err) {
    return { ok: false, reason: `request failed: ${(err as Error).message}` };
  }

  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}, cookie likely expired` };
  }

  const body: any = await res.json().catch(() => null);
  if (body?.errors?.length) {
    return { ok: false, reason: summarizeGraphQlError(body.errors[0]) };
  }

  const phone = extractPhoneNumber(body);
  if (!phone) {
    return { ok: false, reason: "no phone number in response" };
  }

  return { ok: true, phone };
}

export async function fetchGuestPhoneFromAirbnb(confirmationCode: string): Promise<PhoneLookupResult> {
  const cookies = configuredCookies();
  if (cookies.length === 0) {
    return { ok: false, reason: "AIRBNB_SESSION_COOKIE not configured — skipping phone lookup" };
  }

  const failures: string[] = [];
  for (let i = 0; i < cookies.length; i++) {
    const result = await lookupWithCookie(cookies[i], confirmationCode);
    if (result.ok) return result;
    failures.push(`account ${i + 1}: ${result.reason}`);
  }

  return { ok: false, reason: `Airbnb lookup failed (${failures.join("; ")})` };
}
