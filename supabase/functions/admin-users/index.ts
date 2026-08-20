// AJCV Caisse — gestion des utilisateurs et entités (v2, multi-entités)
// Fonction Edge Supabase. La clé d'administration reste côté serveur.
// Autorisations : chaque action exige d'être ADMIN DE L'ENTITÉ concernée.
// Déploiement : Edge Functions → admin-users → remplacer le code → Deploy.
// (Verify JWT doit rester désactivé : la fonction contrôle elle-même.)

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!token) return json({ error: "Non authentifié" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "Session invalide" }, 401);
  const caller = who.user;

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Requête invalide" }, 400); }
  const action = body.action;
  const entite = body.entite_id || null;

  async function isAdminOf(uid: string, ent: string) {
    const { data } = await admin.from("membres").select("role").eq("user_id", uid).eq("entite_id", ent).maybeSingle();
    return !!data && data.role === "admin";
  }
  async function isMemberOf(uid: string, ent: string) {
    const { data } = await admin.from("membres").select("role").eq("user_id", uid).eq("entite_id", ent).maybeSingle();
    return !!data;
  }
  async function callerAdminSomewhere() {
    const { data } = await admin.from("membres").select("entite_id").eq("user_id", caller.id).eq("role", "admin").limit(1);
    return !!(data && data.length);
  }
  async function findUserByEmail(email: string) {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;
    return (data.users || []).find((u: any) => (u.email || "").toLowerCase() === email.toLowerCase()) || null;
  }

  try {
    // ── actions liées à une entité ─────────────────────────────
    const needEntity = ["list", "create", "addMember", "removeMember", "setRole", "setPassword", "resetEmail", "delete"];
    if (needEntity.includes(action)) {
      if (!entite) return json({ error: "Entité manquante" }, 400);
      if (!(await isAdminOf(caller.id, entite))) return json({ error: "Réservé aux administrateurs de cette entité" }, 403);
    }

    if (action === "list") {
      const { data: mb, error } = await admin.from("membres").select("user_id, role").eq("entite_id", entite);
      if (error) throw error;
      const ids = (mb || []).map((m: any) => m.user_id);
      const { data: profs } = await admin.from("profiles").select("id, display_name").in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
      const pmap = new Map((profs || []).map((p: any) => [p.id, p]));
      const { data: au } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const umap = new Map((au?.users || []).map((u: any) => [u.id, u]));
      const users = (mb || []).map((m: any) => {
        const u: any = umap.get(m.user_id) || {};
        return {
          id: m.user_id, email: u.email || "(compte supprimé)",
          role: m.role, display_name: pmap.get(m.user_id)?.display_name || "",
          last_sign_in_at: u.last_sign_in_at || null
        };
      }).sort((a: any, b: any) => (a.email || "").localeCompare(b.email || ""));
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
        email, password, email_confirm: true, user_metadata: { display_name },
      });
      if (error) throw error;
      await admin.from("profiles").upsert({ id: created.user.id, role, display_name }, { onConflict: "id" });
      await admin.from("membres").upsert({ user_id: created.user.id, entite_id: entite, role }, { onConflict: "user_id,entite_id" });
      return json({ ok: true, id: created.user.id });
    }

    if (action === "addMember") {
      const email = (body.email || "").trim().toLowerCase();
      const role = body.role === "admin" ? "admin" : "caissier";
      if (!email) return json({ error: "Email manquant" }, 400);
      const u = await findUserByEmail(email);
      if (!u) return json({ error: "Aucun compte avec cet email — crée-le d'abord" }, 404);
      await admin.from("membres").upsert({ user_id: u.id, entite_id: entite, role }, { onConflict: "user_id,entite_id" });
      return json({ ok: true, id: u.id });
    }

    if (action === "removeMember") {
      const user_id = body.user_id;
      if (!user_id) return json({ error: "Utilisateur manquant" }, 400);
      if (user_id === caller.id) return json({ error: "Impossible de te retirer toi-même de cette entité" }, 400);
      const { error } = await admin.from("membres").delete().eq("user_id", user_id).eq("entite_id", entite);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "setRole") {
      const user_id = body.user_id;
      const role = body.role === "admin" ? "admin" : "caissier";
      if (!user_id) return json({ error: "Utilisateur manquant" }, 400);
      if (user_id === caller.id && role !== "admin") return json({ error: "Impossible de retirer ton propre rôle admin" }, 400);
      if (!(await isMemberOf(user_id, entite))) return json({ error: "Cet utilisateur n'est pas membre de l'entité" }, 400);
      await admin.from("membres").update({ role }).eq("user_id", user_id).eq("entite_id", entite);
      return json({ ok: true });
    }

    if (action === "setPassword") {
      const user_id = body.user_id;
      const password = body.password || "";
      if (!user_id || !password) return json({ error: "Mot de passe requis" }, 400);
      if (password.length < 8) return json({ error: "Mot de passe : 8 caractères minimum" }, 400);
      if (!(await isMemberOf(user_id, entite))) return json({ error: "Cet utilisateur n'est pas membre de l'entité" }, 400);
      const { error } = await admin.auth.admin.updateUserById(user_id, { password });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "resetEmail") {
      const email = (body.email || "").trim().toLowerCase();
      if (!email) return json({ error: "Email manquant" }, 400);
      const u = await findUserByEmail(email);
      if (!u || !(await isMemberOf(u.id, entite))) return json({ error: "Cet utilisateur n'est pas membre de l'entité" }, 400);
      const pub = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      const opts = body.redirect_to ? { redirectTo: body.redirect_to } : undefined;
      const { error } = await pub.auth.resetPasswordForEmail(email, opts);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "delete") {
      // suppression DÉFINITIVE du compte (toutes entités)
      const user_id = body.user_id;
      if (!user_id) return json({ error: "Utilisateur manquant" }, 400);
      if (user_id === caller.id) return json({ error: "Impossible de supprimer ton propre compte" }, 400);
      // le demandeur doit être admin de TOUTES les entités du compte visé
      const { data: mbs } = await admin.from("membres").select("entite_id").eq("user_id", user_id);
      for (const m of (mbs || [])) {
        if (!(await isAdminOf(caller.id, m.entite_id)))
          return json({ error: "Ce compte appartient aussi à une entité dont tu n'es pas admin — retire-le plutôt de cette entité" }, 403);
      }
      const { error } = await admin.auth.admin.deleteUser(user_id);
      if (error) throw error;
      await admin.from("profiles").delete().eq("id", user_id);
      await admin.from("membres").delete().eq("user_id", user_id);
      return json({ ok: true });
    }

    // ── entités ────────────────────────────────────────────────
    if (action === "createEntity") {
      if (!(await callerAdminSomewhere())) return json({ error: "Réservé aux administrateurs" }, 403);
      const code = (body.code || "").trim().toUpperCase();
      const nom = (body.nom || "").trim();
      const couleur = (body.couleur || "").trim() || null;
      if (!code || !nom) return json({ error: "Code et nom requis" }, 400);
      const { data: ent, error } = await admin.from("entites")
        .insert({ code, nom, couleur }).select().single();
      if (error) return json({ error: /duplicate|unique/i.test(error.message) ? "Ce code d'entité existe déjà" : error.message }, 400);
      await admin.from("membres").upsert({ user_id: caller.id, entite_id: ent.id, role: "admin" }, { onConflict: "user_id,entite_id" });
      return json({ ok: true, entite: ent });
    }

    return json({ error: "Action inconnue" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || "Erreur serveur" }, 400);
  }
});
