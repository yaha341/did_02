-- URL / KZ snapshot columns (safe to re-run).
-- Code expects these for bilingual delivery and external file links.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS file_url TEXT,
  ADD COLUMN IF NOT EXISTS file_url_kz TEXT;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS file_path_kz_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS file_name_kz_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS file_url_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS file_url_kz_snapshot TEXT;

NOTIFY pgrst, 'reload schema';
