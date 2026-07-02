-- AJCV Caisse — schéma Supabase (v2 : authentification + rôles + clôtures)
-- À exécuter dans : projet Supabase ▸ SQL Editor ▸ New query ▸ Run
--
-- Accès réservé aux utilisateurs connectés (rôle "to authenticated").
-- Journal des opérations + clôtures = APPEND-ONLY (INSERT + SELECT, aucune
-- policy UPDATE/DELETE) : impossible de modifier/supprimer une ligne via l'API.
-- Une correction se fait par contre-passation (nouvelle ligne inverse).

-- ─────────────────────────────────────────────────────────────
-- Profils (rôle + nom affiché), liés aux comptes auth Supabase
-- ─────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  role         text not null default 'caissier' check (role in ('admin','caissier')),
  created_at   timestamptz not null default now()
);

-- Rôle de l'utilisateur courant — SECURITY DEFINER pour éviter la récursion RLS
create or replace function public.user_role()
returns text language sql security definer stable
set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;
grant execute on function public.user_role() to authenticated;

-- Création automatique du profil à l'inscription (rôle caissier par défaut)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────
-- Opérations de caisse (append-only)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.caisse_operations (
  id          uuid primary key default gen_random_uuid(),
  numero      bigint generated always as identity,
  created_at  timestamptz not null default now(),
  user_id     uuid not null default auth.uid(),      -- auteur réel (audit)
  op_date     date  not null,
  op_time     text  not null,
  type        text  not null check (type in ('facture','achat','sortie','retour','remise','contre','depot')),
  sens        smallint not null check (sens in (-1, 1)),
  montant     numeric(12,2) not null check (montant >= 0),
  mode        text,
  n_doc       text,
  nom         text,
  prenom      text,
  n_cheque    text,
  banque      text,
  operateur   text,
  ref_numero  bigint,
  photo_path  text
);
create index if not exists idx_caisse_ops_date on public.caisse_operations (op_date);

-- ─────────────────────────────────────────────────────────────
-- Fond de caisse par jour (ajustable : insert + update)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.caisse_fonds (
  op_date    date primary key,
  montant    numeric(12,2) not null default 0,
  operateur  text,
  locked     boolean not null default false,
  locked_at  timestamptz,
  locked_by  uuid,
  attendu          numeric(12,2),
  ecart_ouverture  numeric(12,2),
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Clôtures de caisse quotidiennes (une par jour, append-only)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.caisse_clotures (
  op_date          date primary key,
  created_at       timestamptz not null default now(),
  user_id          uuid not null default auth.uid(),
  fond             numeric(12,2) not null default 0,
  theorique        numeric(12,2) not null default 0,
  comptage         numeric(12,2) not null default 0,
  ecart            numeric(12,2) not null default 0,
  theorique_cheque numeric(12,2) not null default 0,
  comptage_cheque  numeric(12,2) not null default 0,
  nb_cheque        integer not null default 0,
  ecart_cheque     numeric(12,2) not null default 0,
  operateur        text
);

-- ─────────────────────────────────────────────────────────────
-- Row Level Security — réservé aux utilisateurs connectés
-- ─────────────────────────────────────────────────────────────
alter table public.profiles          enable row level security;
alter table public.caisse_operations enable row level security;
alter table public.caisse_fonds      enable row level security;
alter table public.caisse_clotures   enable row level security;

-- Profils : tout connecté lit ; seul un admin modifie les rôles
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);
create policy profiles_update_admin on public.profiles
  for update to authenticated using (public.user_role() = 'admin') with check (public.user_role() = 'admin');

-- Opérations : lecture + ajout (pas de modif/suppression -> append-only)
drop policy if exists ops_select on public.caisse_operations;
drop policy if exists ops_insert on public.caisse_operations;
create policy ops_select on public.caisse_operations
  for select to authenticated using (true);
create policy ops_insert on public.caisse_operations
  for insert to authenticated with check (true);

-- Fonds : lecture + upsert
drop policy if exists fonds_select on public.caisse_fonds;
drop policy if exists fonds_insert on public.caisse_fonds;
drop policy if exists fonds_update on public.caisse_fonds;
create policy fonds_select on public.caisse_fonds
  for select to authenticated using (true);
create policy fonds_insert on public.caisse_fonds
  for insert to authenticated with check (true);
-- Une fois le fond validé (locked = true), plus aucune modification possible
create policy fonds_update on public.caisse_fonds
  for update to authenticated using (locked = false) with check (true);

-- Clôtures : lecture + ajout (append-only)
drop policy if exists clotures_select on public.caisse_clotures;
drop policy if exists clotures_insert on public.caisse_clotures;
create policy clotures_select on public.caisse_clotures
  for select to authenticated using (true);
create policy clotures_insert on public.caisse_clotures
  for insert to authenticated with check (true);

-- ─────────────────────────────────────────────────────────────
-- Stockage des photos de paiement (bucket privé "caisse-photos")
-- Lecture + ajout réservés aux connectés ; pas de modif/suppression.
-- ─────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('caisse-photos', 'caisse-photos', false)
on conflict (id) do nothing;

drop policy if exists caisse_photos_read on storage.objects;
drop policy if exists caisse_photos_insert on storage.objects;
create policy caisse_photos_read on storage.objects
  for select to authenticated using (bucket_id = 'caisse-photos');
create policy caisse_photos_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'caisse-photos');

-- ─────────────────────────────────────────────────────────────
-- Rappel sécurité
-- ─────────────────────────────────────────────────────────────
-- La clé "anon public" peut figurer dans le frontend (la sécurité repose sur
-- l'authentification + ces policies). La clé "service_role" ne doit JAMAIS y être.

-- ─────────────────────────────────────────────────────────────
-- Réinitialisation complète (réservée ADMIN)
-- Le journal reste append-only via l'API ; seule cette fonction (qui vérifie
-- le rôle admin) peut tout effacer, pour repartir de zéro après des tests.
-- ─────────────────────────────────────────────────────────────
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
