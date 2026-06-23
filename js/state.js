// État de la caisse + opérations métier. Aucune dépendance au DOM ni au stockage :
// le stockage est injecté via useAdapter(), le DOM s'abonne via onChange().

import { todayKey, frDate, frTime, p3, num2 } from "./format.js";

export const TYPES = {
  facture: { label: "Facture vente",    sens: 1,  cls: "facture" },
  achat:   { label: "Facture achat",    sens: -1, cls: "achat" },
  sortie:  { label: "Sortie de caisse", sens: -1, cls: "sortie" },
  retour:  { label: "Retour d'argent",  sens: -1, cls: "retour" },
  remise:  { label: "Remise compta",    sens: -1, cls: "remise" },
  contre:  { label: "Contre-passation", sens: 0,  cls: "contre" }
};
export const MODES = ["Espèces", "Chèque", "CB"];

export const state = { operateur: "", role: "local", fonds: {}, fondsLocked: {}, fondsMeta: {}, entries: [], clotures: {} };

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
  state.fondsMeta = d.fondsMeta || {};
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

// Chèques physiquement en caisse aujourd'hui : encaissements par chèque (factures)
// non encore remis ni contre-passés.
export function chequesEnCaisse(key){
  key = key || todayKey();
  const sortis = new Set();
  state.entries.forEach(e => {
    if ((e.typeKey === "remise" || e.typeKey === "contre") && e.refSeq) sortis.add(e.refSeq);
  });
  return state.entries
    .filter(e => e.dateKey === key && e.typeKey === "facture" && e.mode === "Chèque" && !sortis.has(e.seq))
    .map(e => ({ seq: e.seq, nchq: e.nchq, montant: e.montant, nom: e.nom, prenom: e.prenom }))
    .sort((a, b) => a.seq - b.seq);
}

// Remise à la comptabilité : décrémente la caisse.
//   especes : montant en espèces (number)
//   cheques : tableau [{ montant, nchq, nom, seq }] des chèques remis (sélectionnés)
// Crée 1 opération "remise" pour les espèces + 1 par chèque (chacune liée au chèque d'origine).
export async function addRemise(especes, cheques){
  const created = [];
  const e = +especes || 0;
  if (e > 0) created.push(await addEntry({ typeKey: "remise", mode: "Espèces", montant: e, nom: "Comptabilité" }));
  for (const c of (cheques || [])){
    if (+c.montant > 0) created.push(await addEntry({
      typeKey: "remise", mode: "Chèque", montant: +c.montant,
      nchq: c.nchq || "", nom: c.nom || "Comptabilité", refSeq: c.seq || null
    }));
  }
  return created;
}

export function setOperateur(v){ state.operateur = v || ""; }
export function setRole(r){ state.role = r || "local"; }
export function isAdmin(){ return state.role === "admin" || state.role === "local"; }

// Réinitialisation complète (réservée admin). Efface opérations, fonds et clôtures.
// En Supabase, l'effacement passe par une fonction serveur qui vérifie le rôle admin.
export async function resetAll(){
  if (adapter && adapter.reset) await adapter.reset();
  state.entries = []; state.fonds = {}; state.fondsLocked = {}; state.fondsMeta = {}; state.clotures = {};
  emit();
}

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
  const val = state.fonds[key] || 0;
  const attendu = expectedOpening();
  const ecart = (attendu == null) ? null : Math.round((val - attendu) * 100) / 100;
  if (adapter) await adapter.setFond(key, val, true, attendu, ecart);
  state.fondsLocked[key] = true;
  state.fondsMeta[key] = { attendu: attendu, ecart: ecart };
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

// Montant d'espèces attendu à l'ouverture = comptage de la dernière clôture
// (avant aujourd'hui). null s'il n'y a pas encore eu de clôture.
export function expectedOpening(){
  const today = todayKey();
  const keys = Object.keys(state.clotures).filter(k => k < today).sort();
  if (!keys.length) return null;
  const last = state.clotures[keys[keys.length - 1]];
  return last && last.comptage != null ? last.comptage : null;
}

// Jours passés (avant aujourd'hui) qui ont des opérations mais pas de clôture.
export function unclosedDays(){
  const today = todayKey();
  const days = new Set();
  state.entries.forEach(e => { if (e.dateKey && e.dateKey < today) days.add(e.dateKey); });
  return [...days].filter(d => !state.clotures[d]).sort();
}

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

export function exportAchatsRows(scope){    // factures d'achat (sorties)
  const key = todayKey();
  const rows = [["Date", "Heure", "N° Facture", "Fournisseur", "Montant", "Mode", "Opérateur"]];
  state.entries.slice().reverse().forEach(e => {
    if (e.typeKey !== "achat") return;
    if (scope === "day" && e.dateKey !== key) return;
    rows.push([
      e.date, e.heure, e.ndoc, (e.nom + " " + (e.prenom || "")).trim(),
      num2(e.montant), e.mode, e.operateur
    ]);
  });
  return rows;
}

export function exportRemisesRows(scope){   // remises à la comptabilité  const key = todayKey();
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

// ---------- suivi journalier (traçabilité / anti-vol) ----------
// Agrège tout ce qui est enregistré pour un jour donné.
export function daySummary(key){
  let ventes = 0, achats = 0, sorties = 0, remises = 0, retours = 0, nb = 0;
  state.entries.forEach(e => {
    if (e.dateKey !== key) return; nb++;
    if (e.typeKey === "facture") ventes += e.montant;
    else if (e.typeKey === "achat") achats += e.montant;
    else if (e.typeKey === "sortie") sorties += e.montant;
    else if (e.typeKey === "remise") remises += e.montant;
    else if (e.typeKey === "retour") retours += e.montant;
  });
  const meta = state.fondsMeta[key] || {};
  const c = state.clotures[key] || null;
  return {
    dateKey: key, date: frDate(new Date(key + "T00:00:00")),
    fond: state.fonds[key] || 0, locked: !!state.fondsLocked[key],
    attendu: (meta.attendu != null) ? meta.attendu : null,
    ecartOuv: (meta.ecart != null) ? meta.ecart : null,
    ventes, achats, sorties, remises, retours, nb, clot: c
  };
}
// Tous les jours connus (opérations, clôtures ou fonds), récents d'abord.
export function allDays(){
  const s = new Set();
  state.entries.forEach(e => { if (e.dateKey) s.add(e.dateKey); });
  Object.keys(state.clotures).forEach(k => s.add(k));
  Object.keys(state.fonds).forEach(k => s.add(k));
  return [...s].filter(Boolean).sort().reverse();
}
// Données complètes pour le rapport de clôture (ticket Z) d'un jour.
export function dayReport(key){
  key = key || todayKey();
  const s = daySummary(key);
  const t = computeTotals(key);
  let vEsp = 0, vChq = 0, vCb = 0, cbIn = 0;
  state.entries.forEach(e => {
    if (e.dateKey !== key) return;
    if (e.typeKey === "facture"){
      if (e.mode === "Espèces") vEsp += e.montant;
      else if (e.mode === "Chèque") vChq += e.montant;
      else if (e.mode === "CB") vCb += e.montant;
    }
    if (e.mode === "CB" && e.sens > 0) cbIn += e.montant;
  });
  return Object.assign({}, s, {
    theoEsp: t.soldeEspeces, theoChq: t.soldeCheques,
    espIn: t.espIn, espOut: t.espOut, chqIn: t.chqIn, chqOut: t.chqOut,
    ventesEsp: vEsp, ventesChq: vChq, ventesCb: vCb, cbIn: cbIn
  });
}
export function exportSuiviRows(){
  const rows = [[
    "Date", "Fond ouverture", "Attendu ouverture", "Écart ouverture",
    "Ventes", "Achats", "Sorties", "Remises", "Nb opérations",
    "Comptage espèces", "Écart espèces", "Comptage chèques", "Écart chèques", "Clôturé par"
  ]];
  allDays().slice().reverse().forEach(k => {
    const s = daySummary(k); const c = s.clot;
    rows.push([
      s.date, num2(s.fond),
      s.attendu != null ? num2(s.attendu) : "",
      s.ecartOuv != null ? num2(s.ecartOuv) : "",
      num2(s.ventes), num2(s.achats), num2(s.sorties), num2(s.remises), s.nb,
      c ? num2(c.comptage) : "", c ? num2(c.ecart) : "",
      c ? num2(c.comptageCheque || 0) : "", c ? num2(c.ecartCheque || 0) : "",
      c ? (c.operateur || "") : "(non clôturé)"
    ]);
  });
  return rows;
}
