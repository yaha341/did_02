import { isTelegramAdmin, parseNotifyAdminIds } from "./telegram-webhook.server";
import { assignMemberTariff, getMemberAssignedTariff } from "./vip-member.server";
import { resolveTelegramFileMeta } from "./file-mime";

const TG_API = "https://api.telegram.org";

/** Warn stages stored in vip_subscriptions.admin_note */
export const WARN_STAGE_1 = "warned";
export const WARN_STAGE_2 = "warned2";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** VIP bot @username from env (no legacy fallback). Empty if unset. */
export function resolveVipBotUsername(): string {
  return (process.env.VIP_BOT_USERNAME || "").replace(/^@/, "").trim();
}

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

export async function revokeVipInvite(groupId: string, inviteLink: string | null | undefined) {
  if (!groupId || !inviteLink) return;
  await tgVip("revokeChatInviteLink", { chat_id: groupId, invite_link: inviteLink });
}

/** True if user is currently a member/admin of the VIP group. */
export async function isVipGroupMember(groupId: string, telegramId: number): Promise<boolean> {
  const res = await tgVip("getChatMember", { chat_id: groupId, user_id: telegramId });
  if (!res.ok) return false;
  const status = (res.result as { status?: string } | undefined)?.status;
  return status === "member" || status === "administrator" || status === "creator" || status === "restricted";
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
  // Real past/present access only (not cancelled / pending)
  const { count } = await s
    .from("vip_subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("telegram_id", telegram_id)
    .in("status", ["active", "expired"]);
  return (count ?? 0) > 0;
}

/** Parse /start payload including /start@BotName renew and /start t_uuid */
function parseStartPayload(text: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed.toLowerCase().startsWith("/start")) return "";
  const parts = trimmed.split(/\s+/);
  return parts.slice(1).join(" ").trim();
}

const TG_CAPTION_MAX = 1024;

async function sendPaymentInstructions(
  chat_id: number,
  paymentText: string,
  qrPath: string | undefined,
) {
  if (qrPath) {
    if (paymentText.length <= TG_CAPTION_MAX) {
      await tgVip("sendPhoto", {
        chat_id,
        photo: imageUrl(qrPath),
        caption: paymentText,
        parse_mode: "HTML",
      });
    } else {
      // Caption limit 1024 — send QR then full text separately
      await tgVip("sendPhoto", { chat_id, photo: imageUrl(qrPath) });
      await tgVip("sendMessage", { chat_id, text: paymentText, parse_mode: "HTML" });
    }
  } else {
    await tgVip("sendMessage", {
      chat_id,
      text: paymentText,
      parse_mode: "HTML",
    });
  }
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
      `Стоимость: <b>${escapeHtml(String(entry.price))} ${escapeHtml(String(entry.currency))}</b>\n\n` +
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

  // Personal (legacy/cheap) renew — skip entry fee, but allow switching to public list
  if (assigned && !(assigned as any).is_entry) {
    const t = assigned as any;
    const intro = renew
      ? `Продление VIP — ваш персональный тариф:\n<b>${escapeHtml(String(t.name))}</b> — ${escapeHtml(String(t.price))} ${escapeHtml(String(t.currency))}`
      : `Ваш персональный тариф VIP:\n<b>${escapeHtml(String(t.name))}</b> — ${escapeHtml(String(t.price))} ${escapeHtml(String(t.currency))}`;
    await tgVip("sendMessage", {
      chat_id,
      text: intro,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: `Оплатить — ${t.price} ${t.currency}`, callback_data: `buy_tariff:${t.id}` }],
          [{ text: "Другие публичные тарифы", callback_data: "buy_renew_public" }],
        ],
      },
    });
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
  if (!tariff.is_active) {
    await tgVip("sendMessage", { chat_id, text: "Этот тариф больше не активен. Нажмите /start чтобы выбрать другой." });
    return;
  }

  // Entry package is one-time — returning members must use renew tariffs
  if (tariff.is_entry) {
    const hadAccess = await userHadPaidAccess(s, telegram_id);
    if (hadAccess) {
      await tgVip("sendMessage", {
        chat_id,
        text: "Тариф «Первый вход» доступен только новым участникам. Выберите тариф продления:",
      });
      await showTariffs(chat_id, { renew: true });
      return;
    }
  }

  if (tariff.is_public === false && !tariff.is_entry) {
    await assignMemberTariff(s, telegram_id, user, tariff_id, "deep_link");
  }

  const settings = await getVipSettings();
  const instructions = settings.vip_payment_instructions || "Оплатите по реквизитам и пришлите скриншот.";

  const { data: existingPendings } = await s
    .from("vip_subscriptions")
    .select("id, created_at")
    .eq("telegram_id", telegram_id)
    .eq("status", "pending_payment")
    .order("created_at", { ascending: false });

  const existingPending = existingPendings?.[0] ?? null;

  if (existingPending) {
    // Changing tariff invalidates previous proof
    await s
      .from("vip_subscriptions")
      .update({
        tariff_id,
        payment_proof_path: null,
        username: user?.username ?? null,
        first_name: user?.first_name ?? null,
        last_name: user?.last_name ?? null,
      })
      .eq("id", existingPending.id);

    // Race: cancel older duplicate pendings if any
    if ((existingPendings?.length ?? 0) > 1) {
      const olderIds = existingPendings!.slice(1).map((p) => p.id);
      await s
        .from("vip_subscriptions")
        .update({ status: "cancelled" })
        .in("id", olderIds)
        .eq("status", "pending_payment");
    }
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

    // After insert, collapse concurrent race duplicates — keep newest
    const { data: allPending } = await s
      .from("vip_subscriptions")
      .select("id, created_at")
      .eq("telegram_id", telegram_id)
      .eq("status", "pending_payment")
      .order("created_at", { ascending: false });

    if ((allPending?.length ?? 0) > 1) {
      const keepId = allPending![0].id;
      const olderIds = allPending!.slice(1).map((p) => p.id);
      await s
        .from("vip_subscriptions")
        .update({
          tariff_id,
          payment_proof_path: null,
          username: user?.username ?? null,
          first_name: user?.first_name ?? null,
          last_name: user?.last_name ?? null,
        })
        .eq("id", keepId);
      await s
        .from("vip_subscriptions")
        .update({ status: "cancelled" })
        .in("id", olderIds)
        .eq("status", "pending_payment");
    }
  }

  const paymentText =
    `Вы выбрали тариф: <b>${escapeHtml(String(tariff.name))}</b>\n` +
    `К оплате: <b>${escapeHtml(String(tariff.price))} ${escapeHtml(String(tariff.currency))}</b>\n\n` +
    `${escapeHtml(instructions)}\n\n` +
    `После оплаты отправьте фото (скриншот чека) прямо в этот чат.`;

  await sendPaymentInstructions(chat_id, paymentText, settings.vip_payment_qr_path || undefined);
}

async function handlePhoto(chat_id: number, from_id: number, photoId: string) {
  const s = await db();
  const { data: pendingSub } = await s
    .from("vip_subscriptions")
    .select("id, tariff_id, payment_proof_path, vip_tariffs(name, price, currency)")
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

  const isResubmit = !!pendingSub.payment_proof_path;

  await tgVip("sendMessage", {
    chat_id,
    text: isResubmit
      ? "✅ Новый чек получен! Предыдущий заменён. Ожидайте подтверждения администратором."
      : "✅ Чек получен! Ожидайте подтверждения администратором. После проверки вы получите доступ к VIP-группе.",
  });

  const tariff = pendingSub.vip_tariffs as any;
  const adminText =
    `🆕 <b>Оплата VIP-подписки${isResubmit ? " (повторный чек)" : ""}</b>\n\n` +
    `Пользователь: <a href="tg://user?id=${from_id}">ID ${from_id}</a>\n` +
    `Тариф: <b>${escapeHtml(String(tariff?.name ?? ""))}</b>\n` +
    `Сумма: <b>${escapeHtml(String(tariff?.price ?? ""))} ${escapeHtml(String(tariff?.currency ?? ""))}</b>\n\n` +
    `Проверьте чек и подтвердите подписку.`;

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
  let proofSaved = false;
  if (fileInfo) {
    const path = `vip-${pendingSub.id}/${Date.now()}.${fileInfo.ext}`;
    const { error } = await s.storage.from("payment-proofs").upload(path, fileInfo.bytes, {
      contentType: fileInfo.mime,
    });
    if (!error) {
      await s.from("vip_subscriptions").update({ payment_proof_path: path }).eq("id", pendingSub.id);
      proofSaved = true;
    } else {
      console.error("[vip-bot] payment proof upload failed:", error.message);
    }
  } else {
    console.error("[vip-bot] failed to download payment proof from Telegram");
  }

  const caption = proofSaved
    ? adminText
    : `${adminText}\n\n⚠️ Чек не сохранён в Storage — смотрите фото в этом сообщении.`;

  const captionSafe =
    caption.length > TG_CAPTION_MAX ? caption.slice(0, TG_CAPTION_MAX - 20) + "…" : caption;

  for (const adminId of adminIds) {
    await tgVip("sendPhoto", {
      chat_id: adminId,
      photo: photoId,
      caption: captionSafe,
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
        const payload = parseStartPayload(text);
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

      if (data === "buy_renew") {
        await showStartFlow(chat_id, cq.from, true);
        return;
      }

      if (data === "buy_renew_public") {
        await showTariffs(chat_id, { renew: true });
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
        const { rejectVipSubscriptionCore } = await import("./vip-subscriptions.functions");
        try {
          const result = await rejectVipSubscriptionCore(subId);
          await tgVip("sendMessage", {
            chat_id,
            text: result.alreadyProcessed
              ? "Заявка уже обработана или не найдена."
              : "❌ Подписка отклонена.",
          });
          if (cq.message?.message_id) {
            await tgVip("editMessageReplyMarkup", {
              chat_id,
              message_id: cq.message.message_id,
              reply_markup: { inline_keyboard: [] },
            });
          }
        } catch (e: any) {
          await tgVip("sendMessage", { chat_id, text: `Ошибка отклонения: ${e.message}` });
        }
        return;
      }
    }
  } catch (err) {
    console.error("[vip-bot] error handling update", err);
  }
}
