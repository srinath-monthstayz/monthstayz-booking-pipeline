import { google, calendar_v3 } from "googleapis";

const TIME_ZONE = "Asia/Bangkok";

function getServiceAccountCredentials(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set");

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is missing client_email or private_key");
  }
  return parsed;
}

function getClient(): calendar_v3.Calendar {
  const creds = getServiceAccountCredentials();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

/** Formats a Date as YYYY-MM-DD for an all-day Calendar event boundary. */
function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Searches a property's calendar for an existing booking event carrying the
 * given confirmation code in its summary, so re-runs never double-book.
 */
export async function findExistingBookingEvent(
  calendarId: string,
  confirmationCode: string
): Promise<calendar_v3.Schema$Event | null> {
  const calendar = getClient();
  const { data } = await calendar.events.list({
    calendarId,
    q: confirmationCode,
    showDeleted: false,
    singleEvents: true,
  });
  const match = (data.items ?? []).find((e) => e.summary?.includes(confirmationCode));
  return match ?? null;
}

export async function createAllDayBookingEvent(params: {
  calendarId: string;
  summary: string;
  checkIn: Date;
  checkoutExclusive: Date;
}): Promise<calendar_v3.Schema$Event> {
  const calendar = getClient();
  const { data } = await calendar.events.insert({
    calendarId: params.calendarId,
    requestBody: {
      summary: params.summary,
      start: { date: toDateOnly(params.checkIn), timeZone: TIME_ZONE },
      end: { date: toDateOnly(params.checkoutExclusive), timeZone: TIME_ZONE },
    },
  });
  return data;
}

export async function getEventById(
  calendarId: string,
  eventId: string
): Promise<calendar_v3.Schema$Event> {
  const calendar = getClient();
  const { data } = await calendar.events.get({ calendarId, eventId });
  return data;
}
