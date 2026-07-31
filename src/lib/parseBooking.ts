import type { ParsedEmail } from "./gmail";

export interface ParsedBooking {
  gmailMessageId: string;
  guestName: string;
  confirmationCode: string;
  airbnbRoomId: string;
  checkIn: Date;
  checkoutExclusive: Date;
  numberOfGuests: number;
  totalPaidThb: number;
}

export interface ParseFailure {
  gmailMessageId: string;
  reason: string;
}

export type ParseResult =
  | { ok: true; booking: ParsedBooking }
  | { ok: false; failure: ParseFailure };

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parses an Airbnb "Reservation confirmed" host-notification email.
 * Built and verified against real emails pulled from the connected Gmail
 * account (2026-07-31) — see plaintext structure notes inline.
 */
export function parseBookingEmail(email: ParsedEmail): ParseResult {
  const gmailMessageId = email.gmailMessageId;
  const text = normalizeWhitespace(email.text || email.html);

  const guestName = extractGuestName(email.subject);
  if (!guestName) {
    return { ok: false, failure: { gmailMessageId, reason: "Could not extract guest name from subject" } };
  }

  const confirmationCode = extractConfirmationCode(text);
  if (!confirmationCode) {
    return { ok: false, failure: { gmailMessageId, reason: "Could not extract confirmation code" } };
  }

  const airbnbRoomId = extractRoomId(text);
  if (!airbnbRoomId) {
    return { ok: false, failure: { gmailMessageId, reason: "Could not extract Airbnb room ID from listing URL" } };
  }

  const dates = extractDates(text, new Date(email.receivedAt));
  if (!dates) {
    return { ok: false, failure: { gmailMessageId, reason: "Could not extract check-in/checkout dates" } };
  }

  const numberOfGuests = extractGuestCount(text);
  if (numberOfGuests === null) {
    return { ok: false, failure: { gmailMessageId, reason: "Could not extract number of guests" } };
  }

  const totalPaidThb = extractTotalPaidThb(text);
  if (totalPaidThb === null) {
    return { ok: false, failure: { gmailMessageId, reason: "Could not extract TOTAL (THB) guest-paid amount" } };
  }

  return {
    ok: true,
    booking: {
      gmailMessageId,
      guestName,
      confirmationCode,
      airbnbRoomId,
      checkIn: dates.checkIn,
      checkoutExclusive: dates.checkoutExclusive,
      numberOfGuests,
      totalPaidThb,
    },
  };
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
}

function extractGuestName(subject: string): string | null {
  const match = subject.match(/Reservation confirmed\s*-\s*(.+?)\s+arrives\s/i);
  return match ? match[1].trim() : null;
}

function extractConfirmationCode(text: string): string | null {
  const labeled = text.match(/CONFIRMATION CODE\s*\n?\s*([A-Z0-9]{8,12})/);
  if (labeled) return labeled[1];
  const fromUrl = text.match(/reservations\/details\/([A-Z0-9]{8,12})/);
  return fromUrl ? fromUrl[1] : null;
}

function extractRoomId(text: string): string | null {
  const match = text.match(/airbnb\.[a-z.]+\/rooms\/(\d+)/i);
  return match ? match[1] : null;
}

/**
 * Airbnb's plaintext renders "Check-in Checkout" as a header line, followed
 * eventually by a line with two "Weekday, Month Day" tokens (no year).
 * We infer the year from the email's received date: if the parsed date would
 * fall more than ~120 days in the past, roll it forward a year.
 */
function extractDates(text: string, receivedAt: Date): { checkIn: Date; checkoutExclusive: Date } | null {
  const headerIdx = text.indexOf("Check-in Checkout");
  if (headerIdx === -1) return null;

  const window = text.slice(headerIdx, headerIdx + 400);
  const dateTokenPattern = /[A-Z][a-z]{2},\s+([A-Z][a-z]{2})\s+(\d{1,2})/g;
  const matches = [...window.matchAll(dateTokenPattern)];
  if (matches.length < 2) return null;

  const [checkInMatch, checkoutMatch] = matches;
  const checkIn = resolveDateWithYear(checkInMatch[1], Number(checkInMatch[2]), receivedAt);
  const checkoutExclusive = resolveDateWithYear(checkoutMatch[1], Number(checkoutMatch[2]), receivedAt);
  if (!checkIn || !checkoutExclusive) return null;

  return { checkIn, checkoutExclusive };
}

function resolveDateWithYear(monthAbbrev: string, day: number, receivedAt: Date): Date | null {
  const month = MONTHS[monthAbbrev.toLowerCase()];
  if (month === undefined) return null;

  let year = receivedAt.getFullYear();
  let candidate = new Date(Date.UTC(year, month, day));
  const diffDays = (candidate.getTime() - receivedAt.getTime()) / 86_400_000;
  if (diffDays < -120) {
    year += 1;
    candidate = new Date(Date.UTC(year, month, day));
  }
  return candidate;
}

function extractGuestCount(text: string): number | null {
  const headerIdx = text.indexOf("GUESTS");
  if (headerIdx === -1) return null;

  const window = text.slice(headerIdx, headerIdx + 200);
  const countPattern = /(\d+)\s+(adult|child|children|infant)s?/gi;
  const matches = [...window.matchAll(countPattern)];
  if (matches.length === 0) return null;

  return matches.reduce((sum, m) => sum + Number(m[1]), 0);
}

function extractTotalPaidThb(text: string): number | null {
  const match = text.match(/TOTAL \(THB\)\s*[^\d]*([\d,]+\.\d{2})/);
  if (!match) return null;
  return Number(match[1].replace(/,/g, ""));
}
