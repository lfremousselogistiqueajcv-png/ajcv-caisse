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
  sb.auth.onAuthStateChange((_event, session) => cb(session));
}

// Profil = rôle + nom affiché (table public.profiles)
export async function getProfile(sb, userId){
  const { data, error } = await sb
    .from("profiles").select("display_name, role").eq("id", userId).single();
  if (error || !data) return { display_name: "", role: "caissier" };
  return { display_name: data.display_name || "", role: data.role || "caissier" };
}
