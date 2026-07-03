-- AJCV Caisse — correctif du sens « Retour d'argent »
--
-- Un remboursement client SORT de la caisse : son sens doit être -1.
-- À cause d'un bug, certains retours ont pu être enregistrés en +1 (ils
-- augmentaient la caisse au lieu de la diminuer). Cette requête corrige
-- UNIQUEMENT ces lignes-là. Elle ne supprime rien. Si tu n'as jamais
-- enregistré de « Retour d'argent », elle ne modifie rien (0 ligne).
--
-- Optionnel : à lancer seulement si tu as saisi des retours récemment.
-- Supabase → SQL Editor → coller → Run.

update public.caisse_operations
set sens = -1
where type = 'retour' and sens = 1;

-- Combien de lignes ont été corrigées : le résultat s'affiche après le Run.
-- Note : les journées déjà clôturées gardent leur clôture enregistrée telle
-- quelle ; ce correctif remet surtout la journée en cours et l'historique
-- des opérations au bon signe.
