import { google, calendar_v3 } from "googleapis";
import { getGoogleOAuthClient } from "./googleAuth";

const TIME_ZONE = "Asia/Bangkok";

/**
 * Authenticates as the same Google account used for Gmail (OAuth, not a
 * service account) — it already has write access to every property calendar
 * it manages day-to-day, so no separate per-calendar sharing step is needed.
 */
function getClient(): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: getGoogleOAuthClient() });
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
