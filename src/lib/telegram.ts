/**
 * Sends booking notifications to region-specific Telegram topics (Pattaya /
 * Phuket) via the Bot API. Uses a dedicated bot already added as a member of
 * both destination groups — each group is a "forum" (Topics-enabled)
 * supergroup, so routing needs both a chat ID and a topic/thread ID, not
 * just a chat ID.
 */

export type Region = "Pattaya" | "Phuket";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function targetForRegion(region: Region): { chatId: string; threadId: string } {
  return region === "Pattaya"
    ? { chatId: requireEnv("TELEGRAM_PATTAYA_CHAT_ID"), threadId: requireEnv("TELEGRAM_PATTAYA_THREAD_ID") }
    : { chatId: requireEnv("TELEGRAM_PHUKET_CHAT_ID"), threadId: requireEnv("TELEGRAM_PHUKET_THREAD_ID") };
}

export async function sendBookingNotification(region: Region, text: string): Promise<void> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const { chatId, threadId } = targetForRegion(region);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: Number(chatId),
      message_thread_id: Number(threadId),
      text,
      parse_mode: "HTML",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}
