import {
  listRecords,
  createRecord,
  verifyRecordPersisted,
  escapeFormulaString,
  AirtableRecord,
} from "../lib/airtable";
import {
  TABLES,
  MASTER_TRIPS_FIELDS,
  MASTER_TRIPS_CHOICES,
  PROPERTIES_FIELDS,
  CRM_FIELDS,
  CRM_CHOICES,
} from "../lib/schema";
import { normalizePhone } from "../lib/phone";
import type { ParsedBooking } from "../lib/parseBooking";
import { findExistingBookingEvent, createAllDayBookingEvent, getEventById } from "../lib/calendar";
import { fetchGuestPhoneFromAirbnb } from "../lib/airbnbScraper";
import { sendBookingNotification, type Region } from "../lib/telegram";

export type ProcessResult =
  | { outcome: "processed"; reason: string; detail?: Record<string, unknown> }
  | { outcome: "skipped"; reason: string; detail?: Record<string, unknown>; retryable: boolean };

function fmt(fieldId: string): string {
  return `{${fieldId}}`;
}

async function findExistingTripByConfirmationCode(code: string): Promise<AirtableRecord | null> {
  const matches = await listRecords(TABLES.masterTrips, {
    filterByFormula: `FIND("${escapeFormulaString(code)}", ${fmt(MASTER_TRIPS_FIELDS.comments)}) > 0`,
    fields: [MASTER_TRIPS_FIELDS.comments],
    maxRecords: 1,
  });
  return matches[0] ?? null;
}

async function resolveProperty(
  airbnbRoomId: string
): Promise<{ ok: true; property: AirtableRecord } | { ok: false; reason: string }> {
  const matches = await listRecords(TABLES.properties, {
    filterByFormula: `${fmt(PROPERTIES_FIELDS.airbnbId)} = "${escapeFormulaString(airbnbRoomId)}"`,
    fields: [
      PROPERTIES_FIELDS.airbnbId,
      PROPERTIES_FIELDS.airbnbListingTitle,
      PROPERTIES_FIELDS.internalListingName,
      PROPERTIES_FIELDS.googleCalendarId,
      PROPERTIES_FIELDS.city,
    ],
  });

  if (matches.length === 0) {
    return { ok: false, reason: `No property found with Airbnb ID ${airbnbRoomId}` };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `Ambiguous: ${matches.length} properties share Airbnb ID ${airbnbRoomId}` };
  }
  return { ok: true, property: matches[0] };
}

/** Digit-suffix comparison key: tolerant of country-code / trunk-prefix differences across stored formats. */
function phoneComparisonKey(e164: string): string {
  return e164.replace(/\D/g, "").slice(-9);
}

async function findCrmContactByPhone(normalizedPhone: string): Promise<AirtableRecord | null> {
  const key = phoneComparisonKey(normalizedPhone);
  const candidates = await listRecords(TABLES.crm, {
    filterByFormula: `NOT({${CRM_FIELDS.phoneNumber}} = "")`,
    fields: [CRM_FIELDS.phoneNumber, CRM_FIELDS.firstName, CRM_FIELDS.lastName],
  });

  for (const record of candidates) {
    const raw = record.fields[CRM_FIELDS.phoneNumber];
    if (typeof raw !== "string") continue;
    const normalized = normalizePhone(raw);
    if (normalized && phoneComparisonKey(normalized) === key) return record;
  }
  return null;
}

function splitGuestName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

/**
 * Exact, case-insensitive First+Last Name match. Used only when the Airbnb
 * phone lookup couldn't produce a number — a coarser signal than phone, so a
 * name collision (>1 match) is treated as genuinely ambiguous and skipped
 * rather than guessed.
 */
async function findCrmContactsByName(
  firstName: string,
  lastName: string
): Promise<AirtableRecord[]> {
  const formula =
    `AND(LOWER({${CRM_FIELDS.firstName}}) = "${escapeFormulaString(firstName.toLowerCase())}", ` +
    `LOWER({${CRM_FIELDS.lastName}}) = "${escapeFormulaString(lastName.toLowerCase())}")`;
  return listRecords(TABLES.crm, {
    filterByFormula: formula,
    fields: [CRM_FIELDS.firstName, CRM_FIELDS.lastName, CRM_FIELDS.phoneNumber],
  });
}

type CrmResolution =
  | {
      ok: true;
      crmContactId: string;
      isRepeat: boolean;
      matchedBy: "phone" | "name-new" | "name-existing";
      phone: string | null;
    }
  | { ok: false; reason: string };

async function resolveCrmContact(booking: ParsedBooking): Promise<CrmResolution> {
  const phoneLookup = await fetchGuestPhoneFromAirbnb(booking.confirmationCode);
  const normalizedPhone = phoneLookup.ok ? normalizePhone(phoneLookup.phone) : null;

  if (normalizedPhone) {
    const existing = await findCrmContactByPhone(normalizedPhone);
    if (existing) {
      return { ok: true, crmContactId: existing.id, isRepeat: true, matchedBy: "phone", phone: normalizedPhone };
    }
    const { firstName, lastName } = splitGuestName(booking.guestName);
    const created = await createRecord(TABLES.crm, {
      [CRM_FIELDS.firstName]: firstName,
      [CRM_FIELDS.lastName]: lastName,
      [CRM_FIELDS.phoneNumber]: normalizedPhone,
      [CRM_FIELDS.initialContactPoint]: CRM_CHOICES.initialContactPoint.airbnb.name,
    });
    await verifyRecordPersisted(TABLES.crm, created.id, {
      [CRM_FIELDS.firstName]: firstName,
      [CRM_FIELDS.phoneNumber]: normalizedPhone,
    });
    return { ok: true, crmContactId: created.id, isRepeat: false, matchedBy: "phone", phone: normalizedPhone };
  }

  // Phone unavailable (scraper not configured, session expired, or no match found) — fall back to name.
  const { firstName, lastName } = splitGuestName(booking.guestName);
  const nameMatches = await findCrmContactsByName(firstName, lastName);

  if (nameMatches.length > 1) {
    return {
      ok: false,
      reason:
        `Phone unavailable (${!phoneLookup.ok ? phoneLookup.reason : "no CRM match"}) and ` +
        `${nameMatches.length} CRM contacts share the name "${booking.guestName}" — ambiguous, cannot link safely`,
    };
  }

  if (nameMatches.length === 1) {
    const existingPhone = nameMatches[0].fields[CRM_FIELDS.phoneNumber];
    return {
      ok: true,
      crmContactId: nameMatches[0].id,
      isRepeat: true,
      matchedBy: "name-existing",
      phone: typeof existingPhone === "string" ? existingPhone : null,
    };
  }

  const created = await createRecord(TABLES.crm, {
    [CRM_FIELDS.firstName]: firstName,
    [CRM_FIELDS.lastName]: lastName,
    [CRM_FIELDS.initialContactPoint]: CRM_CHOICES.initialContactPoint.airbnb.name,
  });
  await verifyRecordPersisted(TABLES.crm, created.id, {
    [CRM_FIELDS.firstName]: firstName,
    [CRM_FIELDS.lastName]: lastName,
  });
  return { ok: true, crmContactId: created.id, isRepeat: false, matchedBy: "name-new", phone: null };
}

function toAirtableDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "SND 1906 | 1BR | 55SQ | 19F | SV | PT" -> "SND-1906" */
function extractPropertyCode(internalListingName: unknown): string | null {
  if (typeof internalListingName !== "string" || !internalListingName.trim()) return null;
  const firstSegment = internalListingName.split("|")[0].trim();
  return firstSegment.replace(/\s+/, "-") || null;
}

function formatDateLong(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function nightsBetween(checkIn: Date, checkoutExclusive: Date): number {
  return Math.round((checkoutExclusive.getTime() - checkIn.getTime()) / 86_400_000);
}

export async function processBooking(booking: ParsedBooking): Promise<ProcessResult> {
  const existingTrip = await findExistingTripByConfirmationCode(booking.confirmationCode);
  if (existingTrip) {
    return {
      outcome: "processed",
      reason: "Booking already exists in Master Trips (confirmation-code dedup match)",
      detail: { tripRecordId: existingTrip.id },
    };
  }

  const propertyResult = await resolveProperty(booking.airbnbRoomId);
  if (!propertyResult.ok) {
    return { outcome: "skipped", reason: propertyResult.reason, retryable: true };
  }
  const property = propertyResult.property;

  const crmResolution = await resolveCrmContact(booking);
  if (!crmResolution.ok) {
    return { outcome: "skipped", reason: crmResolution.reason, retryable: true };
  }
  const crmContactId = crmResolution.crmContactId;
  const inquiryType = crmResolution.isRepeat
    ? MASTER_TRIPS_CHOICES.inquiryType.repeat.name
    : MASTER_TRIPS_CHOICES.inquiryType.fresh.name;

  const listingTitle = (property.fields[PROPERTIES_FIELDS.airbnbListingTitle] as string) || booking.airbnbRoomId;
  const comments =
    `Airbnb booking ${booking.confirmationCode} — ${booking.guestName} — ${listingTitle} — ` +
    `${toAirtableDateString(booking.checkIn)} to ${toAirtableDateString(booking.checkoutExclusive)}`;

  const tripFields: Record<string, unknown> = {
    [MASTER_TRIPS_FIELDS.property]: [property.id],
    [MASTER_TRIPS_FIELDS.bookingChannel]: MASTER_TRIPS_CHOICES.bookingChannel.airbnb.name,
    [MASTER_TRIPS_FIELDS.arrivalDate]: toAirtableDateString(booking.checkIn),
    [MASTER_TRIPS_FIELDS.checkoutDate]: toAirtableDateString(booking.checkoutExclusive),
    [MASTER_TRIPS_FIELDS.paymentStatus]: MASTER_TRIPS_CHOICES.paymentStatus.fullyPaid.name,
    [MASTER_TRIPS_FIELDS.numberOfGuests]: booking.numberOfGuests,
    // MASTER_TRIPS_FIELDS.guestContact ("Guest Contact") was deleted from the
    // base sometime after initial setup — see README "2026-08-03 incident".
    // Guest name is folded into Comments below until a replacement field is chosen.
    [MASTER_TRIPS_FIELDS.comments]: comments,
    [MASTER_TRIPS_FIELDS.agreedCost]: booking.totalPaidThb,
    [MASTER_TRIPS_FIELDS.actualAmountPaid]: booking.totalPaidThb,
    [MASTER_TRIPS_FIELDS.inquiryStatus]: MASTER_TRIPS_CHOICES.inquiryStatus.paidAndConfirmed.name,
    [MASTER_TRIPS_FIELDS.inquiryFrom]: MASTER_TRIPS_CHOICES.inquiryFrom.customer.name,
    [MASTER_TRIPS_FIELDS.inquiryType]: inquiryType,
    [MASTER_TRIPS_FIELDS.crmContact]: [crmContactId],
  };

  const createdTrip = await createRecord(TABLES.masterTrips, tripFields);
  await verifyRecordPersisted(TABLES.masterTrips, createdTrip.id, {
    [MASTER_TRIPS_FIELDS.property]: [property.id],
    [MASTER_TRIPS_FIELDS.comments]: comments,
    [MASTER_TRIPS_FIELDS.crmContact]: [crmContactId],
  });

  const calendarId = property.fields[PROPERTIES_FIELDS.googleCalendarId] as string | undefined;
  let calendarOutcome: { blocked: boolean; eventId?: string; note: string };

  if (!calendarId) {
    calendarOutcome = { blocked: false, note: "calendar block skipped — property has no Google Calendar ID on file" };
  } else {
    const existingEvent = await findExistingBookingEvent(calendarId, booking.confirmationCode);
    if (existingEvent) {
      calendarOutcome = { blocked: true, eventId: existingEvent.id!, note: "calendar event already existed (dedup match)" };
    } else {
      const guestNoun = booking.numberOfGuests === 1 ? "guest" : "guests";
      const summary = `${booking.guestName} | Airbnb | ${booking.confirmationCode} (${booking.numberOfGuests} ${guestNoun})`;
      const createdEvent = await createAllDayBookingEvent({
        calendarId,
        summary,
        checkIn: booking.checkIn,
        checkoutExclusive: booking.checkoutExclusive,
      });

      const verifiedEvent = await getEventById(calendarId, createdEvent.id!);
      if (verifiedEvent.status !== "confirmed") {
        throw new Error(
          `Calendar event ${createdEvent.id} for trip ${createdTrip.id} did not verify as confirmed (status: ${verifiedEvent.status})`
        );
      }
      calendarOutcome = { blocked: true, eventId: createdEvent.id!, note: "calendar block created and verified" };
    }
  }

  const region = property.fields[PROPERTIES_FIELDS.city] as Region | undefined;
  let notificationNote = "not sent — property has no City set";
  if (region === "Pattaya" || region === "Phuket") {
    try {
      const propertyCode = extractPropertyCode(property.fields[PROPERTIES_FIELDS.internalListingName]);
      await sendBookingNotification(
        region,
        buildNotificationText(booking, listingTitle, propertyCode, calendarOutcome, crmResolution.phone)
      );
      notificationNote = `sent to ${region} Telegram group`;
    } catch (err) {
      // Notification failures never undo a successful trip/calendar creation — just log it.
      notificationNote = `failed: ${(err as Error).message}`;
    }
  }

  return {
    outcome: "processed",
    reason: `Master Trips record created; ${calendarOutcome.note}; Telegram notification ${notificationNote}`,
    detail: {
      tripRecordId: createdTrip.id,
      eventId: calendarOutcome.eventId,
      calendarId,
      crmMatchedBy: crmResolution.matchedBy,
      region,
      notificationNote,
    },
  };
}

function buildNotificationText(
  booking: ParsedBooking,
  listingTitle: string,
  propertyCode: string | null,
  calendarOutcome: { blocked: boolean; note: string },
  phone: string | null
): string {
  const guestNoun = booking.numberOfGuests === 1 ? "guest" : "guests";
  const nights = nightsBetween(booking.checkIn, booking.checkoutExclusive);
  const propertyLine = propertyCode ? `🏠 <b>${propertyCode}</b> — ${listingTitle}` : `🏠 ${listingTitle}`;

  return [
    `🏝️ <b>New Airbnb Booking</b>`,
    "",
    `👤 ${booking.guestName}`,
    propertyLine,
    `📅 ${formatDateLong(booking.checkIn)} → ${formatDateLong(booking.checkoutExclusive)} · ${nights} nights`,
    `👥 ${booking.numberOfGuests} ${guestNoun}`,
    `🔖 ${booking.confirmationCode}`,
    "",
    "✅ Trip created",
    calendarOutcome.blocked ? "✅ Calendar blocked" : "⚠️ Calendar NOT blocked (no Google Calendar ID on file)",
    `📞 Phone: ${phone ?? "not available"}`,
    "👥 Create group with guest",
  ].join("\n");
}
