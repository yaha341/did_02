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
  // Fix Kazakhstan flag
  const { error } = await s
    .from("payment_methods")
    .update({ country_name: "🇰🇿 Казахстан" })
    .eq("country_code", "KZ");
  if (error) console.error("Error:", error.message);
  else console.log("Kazakhstan flag added successfully!");
  
  // Check all methods
  const { data } = await s.from("payment_methods").select("country_code, country_name, is_active").order("sort_order");
  console.log("All payment methods:", data);
}
run();
