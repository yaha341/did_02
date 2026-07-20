# Деплой Telegram ботов (магазин + VIP) с админ-панелью на Vercel

## Архитектура
- **База данных**: Supabase
- **Фронтенд / SSR**: React + TanStack Start + Nitro
- **Shop bot**: webhook `/api/public/telegram/webhook`
- **VIP bot**: webhook `/api/public/telegram/webhook-vip`
- **VIP cron**: HTTP `GET /api/public/vip/cron` (на Hobby/Free Vercel — **внешний** cron, не Vercel Cron)

---

## 1. Supabase SQL

В SQL Editor выполните по порядку:

1. [`COMPLETE-SETUP.sql`](./COMPLETE-SETUP.sql) — если база ещё не создана (включает VIP)
2. На уже существующей БД магазина — один файл:
   - **[`VIP-RUN-IN-SUPABASE.sql`](./VIP-RUN-IN-SUPABASE.sql)** ← рекомендуемый патч VIP (таблицы + settings + bucket)
3. При необходимости отдельно: [`schema-urls-patch.sql`](./schema-urls-patch.sql), [`reset-orders-sequence.sql`](./reset-orders-sequence.sql)

Проверка VIP-таблиц:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'vip_%';
```

---

## 2. Переменные окружения (Vercel → Settings → Environment Variables)

### Обязательные

```
SUPABASE_URL=https://<project-id>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role>
SUPABASE_PUBLISHABLE_KEY=<anon/publishable>
VITE_SUPABASE_URL=https://<project-id>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<anon/publishable>

TELEGRAM_BOT_TOKEN=<shop bot token>
VIP_BOT_TOKEN=<vip bot token>
VIP_BOT_USERNAME=didaktika_03_VIP_bot

ADMIN_USERNAME=<strong-login>
ADMIN_PASSWORD=<strong-password>
SESSION_SECRET=<random-32-plus-chars>
```

### Рекомендуемые

```
PUBLIC_APP_URL=https://did-02.vercel.app
TELEGRAM_WEBHOOK_SECRET=<random-secret-for-shop-webhook>
VIP_TELEGRAM_WEBHOOK_SECRET=<random-secret-for-vip-webhook>
CRON_SECRET=<random-secret-for-vip-cron>
```

`CRON_SECRET` обязателен для почасового VIP cron (напоминания / кик). Vercel передаёт его как `Authorization: Bearer <CRON_SECRET>`.

После изменения env — **Redeploy**.

---

## 3. Webhooks

После деплоя (нужен `.env.local` с токенами и секретами):

```bash
node scripts/set-webhooks.mjs
```

Или вручную:

```bash
# Shop
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://did-02.vercel.app/api/public/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>"}'

# VIP
curl -X POST "https://api.telegram.org/bot<VIP_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://did-02.vercel.app/api/public/telegram/webhook-vip","secret_token":"<VIP_TELEGRAM_WEBHOOK_SECRET>"}'
```

Проверка:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

---

## 4. Админка после деплоя

1. `/admin/settings` — `admin_chat_id` (Telegram ID для уведомлений)
2. `/admin/vip/settings` — `vip_group_id`, реквизиты, QR, welcome
3. `/admin/vip/tariffs` — тариф «Первый вход» и продления
4. `/admin/payment-methods` — реквизиты магазина по странам

---

## 5. VIP Cron (без Vercel Cron — Hobby/Free)

На бесплатном плане Vercel **Cron Jobs недоступны** (или сильно ограничены). Endpoint остаётся, вызов — снаружи.

### Обязательно в Vercel env

```
CRON_SECRET=<длинный-случайный-секрет>
PUBLIC_APP_URL=https://did-02.vercel.app
```

### Вариант A — cron-job.org (рекомендуется)

1. Зарегистрируйтесь на [cron-job.org](https://cron-job.org)
2. Create cronjob:
   - **URL:** `https://did-02.vercel.app/api/public/vip/cron?secret=ВАШ_CRON_SECRET`
   - **Schedule:** every hour (`0 * * * *`)
   - **Request method:** GET
3. (Опционально) Header: `Authorization: Bearer ВАШ_CRON_SECRET`
4. Save → Enable

### Вариант B — вручную / скрипт

```bash
# из корня репо, нужен .env.local с CRON_SECRET
node scripts/run-vip-cron.mjs
# или
node scripts/run-vip-cron.mjs --url https://did-02.vercel.app
```

```bash
curl -sS "https://did-02.vercel.app/api/public/vip/cron?secret=$CRON_SECRET"
```

### Вариант C — из админки

`/admin/vip/settings` → «Запустить проверку подписок сейчас» (для теста, не замена почасового cron).

Ожидаемый JSON: `{ "ok": true, "warned": N, "warned2": N, "expired": N, "kickFailed": N, "errors": [] }`

---

## 6. VIP smoke checklist (после деплоя)

Перед продакшеном убедитесь в env: `VIP_BOT_TOKEN`, `VIP_BOT_USERNAME`, `CRON_SECRET`, `VIP_TELEGRAM_WEBHOOK_SECRET`, в админке — `vip_group_id` и admin/owner chat ids.

1. **Новый участник:** `/start` → тариф входа → чек → confirm → одна invite-ссылка, вход в группу.
2. **Продление в группе:** оплата renew → confirm → срок стекается с остатком, **без** новой ссылки, человек остаётся в группе.
3. **Вышел из группы + renew:** confirm → одноразовая ссылка на возврат.
4. **Past-due active:** в админке «Продлить» → если уже вне группы — invite; если ещё в группе — без ссылки.
5. **Cron (test mode):** warn1 → warn2 → kick + статус `expired`.
6. **Deep-link тарифа** в `/admin/vip/tariffs` открывается на правильный `VIP_BOT_USERNAME`.

Дальнейшие правки VIP — только по реальным жалобам с прода, без спекулятивных рефакторингов.

---

## Важные замечания

- Без `TELEGRAM_WEBHOOK_SECRET` / `VIP_TELEGRAM_WEBHOOK_SECRET` webhooks в production отклоняются (fail-closed).
- Не используйте дефолтные `admin`/`admin` и слабый `SESSION_SECRET` в production.
- Оплата в did_02 — скриншот + ручное подтверждение (автоэквайринг не подключён).
