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
    fields: [PROPERTIES_FIELDS.airbnbId, PROPERTIES_FIELDS.airbnbListingTitle, PROPERTIES_FIELDS.googleCalendarId],
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

function toAirtableDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
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

  const normalizedPhone = normalizePhone(booking.guestPhoneRaw);
  if (!normalizedPhone) {
    return {
      outcome: "skipped",
      reason: "Guest phone number missing or malformed — cannot verify CRM contact match",
      detail: { rawPhone: booking.guestPhoneRaw },
      retryable: true,
    };
  }

  const existingCrmContact = await findCrmContactByPhone(normalizedPhone);
  const inquiryType = existingCrmContact
    ? MASTER_TRIPS_CHOICES.inquiryType.repeat.name
    : MASTER_TRIPS_CHOICES.inquiryType.fresh.name;

  let crmContactId: string;
  if (existingCrmContact) {
    crmContactId = existingCrmContact.id;
  } else {
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
    crmContactId = created.id;
  }

  const listingTitle = (property.fields[PROPERTIES_FIELDS.airbnbListingTitle] as string) || booking.airbnbRoomId;
  const comments =
    `Airbnb booking ${booking.confirmationCode} — ${listingTitle} — ` +
    `${toAirtableDateString(booking.checkIn)} to ${toAirtableDateString(booking.checkoutExclusive)}`;

  const tripFields: Record<string, unknown> = {
    [MASTER_TRIPS_FIELDS.property]: [property.id],
    [MASTER_TRIPS_FIELDS.bookingChannel]: MASTER_TRIPS_CHOICES.bookingChannel.airbnb.name,
    [MASTER_TRIPS_FIELDS.arrivalDate]: toAirtableDateString(booking.checkIn),
    [MASTER_TRIPS_FIELDS.checkoutDate]: toAirtableDateString(booking.checkoutExclusive),
    [MASTER_TRIPS_FIELDS.paymentStatus]: MASTER_TRIPS_CHOICES.paymentStatus.fullyPaid.name,
    [MASTER_TRIPS_FIELDS.numberOfGuests]: booking.numberOfGuests,
    [MASTER_TRIPS_FIELDS.guestContact]: booking.guestName,
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
  if (!calendarId) {
    return {
      outcome: "processed",
      reason: "Master Trips record created; calendar block skipped — property has no Google Calendar ID on file",
      detail: { tripRecordId: createdTrip.id, propertyId: property.id },
    };
  }

  const existingEvent = await findExistingBookingEvent(calendarId, booking.confirmationCode);
  if (existingEvent) {
    return {
      outcome: "processed",
      reason: "Master Trips record created; calendar event already existed (dedup match)",
      detail: { tripRecordId: createdTrip.id, eventId: existingEvent.id },
    };
  }

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

  return {
    outcome: "processed",
    reason: "Master Trips record and calendar block created and verified",
    detail: { tripRecordId: createdTrip.id, eventId: createdEvent.id, calendarId },
  };
}
