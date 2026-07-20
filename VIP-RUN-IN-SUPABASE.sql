-- =============================================================================
-- VIP: run once in Supabase → SQL Editor → Run
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- Use this on an existing shop DB. Fresh install: prefer COMPLETE-SETUP.sql.
-- =============================================================================

-- Ensure touch_updated_at exists
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

-- VIP Tariffs
CREATE TABLE IF NOT EXISTS public.vip_tariffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KZT',
  duration_days INT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.vip_tariffs TO service_role;
ALTER TABLE public.vip_tariffs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.vip_tariffs
  ADD COLUMN IF NOT EXISTS duration_minutes INT NOT NULL DEFAULT 2;

ALTER TABLE public.vip_tariffs
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.vip_tariffs
  ADD COLUMN IF NOT EXISTS is_entry BOOLEAN NOT NULL DEFAULT false;

-- VIP Subscriptions
CREATE TABLE IF NOT EXISTS public.vip_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  tariff_id UUID NOT NULL REFERENCES public.vip_tariffs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending_payment',
  payment_proof_path TEXT,
  group_invite_link TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT status_check CHECK (status IN ('pending_payment', 'active', 'expired', 'cancelled'))
);
GRANT ALL ON public.vip_subscriptions TO service_role;
ALTER TABLE public.vip_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_vip_subscriptions_telegram ON public.vip_subscriptions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_vip_subscriptions_status ON public.vip_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_vip_subscriptions_expires ON public.vip_subscriptions(expires_at);

DROP TRIGGER IF EXISTS trg_vip_subscriptions_touch ON public.vip_subscriptions;
CREATE TRIGGER trg_vip_subscriptions_touch BEFORE UPDATE ON public.vip_subscriptions
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.vip_subscriptions
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS imported BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_note TEXT,
  ADD COLUMN IF NOT EXISTS group_invite_link TEXT,
  ADD COLUMN IF NOT EXISTS payment_proof_path TEXT;

DO $$
BEGIN
  ALTER TABLE public.vip_subscriptions DROP CONSTRAINT IF EXISTS status_check;
  ALTER TABLE public.vip_subscriptions
    ADD CONSTRAINT status_check
    CHECK (status IN ('pending_payment', 'active', 'expired', 'cancelled'));
EXCEPTION
  WHEN others THEN
    RAISE NOTICE 'status_check update skipped: %', SQLERRM;
END $$;

-- Personal tariff per user
CREATE TABLE IF NOT EXISTS public.vip_member_profiles (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  assigned_tariff_id UUID REFERENCES public.vip_tariffs(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_source TEXT NOT NULL DEFAULT 'deep_link'
);
GRANT ALL ON public.vip_member_profiles TO service_role;
ALTER TABLE public.vip_member_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service Role All vip_tariffs" ON public.vip_tariffs;
CREATE POLICY "Service Role All vip_tariffs"
ON public.vip_tariffs FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Service Role All vip_subscriptions" ON public.vip_subscriptions;
CREATE POLICY "Service Role All vip_subscriptions"
ON public.vip_subscriptions FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Service Role All vip_member_profiles" ON public.vip_member_profiles;
CREATE POLICY "Service Role All vip_member_profiles"
ON public.vip_member_profiles FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Default VIP settings (skip if already set)
INSERT INTO public.app_settings (key, value)
VALUES
  ('vip_group_id', ''),
  ('vip_warn_days', '3'),
  ('vip_warn_days_2', '1'),
  ('vip_test_mode', 'false'),
  ('vip_payment_instructions', ''),
  ('vip_welcome_message', 'Ваша VIP подписка активна!')
ON CONFLICT (key) DO NOTHING;

-- Storage bucket for payment proofs (ignore errors if storage not ready)
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public)
  VALUES ('payment-proofs', 'payment-proofs', false)
  ON CONFLICT (id) DO NOTHING;
EXCEPTION
  WHEN others THEN
    RAISE NOTICE 'payment-proofs bucket skipped: %', SQLERRM;
END $$;

NOTIFY pgrst, 'reload schema';

-- Verify
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'vip_%'
ORDER BY 1;
