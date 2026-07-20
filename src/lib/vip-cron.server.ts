import { isAlreadyNotInChat, tgVip } from "@/lib/vip-bot.server";

export type VipCronResult = {
  warned: number;
  warned2: number;
  expired: number;
  kickFailed: number;
  errors: string[];
};

function addWarnOffset(base: Date, amount: number, isTest: boolean): Date {
  const d = new Date(base);
  if (isTest) d.setMinutes(d.getMinutes() + amount);
  else d.setDate(d.getDate() + amount);
  return d;
}

async function sendWarn(
  telegramId: number,
  expiresAt: string,
  stage: 1 | 2,
): Promise<{ ok: boolean; description?: string }> {
  const when = new Date(expiresAt).toLocaleString("ru-RU");
  const text =
    stage === 1
      ? `⚠️ <b>Напоминание</b>\n\nВаша VIP подписка истекает <b>${when}</b>.\n\nПродлите подписку заранее, чтобы не потерять доступ к группе.`
      : `🚨 <b>Срочно!</b>\n\nВаша VIP подписка истекает уже <b>${when}</b>!\n\nПродлите сейчас — иначе доступ к группе будет закрыт.`;

  return tgVip("sendMessage", {
    chat_id: telegramId,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Продлить подписку",
            url: `https://t.me/${process.env.VIP_BOT_USERNAME || "RazvivashkaVIP_bot"}?start=renew`,
          },
        ],
      ],
    },
  });
}

/** Shared VIP expiry/warn job — used by HTTP cron and admin "run now". */
export async function runVipCronJob(): Promise<VipCronResult> {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  const s = supabaseAdmin;

  const result: VipCronResult = { warned: 0, warned2: 0, expired: 0, kickFailed: 0, errors: [] };

  const { data: settingsData } = await s.from("app_settings").select("*");
  const settings: Record<string, string> = {};
  for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";

  const isTest = settings.vip_test_mode === "true";
  const warnDays = parseInt(settings.vip_warn_days || "3", 10);
  const warnDays2 = parseInt(settings.vip_warn_days_2 || "1", 10);
  const groupId = settings.vip_group_id;

  if (!groupId) {
    throw new Error("vip_group_id не настроен в настройках VIP");
  }

  const now = new Date();
  const threshold1 = addWarnOffset(now, warnDays, isTest);
  const threshold2 = addWarnOffset(now, warnDays2, isTest);

  // 1st warning: not warned yet, within first window
  const { data: stage1 } = await s
    .from("vip_subscriptions")
    .select("*")
    .eq("status", "active")
    .lte("expires_at", threshold1.toISOString())
    .gt("expires_at", now.toISOString())
    .is("admin_note", null);

  for (const sub of stage1 ?? []) {
    try {
      const sent = await sendWarn(sub.telegram_id as number, sub.expires_at as string, 1);
      if (sent.ok) {
        await s.from("vip_subscriptions").update({ admin_note: "warned" }).eq("id", sub.id);
        result.warned++;
      } else {
        result.errors.push(`warn1 ${sub.telegram_id}: ${sent.description || "send failed"}`);
      }
    } catch (err) {
      result.errors.push(`warn1 ${sub.telegram_id}: ${(err as Error).message}`);
    }
  }

  // 2nd warning: already got 1st, within second (closer) window
  const { data: stage2 } = await s
    .from("vip_subscriptions")
    .select("*")
    .eq("status", "active")
    .lte("expires_at", threshold2.toISOString())
    .gt("expires_at", now.toISOString())
    .eq("admin_note", "warned");

  for (const sub of stage2 ?? []) {
    try {
      const sent = await sendWarn(sub.telegram_id as number, sub.expires_at as string, 2);
      if (sent.ok) {
        await s.from("vip_subscriptions").update({ admin_note: "warned2" }).eq("id", sub.id);
        result.warned2++;
      } else {
        result.errors.push(`warn2 ${sub.telegram_id}: ${sent.description || "send failed"}`);
      }
    } catch (err) {
      result.errors.push(`warn2 ${sub.telegram_id}: ${(err as Error).message}`);
    }
  }

  const { data: subsToExpire } = await s
    .from("vip_subscriptions")
    .select("*")
    .eq("status", "active")
    .lte("expires_at", now.toISOString());

  for (const sub of subsToExpire ?? []) {
    try {
      const { count: otherActive } = await s
        .from("vip_subscriptions")
        .select("*", { count: "exact", head: true })
        .eq("telegram_id", sub.telegram_id)
        .eq("status", "active")
        .gt("expires_at", now.toISOString())
        .neq("id", sub.id);

      if ((otherActive ?? 0) > 0) {
        if (sub.group_invite_link) {
          await tgVip("revokeChatInviteLink", {
            chat_id: groupId,
            invite_link: sub.group_invite_link,
          });
        }
        await s.from("vip_subscriptions").update({ status: "expired" }).eq("id", sub.id);
        result.expired++;
        continue;
      }

      const ban = await tgVip("banChatMember", {
        chat_id: groupId,
        user_id: sub.telegram_id,
        revoke_messages: false,
      });

      if (!ban.ok && !isAlreadyNotInChat(ban.description)) {
        result.kickFailed++;
        result.errors.push(`kick ${sub.telegram_id}: ${ban.description || "ban failed"}`);
        continue;
      }

      await tgVip("unbanChatMember", {
        chat_id: groupId,
        user_id: sub.telegram_id,
        only_if_banned: true,
      });

      if (sub.group_invite_link) {
        await tgVip("revokeChatInviteLink", {
          chat_id: groupId,
          invite_link: sub.group_invite_link,
        });
      }

      await tgVip("sendMessage", {
        chat_id: sub.telegram_id,
        text: `❌ <b>Ваша VIP подписка истекла!</b>\n\nВы были исключены из VIP группы. Чтобы вернуться, оформите новую подписку в боте.`,
        parse_mode: "HTML",
      });

      await s.from("vip_subscriptions").update({ status: "expired" }).eq("id", sub.id);
      result.expired++;
    } catch (err) {
      result.errors.push(`expire ${sub.telegram_id}: ${(err as Error).message}`);
    }
  }

  return result;
}

export function isVipCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const url = new URL(request.url);
  if (url.searchParams.get("secret") === secret) return true;

  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;

  if (request.headers.get("x-vercel-cron") === "1" && secret) return true;

  return false;
}
