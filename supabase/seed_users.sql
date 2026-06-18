-- AJCV Caisse — rôles & noms affichés (SCRIPT 2)
-- À lancer APRÈS schema.sql et APRÈS avoir créé les 5 comptes (Authentication ▸ Add user).
-- Le bloc 1 garantit qu'un profil existe pour chaque compte, quel que soit l'ordre.

-- 1) Profil pour chaque compte existant qui n'en a pas encore
insert into public.profiles (id, display_name)
select u.id, split_part(u.email, '@', 1)
from auth.users u
on conflict (id) do nothing;

-- 2) Rôles + noms affichés
update public.profiles p set role = 'admin', display_name = 'Laurent (admin)'
from auth.users u where u.id = p.id and u.email = 'lfremousselogistiqueajcv@gmail.com';

update public.profiles p set role = 'admin', display_name = 'Comptabilité'
from auth.users u where u.id = p.id and u.email = 'sarl.ajcv@gmail.com';

update public.profiles p set role = 'caissier', display_name = 'Jean Fred'
from auth.users u where u.id = p.id and u.email = 'jfgrondin.ajcv@gmail.com';

update public.profiles p set role = 'caissier', display_name = 'Clément'
from auth.users u where u.id = p.id and u.email = 'cbenard.livreurajcv@gmail.com';

update public.profiles p set role = 'caissier', display_name = 'Laurent'
from auth.users u where u.id = p.id and u.email = 'sav.ajcv@gmail.com';

-- 3) Vérification (doit renvoyer 5 lignes : 2 admin, 3 caissier)
select u.email, pr.display_name, pr.role
from public.profiles pr join auth.users u on u.id = pr.id
order by pr.role, pr.display_name;
