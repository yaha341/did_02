-- Reset orders id sequence to max(id) + 1
-- Run once in Supabase → SQL Editor (safe to re-run)

CREATE OR REPLACE FUNCTION public.reset_orders_sequence()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  max_id bigint;
BEGIN
  SELECT COALESCE(MAX(id), 0) INTO max_id FROM public.orders;
  PERFORM setval(pg_get_serial_sequence('public.orders', 'id'), GREATEST(max_id, 1), max_id > 0);
END;
$$;
