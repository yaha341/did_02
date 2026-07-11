import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const envStr = readFileSync('.env', 'utf-8');
const env = {};
envStr.split('\n').forEach(line => {
  const [k, v] = line.split('=');
  if (k && v) env[k.trim()] = v.trim().replace(/^"|"$/g, '');
});
const s = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
async function check() {
  const { data: buckets } = await s.storage.listBuckets();
  for (const b of buckets || []) {
    const mb = Math.round((b.file_size_limit || 0) / 1024 / 1024);
    console.log(`${b.name}: limit=${b.file_size_limit} bytes (${mb} MB)`);
  }
}
check();
