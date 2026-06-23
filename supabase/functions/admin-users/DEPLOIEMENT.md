# Déployer la fonction « admin-users » (gestion des utilisateurs)

Cette mini-fonction tourne sur les serveurs Supabase. Elle détient la clé
d'administration (service_role) — qui ne doit JAMAIS se trouver dans le
navigateur. L'appli l'appelle avec ton jeton de session ; la fonction vérifie
que tu es admin avant d'agir.

À faire UNE SEULE FOIS, sans ligne de commande.

## 1. Ouvrir l'éditeur de fonctions
- Tableau de bord Supabase → ton projet → menu de gauche **Edge Functions**.
- Bouton **Deploy a new function** (ou **Create a new function**).

## 2. Créer la fonction
- Nom (exactement) : `admin-users`
- Colle tout le contenu du fichier `supabase/functions/admin-users/index.ts`
  dans l'éditeur, puis **Deploy**.
- C'est tout : la clé service_role est fournie automatiquement à la fonction,
  il n'y a aucun secret à saisir.

## 3. Vérifier dans l'appli
- Recharge l'appli, connecte-toi avec un compte **admin**.
- Ouvre **Paramètres** (bouton visible seulement pour les admins en ligne).
- La liste des utilisateurs doit s'afficher.
- Test rapide : crée un compte caissier de test → il apparaît → connecte-toi
  avec → reviens en admin → supprime-le.

## En cas de souci
- La liste ne se charge pas, erreur 401 / CORS dans la console :
  ouvre la fonction `admin-users` → **Settings** → désactive
  **Verify JWT** (« Enforce JWT verification »). La fonction fait déjà
  elle-même le contrôle (jeton valide + rôle admin), c'est sans risque.
- « Réservé aux administrateurs » : ton compte n'a pas le rôle admin dans la
  table `profiles`. Mets-le admin une fois (SQL Editor) :
  `update public.profiles set role='admin' where id = (select id from auth.users where email='ton@email');`

## Ce que la fonction permet (réservé aux admins)
- Lister les utilisateurs (email, rôle, nom, dernière connexion)
- Créer un compte (email + mot de passe temporaire + rôle)
- Changer le rôle (admin / caissier)
- Réinitialiser un mot de passe (nouveau mot de passe temporaire, ou mail)
- Supprimer un compte
Protections intégrées : tu ne peux pas supprimer ton propre compte ni retirer
ton propre rôle admin.
