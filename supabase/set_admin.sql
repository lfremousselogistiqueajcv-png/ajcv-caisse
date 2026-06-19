-- AJCV Caisse — te passer ADMIN (sans connaître l'e-mail)
--
-- Mode d'emploi :
--   1) Dans l'appli : déconnecte-toi puis reconnecte-toi avec le compte à passer admin.
--   2) Ici : SQL Editor → New query → colle tout → Run.
--   3) Recharge l'appli (ou déconnecte/reconnecte) : le rôle est lu à la connexion.
--
-- Ce script promeut le DERNIER compte connecté (donc toi, juste après ta reconnexion)
-- et crée sa fiche profil si elle n'existe pas encore (c'est ce qui manquait).

insert into public.profiles (id, display_name, role)
select id, coalesce(nullif(split_part(email, '@', 1), ''), 'Admin'), 'admin'
from auth.users
order by last_sign_in_at desc nulls last
limit 1
on conflict (id) do update set role = 'admin';

-- Vérification : ton compte (en haut, le plus récent) doit afficher role = admin
select u.email, p.role, u.last_sign_in_at
from auth.users u
left join public.profiles p on p.id = u.id
order by u.last_sign_in_at desc nulls last;

-- ── Variante : viser un e-mail précis (si besoin) ──
-- insert into public.profiles (id, display_name, role)
-- select id, split_part(email, '@', 1), 'admin'
-- from auth.users where email = 'TON-EMAIL'
-- on conflict (id) do update set role = 'admin';
