import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const envStr = readFileSync('.env', 'utf-8');
const env = {};
envStr.split('\n').forEach(line => {
  const [k, v] = line.split('=');
  if (k && v) env[k.trim()] = v.trim().replace(/^"|"$/g, '');
});
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
async function check() {
  const { data: p, error: pErr } = await supabase.from('payment_methods').select('*');
  console.log('payment_methods present:', p);
}
check();
