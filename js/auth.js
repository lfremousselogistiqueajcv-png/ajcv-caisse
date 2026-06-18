// Authentification Supabase (utilisé uniquement en mode Supabase).
// Reçoit un client Supabase déjà créé.

export async function getSession(sb){
  const { data } = await sb.auth.getSession();
  return data ? data.session : null;
}

export async function signIn(sb, email, password){
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  return { session: data ? data.session : null, error };
}

export async function signOut(sb){
  await sb.auth.signOut();
}

export function onAuthChange(sb, cb){
  sb.auth.onAuthStateChange((event, session) => cb(event, session));
}

// Envoi d'un e-mail de réinitialisation (lien de récupération)
export async function resetPassword(sb, email, redirectTo){
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
  return { error };
}

// Définit un nouveau mot de passe pour l'utilisateur connecté (ou en récupération)
export async function updatePassword(sb, newPassword){
  const { error } = await sb.auth.updateUser({ password: newPassword });
  return { error };
}

// Profil = rôle + nom affiché (table public.profiles)
export async function getProfile(sb, userId){
  const { data, error } = await sb
    .from("profiles").select("display_name, role").eq("id", userId).single();
  if (error || !data) return { display_name: "", role: "caissier" };
  return { display_name: data.display_name || "", role: data.role || "caissier" };
}
