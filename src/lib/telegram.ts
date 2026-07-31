/**
 * Sends booking notifications to region-specific Telegram groups (Pattaya /
 * Phuket) via the Bot API. Reuses the existing "My Claude Agent" bot token
 * rather than provisioning a new bot — this module only needs the bot to
 * already be a member of both destination group chats.
 */

export type Region = "Pattaya" | "Phuket";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function chatIdForRegion(region: Region): string {
  return region === "Pattaya"
    ? requireEnv("TELEGRAM_PATTAYA_CHAT_ID")
    : requireEnv("TELEGRAM_PHUKET_CHAT_ID");
}

export async function sendBookingNotification(region: Region, text: string): Promise<void> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const chatId = chatIdForRegion(region);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}
