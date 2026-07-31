import { google, gmail_v1 } from "googleapis";

export interface ParsedEmail {
  gmailMessageId: string;
  subject: string;
  from: string;
  receivedAt: string;
  html: string;
  text: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function getOAuthClient() {
  const client = new google.auth.OAuth2(
    requireEnv("GMAIL_CLIENT_ID"),
    requireEnv("GMAIL_CLIENT_SECRET")
  );
  client.setCredentials({ refresh_token: requireEnv("GMAIL_REFRESH_TOKEN") });
  return client;
}

function getClient(): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: getOAuthClient() });
}

/** Gmail search query for new, unprocessed Airbnb booking-confirmation emails. Configurable via env. */
function buildSearchQuery(): string {
  const base =
    process.env.GMAIL_SEARCH_QUERY ??
    'from:(automated@airbnb.com OR express@airbnb.com) subject:"Reservation confirmed"';
  const exclusions = [processedLabelName(), needsAttentionLabelName()]
    .map((name) => `-label:${name.replace(/\s+/g, "-")}`)
    .join(" ");
  return `${base} ${exclusions}`;
}

function processedLabelName(): string {
  return process.env.GMAIL_PROCESSED_LABEL ?? "MonthStayz-Processed";
}

function needsAttentionLabelName(): string {
  return process.env.GMAIL_NEEDS_ATTENTION_LABEL ?? "MonthStayz-Needs-Attention";
}

const labelIdCache = new Map<string, string>();

async function ensureLabelId(gmail: gmail_v1.Gmail, name: string): Promise<string> {
  const cached = labelIdCache.get(name);
  if (cached) return cached;

  const { data } = await gmail.users.labels.list({ userId: "me" });
  const existing = data.labels?.find((l) => l.name === name);
  if (existing?.id) {
    labelIdCache.set(name, existing.id);
    return existing.id;
  }

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  labelIdCache.set(name, created.data.id!);
  return created.data.id!;
}

/** Returns Gmail message IDs for unprocessed booking-confirmation emails, oldest first. */
export async function listNewBookingEmailIds(maxResults = 25): Promise<string[]> {
  const gmail = getClient();
  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: buildSearchQuery(),
    maxResults,
  });
  const ids = (data.messages ?? []).map((m) => m.id!).filter(Boolean);
  return ids.reverse(); // process oldest-first
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf-8");
}

function extractBodies(payload: gmail_v1.Schema$MessagePart | undefined): { html: string; text: string } {
  let html = "";
  let text = "";
  if (!payload) return { html, text };

  const stack: gmail_v1.Schema$MessagePart[] = [payload];
  while (stack.length) {
    const part = stack.pop()!;
    if (part.parts) stack.push(...part.parts);
    const data = part.body?.data;
    if (!data) continue;
    if (part.mimeType === "text/html") html += decodeBase64Url(data);
    else if (part.mimeType === "text/plain") text += decodeBase64Url(data);
  }
  return { html, text };
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export async function getBookingEmail(messageId: string): Promise<ParsedEmail> {
  const gmail = getClient();
  const { data } = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = data.payload?.headers;
  const { html, text } = extractBodies(data.payload);

  return {
    gmailMessageId: messageId,
    subject: headerValue(headers, "Subject"),
    from: headerValue(headers, "From"),
    receivedAt: new Date(Number(data.internalDate ?? Date.now())).toISOString(),
    html,
    text,
  };
}

/**
 * Marks a message as successfully processed (trip created, or confirmed as an
 * already-existing duplicate) so it's never picked up by the search query again.
 */
export async function markBookingEmailProcessed(messageId: string): Promise<void> {
  const gmail = getClient();
  const labelId = await ensureLabelId(gmail, processedLabelName());
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

/**
 * Marks a message as needing manual attention (unparseable, unmatched
 * property, missing/malformed phone, etc). Excluded from future search runs
 * so the same failure isn't re-logged forever; remove the label in Gmail
 * once the underlying data is fixed to let the cron pick it up again.
 */
export async function markBookingEmailNeedsAttention(messageId: string): Promise<void> {
  const gmail = getClient();
  const labelId = await ensureLabelId(gmail, needsAttentionLabelName());
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}
