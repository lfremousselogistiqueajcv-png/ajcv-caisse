-- AJCV Caisse — rôles & noms affichés des comptes
--
-- ÉTAPE 1 — créer les comptes (Supabase ▸ Authentication ▸ Users ▸ Add user)
--   Coche "Auto Confirm User" pour qu'ils puissent se connecter tout de suite,
--   et définis un mot de passe pour chacun. Remplace les e-mails ci-dessous par
--   les vrais. Le trigger crée automatiquement un profil (rôle caissier).
--
-- ÉTAPE 2 — exécuter ce script (SQL Editor) pour fixer rôles + noms affichés.
--   On met à jour public.profiles en faisant la jointure sur l'e-mail.

-- ── Administrateurs (accès complet : tout voir, factures, export) ──
update public.profiles p set role = 'admin', display_name = 'Laurent (admin)'
from auth.users u where u.id = p.id and u.email = 'laurent.admin@ajcv.re';

update public.profiles p set role = 'admin', display_name = 'Comptabilité'
from auth.users u where u.id = p.id and u.email = 'compta@ajcv.re';

-- ── Caissiers (saisie + journal du jour + clôture) ──
update public.profiles p set role = 'caissier', display_name = 'Jean Fred'
from auth.users u where u.id = p.id and u.email = 'jeanfred@ajcv.re';

update public.profiles p set role = 'caissier', display_name = 'Clément'
from auth.users u where u.id = p.id and u.email = 'clement@ajcv.re';

update public.profiles p set role = 'caissier', display_name = 'Laurent'
from auth.users u where u.id = p.id and u.email = 'laurent@ajcv.re';

-- Vérification
select u.email, pr.display_name, pr.role
from public.profiles pr join auth.users u on u.id = pr.id
order by pr.role, pr.display_name;
