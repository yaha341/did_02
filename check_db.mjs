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
  const { data: cols, error } = await supabase.rpc('get_columns_info');
  // We'll just run a query to select 1 row to see the columns, since RPC might not exist.
  const { data: oi, error: oiErr } = await supabase.from('order_items').select('*').limit(1);
  console.log('order_items error:', oiErr?.message);
  console.log('order_items sample (or empty):', oi);

  const { data: p, error: pErr } = await supabase.from('products').select('*').limit(1);
  console.log('products error:', pErr?.message);
  console.log('products columns present:', p && p.length > 0 ? Object.keys(p[0]) : 'no data');
}
check();
