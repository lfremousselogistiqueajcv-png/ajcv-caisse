// État de la caisse + opérations métier. Aucune dépendance au DOM ni au stockage :
// le stockage est injecté via useAdapter(), le DOM s'abonne via onChange().

import { todayKey, frDate, frTime, p3, num2 } from "./format.js";

export const TYPES = {
  facture: { label: "Facture",          sens: 1,  cls: "facture" },
  sortie:  { label: "Sortie de caisse", sens: -1, cls: "sortie" },
  retour:  { label: "Retour d'argent",  sens: -1, cls: "retour" },
  remise:  { label: "Remise compta",    sens: -1, cls: "remise" },
  contre:  { label: "Contre-passation", sens: 0,  cls: "contre" }
};
export const MODES = ["Espèces", "Chèque", "CB"];

export const state = { operateur: "", role: "local", fonds: {}, fondsLocked: {}, entries: [], clotures: {} };

let adapter = null;
const listeners = [];

export function useAdapter(a){ adapter = a; }
export function onChange(cb){ listeners.push(cb); }
function emit(){ listeners.forEach(f => f()); }

export async function hydrate(){
  const d = await adapter.list();
  state.entries = d.entries || [];
  state.fonds = d.fonds || {};
  state.fondsLocked = d.fondsLocked || {};
  if (adapter.listClotures){
    state.clotures = await adapter.listClotures();
  }
  emit();
}

export async function addEntry(pl){
  const d = pl.when ? new Date(pl.when) : new Date();
  const t = TYPES[pl.typeKey] ? pl.typeKey : "facture";
  const sens = (t === "contre") ? (pl.sens || 0) : TYPES[t].sens;
  const draft = {
    id: null, seq: null, iso: d.toISOString(),
    dateKey: todayKey(d), date: frDate(d), heure: frTime(d),
    typeKey: t, sens: sens, montant: +pl.montant,
    mode: pl.mode || "", ndoc: pl.ndoc || "", nom: pl.nom || "", prenom: pl.prenom || "",
    nchq: pl.nchq || "", banque: pl.banque || "",
    operateur: pl.operateur != null ? pl.operateur : state.operateur,
    refSeq: pl.refSeq || null,
    photoPath: pl.photoPath || "", photo: pl.photo || ""
  };
  const saved = await adapter.create(draft);
  if (saved !== draft && !state.entries.some(e => e.id === saved.id)) state.entries.unshift(saved);
  else if (saved === draft && !state.entries.includes(draft)) state.entries.unshift(draft);
  emit();
  return saved;
}

export async function reversal(id){
  const o = state.entries.find(e => e.id === id);
  if (!o) return null;
  return addEntry({
    typeKey: "contre", sens: -o.sens, montant: o.montant, mode: o.mode, ndoc: o.ndoc,
    nom: o.nom, prenom: o.prenom, nchq: o.nchq, banque: o.banque,
    operateur: state.operateur, refSeq: o.seq
  });
}

// Remise à la comptabilité : décrémente la caisse (espèces) et le portefeuille chèques.
// Crée une opération par mode concerné (espèces et/ou chèque), type "remise".
export async function addRemise(especes, cheques){
  const created = [];
  const e = +especes || 0, c = +cheques || 0;
  if (e > 0) created.push(await addEntry({ typeKey: "remise", mode: "Espèces", montant: e, nom: "Comptabilité" }));
  if (c > 0) created.push(await addEntry({ typeKey: "remise", mode: "Chèque",  montant: c, nom: "Comptabilité" }));
  return created;
}

export function setOperateur(v){ state.operateur = v || ""; }
export function setRole(r){ state.role = r || "local"; }
export function isAdmin(){ return state.role === "admin" || state.role === "local"; }

// Photos : délégué à l'adaptateur (Supabase Storage en ligne, data URL en local)
export async function uploadPhoto(blob){ return adapter && adapter.uploadPhoto ? adapter.uploadPhoto(blob) : ""; }
export async function photoUrl(ref){ return adapter && adapter.photoUrl ? adapter.photoUrl(ref) : ref; }

// fond : maj mémoire + rendu immédiat ; persistance via persistFond()
export function setFondLocal(v, key){
  key = key || todayKey();
  state.fonds[key] = isNaN(v) ? 0 : v;
  emit();
}
export async function persistFond(key){
  key = key || todayKey();
  if (adapter) await adapter.setFond(key, state.fonds[key] || 0, false);
}
export function isFondLocked(key){ key = key || todayKey(); return !!state.fondsLocked[key]; }
export async function lockFond(key){
  key = key || todayKey();
  if (adapter) await adapter.setFond(key, state.fonds[key] || 0, true);
  state.fondsLocked[key] = true;
  emit();
}

export function computeTotals(key){
  key = key || todayKey();
  const fond = state.fonds[key] || 0;
  let esp = 0, espIn = 0, espOut = 0, chq = 0, chqIn = 0, chqOut = 0, inn = 0, out = 0, nb = 0;
  state.entries.forEach(e => {
    if (e.dateKey !== key) return;
    nb++;
    const signed = e.sens * e.montant;
    if (e.mode === "Espèces"){ esp += signed; if (signed > 0) espIn += signed; else espOut += -signed; }
    if (e.mode === "Chèque"){  chq += signed; if (signed > 0) chqIn += signed; else chqOut += -signed; }
    if (signed > 0) inn += signed; else out += -signed;
  });
  return {
    fond,
    espece: esp, espIn, espOut, soldeEspeces: fond + esp,   // théorique espèces en caisse
    cheque: chq, chqIn, chqOut, soldeCheques: chq,           // théorique chèques en caisse (net)
    encaisse: inn, sorties: out, nb
  };
}

// ---------- clôture quotidienne ----------
export function getCloture(key){ key = key || todayKey(); return state.clotures[key] || null; }

// pl = { comptageEspeces, comptageCheques, nbCheques }
export async function addCloture(pl, key){
  key = key || todayKey();
  const t = computeTotals(key);
  const now = new Date();
  const compEsp = +pl.comptageEspeces || 0;
  const compChq = +pl.comptageCheques || 0;
  const nbChq = parseInt(pl.nbCheques, 10) || 0;
  const c = {
    dateKey: key, date: frDate(new Date(key + "T00:00:00")),
    fond: t.fond,
    theorique: t.soldeEspeces, comptage: compEsp, ecart: compEsp - t.soldeEspeces,
    theoriqueCheque: t.soldeCheques, comptageCheque: compChq, nbCheque: nbChq,
    ecartCheque: compChq - t.soldeCheques,
    operateur: state.operateur, closedAt: now.toISOString()
  };
  const saved = await adapter.createCloture(c);
  state.clotures[key] = saved || c;
  emit();
  return state.clotures[key];
}

// ---------- exports (tableaux 2D, testables) ----------
export function exportRows(scope){          // Opérations (aligné onglet SAISIE)
  const key = todayKey();
  const rows = [[
    "Date", "Heure", "Type", "Mode", "Libellé", "Tiers", "N° Facture",
    "Entrée", "Sortie", "N° Chèque", "Banque", "Opérateur"
  ]];
  state.entries.slice().reverse().forEach(e => {
    if (scope === "day" && e.dateKey !== key) return;
    const lib = TYPES[e.typeKey].label + (e.refSeq ? (" de #" + p3(e.refSeq)) : "");
    rows.push([
      e.date, e.heure, (e.sens > 0 ? "Encaissement" : "Décaissement"), e.mode, lib,
      (e.nom + " " + (e.prenom || "")).trim(), e.ndoc,
      e.sens > 0 ? num2(e.montant) : "", e.sens < 0 ? num2(e.montant) : "",
      e.nchq, e.banque, e.operateur
    ]);
  });
  return rows;
}

export function exportFacturesRows(scope){  // uniquement les encaissements de type Facture
  const key = todayKey();
  const rows = [["Date", "Heure", "N° Facture", "Tiers", "Montant", "Mode", "Opérateur"]];
  state.entries.slice().reverse().forEach(e => {
    if (e.typeKey !== "facture") return;
    if (scope === "day" && e.dateKey !== key) return;
    rows.push([
      e.date, e.heure, e.ndoc, (e.nom + " " + (e.prenom || "")).trim(),
      num2(e.montant), e.mode, e.operateur
    ]);
  });
  return rows;
}

export function exportRemisesRows(scope){   // remises à la comptabilité
  const key = todayKey();
  const rows = [["Date", "Heure", "Mode", "Montant", "Opérateur"]];
  state.entries.slice().reverse().forEach(e => {
    if (e.typeKey !== "remise") return;
    if (scope === "day" && e.dateKey !== key) return;
    rows.push([e.date, e.heure, e.mode, num2(e.montant), e.operateur]);
  });
  return rows;
}

export function exportCloturesRows(scope){
  const key = todayKey();
  const rows = [[
    "Date", "Fond", "Théorique espèces", "Comptage espèces", "Écart espèces",
    "Théorique chèques", "Comptage chèques", "Nb chèques", "Écart chèques",
    "Opérateur", "Clôturé le"
  ]];
  Object.keys(state.clotures).sort().forEach(k => {
    if (scope === "day" && k !== key) return;
    const c = state.clotures[k];
    const dt = c.closedAt ? new Date(c.closedAt) : null;
    rows.push([
      c.date, num2(c.fond), num2(c.theorique), num2(c.comptage), num2(c.ecart),
      num2(c.theoriqueCheque || 0), num2(c.comptageCheque || 0), c.nbCheque || 0, num2(c.ecartCheque || 0),
      c.operateur || "", dt ? (frDate(dt) + " " + frTime(dt)) : ""
    ]);
  });
  return rows;
}
