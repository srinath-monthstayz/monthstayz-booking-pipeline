import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Normalizes a phone number to E.164 (+66812345678) for comparison and storage.
 * Airbnb emails rarely include a country hint, so we default to Thailand when
 * the number doesn't already carry a country code.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withPlus = parsePhoneNumberFromString(trimmed);
  if (withPlus?.isValid()) return withPlus.number;

  const asThai = parsePhoneNumberFromString(trimmed, "TH");
  if (asThai?.isValid()) return asThai.number;

  return null;
}
