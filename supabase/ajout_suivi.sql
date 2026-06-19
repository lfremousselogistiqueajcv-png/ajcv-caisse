-- AJCV Caisse — v1.9 « Suivi des caisses »
-- Enregistre, pour chaque jour, le montant attendu à l'ouverture
-- (dernière clôture) et l'écart constaté. À lancer dans Supabase :
-- SQL Editor → coller → Run. Idempotent (sans risque si relancé).

alter table public.caisse_fonds add column if not exists attendu          numeric(12,2);
alter table public.caisse_fonds add column if not exists ecart_ouverture  numeric(12,2);

-- rafraîchit le cache de l'API (sinon les nouvelles colonnes restent invisibles)
notify pgrst, 'reload schema';
