// AJCV Caisse — gestion des utilisateurs (réservée aux admins)
// Fonction Edge Supabase. La clé d'administration (service_role) reste ici,
// côté serveur, et n'est JAMAIS exposée au navigateur.
//
// Déploiement : tableau de bord Supabase → Edge Functions → Deploy a new
// function → nom "admin-users" → coller ce fichier → Deploy.
// (La clé service_role est injectée automatiquement, rien à configurer.)

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  // 1) Identifier l'appelant à partir de son jeton
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!token) return json({ error: "Non authentifié" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "Session invalide" }, 401);
  const caller = who.user;

  // 2) Vérifier que l'appelant est administrateur
  const { data: prof } = await admin.from("profiles").select("role").eq("id", caller.id).single();
  if (!prof || prof.role !== "admin") return json({ error: "Réservé aux administrateurs" }, 403);

  // 3) Exécuter l'action demandée
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Requête invalide" }, 400); }
  const action = body.action;

  try {
    if (action === "list") {
      const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) throw error;
      const { data: profs } = await admin.from("profiles").select("id, role, display_name");
      const map = new Map((profs || []).map((p: any) => [p.id, p]));
      const users = (list.users || []).map((u: any) => ({
        id: u.id,
        email: u.email,
        role: map.get(u.id)?.role || "caissier",
        display_name: map.get(u.id)?.display_name || "",
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
      }));
      users.sort((a: any, b: any) => (a.email || "").localeCompare(b.email || ""));
      return json({ users });
    }

    if (action === "create") {
      const email = (body.email || "").trim().toLowerCase();
      const password = body.password || "";
      const display_name = (body.display_name || "").trim();
      const role = body.role === "admin" ? "admin" : "caissier";
      if (!email || !password) return json({ error: "Email et mot de passe requis" }, 400);
      if (password.length < 8) return json({ error: "Mot de passe : 8 caractères minimum" }, 400);
      const { data: created, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { display_name },
      });
      if (error) throw error;
      // le déclencheur a créé le profil (rôle caissier) ; on fixe rôle + nom
      await admin.from("profiles").upsert(
        { id: created.user.id, role, display_name },
        { onConflict: "id" }
      );
      return json({ ok: true, id: created.user.id });
    }

    if (action === "delete") {
      const user_id = body.user_id;
      if (!user_id) return json({ error: "Utilisateur manquant" }, 400);
      if (user_id === caller.id) return json({ error: "Impossible de supprimer ton propre compte" }, 400);
      const { error } = await admin.auth.admin.deleteUser(user_id);
      if (error) throw error;
      await admin.from("profiles").delete().eq("id", user_id);
      return json({ ok: true });
    }

    if (action === "setRole") {
      const user_id = body.user_id;
      const role = body.role === "admin" ? "admin" : "caissier";
      if (!user_id) return json({ error: "Utilisateur manquant" }, 400);
      if (user_id === caller.id && role !== "admin") return json({ error: "Impossible de retirer ton propre rôle admin" }, 400);
      await admin.from("profiles").upsert({ id: user_id, role }, { onConflict: "id" });
      return json({ ok: true });
    }

    if (action === "setPassword") {
      const user_id = body.user_id;
      const password = body.password || "";
      if (!user_id || !password) return json({ error: "Mot de passe requis" }, 400);
      if (password.length < 8) return json({ error: "Mot de passe : 8 caractères minimum" }, 400);
      const { error } = await admin.auth.admin.updateUserById(user_id, { password });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "resetEmail") {
      const email = (body.email || "").trim().toLowerCase();
      if (!email) return json({ error: "Email manquant" }, 400);
      const pub = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      const opts = body.redirect_to ? { redirectTo: body.redirect_to } : undefined;
      const { error } = await pub.auth.resetPasswordForEmail(email, opts);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Action inconnue" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || "Erreur serveur" }, 400);
  }
});
