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
  const { data: buckets } = await supabase.storage.listBuckets();
  console.log('--- BUCKETS ---');
  for (const b of buckets || []) {
    console.log(`\nBucket: ${b.name}`);
    console.log(`Public: ${b.public}`);
    console.log(`File Size Limit: ${b.file_size_limit}`);
    console.log(`Allowed Mime Types: ${b.allowed_mime_types}`);
  }
}
check();
