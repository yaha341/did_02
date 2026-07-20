import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-session.server";
import { isAlreadyNotInChat, tgVip } from "./vip-bot.server";
import { assignMemberTariff } from "./vip-member.server";

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

// Test function to check Supabase connection (real totals, not limit(1))
export const testVipDbConnection = createServerFn({ method: "GET" })
  .handler(async () => {
    await requireAdmin();

    try {
      const s = await db();

      const [settingsRes, tariffsRes, subsRes, pendingRes] = await Promise.all([
        s.from("app_settings").select("*", { count: "exact", head: true }),
        s.from("vip_tariffs").select("*", { count: "exact", head: true }),
        s.from("vip_subscriptions").select("*", { count: "exact", head: true }),
        s
          .from("vip_subscriptions")
          .select("*", { count: "exact", head: true })
          .eq("status", "pending_payment"),
      ]);

      const firstError =
        settingsRes.error?.message ||
        tariffsRes.error?.message ||
        subsRes.error?.message ||
        pendingRes.error?.message;

      if (firstError) {
        return { success: false, error: firstError };
      }

      return {
        success: true,
        settingsCount: settingsRes.count ?? 0,
        tariffsCount: tariffsRes.count ?? 0,
        subscriptionsCount: subsRes.count ?? 0,
        pendingCount: pendingRes.count ?? 0,
        message: "All queries successful",
      };
    } catch (error) {
      console.error("[testVipDbConnection] Exception:", error);
      return { success: false, error: (error as Error).message };
    }
  });

export const getVipSubscriptions = createServerFn({ method: "GET" })
  .validator((d: unknown) => z.object({ status: z.string().optional() }).parse(d ?? {}))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const status = data?.status && data.status !== "all" ? data.status : null;

    try {
      let q = s
        .from("vip_subscriptions")
        .select("*, vip_tariffs(name, duration_days, duration_minutes)")
        .order("created_at", { ascending: false });

      if (status) q = q.eq("status", status);

      const { data: subs, error } = await q;

      if (!error) {
        return subs ?? [];
      }

      console.error("[getVipSubscriptions] Join query error, fallback:", error.message);
      let simple = s.from("vip_subscriptions").select("*").order("created_at", { ascending: false });
      if (status) simple = simple.eq("status", status);
      const { data: simpleSubs, error: simpleError } = await simple;
      if (simpleError) {
        console.error("[getVipSubscriptions] simple error:", simpleError.message);
        return [];
      }
      return simpleSubs ?? [];
    } catch (e) {
      console.error("[getVipSubscriptions] exception:", e);
      return [];
    }
  });

/** Shared confirm logic for admin UI and VIP bot callbacks */
export async function activateVipSubscription(id: string) {
  console.log("[confirmVipSubscription] START - Confirming subscription:", id);
  const s = await db();

  const { data: sub, error: fetchError } = await s
    .from("vip_subscriptions")
    .select("*, vip_tariffs(*)")
    .eq("id", id)
    .single();

  if (fetchError) {
    console.error("[confirmVipSubscription] Error fetching subscription:", fetchError);
    throw new Error("Ошибка получения подписки: " + fetchError.message);
  }

  if (!sub) {
    throw new Error("Подписка не найдена");
  }

  if (sub.status === "active") {
    throw new Error("Подписка уже активна");
  }

  if (sub.status !== "pending_payment") {
    throw new Error("Подписку можно подтвердить только из статуса «ожидает оплаты»");
  }

  const { data: settingsData } = await s.from("app_settings").select("*");
  const settings: Record<string, string> = {};
  for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";

  const groupId = settings.vip_group_id;
  if (!groupId) {
    throw new Error("Не настроен ID VIP группы в настройках");
  }

  const tariff = sub.vip_tariffs as any;
  const isTest = settings.vip_test_mode === "true";

  const now = new Date();
  const expiresAt = new Date(now);
  if (isTest) {
    expiresAt.setMinutes(now.getMinutes() + (tariff?.duration_minutes || 1));
  } else {
    expiresAt.setDate(now.getDate() + (tariff?.duration_days || 30));
  }

  // Create one-time invite BEFORE marking active — avoids stuck "active" without link
  const inviteLinkData = await tgVip("createChatInviteLink", {
    chat_id: groupId,
    member_limit: 1,
    name: `vip-${id.slice(0, 8)}`,
    expire_date: Math.floor(expiresAt.getTime() / 1000),
  });

  if (!inviteLinkData.ok) {
    throw new Error("Не удалось создать ссылку-приглашение. Убедитесь что бот админ в группе.");
  }

  const link = (inviteLinkData.result as any).invite_link as string;

  const { data: updated, error: updateError } = await s
    .from("vip_subscriptions")
    .update({
      status: "active",
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      group_invite_link: link,
      admin_note: null,
    })
    .eq("id", id)
    .eq("status", "pending_payment")
    .select("id")
    .maybeSingle();

  if (updateError) {
    await tgVip("revokeChatInviteLink", { chat_id: groupId, invite_link: link });
    throw new Error("Ошибка обновления подписки: " + updateError.message);
  }

  if (!updated) {
    await tgVip("revokeChatInviteLink", { chat_id: groupId, invite_link: link });
    throw new Error("Заявка уже обработана другим администратором");
  }

  // Renewal: close other actives without kicking (user stays in group under new period)
  await s
    .from("vip_subscriptions")
    .update({ status: "expired" })
    .eq("telegram_id", sub.telegram_id)
    .eq("status", "active")
    .neq("id", id);

  const welcomeMsg = settings.vip_welcome_message || "Ваша VIP подписка активна!";

  await tgVip("sendMessage", {
    chat_id: sub.telegram_id,
    text: `✅ ${welcomeMsg}\n\nСрок действия до: ${expiresAt.toLocaleString("ru-RU")}\n\nВаша персональная одноразовая ссылка для вступления:\n${link}`,
    parse_mode: "HTML",
  });

  if (tariff?.is_public === false && !tariff?.is_entry) {
    await assignMemberTariff(
      s,
      sub.telegram_id as number,
      {
        username: sub.username as string | null,
        first_name: sub.first_name as string | null,
        last_name: sub.last_name as string | null,
      },
      tariff.id,
      "payment",
    );
  }

  console.log("[confirmVipSubscription] COMPLETE - Confirmation successful");
  return { ok: true as const };
}

export const getVipMemberProfiles = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  try {
    const s = await db();
    const { data, error } = await s
      .from("vip_member_profiles")
      .select("telegram_id, assigned_tariff_id, assigned_at, assigned_source, vip_tariffs(name, price, currency, is_public)")
      .order("assigned_at", { ascending: false });
    if (error) {
      console.error("[getVipMemberProfiles]", error.message);
      return [];
    }
    return data ?? [];
  } catch (e) {
    console.error("[getVipMemberProfiles] exception", e);
    return [];
  }
});

export const runVipCronNow = createServerFn({ method: "POST" }).handler(async () => {
  await requireAdmin();
  const { runVipCronJob } = await import("./vip-cron.server");
  return await runVipCronJob();
});

export const confirmVipSubscription = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    return await activateVipSubscription(data.id);
  });

const AddManualInput = z.object({
  telegram_id: z.string().min(1),
  tariff_id: z.string().uuid(),
  days: z.number().min(1),
  status: z.string(),
});

export const addVipSubscriptionManual = createServerFn({ method: "POST" })
  .validator((d: unknown) => AddManualInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(now.getDate() + data.days);

    const { error } = await s.from("vip_subscriptions").insert({
      telegram_id: parseInt(data.telegram_id),
      tariff_id: data.tariff_id,
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: data.status,
      imported: true,
    });

    if (error) throw new Error(error.message);

    const { data: tariff } = await s.from("vip_tariffs").select("is_public").eq("id", data.tariff_id).maybeSingle();
    if (tariff?.is_public === false && !tariff?.is_entry) {
      await assignMemberTariff(
        s,
        parseInt(data.telegram_id),
        {},
        data.tariff_id,
        "admin",
      );
    }

    return { ok: true };
  });

const ExtendInput = z.object({
  id: z.string().uuid(),
  days: z.number().min(1),
});

export const extendVipSubscription = createServerFn({ method: "POST" })
  .validator((d: unknown) => ExtendInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const { data: sub } = await s.from("vip_subscriptions").select("*").eq("id", data.id).single();
    if (!sub) throw new Error("Not found");

    const { data: settingsData } = await s.from("app_settings").select("*");
    const settings: Record<string, string> = {};
    for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";
    const groupId = settings.vip_group_id;

    const wasInactive = sub.status !== "active";
    const base = wasInactive ? new Date() : new Date(sub.expires_at as string);
    // If already expired in the past, extend from now
    const baseSafe = base.getTime() < Date.now() ? new Date() : base;
    baseSafe.setDate(baseSafe.getDate() + data.days);

    let inviteLink = sub.group_invite_link as string | null;

    // Re-issue invite if user was expired/cancelled (likely already kicked)
    if (wasInactive && groupId) {
      if (inviteLink) {
        await tgVip("revokeChatInviteLink", { chat_id: groupId, invite_link: inviteLink });
      }
      const invite = await tgVip("createChatInviteLink", {
        chat_id: groupId,
        member_limit: 1,
        name: `vip-ext-${data.id.slice(0, 8)}`,
        expire_date: Math.floor(baseSafe.getTime() / 1000),
      });
      if (!invite.ok) {
        throw new Error("Не удалось создать ссылку-приглашение. Убедитесь что бот админ в группе.");
      }
      inviteLink = (invite.result as any).invite_link;

      await tgVip("sendMessage", {
        chat_id: sub.telegram_id,
        text: `✅ Подписка продлена до ${baseSafe.toLocaleString("ru-RU")}\n\nОдноразовая ссылка для вступления:\n${inviteLink}`,
        parse_mode: "HTML",
      });
    }

    const { error } = await s
      .from("vip_subscriptions")
      .update({
        expires_at: baseSafe.toISOString(),
        status: "active",
        admin_note: null,
        ...(inviteLink ? { group_invite_link: inviteLink } : {}),
      })
      .eq("id", data.id);

    if (error) throw new Error(error.message);
    return { ok: true };
  });

const DeleteInput = z.object({ id: z.string().uuid() });

export const deleteVipSubscription = createServerFn({ method: "POST" })
  .validator((d: unknown) => DeleteInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const { data: sub } = await s.from("vip_subscriptions").select("*").eq("id", data.id).maybeSingle();
    if (!sub) throw new Error("Not found");

    const { data: settingsData } = await s.from("app_settings").select("*");
    const settings: Record<string, string> = {};
    for (const r of settingsData ?? []) settings[r.key as string] = (r.value as string) ?? "";
    const groupId = settings.vip_group_id;

    if (groupId && sub.group_invite_link) {
      await tgVip("revokeChatInviteLink", {
        chat_id: groupId,
        invite_link: sub.group_invite_link,
      });
    }

    // Kick only if this was an active sub and no other valid active remains
    if (groupId && sub.status === "active") {
      const { count: otherActive } = await s
        .from("vip_subscriptions")
        .select("*", { count: "exact", head: true })
        .eq("telegram_id", sub.telegram_id)
        .eq("status", "active")
        .gt("expires_at", new Date().toISOString())
        .neq("id", data.id);

      if ((otherActive ?? 0) === 0) {
        const ban = await tgVip("banChatMember", {
          chat_id: groupId,
          user_id: sub.telegram_id,
          revoke_messages: false,
        });
        if (ban.ok || isAlreadyNotInChat(ban.description)) {
          await tgVip("unbanChatMember", {
            chat_id: groupId,
            user_id: sub.telegram_id,
            only_if_banned: true,
          });
        }
      }
    }

    const { error } = await s.from("vip_subscriptions").delete().eq("id", data.id);
    if (error) throw new Error(error.message);

    // If no subscriptions left for this user — forget personal tariff / "already was in VIP"
    const { count: remaining } = await s
      .from("vip_subscriptions")
      .select("*", { count: "exact", head: true })
      .eq("telegram_id", sub.telegram_id);

    if ((remaining ?? 0) === 0) {
      await s.from("vip_member_profiles").delete().eq("telegram_id", sub.telegram_id);
    }

    return { ok: true, forgotProfile: (remaining ?? 0) === 0 };
  });
