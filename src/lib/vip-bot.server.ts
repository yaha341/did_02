import { isTelegramAdmin, parseNotifyAdminIds } from "./telegram-webhook.server";
import { assignMemberTariff, getMemberAssignedTariff } from "./vip-member.server";
import { resolveTelegramFileMeta } from "./file-mime";

const TG_API = "https://api.telegram.org";

function token() {
  const t = process.env.VIP_BOT_TOKEN;
  if (!t) throw new Error("VIP_BOT_TOKEN is not configured");
  return t;
}

async function retryFetch(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status < 500) {
        return res;
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error as Error;
    }

    if (attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error("Retry failed");
}

export async function tgVip(method: string, payload: unknown) {
  try {
    const res = await retryFetch(`${TG_API}/bot${token()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.ok === false)) {
      console.error(`[vip-bot] ${method} failed`, res.status, data);
    }
    return data as { ok: boolean; result?: unknown; description?: string };
  } catch (error) {
    console.error(`[vip-bot] ${method} retry exhausted`, error);
    return { ok: false, description: "Retry exhausted" };
  }
}

function publicAppOrigin(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    "https://did-02.vercel.app"
  );
}

function imageUrl(path: string): string {
  return `${publicAppOrigin()}/api/public/img/${path}`;
}

export async function downloadVipTelegramFile(
  file_id: string,
): Promise<{ bytes: Uint8Array; mime: string; ext: string } | null> {
  const info = await tgVip("getFile", { file_id });
  // @ts-expect-error dynamic
  const path = info?.result?.file_path as string | undefined;
  if (!path) return null;

  try {
    const res = await retryFetch(`${TG_API}/file/bot${token()}/${path}`, { method: "GET" });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const meta = resolveTelegramFileMeta(path, res.headers.get("content-type"));
    return { bytes, mime: meta.mime, ext: meta.ext };
  } catch (error) {
    console.error(`[vip-bot] downloadFile retry exhausted`, error);
    return null;
  }
}

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

async function getVipSettings() {
  const s = await db();
  const { data } = await s.from("app_settings").select("*");
  const map: Record<string, string> = {};
  for (const r of data ?? []) map[r.key as string] = (r.value as string) ?? "";
  return map;
}

/** True if Telegram error means user is already not in the group. */
export function isAlreadyNotInChat(description?: string): boolean {
  if (!description) return false;
  const d = description.toLowerCase();
  return (
    d.includes("user_not_participant") ||
    d.includes("user not found") ||
    d.includes("chat_not_found") ||
    d.includes("participant_id_invalid") ||
    d.includes("user_id_invalid")
  );
}

async function showTariffs(chat_id: number, opts?: { renew?: boolean }) {
  const s = await db();
  // Renewal list: public active tariffs, but never the first-entry package
  let q = s
    .from("vip_tariffs")
    .select("*")
    .eq("is_active", true)
    .eq("is_public", true)
    .order("sort_order");

  const { data: all, error } = await q;
  if (error) {
    console.error("[vip-bot] showTariffs", error);
    await tgVip("sendMessage", { chat_id, text: "Не удалось загрузить тарифы. Попробуйте позже." });
    return;
  }

  const tariffs = (all ?? []).filter((t: any) => !t.is_entry);

  if (tariffs.length === 0) {
    await tgVip("sendMessage", {
      chat_id,
      text: opts?.renew
        ? "Нет публичных тарифов для продления. Используйте вашу персональную ссылку на тариф или напишите администратору."
        : "В данный момент нет доступных тарифов.",
    });
    return;
  }

  const buttons = tariffs.map((t) => [
    { text: `${t.name} — ${t.price} ${t.currency}`, callback_data: `buy_tariff:${t.id}` },
  ]);

  const intro = opts?.renew
    ? "Продление VIP: выберите тариф. После подтверждения оплаты доступ продолжится без исключения из группы."
    : "Выберите тариф для продления VIP-подписки:";

  await tgVip("sendMessage", {
    chat_id,
    text: intro,
    reply_markup: { inline_keyboard: buttons },
  });
}

async function userHadPaidAccess(s: Awaited<ReturnType<typeof db>>, telegram_id: number): Promise<boolean> {
  const { count } = await s
    .from("vip_subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("telegram_id", telegram_id)
    .or("status.eq.active,status.eq.expired,imported.eq.true");
  return (count ?? 0) > 0;
}

async function showEntryOffer(chat_id: number, from: any) {
  const s = await db();
  const { data: entry } = await s
    .from("vip_tariffs")
    .select("*")
    .eq("is_entry", true)
    .eq("is_active", true)
    .maybeSingle();

  if (!entry) {
    // Entry disabled / missing — fall back to renewal list
    await showTariffs(chat_id);
    return;
  }

  await tgVip("sendMessage", {
    chat_id,
    text:
      `👋 <b>Первый вход в VIP</b>\n\n` +
      `Разовый вход + доступ на ${entry.duration_days} дн.\n` +
      `Стоимость: <b>${entry.price} ${entry.currency}</b>\n\n` +
      `После оплаты и подтверждения вы получите ссылку в группу.\n` +
      `Дальнейшее продление — по отдельным тарифам.`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: `Оплатить вход — ${entry.price} ${entry.currency}`, callback_data: `buy_tariff:${entry.id}` }],
      ],
    },
  });
}

/** Deep-link to a (possibly hidden) tariff: /start t_<uuid> */
async function handleTariffDeepLink(chat_id: number, from: any, tariffId: string) {
  const s = await db();
  const { data: tariff } = await s
    .from("vip_tariffs")
    .select("*")
    .eq("id", tariffId)
    .eq("is_active", true)
    .maybeSingle();

  if (!tariff) {
    await tgVip("sendMessage", {
      chat_id,
      text: "Тариф по этой ссылке не найден или выключен. Нажмите /start для общего списка.",
    });
    return;
  }

  // Remember hidden renew tariff (not entry) — next /start uses it
  if (tariff.is_public === false && !tariff.is_entry) {
    await assignMemberTariff(s, from.id, from, tariff.id, "deep_link");
  }

  await handleBuyTariff(chat_id, from.id, from, tariff.id);
}

/** /start or /start renew */
async function showStartFlow(chat_id: number, from: any, renew?: boolean) {
  const s = await db();
  const assigned = await getMemberAssignedTariff(s, from.id);

  // Personal (legacy/cheap) renew — skip entry fee
  if (assigned && !(assigned as any).is_entry) {
    const t = assigned as any;
    const intro = renew
      ? `Продление VIP — ваш персональный тариф:\n<b>${t.name}</b> — ${t.price} ${t.currency}`
      : `Ваш персональный тариф VIP:\n<b>${t.name}</b> — ${t.price} ${t.currency}`;
    await tgVip("sendMessage", { chat_id, text: intro, parse_mode: "HTML" });
    await handleBuyTariff(chat_id, from.id, from, t.id);
    return;
  }

  const hadAccess = await userHadPaidAccess(s, from.id);

  // Renew button or returning member → renew tariffs
  if (renew || hadAccess) {
    await showTariffs(chat_id, { renew: true });
    return;
  }

  // Brand-new user → first entry package
  await showEntryOffer(chat_id, from);
}


async function handleBuyTariff(chat_id: number, telegram_id: number, user: any, tariff_id: string) {
  const s = await db();
  const { data: tariff } = await s.from("vip_tariffs").select("*").eq("id", tariff_id).single();
  if (!tariff) {
    await tgVip("sendMessage", { chat_id, text: "Тариф не найден." });
    return;
  }

  if (tariff.is_public === false && !tariff.is_entry) {
    await assignMemberTariff(s, telegram_id, user, tariff_id, "deep_link");
  }

  const settings = await getVipSettings();
  const instructions = settings.vip_payment_instructions || "Оплатите по реквизитам и пришлите скриншот.";

  const { data: existingPending } = await s
    .from("vip_subscriptions")
    .select("id")
    .eq("telegram_id", telegram_id)
    .eq("status", "pending_payment")
    .maybeSingle();

  if (existingPending) {
    await s.from("vip_subscriptions").update({ tariff_id }).eq("id", existingPending.id);
  } else {
    const { error } = await s.from("vip_subscriptions").insert({
      telegram_id,
      username: user?.username ?? null,
      first_name: user?.first_name ?? null,
      last_name: user?.last_name ?? null,
      tariff_id,
      status: "pending_payment",
      expires_at: new Date().toISOString(),
    });
    if (error) {
      await tgVip("sendMessage", { chat_id, text: "Не удалось создать заявку. Попробуйте позже." });
      console.error("[vip-bot] insert pending failed", error);
      return;
    }
  }

  const paymentText = `Вы выбрали тариф: <b>${tariff.name}</b>\nК оплате: <b>${tariff.price} ${tariff.currency}</b>\n\n${instructions}\n\nПосле оплаты отправьте фото (скриншот чека) прямо в этот чат.`;

  if (settings.vip_payment_qr_path) {
    await tgVip("sendPhoto", {
      chat_id,
      photo: imageUrl(settings.vip_payment_qr_path),
      caption: paymentText,
      parse_mode: "HTML",
    });
  } else {
    await tgVip("sendMessage", {
      chat_id,
      text: paymentText,
      parse_mode: "HTML",
    });
  }
}

async function handlePhoto(chat_id: number, from_id: number, photoId: string) {
  const s = await db();
  const { data: pendingSub } = await s
    .from("vip_subscriptions")
    .select("id, tariff_id, vip_tariffs(name, price, currency)")
    .eq("telegram_id", from_id)
    .eq("status", "pending_payment")
    .maybeSingle();

  if (!pendingSub) {
    await tgVip("sendMessage", {
      chat_id,
      text: "У вас нет ожидающих оплаты тарифов. Нажмите /start чтобы выбрать тариф.",
    });
    return;
  }

  await tgVip("sendMessage", {
    chat_id,
    text: "✅ Чек получен! Ожидайте подтверждения администратором. После проверки вы получите доступ к VIP-группе.",
  });

  const tariff = pendingSub.vip_tariffs as any;
  const adminText = `🆕 <b>Оплата VIP-подписки</b>\n\nПользователь: <a href="tg://user?id=${from_id}">ID ${from_id}</a>\nТариф: <b>${tariff?.name}</b>\nСумма: <b>${tariff?.price} ${tariff?.currency}</b>\n\nПроверьте чек и подтвердите подписку.`;

  const settings = await getVipSettings();
  const adminIds = parseNotifyAdminIds(settings);

  if (adminIds.length === 0) {
    console.error("[vip-bot] No admin_chat_id / owner_chat_id configured — payment notify skipped");
  }

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "✅ Подтвердить", callback_data: `vip_confirm:${pendingSub.id}` },
        { text: "❌ Отклонить", callback_data: `vip_reject:${pendingSub.id}` },
      ],
    ],
  };

  const fileInfo = await downloadVipTelegramFile(photoId);
  if (fileInfo) {
    const path = `vip-${pendingSub.id}/${Date.now()}.${fileInfo.ext}`;
    const { error } = await s.storage.from("payment-proofs").upload(path, fileInfo.bytes, {
      contentType: fileInfo.mime,
    });
    if (!error) {
      await s.from("vip_subscriptions").update({ payment_proof_path: path }).eq("id", pendingSub.id);
    }
  }

  for (const adminId of adminIds) {
    await tgVip("sendPhoto", {
      chat_id: adminId,
      photo: photoId,
      caption: adminText,
      parse_mode: "HTML",
      reply_markup,
    });
  }
}

async function requireVipAdmin(from_id: number, chat_id: number): Promise<boolean> {
  const settings = await getVipSettings();
  const adminIds = parseNotifyAdminIds(settings);
  if (adminIds.length === 0) {
    await tgVip("sendMessage", {
      chat_id,
      text: "Ошибка: не настроены admin_chat_id / owner_chat_id. Подтверждение из Telegram отключено.",
    });
    return false;
  }
  if (!isTelegramAdmin(from_id, adminIds)) {
    await tgVip("sendMessage", { chat_id, text: "⛔ Только администратор может подтверждать/отклонять оплату." });
    return false;
  }
  return true;
}

export async function handleVipUpdate(update: any) {
  try {
    if (update.message) {
      const msg = update.message;
      const chat_id = msg.chat?.id;
      const from_id = msg.from?.id;
      const text = msg.text || "";

      if (text.startsWith("/start")) {
        const payload = text.slice(6).trim();
        // Hidden / special tariff deep-link: /start t_<uuid>
        if (payload.startsWith("t_")) {
          const tariffId = payload.slice(2);
          if (/^[0-9a-f-]{36}$/i.test(tariffId)) {
            await handleTariffDeepLink(chat_id, msg.from, tariffId);
            return;
          }
        }
        await showStartFlow(chat_id, msg.from, payload === "renew");
        return;
      }

      if (text === "/id" || text.startsWith("/id@")) {
        const un = msg.from?.username ? `\nUsername: @${msg.from.username}` : "";
        await tgVip("sendMessage", {
          chat_id,
          text: `Ваш Telegram ID: <code>${from_id}</code>${un}\n\nЭтот ID нужен для ручного добавления в VIP-админке.`,
          parse_mode: "HTML",
        });
        return;
      }

      if (msg.photo && msg.photo.length > 0) {
        const bestPhoto = msg.photo[msg.photo.length - 1];
        await handlePhoto(chat_id, from_id, bestPhoto.file_id);
        return;
      }

      if (msg.document) {
        const mime = msg.document.mime_type || "";
        if (mime.startsWith("image/")) {
          await handlePhoto(chat_id, from_id, msg.document.file_id);
        } else {
          await tgVip("sendMessage", {
            chat_id,
            text: "Пожалуйста, отправьте скриншот как изображение (фото), а не файлом.",
          });
        }
        return;
      }
    }

    if (update.callback_query) {
      const cq = update.callback_query;
      const chat_id = cq.message?.chat?.id;
      const from_id = cq.from?.id;
      const data: string = cq.data || "";
      await tgVip("answerCallbackQuery", { callback_query_id: cq.id });

      if (data.startsWith("buy_tariff:")) {
        await handleBuyTariff(chat_id, from_id, cq.from, data.slice(11));
        return;
      }

      if (data.startsWith("vip_confirm:")) {
        if (!(await requireVipAdmin(from_id, chat_id))) return;
        const subId = data.slice(12);
        const { activateVipSubscription } = await import("./vip-subscriptions.functions");
        try {
          await activateVipSubscription(subId);
          await tgVip("sendMessage", { chat_id, text: `✅ Подписка подтверждена.` });
          if (cq.message?.message_id) {
            await tgVip("editMessageReplyMarkup", {
              chat_id,
              message_id: cq.message.message_id,
              reply_markup: { inline_keyboard: [] },
            });
          }
        } catch (e: any) {
          await tgVip("sendMessage", { chat_id, text: `Ошибка: ${e.message}` });
        }
        return;
      }

      if (data.startsWith("vip_reject:")) {
        if (!(await requireVipAdmin(from_id, chat_id))) return;
        const subId = data.slice(11);
        const s = await db();
        const settings = await getVipSettings();
        const groupId = settings.vip_group_id;

        const { data: existing } = await s.from("vip_subscriptions").select("*").eq("id", subId).maybeSingle();
        if (!existing || existing.status !== "pending_payment") {
          await tgVip("sendMessage", { chat_id, text: "Заявка уже обработана или не найдена." });
          return;
        }

        if (groupId && existing.group_invite_link) {
          await tgVip("revokeChatInviteLink", {
            chat_id: groupId,
            invite_link: existing.group_invite_link,
          });
        }

        const { data: sub, error } = await s
          .from("vip_subscriptions")
          .update({ status: "cancelled" })
          .eq("id", subId)
          .eq("status", "pending_payment")
          .select("telegram_id")
          .maybeSingle();

        if (error) {
          await tgVip("sendMessage", { chat_id, text: `Ошибка отклонения: ${error.message}` });
          return;
        }
        if (sub) {
          await tgVip("sendMessage", {
            chat_id: sub.telegram_id,
            text: "❌ Ваша оплата была отклонена. Если это ошибка, свяжитесь с поддержкой.",
          });
        }
        await tgVip("sendMessage", { chat_id, text: "❌ Подписка отклонена." });
        if (cq.message?.message_id) {
          await tgVip("editMessageReplyMarkup", {
            chat_id,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] },
          });
        }
        return;
      }
    }
  } catch (err) {
    console.error("[vip-bot] error handling update", err);
  }
}
