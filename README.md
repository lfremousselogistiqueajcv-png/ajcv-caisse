# AJCV Caisse

Appli de saisie de caisse, un seul écran, pensée mobile (Samsung Z Fold). Les caissiers saisissent les opérations sans toucher Excel ; chaque ligne enregistrée est verrouillée. Site statique déployable sur GitHub Pages, avec authentification et rôles via Supabase (journal partagé, infalsifiable côté serveur).

## Fonctions

- Saisie : type (Facture / Sortie de caisse / Retour d'argent), montant, mode de règlement, n° document, nom + prénom. N° chèque + banque si Mode = Chèque. Date et heure automatiques.
- Tickets verrouillés, pas d'édition. Correction par contre-passation (écriture inverse, l'original reste intact).
- Clôture du jour : fond de caisse, théorique, comptage réel, écart calculé. Une clôture par jour, définitive.
- Export .xlsx direct (onglets Opérations, Clôtures, et Factures pour les admins) et « Copier pour Excel » (collage dans l'onglet SAISIE du classeur de suivi).
- Authentification + rôles (mode Supabase).

## Rôles

- admin (toi + comptabilité) : voit tout, tous les jours, filtre les factures, export complet.
- caissier (Jean Fred, Clément, Laurent) : saisie + journal du jour + clôture du jour.

En mode local (sans Supabase), pas de login : l'appareil a tous les droits et son propre historique.

## Structure

```
ajcv-caisse/
├── index.html
├── css/styles.css
├── js/
│   ├── app.js              point d'entrée, auth, rôles, câblage écran
│   ├── state.js            état + logique métier (immuable, clôtures, exports)
│   ├── auth.js             authentification Supabase
│   ├── format.js           formatage (montants, dates)
│   ├── prefs.js            préférence appareil (opérateur, mode local)
│   ├── storage.local.js    stockage localStorage (par défaut)
│   ├── storage.supabase.js stockage Supabase
│   └── config.js           configuration
├── supabase/
│   ├── schema.sql          tables + RLS append-only + rôles
│   └── seed_users.sql      attribution des rôles aux comptes
└── assets/favicon.svg
```

## Lancer en local

Les modules ES nécessitent un petit serveur (pas d'ouverture en `file://`) :

```bash
python3 -m http.server 8000
# puis http://localhost:8000
```

## Déployer sur GitHub Pages

```bash
git init
git add .
git commit -m "AJCV Caisse — v2 (auth, clôture, export xlsx)"
git branch -M main
git remote add origin https://github.com/<utilisateur>/ajcv-caisse.git
git push -u origin main
```

Dépôt ▸ Settings ▸ Pages ▸ branche `main`, dossier `/ (root)`.

## Activer Supabase, l'authentification et les comptes

1. Crée un projet sur https://supabase.com
2. SQL Editor → exécute `supabase/schema.sql` (tables, RLS, rôles, trigger de profil).
3. Authentication ▸ Users ▸ Add user → crée tes 5 comptes. Coche « Auto Confirm User » et définis un mot de passe :
   - 2 admins : toi + comptabilité
   - 3 caissiers : Jean Fred, Clément, Laurent
4. SQL Editor → ouvre `supabase/seed_users.sql`, remplace les e-mails par les vrais, exécute-le (fixe rôles + noms affichés).
5. Settings ▸ API → copie l'URL du projet et la clé `anon public`.
6. Dans `js/config.js` : renseigne URL + clé, passe `USE_SUPABASE` à `true`.
7. Pousse et recharge : l'écran de connexion apparaît.

Ajouter un compte plus tard : Add user dans le dashboard (il devient caissier automatiquement), puis un `update` comme dans `seed_users.sql` si besoin de le passer admin ou de fixer son nom affiché.

## Immuabilité & sécurité

- Mode local : l'interface empêche toute édition, mais le `localStorage` reste modifiable par un utilisateur averti. Usage simple, mono-appareil.
- Mode Supabase : `caisse_operations` et `caisse_clotures` sont append-only au niveau base (INSERT + SELECT, aucune policy UPDATE/DELETE) — verrouillage réel. Chaque opération enregistre aussi `user_id` (auteur réel) pour l'audit.
- Accès réservé aux utilisateurs connectés (`to authenticated`).
- La clé `anon public` peut figurer dans le frontend ; la clé `service_role` ne doit jamais y apparaître.

## Workflow avec le classeur Excel

Les caissiers utilisent l'appli. Pour le back-office (clôture, archive, reporting), l'admin exporte en .xlsx ou copie les lignes dans l'onglet SAISIE du classeur de suivi — les onglets Caisse/Synthèse s'y recalculent.

## Roadmap

- Réinitialisation de mot de passe en libre-service.
- Bornage de l'export admin par plage de dates.
- Rapprochement automatique des chèques remis.
