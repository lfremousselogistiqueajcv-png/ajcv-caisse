-- ============================================================
-- CAISSE MULTI-ENTITÉS — SQL n°2 (cloisonnement)
-- PRÉREQUIS : multi_entites_etape1.sql déjà exécuté.
-- IMPORTANT : à lancer JUSTE AVANT de déployer l'appli v4.0
-- (l'appli v3.x cesse de fonctionner après ce script).
-- Idempotent : relançable sans risque.
-- ============================================================

-- 1) Clés par entité (un fond / une clôture PAR JOUR ET PAR ENTITÉ)
do $$
begin
  if exists (select 1 from pg_constraint where conname='caisse_fonds_pkey'
             and conrelid='public.caisse_fonds'::regclass
             and array_length(conkey,1)=1) then
    alter table public.caisse_fonds drop constraint caisse_fonds_pkey;
    alter table public.caisse_fonds add primary key (entite_id, op_date);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.caisse_fonds'::regclass and contype='p') then
    alter table public.caisse_fonds add primary key (entite_id, op_date);
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_constraint where conname='caisse_clotures_pkey'
             and conrelid='public.caisse_clotures'::regclass
             and array_length(conkey,1)=1) then
    alter table public.caisse_clotures drop constraint caisse_clotures_pkey;
    alter table public.caisse_clotures add primary key (entite_id, op_date);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.caisse_clotures'::regclass and contype='p') then
    alter table public.caisse_clotures add primary key (entite_id, op_date);
  end if;
end $$;

-- 2) Fonction d'appartenance (réutilisée par toutes les politiques)
create or replace function public.est_membre(p_entite uuid)
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.membres m
                  where m.user_id = auth.uid() and m.entite_id = p_entite); $$;

create or replace function public.est_admin_entite(p_entite uuid)
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.membres m
                  where m.user_id = auth.uid() and m.entite_id = p_entite
                    and m.role = 'admin'); $$;

-- 3) Politiques RLS par appartenance — opérations
drop policy if exists ops_select on public.caisse_operations;
drop policy if exists ops_insert on public.caisse_operations;
create policy ops_select on public.caisse_operations
  for select to authenticated using (public.est_membre(entite_id));
create policy ops_insert on public.caisse_operations
  for insert to authenticated with check (public.est_membre(entite_id));
-- (ni update ni delete : journal infalsifiable, inchangé)

-- 4) Fonds
drop policy if exists fonds_select on public.caisse_fonds;
drop policy if exists fonds_insert on public.caisse_fonds;
drop policy if exists fonds_update on public.caisse_fonds;
create policy fonds_select on public.caisse_fonds
  for select to authenticated using (public.est_membre(entite_id));
create policy fonds_insert on public.caisse_fonds
  for insert to authenticated with check (public.est_membre(entite_id));
create policy fonds_update on public.caisse_fonds
  for update to authenticated
  using (public.est_membre(entite_id) and locked = false)
  with check (public.est_membre(entite_id));

-- 5) Clôtures
drop policy if exists clot_select on public.caisse_clotures;
drop policy if exists clot_insert on public.caisse_clotures;
create policy clot_select on public.caisse_clotures
  for select to authenticated using (public.est_membre(entite_id));
create policy clot_insert on public.caisse_clotures
  for insert to authenticated with check (public.est_membre(entite_id));

-- 6) Réinitialisation PAR ENTITÉ (admin de l'entité uniquement)
drop function if exists public.reset_caisse();
drop function if exists public.reset_caisse(uuid);
create function public.reset_caisse(p_entite uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.est_admin_entite(p_entite) then
    raise exception 'Réservé aux administrateurs de cette entité';
  end if;
  delete from public.caisse_operations where entite_id = p_entite;
  delete from public.caisse_clotures  where entite_id = p_entite;
  delete from public.caisse_fonds     where entite_id = p_entite;
  return 'ok';
end $$;
grant execute on function public.reset_caisse(uuid) to authenticated;

-- 7) Rafraîchir le cache de l'API
notify pgrst, 'reload schema';

-- ============================================================
-- CONTRÔLES :
select 'fonds pk' as t, count(*) from pg_constraint
  where conrelid='public.caisse_fonds'::regclass and contype='p' and array_length(conkey,1)=2
union all
select 'clotures pk', count(*) from pg_constraint
  where conrelid='public.caisse_clotures'::regclass and contype='p' and array_length(conkey,1)=2
union all
select 'politiques caisse', count(*) from pg_policies
  where schemaname='public' and tablename like 'caisse%';
-- Attendu : fonds pk = 1, clotures pk = 1, politiques caisse ≥ 7.
-- ============================================================
