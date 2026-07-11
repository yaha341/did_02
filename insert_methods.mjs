import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const envStr = readFileSync('.env', 'utf-8');
const env = {};
envStr.split('\n').forEach(line => {
  const [k, v] = line.split('=');
  if (k && v) env[k.trim()] = v.trim().replace(/^"|"$/g, '');
});

const s = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const methods = [
    { country_code: "KZ", country_name: "🇰🇿 Казахстан", currency: "KZT", sort_order: 1 },
    { country_code: "RU", country_name: "🇷🇺 Россия", currency: "RUB", sort_order: 2 },
    { country_code: "BY", country_name: "🇧🇾 Беларусь", currency: "BYN", sort_order: 3 },
    { country_code: "KG", country_name: "🇰🇬 Кыргызстан", currency: "KGS", sort_order: 4 },
    { country_code: "UZ", country_name: "🇺🇿 Узбекистан", currency: "UZS", sort_order: 5 },
    { country_code: "OTHER", country_name: "🌍 Другая страна", currency: "USD", sort_order: 6 },
  ];

  for (const m of methods) {
    const { data: existing } = await s.from("payment_methods").select("id").eq("country_code", m.country_code).maybeSingle();
    if (!existing) {
      await s.from("payment_methods").insert({
        country_code: m.country_code,
        country_name: m.country_name,
        currency: m.currency,
        instructions: "Реквизиты не заданы. Обратитесь к администратору.",
        is_active: false,
        sort_order: m.sort_order,
      });
      console.log(`Inserted ${m.country_code}`);
    } else {
      console.log(`Exists: ${m.country_code}`);
    }
  }
}
run();
