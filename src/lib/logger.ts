export type RunOutcome = "processed" | "skipped" | "errored";

export interface RunLogEntry {
  outcome: RunOutcome;
  gmailMessageId: string;
  reason: string;
  detail?: Record<string, unknown>;
}

/**
 * Structured, single-line-JSON logging so a run's outcomes are greppable in
 * Vercel logs without opening each invocation.
 */
export class RunLogger {
  private entries: RunLogEntry[] = [];
  private readonly runId: string;
  private readonly startedAt: string;

  constructor(runId: string) {
    this.runId = runId;
    this.startedAt = new Date().toISOString();
  }

  record(entry: RunLogEntry): void {
    this.entries.push(entry);
    console.log(
      JSON.stringify({
        runId: this.runId,
        ts: new Date().toISOString(),
        ...entry,
      })
    );
  }

  summary() {
    const counts = { processed: 0, skipped: 0, errored: 0 };
    for (const e of this.entries) counts[e.outcome]++;
    return {
      runId: this.runId,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      counts,
      entries: this.entries,
    };
  }
}
