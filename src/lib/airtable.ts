import { BASE_ID } from "./schema";

const API_ROOT = "https://api.airtable.com/v0";

function apiKey(): string {
  const key = process.env.AIRTABLE_API_KEY;
  if (!key) throw new Error("AIRTABLE_API_KEY is not set");
  return key;
}

async function airtableFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Airtable ${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

export type AirtableRecord<TFields extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  createdTime: string;
  fields: TFields;
};

/** List records matching an Airtable formula. Handles pagination transparently. */
export async function listRecords(
  tableId: string,
  opts: { filterByFormula?: string; fields?: string[]; maxRecords?: number } = {}
): Promise<AirtableRecord[]> {
  const records: AirtableRecord[] = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    if (opts.filterByFormula) params.set("filterByFormula", opts.filterByFormula);
    if (opts.maxRecords) params.set("maxRecords", String(opts.maxRecords));
    if (opts.fields) for (const f of opts.fields) params.append("fields[]", f);
    if (offset) params.set("offset", offset);

    const data = await airtableFetch(`/${BASE_ID}/${tableId}?${params.toString()}`);
    records.push(...(data.records ?? []));
    offset = data.offset;
  } while (offset && (!opts.maxRecords || records.length < opts.maxRecords));

  return records;
}

export async function getRecord(tableId: string, recordId: string): Promise<AirtableRecord | null> {
  try {
    return await airtableFetch(`/${BASE_ID}/${tableId}/${recordId}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes(" 404 ")) return null;
    throw err;
  }
}

export async function createRecord(
  tableId: string,
  fields: Record<string, unknown>
): Promise<AirtableRecord> {
  const data = await airtableFetch(`/${BASE_ID}/${tableId}`, {
    method: "POST",
    body: JSON.stringify({ fields, typecast: true }),
  });
  return data;
}

export async function updateRecord(
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>
): Promise<AirtableRecord> {
  const data = await airtableFetch(`/${BASE_ID}/${tableId}/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ fields, typecast: true }),
  });
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * This base's search index lags and writes occasionally don't persist on the
 * first attempt. Re-fetch by record ID and confirm the expected fields stuck
 * before the caller proceeds, retrying the raw GET a few times.
 */
export async function verifyRecordPersisted(
  tableId: string,
  recordId: string,
  expectedFields: Record<string, unknown>,
  opts: { attempts?: number; delayMs?: number } = {}
): Promise<AirtableRecord> {
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 1000;

  let last: AirtableRecord | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await getRecord(tableId, recordId);
    if (last && fieldsMatch(last.fields, expectedFields)) return last;
    await sleep(delayMs);
  }

  throw new Error(
    `Record ${recordId} in ${tableId} did not persist expected fields after ${attempts} attempts. ` +
      `Last seen: ${JSON.stringify(last?.fields ?? null)}`
  );
}

function scalarKey(v: unknown): unknown {
  return v && typeof v === "object" && "id" in (v as any) ? (v as any).id : v;
}

function scalarKeyByNameOrId(v: unknown): unknown {
  // singleSelect reads back as {id, name, color}; writes are done by name, so compare on name.
  return v && typeof v === "object" && "name" in (v as any) ? (v as any).name : v;
}

function fieldsMatch(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) continue;
    const actualValue = actual[key];
    if (Array.isArray(value)) {
      const actualArr = Array.isArray(actualValue) ? actualValue : [];
      const normalize = (arr: unknown[]) => arr.map(scalarKey).sort();
      if (JSON.stringify(normalize(value)) !== JSON.stringify(normalize(actualArr))) return false;
    } else if (scalarKeyByNameOrId(actualValue) !== value) {
      return false;
    }
  }
  return true;
}

/** Escapes a string for safe embedding inside an Airtable filterByFormula string literal. */
export function escapeFormulaString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
