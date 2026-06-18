-- AJCV Caisse — migration v3 (à exécuter UNE FOIS sur une base déjà créée en v2)
-- SQL Editor → New query → coller → Run. Sans danger, idempotent.

-- 1) Autoriser le nouveau type d'opération "remise"
alter table public.caisse_operations drop constraint if exists caisse_operations_type_check;
alter table public.caisse_operations
  add constraint caisse_operations_type_check
  check (type in ('facture','sortie','retour','remise','contre'));

-- 2) Ajouter le comptage des chèques à la clôture
alter table public.caisse_clotures add column if not exists theorique_cheque numeric(12,2) not null default 0;
alter table public.caisse_clotures add column if not exists comptage_cheque  numeric(12,2) not null default 0;
alter table public.caisse_clotures add column if not exists nb_cheque        integer        not null default 0;
alter table public.caisse_clotures add column if not exists ecart_cheque     numeric(12,2) not null default 0;
