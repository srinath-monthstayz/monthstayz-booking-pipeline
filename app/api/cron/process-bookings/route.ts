import { NextRequest, NextResponse } from "next/server";
import { listNewBookingEmailIds, getBookingEmail, markBookingEmailProcessed, markBookingEmailNeedsAttention } from "@/lib/gmail";
import { parseBookingEmail } from "@/lib/parseBooking";
import { processBooking } from "@/pipeline/processBooking";
import { RunLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runId = `run_${Date.now()}`;
  const logger = new RunLogger(runId);

  let messageIds: string[];
  try {
    messageIds = await listNewBookingEmailIds();
  } catch (err) {
    logger.record({
      outcome: "errored",
      gmailMessageId: "n/a",
      reason: `Failed to list Gmail messages: ${(err as Error).message}`,
    });
    return NextResponse.json(logger.summary(), { status: 500 });
  }

  for (const messageId of messageIds) {
    try {
      const email = await getBookingEmail(messageId);
      const parsed = parseBookingEmail(email);

      if (!parsed.ok) {
        logger.record({ outcome: "skipped", gmailMessageId: messageId, reason: parsed.failure.reason });
        await markBookingEmailNeedsAttention(messageId);
        continue;
      }

      const result = await processBooking(parsed.booking);

      if (result.outcome === "processed") {
        logger.record({ outcome: "processed", gmailMessageId: messageId, reason: result.reason, detail: result.detail });
        await markBookingEmailProcessed(messageId);
      } else {
        logger.record({ outcome: "skipped", gmailMessageId: messageId, reason: result.reason, detail: result.detail });
        if (result.retryable) {
          await markBookingEmailNeedsAttention(messageId);
        }
      }
    } catch (err) {
      // Left unlabeled so a transient failure (Airtable/Calendar API hiccup) retries next run.
      logger.record({
        outcome: "errored",
        gmailMessageId: messageId,
        reason: (err as Error).message,
      });
    }
  }

  const summary = logger.summary();
  console.log(JSON.stringify({ runSummary: summary }));
  return NextResponse.json(summary);
}
