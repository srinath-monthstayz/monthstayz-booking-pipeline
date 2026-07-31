/**
 * Best-effort lookup of the guest's phone number from Airbnb's authenticated
 * "Manage reservation" panel on the hosting reservation-details page.
 *
 * IMPORTANT — this is unverified against Airbnb's real markup/API. This
 * session has no logged-in Airbnb session to inspect the actual network
 * request the "Manage reservation" dialog makes, so this fetches the
 * reservation-details page HTML and heuristically scans it for a phone
 * number near the confirmation code section. If it doesn't work in
 * practice, capture the real request from Chrome DevTools (Network tab →
 * click "Manage reservation" → find the XHR/fetch call that returns the
 * phone number → share the request URL, headers, and response shape) so
 * this can be pointed at the real endpoint instead of scraping HTML.
 *
 * Uses a pre-established, human-logged-in session cookie (AIRBNB_SESSION_COOKIE)
 * rather than ever automating an Airbnb login — this code never attempts to
 * authenticate, solve a CAPTCHA, or otherwise bypass bot detection. If Airbnb
 * challenges the session (login page, verification prompt, unexpected
 * response), this fails closed and the caller falls back to name-based CRM
 * matching — it never blocks trip/CRM/calendar creation.
 *
 * The session cookie is a real Airbnb login and will expire periodically;
 * re-export it from DevTools (Network tab → any airbnb.com request → copy
 * the `cookie` request header) and update AIRBNB_SESSION_COOKIE when lookups
 * start failing.
 */

export type PhoneLookupResult = { ok: true; phone: string } | { ok: false; reason: string };

const PHONE_NEAR_KEYWORD = /phone number[^+\d]{0,40}(\+?\d[\d\s\-()]{7,17}\d)/i;
const GENERIC_INTL_PHONE = /\+\d{1,3}[\s-]?\d{1,4}[\s-]?\d{3,4}[\s-]?\d{3,5}/;

export async function fetchGuestPhoneFromAirbnb(confirmationCode: string): Promise<PhoneLookupResult> {
  const cookie = process.env.AIRBNB_SESSION_COOKIE;
  if (!cookie) {
    return { ok: false, reason: "AIRBNB_SESSION_COOKIE not configured — skipping phone lookup" };
  }

  const url = `https://www.airbnb.com/hosting/reservations/details/${encodeURIComponent(confirmationCode)}`;

  let html: string;
  try {
    const res = await fetch(url, {
      headers: {
        cookie,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      return { ok: false, reason: `Airbnb reservation page returned HTTP ${res.status}` };
    }
    html = await res.text();
  } catch (err) {
    return { ok: false, reason: `Airbnb reservation page fetch failed: ${(err as Error).message}` };
  }

  if (/log ?in|verify it's you|security check/i.test(html.slice(0, 2000))) {
    return { ok: false, reason: "Airbnb session appears logged out or challenged — re-export AIRBNB_SESSION_COOKIE" };
  }

  const nearKeyword = html.match(PHONE_NEAR_KEYWORD);
  if (nearKeyword) return { ok: true, phone: nearKeyword[1].trim() };

  const generic = html.match(GENERIC_INTL_PHONE);
  if (generic) return { ok: true, phone: generic[0].trim() };

  return { ok: false, reason: "No phone number pattern found in reservation-details page" };
}
