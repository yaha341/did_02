# Деплой Telegram бота с админ-панелью на Vercel

## Текущая архитектура
- **База данных**: Supabase (уже в сети ✅)
- **Фронтенд**: React + TanStack Router 
- **Бэкенд**: Nitro SSR
- **Telegram бот**: Webhook на `/api/public/telegram/webhook`

## Инструкция по деплою на Vercel

### 1. Установите Vercel CLI
```bash
npm install -g vercel
```

### 2. Авторизуйтесь в Vercel
```bash
vercel login
```

### 3. Разверните проект
```bash
vercel
```

При первом деплое:
- Выберите существующий проект или создайте новый
- Подтвердите настройки

### 4. Настройте переменные окружения в Vercel Dashboard

После деплоя перейдите в Vercel Dashboard → Settings → Environment Variables и добавьте:

```
TELEGRAM_BOT_TOKEN=8956271941:AAGqtGWc8wHpJTcTPWt8cPZKa8GAcDcXmZY
SUPABASE_PROJECT_ID=fnwksbasxakktscdjlfp
SUPABASE_PUBLISHABLE_KEY=sb_publishable_4W8CmZnryDawb7df01EKRw_pJX4kLld
SUPABASE_URL=https://fnwksbasxakktscdjlfp.supabase.co
VITE_SUPABASE_PROJECT_ID=fnwksbasxakktscdjlfp
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_4W8CmZnryDawb7df01EKRw_pJX4kLld
VITE_SUPABASE_URL=https://fnwksbasxakktscdjlfp.supabase.co
```

### 5. Настройте Telegram Webhook

После деплоя вы получите URL вида `https://your-project.vercel.app`

Настройте вебхук для Telegram бота:

```bash
curl -X POST "https://api.telegram.org/bot8956271941:AAGqtGWc8wHpJTcTPWt8cPZKa8GAcDcXmZY/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-project.vercel.app/api/public/telegram/webhook"}'
```

### 6. Проверьте вебхук
```bash
curl "https://api.telegram.org/bot8956271941:AAGqtGWc8wHpJTcTPWt8cPZKa8GAcDcXmZY/getWebhookInfo"
```

## Важные замечания

### Telegram Webhook на Vercel
- Vercel поддерживает webhook API endpoints из коробки
- Telegram будет отправлять обновления на ваш URL `/api/public/telegram/webhook`
- Убедитесь, что ваш проект публично доступен

### Supabase
- Ваша база данных уже в сети, настройки не требуют изменений
- Данные будут сохраняться в Supabase независимо от деплоя

### Обновления
- Для обновления проекта просто делайте `git push` в ваш репозиторий
- Vercel автоматически задеплоит новую версию

## Альтернативный вариант: Railway

Если у вас возникнут проблемы с webhook на Vercel, Railway - отличный аналог:

1. Создайте аккаунт на [railway.app](https://railway.app)
2. Подключите GitHub репозиторий
3. Railway автоматически определит Nitro проект
4. Добавьте те же переменные окружения
5. Railway предоставит публичный URL для webhook

Railway особенно удобен для Telegram ботов из-за стабильных webhook endpoints.