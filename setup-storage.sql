-- === SETUP STORAGE BUCKETS ===

-- Создание bucket для изображений товаров
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,
  5242880, -- 5MB limit
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']
) ON CONFLICT (id) DO NOTHING;

-- Создание bucket для файлов товаров
-- allowed_mime_types намеренно НЕ задан: браузеры не знают MIME-тип для .7z
-- (отдают application/octet-stream), из-за чего Supabase отклонял загрузку.
-- Без белого списка поддерживаются любые архивы (zip, 7z, rar, ...).
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES (
  'product-files',
  'product-files',
  true,
  52428800 -- 50MB limit
) ON CONFLICT (id) DO NOTHING;

-- Создание bucket для скриншотов оплаты
-- allowed_mime_types НЕ задан: покупатели присылают чеки как фото, PDF,
-- а также изображениями в виде документа. Любой формат принимается.
-- Размер увеличен до 20МБ — PDF-чеки могут быть тяжелее фото.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES (
  'payment-proofs',
  'payment-proofs',
  false, -- приватный
  20971520 -- 20MB limit
) ON CONFLICT (id) DO NOTHING;