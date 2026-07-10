import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const envStr = readFileSync('.env', 'utf-8');
const env = {};
envStr.split('\n').forEach(line => {
  const [k, v] = line.split('=');
  if (k && v) env[k.trim()] = v.trim().replace(/^"|"$/g, '');
});
const s = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
async function test() {
  const { error } = await s.from("payment_methods").insert({
    country_code: "RU",
    country_name: "Россия",
    currency: "RUB",
    instructions: "Test",
    sort_order: 2,
    is_active: true,
  });
  console.log('insert error:', error);
}
test();
