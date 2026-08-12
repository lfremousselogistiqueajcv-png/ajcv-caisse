# Déployer la caisse pour une NOUVELLE entité (~15 min)

Principe : 1 entité = 1 projet Supabase + 1 dépôt GitHub Pages + 1 config.js.
Données 100 % isolées entre entités. Le même zip sert pour toutes.

## 1. Projet Supabase (base de données)
1. https://supabase.com → New project (nom = l'entité, région Frankfurt, offre Free).
2. Une fois créé : SQL Editor → colle tout `supabase/migration_complete.sql` → Run.
3. Storage : vérifie que le bucket `caisse-photos` existe (créé par le script).
4. Settings → API : note la Project URL et la clé publishable (sb_publishable_…).

## 2. Fonction admin (gestion des utilisateurs)
1. Edge Functions → Deploy a new function → Via Editor.
2. Nom exactement : `admin-users`. Colle tout `supabase/functions/admin-users/index.ts` → Deploy.
3. Ouvre la fonction → Settings → désactive « Verify JWT » → Save.

## 3. Réglages d'authentification
1. Authentication → URL Configuration :
   - Site URL = l'URL GitHub Pages de l'entité (étape 4)
   - Redirect URLs : ajoute l'URL suivie de /**
2. (Recommandé) Authentication → Providers → Email : désactive « Confirm email »
   si tu crées les comptes toi-même depuis Paramètres.

## 4. Dépôt GitHub + Pages
1. github.com → New repository, Public, nom ex. `caisse-entiteX`.
2. Glisse tout le contenu du dossier du zip à la racine → Commit.
3. Settings → Pages → Branch main, dossier /root → Save. Note l'URL.

## 5. config.js de l'entité
1. Ouvre `js/config.example.js`, copie son contenu dans `js/config.js` (sur GitHub :
   ouvrir js/config.js → Edit → remplacer → Commit).
2. Renseigne :
   - ENTITY_NAME : nom affiché (en-tête + titre + pied de page)
   - ENTITY_COLOR : couleur d'accent hex pour distinguer l'entité (ex. "#2E7D5B"),
     vide = doré
   - SUPABASE_URL + SUPABASE_ANON_KEY : valeurs de l'étape 1.4
   - USE_SUPABASE: true

## 6. Comptes utilisateurs
1. Crée TON compte : ouvre l'appli → (si « Confirm email » actif, confirme le mail).
2. Passe-le admin : SQL Editor →
   `update public.profiles set role='admin' where id=(select id from auth.users where email='TON@MAIL');`
3. Reconnecte-toi → bouton Paramètres → crée les caissiers depuis l'appli.

## 7. Vérifications finales
- Le pied de page affiche le nom de l'entité + la version.
- Valide un fond, saisis une opération test, clôture, rapport Z.
- Ajoute l'appli à l'écran d'accueil du téléphone (PWA).

## Mises à jour (toutes entités)
Quand je livre un nouveau zip : glisse son contenu dans CHAQUE dépôt (le zip ne
contient pas de config.js d'entité → ta config n'est jamais écrasée si tu utilises
le zip « pack entité » ; sinon vérifie config.js après). Recharge en vidant le
cache, contrôle le numéro de version en bas.

## Rappels
- Offre gratuite Supabase : un projet inutilisé ~1 semaine est mis en pause →
  bouton Restore project sur son tableau de bord.
- Jamais la clé secrète (sb_secret / service_role) dans config.js.
- Ne modifie pas « Verify JWT » ailleurs que sur admin-users.
