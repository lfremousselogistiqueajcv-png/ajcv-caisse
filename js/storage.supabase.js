// Adaptateur de stockage : Supabase (journal partagé, infalsifiable côté serveur).
// Reçoit un client Supabase déjà créé (partagé avec l'authentification).
// Prérequis : exécuter supabase/schema.sql dans le projet Supabase.

import { frDate } from "./format.js";

export function createSupabaseStore(sb){
  // entrée interne -> ligne BDD (user_id est rempli côté serveur : default auth.uid())
  function toRow(e){
    return {
      op_date: e.dateKey, op_time: e.heure, type: e.typeKey, sens: e.sens,
      montant: e.montant, mode: e.mode || null, n_doc: e.ndoc || null,
      nom: e.nom || null, prenom: e.prenom || null,
      n_cheque: e.nchq || null, banque: e.banque || null,
      operateur: e.operateur || null, ref_numero: e.refSeq || null,
      photo_path: e.photoPath || null
    };
  }
  function fromRow(r){
    return {
      id: r.id, seq: r.numero, iso: r.created_at,
      dateKey: r.op_date, date: frDate(new Date(r.op_date + "T00:00:00")), heure: r.op_time,
      typeKey: r.type, sens: r.sens, montant: Number(r.montant),
      mode: r.mode || "", ndoc: r.n_doc || "", nom: r.nom || "", prenom: r.prenom || "",
      nchq: r.n_cheque || "", banque: r.banque || "",
      operateur: r.operateur || "", refSeq: r.ref_numero || null,
      photoPath: r.photo_path || ""
    };
  }
  function clFromRow(r){
    return {
      dateKey: r.op_date, date: frDate(new Date(r.op_date + "T00:00:00")),
      fond: Number(r.fond), theorique: Number(r.theorique),
      comptage: Number(r.comptage), ecart: Number(r.ecart),
      theoriqueCheque: Number(r.theorique_cheque || 0), comptageCheque: Number(r.comptage_cheque || 0),
      nbCheque: Number(r.nb_cheque || 0), ecartCheque: Number(r.ecart_cheque || 0),
      operateur: r.operateur || "", closedAt: r.created_at
    };
  }

  return {
    kind: "supabase",
    isMemory(){ return false; },

    async list(){
      const { data: ops, error } = await sb
        .from("caisse_operations").select("*").order("numero", { ascending: false });
      if (error) throw error;
      const { data: fo, error: fe } = await sb.from("caisse_fonds").select("*");
      if (fe) throw fe;
      const fonds = {}, fondsLocked = {};
      (fo || []).forEach(f => { fonds[f.op_date] = Number(f.montant); if (f.locked) fondsLocked[f.op_date] = true; });
      return { entries: (ops || []).map(fromRow), fonds, fondsLocked };
    },

    async create(entry){
      const { data, error } = await sb
        .from("caisse_operations").insert(toRow(entry)).select().single();
      if (error) throw error;
      return fromRow(data);
    },

    async setFond(dateKey, val, lock){
      const row = { op_date: dateKey, montant: val, locked: !!lock };
      if (lock) row.locked_at = new Date().toISOString();
      const { error } = await sb
        .from("caisse_fonds")
        .upsert(row, { onConflict: "op_date" });
      if (error) throw error;
    },

    // Stockage des photos (bucket privé "caisse-photos") -> renvoie le chemin
    async uploadPhoto(blob){
      const ext = (blob.type && blob.type.indexOf("png") > -1) ? "png" : "jpg";
      const path = new Date().toISOString().slice(0, 10) + "/" +
        (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + "_" + Math.random().toString(36).slice(2))) + "." + ext;
      const { error } = await sb.storage.from("caisse-photos")
        .upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false });
      if (error) throw error;
      return path;
    },
    async photoUrl(path){
      const { data, error } = await sb.storage.from("caisse-photos").createSignedUrl(path, 3600);
      if (error) throw error;
      return data.signedUrl;
    },

    async listClotures(){
      const { data, error } = await sb.from("caisse_clotures").select("*");
      if (error) throw error;
      const map = {};
      (data || []).forEach(r => { map[r.op_date] = clFromRow(r); });
      return map;
    },

    async createCloture(c){
      const row = {
        op_date: c.dateKey, fond: c.fond, theorique: c.theorique,
        comptage: c.comptage, ecart: c.ecart,
        theorique_cheque: c.theoriqueCheque || 0, comptage_cheque: c.comptageCheque || 0,
        nb_cheque: c.nbCheque || 0, ecart_cheque: c.ecartCheque || 0,
        operateur: c.operateur || null
      };
      const { data, error } = await sb
        .from("caisse_clotures").insert(row).select().single();
      if (error) throw error;
      return clFromRow(data);
    }
  };
}
