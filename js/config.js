// Configuration de l'appli.
//
// Par défaut : USE_SUPABASE = false -> stockage local (cet appareil), fonctionne hors-ligne.
//
// Pour activer le journal partagé Supabase :
//   1. Crée un projet sur https://supabase.com
//   2. Exécute supabase/schema.sql dans l'éditeur SQL du projet
//   3. Récupère l'URL et la clé "anon public" : Settings ▸ API
//   4. Renseigne-les ci-dessous et passe USE_SUPABASE à true
//
// La clé "anon public" est conçue pour être publique (la sécurité repose sur les
// règles RLS définies dans schema.sql). Ne mets JAMAIS la clé "service_role" ici.

export const CONFIG = {
  USE_SUPABASE: true,
  SUPABASE_URL: "https://adktjeubdoeezmhmdbit.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_NEpTmygB6vPZms7vIBbSnw_aNBZlEOM"
};
