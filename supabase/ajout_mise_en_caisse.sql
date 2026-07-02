-- AJCV Caisse — v2.3 « Mise en caisse »
-- Autorise le nouveau type d'opération « depot » (apport d'espèces par la
-- compta). À lancer dans Supabase : SQL Editor → coller → Run. Idempotent.

alter table public.caisse_operations
  drop constraint if exists caisse_operations_type_check;

alter table public.caisse_operations
  add constraint caisse_operations_type_check
  check (type in ('facture','achat','sortie','retour','remise','contre','depot'));

-- rafraîchit le cache de l'API
notify pgrst, 'reload schema';
