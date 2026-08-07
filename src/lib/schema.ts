/**
 * Airtable base "Main" (appND9kP55cvkDX7V) field-ID map.
 * Every ID here was discovered via the Airtable metadata API on 2026-07-31 —
 * none are guessed. If Airtable schema changes, re-run the discovery queries
 * (list_tables_for_base / get_table_schema) before touching these constants.
 */

export const BASE_ID = "appND9kP55cvkDX7V";

export const TABLES = {
  masterTrips: "tblodAjjJy8FBQAY7",
  properties: "tblYsjDyc84qS0cSw",
  crm: "tbljAtpRqo0s1siQe",
} as const;

export const MASTER_TRIPS_FIELDS = {
  property: "fldEkJorW6llGqI08",
  bookingChannel: "fldrmnsj1lsZO9UoJ",
  arrivalDate: "fldu81bwcyq86aBKz",
  checkoutDate: "fldiQISqiSkO45tvn",
  paymentStatus: "fld6Fm1g7VYsmKVl1",
  numberOfGuests: "fldlPEchlM3BssJYx",
  // "Guest Contact" (fldcMCTokTCHyvCbv) was deleted from the base sometime
  // after 2026-07-31 (discovered 2026-08-03 when every booking started
  // silently failing). Guest name is folded into Comments instead. If a
  // replacement field is added, verify its ID before reintroducing here.
  comments: "fld63KH9a06DGbgKT",
  agreedCost: "fldCmeh4OXrF5wt5m",
  inquiryStatus: "fldxU0AyJl5bkeDg2",
  inquiryFrom: "fld5b1Op3s0x32AI4",
  inquiryType: "fldgsJ8a2SgBVU5VT",
  securityDeposit: "fld9R07PzqUejDI5v",
  actualAmountPaid: "fldbOTdIWGDUpeIjt", // "Actual advance paid by the customer"
  crmContact: "fldY3YO3qh41ApmxJ",
} as const;

/**
 * Airtable's write API expects singleSelect fields as the option's plain
 * name string (not its choice ID) — passing an ID would typecast a brand new
 * option into existence. IDs are kept here only for reference/verification.
 */
export const MASTER_TRIPS_CHOICES = {
  bookingChannel: { airbnb: { id: "selbP4KXdoVtXaa2Z", name: "Airbnb" } },
  paymentStatus: { fullyPaid: { id: "selqI5QUPovcyAZVh", name: "Fully paid" } },
  inquiryStatus: { paidAndConfirmed: { id: "selsHAW8UPJjzkEtZ", name: "Paid and confirmed" } },
  inquiryFrom: { customer: { id: "selwk27NBsjQXOxCF", name: "Customer" } },
  inquiryType: {
    fresh: { id: "selvkNI0JWC8okU33", name: "Fresh" },
    repeat: { id: "selUvxJC4uhnjxqvY", name: "Repeat" },
  },
} as const;

export const PROPERTIES_FIELDS = {
  airbnbId: "fldiDSwS3FzURkhpi", // numeric Airbnb room ID; matched against the rooms/{id} URL in booking emails
  airbnbListingTitle: "fld9Tvr8mNpzy9lG7", // display-only, used for human-readable comments/summaries
  internalListingName: "fldbGV6PdAkF2Jhpk", // e.g. "SND 1906 | 1BR | 55SQ | 19F | SV | PT" — used for the short property code in notifications
  googleCalendarId: "flds2Pkaxh2nx4Kjc",
  city: "fldS3QKXfaYiBToIx", // singleSelect: "Pattaya" | "Phuket" — routes the Telegram notification
} as const;

export const PROPERTIES_CHOICES = {
  city: {
    pattaya: { id: "selNhtGWCaUPSETna", name: "Pattaya" },
    phuket: { id: "selrjlqd6X7FkT8Ye", name: "Phuket" },
  },
} as const;

export const CRM_FIELDS = {
  firstName: "fldpQDbt3mhS7JENm",
  lastName: "fldeMrtoK6oqx1tNW",
  phoneNumber: "flddoNYFVjr1w4uq6",
  email: "fldMYbufyr9jnkmIV",
  initialContactPoint: "fld8cQZ307o5NyUAe",
} as const;

export const CRM_CHOICES = {
  initialContactPoint: { airbnb: { id: "selBDvzRAVWwMTlKa", name: "Airbnb" } },
} as const;
