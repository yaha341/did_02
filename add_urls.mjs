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
  const q = `
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS file_url TEXT;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS file_url_kz TEXT;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS file_url_snapshot TEXT;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS file_url_kz_snapshot TEXT;
  `;
  const { error } = await s.rpc('exec_sql', { query: q }); // won't work if exec_sql RPC doesn't exist
  console.log('rpc error:', error?.message);
}
run();
