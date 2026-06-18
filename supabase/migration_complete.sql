-- AJCV Caisse — mise à jour COMPLÈTE de la base (cumule v3 + v4)
-- À exécuter UNE FOIS : SQL Editor → New query → coller → Run.
-- Sans danger et idempotent : tu peux le relancer sans rien casser,
-- même si tu avais déjà passé un bout des scripts précédents.

-- ───── Types d'opération (vente, achat, sortie, retour, remise) ─────
alter table public.caisse_operations drop constraint if exists caisse_operations_type_check;
alter table public.caisse_operations
  add constraint caisse_operations_type_check
  check (type in ('facture','achat','sortie','retour','remise','contre'));

-- ───── Comptage des chèques dans la clôture ─────
alter table public.caisse_clotures add column if not exists theorique_cheque numeric(12,2) not null default 0;
alter table public.caisse_clotures add column if not exists comptage_cheque  numeric(12,2) not null default 0;
alter table public.caisse_clotures add column if not exists nb_cheque        integer        not null default 0;
alter table public.caisse_clotures add column if not exists ecart_cheque     numeric(12,2) not null default 0;

-- ───── Verrou du fond de caisse (validé le matin = non modifiable) ─────
alter table public.caisse_fonds add column if not exists locked    boolean not null default false;
alter table public.caisse_fonds add column if not exists locked_at timestamptz;
alter table public.caisse_fonds add column if not exists locked_by uuid;
drop policy if exists fonds_update on public.caisse_fonds;
create policy fonds_update on public.caisse_fonds
  for update to authenticated using (locked = false) with check (true);

-- ───── Photo du paiement ─────
alter table public.caisse_operations add column if not exists photo_path text;

-- ───── Bucket privé des photos + accès réservé aux connectés ─────
insert into storage.buckets (id, name, public)
values ('caisse-photos', 'caisse-photos', false)
on conflict (id) do nothing;
drop policy if exists caisse_photos_read on storage.objects;
drop policy if exists caisse_photos_insert on storage.objects;
create policy caisse_photos_read on storage.objects
  for select to authenticated using (bucket_id = 'caisse-photos');
create policy caisse_photos_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'caisse-photos');

-- ───── Réinitialisation complète (réservée ADMIN) ─────
-- Le journal reste non supprimable via l'API ; seule cette fonction, qui vérifie
-- le rôle admin, peut tout effacer (pour repartir de zéro après des tests).
create or replace function public.reset_caisse()
returns void language plpgsql security definer
set search_path = public as $$
begin
  if public.user_role() <> 'admin' then
    raise exception 'Réinitialisation réservée aux administrateurs';
  end if;
  delete from public.caisse_operations;
  delete from public.caisse_fonds;
  delete from public.caisse_clotures;
  delete from storage.objects where bucket_id = 'caisse-photos';
end $$;
grant execute on function public.reset_caisse() to authenticated;
