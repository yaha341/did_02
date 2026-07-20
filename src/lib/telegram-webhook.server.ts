/** Shared Telegram webhook / admin-id helpers (server-only). */

export function verifyTelegramWebhookSecret(request: Request, envNames: string[]): boolean {
  const expected = envNames.map((n) => process.env[n]).find((v) => v && v.length > 0);
  if (!expected) {
    // No secret in env: accept updates (otherwise bot is silent on Vercel). Prefer setting a secret.
    console.warn(
      `[webhook] No secret configured (${envNames.join(" / ")}). Accepting request; set env + secret_token on setWebhook for production.`,
    );
    return true;
  }
  const header = request.headers.get("x-telegram-bot-api-secret-token");
  return header === expected;
}

/** Collect unique admin Telegram IDs from app_settings keys. */
export function parseNotifyAdminIds(settings: Record<string, string>): string[] {
  const keys = ["admin_chat_id", "owner_chat_id", "developer_chat_id"] as const;
  const ids = new Set<string>();
  for (const key of keys) {
    const raw = settings[key] || "";
    for (const part of raw.split(",")) {
      const id = part.trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export function isTelegramAdmin(fromId: number | string | undefined, adminIds: string[]): boolean {
  if (fromId == null) return false;
  const id = String(fromId);
  return adminIds.includes(id);
}
