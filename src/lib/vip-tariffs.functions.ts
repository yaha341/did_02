import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-session.server";

async function db() {
  const { supabaseAdmin } = await import("@/integrations-supabase/client.server");
  return supabaseAdmin;
}

const ENTRY_FALLBACK = {
  name: "Вход + 1 месяц",
  price: 10000,
  currency: "KZT",
  duration_days: 30,
  duration_minutes: 5,
  is_active: true,
  is_public: false,
  is_entry: true,
  sort_order: -100,
  _needsSchema: true,
};

export const getVipTariffs = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  const s = await db();
  const { data, error } = await s.from("vip_tariffs").select("*").order("sort_order");
  if (error) throw new Error(error.message);
  return data ?? [];
});

/** First-entry package. Never throws for missing is_entry column — returns safe fallback. */
export const getVipEntryTariff = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  try {
    const s = await db();
    const { data: existing, error: findError } = await s
      .from("vip_tariffs")
      .select("*")
      .eq("is_entry", true)
      .maybeSingle();

    if (findError) {
      console.error("[getVipEntryTariff] find:", findError.message);
      return { ...ENTRY_FALLBACK, _needsSchema: true };
    }
    if (existing) {
      return { ...existing, _needsSchema: false };
    }

    const { data: created, error } = await s
      .from("vip_tariffs")
      .insert({
        name: "Вход + 1 месяц",
        price: 10000,
        currency: "KZT",
        duration_days: 30,
        duration_minutes: 5,
        is_active: true,
        is_public: false,
        is_entry: true,
        sort_order: -100,
      })
      .select("*")
      .single();

    if (error) {
      console.error("[getVipEntryTariff] insert:", error.message);
      return { ...ENTRY_FALLBACK, _needsSchema: true };
    }
    return { ...created, _needsSchema: false };
  } catch (e) {
    console.error("[getVipEntryTariff] exception:", e);
    return { ...ENTRY_FALLBACK, _needsSchema: true };
  }
});

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  price: z.number().min(0),
  currency: z.string().min(1),
  duration_days: z.number().min(1),
  duration_minutes: z.number().min(1),
  is_active: z.boolean(),
  is_public: z.boolean().default(true),
  is_entry: z.boolean().optional(),
  sort_order: z.number(),
});

export const getVipBotUsername = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin();
  return { username: (process.env.VIP_BOT_USERNAME || "").replace(/^@/, "") };
});

export const saveVipTariff = createServerFn({ method: "POST" })
  .validator((d: unknown) => SaveInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const payload: Record<string, unknown> = {
      name: data.name,
      price: data.price,
      currency: data.currency,
      duration_days: data.duration_days,
      duration_minutes: data.duration_minutes,
      is_active: data.is_active,
      is_public: data.is_entry ? false : data.is_public,
      sort_order: data.is_entry ? -100 : data.sort_order,
    };
    if (data.is_entry !== undefined) {
      payload.is_entry = !!data.is_entry;
    }

    if (data.id) {
      const { error } = await s.from("vip_tariffs").update(payload).eq("id", data.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await s.from("vip_tariffs").insert(payload);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

const DeleteInput = z.object({ id: z.string().uuid() });

export const deleteVipTariff = createServerFn({ method: "POST" })
  .validator((d: unknown) => DeleteInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin();
    const s = await db();
    const { data: row } = await s.from("vip_tariffs").select("*").eq("id", data.id).maybeSingle();
    if (row && (row as any).is_entry === true) {
      throw new Error("Тариф «Первый вход» нельзя удалить — выключите его галкой «Активен».");
    }
    const { error } = await s.from("vip_tariffs").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
