-- AJCV Caisse — migration v4 (à exécuter UNE FOIS sur une base déjà en v2/v3)
-- SQL Editor → New query → coller → Run. Sans danger, idempotent.

-- 1) Verrou du fond de caisse (validé le matin = non modifiable de la journée)
alter table public.caisse_fonds add column if not exists locked    boolean not null default false;
alter table public.caisse_fonds add column if not exists locked_at timestamptz;
alter table public.caisse_fonds add column if not exists locked_by uuid;

-- La modification du fond n'est permise que tant qu'il n'est pas verrouillé
drop policy if exists fonds_update on public.caisse_fonds;
create policy fonds_update on public.caisse_fonds
  for update to authenticated using (locked = false) with check (true);

-- 2) Photo du paiement rattachée à l'opération (chemin dans le bucket)
alter table public.caisse_operations add column if not exists photo_path text;

-- 3) Bucket privé pour les photos + accès réservé aux connectés (lecture + ajout)
insert into storage.buckets (id, name, public)
values ('caisse-photos', 'caisse-photos', false)
on conflict (id) do nothing;

drop policy if exists caisse_photos_read on storage.objects;
drop policy if exists caisse_photos_insert on storage.objects;
create policy caisse_photos_read on storage.objects
  for select to authenticated using (bucket_id = 'caisse-photos');
create policy caisse_photos_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'caisse-photos');
