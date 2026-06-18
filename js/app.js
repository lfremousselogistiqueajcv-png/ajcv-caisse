// Point d'entrée. Choisit le stockage (local / Supabase), gère l'authentification
// et les rôles, câble l'écran. La logique métier est dans state.js.

import { CONFIG } from "./config.js";
import { money, num2, parseAmt, esc, frDate, frTime, todayKey } from "./format.js";
import {
  TYPES, state, useAdapter, onChange, hydrate,
  addEntry, reversal, setOperateur, setRole, isAdmin,
  computeTotals, getCloture, addCloture,
  exportRows, exportFacturesRows, exportCloturesRows, persistFond
} from "./state.js";
import * as prefs from "./prefs.js";
import * as auth from "./auth.js";
import { createLocalStore } from "./storage.local.js";

const TYPE_COLOR = { facture: "#0E8A5F", sortie: "#C9760A", retour: "#C2334D", contre: "#15233F" };
const $ = id => document.getElementById(id);

const form = { type: null, mode: null };
let scope = "day";
let typeFilter = "all";
let sb = null;
let currentUid = null;
let booted = false;

function supabaseConfigured(){
  return CONFIG.USE_SUPABASE && CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY &&
         CONFIG.SUPABASE_URL.indexOf("YOUR-") === -1;
}
function p3(n){ n = "" + n; while (n.length < 3) n = "0" + n; return n; }

// ───────── rendu ─────────
function setAccent(t){ document.documentElement.style.setProperty("--accent", t ? TYPE_COLOR[t] : "#15233F"); }

function renderDash(){
  const t = computeTotals();
  $("solde").textContent = money(t.soldeEspeces);
  $("solde").style.color = t.soldeEspeces < 0 ? "var(--ret)" : "var(--ink)";
  $("st-in").textContent = money(t.encaisse);
  $("st-out").textContent = money(t.sorties);
  $("st-nb").textContent = t.nb;
}

function renderList(){
  const key = todayKey(), host = $("list");
  let items = state.entries.filter(e => scope === "all" || e.dateKey === key);
  if (typeFilter !== "all") items = items.filter(e => e.typeKey === typeFilter);
  if (!items.length){
    host.innerHTML = '<div class="empty"><b>Aucune opération' + (scope === "day" ? " aujourd'hui" : "") +
      '</b>Saisis une opération ci-dessus, elle apparaîtra ici, verrouillée.</div>';
    return;
  }
  let html = "";
  items.forEach(e => {
    let meta = '<span><b>Mode</b> ' + esc(e.mode || "—") + "</span>";
    if (e.ndoc) meta += '<span><b>N°</b> ' + esc(e.ndoc) + "</span>";
    const who = (esc(e.nom) + " " + esc(e.prenom || "")).trim();
    if (who) meta += '<span><b>Tiers</b> ' + who + "</span>";
    if (e.nchq) meta += '<span><b>Chèque</b> ' + esc(e.nchq) + (e.banque ? (" · " + esc(e.banque)) : "") + "</span>";
    if (e.operateur) meta += '<span><b>Caissier</b> ' + esc(e.operateur) + "</span>";
    const typeLabel = TYPES[e.typeKey].label + (e.refSeq ? (' <span class="tk-id">de #' + p3(e.refSeq) + "</span>") : "");
    const sign = e.sens > 0 ? "+" : "−";
    html +=
      '<div class="ticket ' + TYPES[e.typeKey].cls + '">' +
        '<div class="tk-top"><span class="tk-id">#' + p3(e.seq) + '</span><span class="tk-lock">🔒 verrouillé</span></div>' +
        '<div class="tk-row"><span class="tk-type">' + typeLabel + "</span>" +
          '<span class="tk-amt">' + sign + " " + money(e.montant) + "</span></div>" +
        '<div class="tk-meta">' + meta + "</div>" +
        '<div class="tk-foot"><span class="tk-time">' + e.date + " · " + e.heure + "</span>" +
          (e.typeKey === "contre" ? "" : '<button class="tk-fix" data-fix="' + e.id + '">Corriger</button>') +
        "</div>" +
      "</div>";
  });
  host.innerHTML = html;
}

function updateEcart(){
  const theo = computeTotals().soldeEspeces;
  const v = parseAmt($("cl-reel").value);
  const cont = document.querySelector(".cl-ecart");
  if (isNaN(v)){ $("cl-ecart").textContent = "—"; cont.classList.remove("ok", "ko"); return; }
  const ec = v - theo;
  $("cl-ecart").textContent = (ec > 0 ? "+ " : "") + money(ec);
  const nul = Math.abs(ec) < 0.005;
  cont.classList.toggle("ok", nul);
  cont.classList.toggle("ko", !nul);
}

function renderCloture(){
  const key = todayKey();
  const t = computeTotals(key);
  $("cl-date").textContent = frDate(new Date(key + "T00:00:00"));
  $("cl-fond").textContent = money(t.fond);
  $("cl-in").textContent  = money(t.espIn);
  $("cl-out").textContent = money(t.espOut);
  $("cl-theo").textContent = money(t.soldeEspeces);

  const c = getCloture(key);
  if (c){
    $("cl-form").hidden = true;
    const done = $("cl-done");
    done.hidden = false;
    const nul = Math.abs(c.ecart) < 0.005;
    done.className = "cl-done" + (nul ? "" : " ko");
    const dt = c.closedAt ? new Date(c.closedAt) : null;
    done.innerHTML =
      "<h3>Journée clôturée" + (nul ? " · caisse juste" : " · écart constaté") + "</h3>" +
      '<div class="row"><span>Théorique</span><b>' + money(c.theorique) + "</b></div>" +
      '<div class="row"><span>Comptage réel</span><b>' + money(c.comptage) + "</b></div>" +
      '<div class="row"><span>Écart</span><b>' + (c.ecart > 0 ? "+ " : "") + money(c.ecart) + "</b></div>" +
      '<div class="row"><span>Clôturé par</span><b>' + esc(c.operateur || "—") + "</b></div>" +
      (dt ? '<div class="row"><span>Le</span><b>' + frDate(dt) + " " + frTime(dt) + "</b></div>" : "");
  } else {
    $("cl-form").hidden = false;
    $("cl-done").hidden = true;
    updateEcart();
  }
}

function renderAll(){ renderDash(); renderList(); renderCloture(); }

// ───────── rôle / UI ─────────
function applyRoleUI(){
  const admin = isAdmin();
  $("scope").hidden = !admin;
  $("filters").hidden = !admin;
  if (!admin){ scope = "day"; typeFilter = "all"; }
}

// ───────── formulaire ─────────
function clearForm(keepTypeMode){
  ["montant", "ndoc", "nom", "prenom", "nchq", "banque"].forEach(id => { $(id).value = ""; });
  $("err").textContent = "";
  if (!keepTypeMode){
    form.type = null; form.mode = null;
    document.querySelectorAll("#seg-type button,#seg-mode button").forEach(b => b.setAttribute("aria-pressed", "false"));
    setAccent(null);
    $("chequeBlock").classList.remove("show");
  }
}
function toggleCheque(){ $("chequeBlock").classList.toggle("show", form.mode === "Chèque"); }
function validate(){
  if (!form.type) return "Choisis un type de document.";
  const m = parseAmt($("montant").value);
  if (isNaN(m) || m <= 0) return "Saisis un montant supérieur à 0.";
  if (!form.mode) return "Choisis un mode de règlement.";
  if (!$("nom").value.trim()) return "Le nom est obligatoire.";
  if ((form.type === "facture" || form.type === "retour") && !$("ndoc").value.trim())
    return "Le n° de document est obligatoire pour ce type.";
  if (form.mode === "Chèque" && !$("nchq").value.trim()) return "Indique le n° du chèque.";
  return "";
}
async function doSave(){
  const msg = validate();
  if (msg){ $("err").textContent = msg; return; }
  const btn = $("save"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "Enregistrement…";
  try {
    await addEntry({
      typeKey: form.type, montant: parseAmt($("montant").value), mode: form.mode,
      ndoc: $("ndoc").value.trim(), nom: $("nom").value.trim(), prenom: $("prenom").value.trim(),
      nchq: form.mode === "Chèque" ? $("nchq").value.trim() : "",
      banque: form.mode === "Chèque" ? $("banque").value.trim() : "",
      operateur: state.operateur
    });
    clearForm(true);
    toast("Opération enregistrée");
    $("montant").focus();
  } catch (e) {
    console.error(e);
    $("err").textContent = "Enregistrement impossible — vérifie la connexion et réessaie.";
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

// ───────── clôture ─────────
async function doCloture(){
  const v = parseAmt($("cl-reel").value);
  if (isNaN(v) || v < 0){ toast("Saisis le comptage réel"); $("cl-reel").focus(); return; }
  const theo = computeTotals().soldeEspeces;
  const ec = v - theo;
  if (!window.confirm("Clôturer la journée ?\nThéorique " + num2(theo) + " € · Comptage " + num2(v) +
      " € · Écart " + num2(ec) + " €.\nLa clôture est définitive.")) return;
  const btn = $("cl-save"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "Clôture…";
  try { await addCloture(v); toast("Journée clôturée"); }
  catch (e) { console.error(e); toast("Clôture impossible (déjà clôturée ?)"); }
  finally { btn.disabled = false; btn.textContent = label; }
}

// ───────── export ─────────
function toTSV(rows){ return rows.map(r => r.join("\t")).join("\n"); }
function copyText(text){
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(() => toast("Copié — colle dans l'onglet SAISIE"), () => fallbackCopy(text));
  } else fallbackCopy(text);
}
function fallbackCopy(text){
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); toast("Copié — colle dans l'onglet SAISIE"); }
  catch (e) { toast("Copie impossible"); }
  ta.remove();
}
async function exportXlsx(){
  const ops = exportRows(scope);
  if (ops.length < 2){ toast("Rien à exporter"); return; }
  toast("Préparation du fichier…");
  let mod;
  try { mod = await import("https://esm.sh/xlsx@0.18.5"); }
  catch (e) { toast("Export .xlsx indisponible (connexion requise)"); return; }
  const XLSX = mod.default || mod;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ops), "Opérations");
  const cl = exportCloturesRows(scope);
  if (cl.length > 1) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cl), "Clôtures");
  if (isAdmin()){
    const fa = exportFacturesRows(scope);
    if (fa.length > 1) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fa), "Factures");
  }
  XLSX.writeFile(wb, "caisse_AJCV_" + todayKey() + ".xlsx");
}

// ───────── toast / horloge ─────────
let toastT;
function toast(msg){
  const el = $("toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2200);
}
function tick(){
  const d = new Date();
  $("ck-time").textContent = frTime(d);
  $("ck-date").textContent = d.toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "short" });
  $("cap").textContent = frDate(d) + " · " + frTime(d);
}
function banner(msg){ const b = $("banner"); b.textContent = msg; b.classList.add("show"); }

// ───────── câblage statique ─────────
function wireUI(){
  $("seg-type").addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b) return;
    form.type = b.dataset.type;
    ev.currentTarget.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    setAccent(form.type); $("err").textContent = "";
  });
  $("seg-mode").addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b) return;
    form.mode = b.dataset.mode;
    ev.currentTarget.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    toggleCheque(); $("err").textContent = "";
  });
  $("save").addEventListener("click", doSave);
  $("montant").addEventListener("keydown", e => { if (e.key === "Enter") doSave(); });

  $("oper").addEventListener("input", function(){ prefs.setOperateur(this.value); setOperateur(this.value); });

  $("fond").addEventListener("input", function(){
    state.fonds[todayKey()] = isNaN(parseAmt(this.value)) ? 0 : parseAmt(this.value);
    renderDash(); renderCloture();
  });
  $("fond").addEventListener("blur", async function(){
    const n = parseAmt(this.value); this.value = isNaN(n) ? "" : num2(n);
    try { await persistFond(); } catch (e) { toast("Fond de caisse non enregistré"); }
  });

  $("scope").addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b) return; scope = b.dataset.scope;
    ev.currentTarget.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    renderList();
  });
  $("filters").addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b) return; typeFilter = b.dataset.filter;
    ev.currentTarget.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    renderList();
  });

  $("exp-xlsx").addEventListener("click", exportXlsx);
  $("exp-copy").addEventListener("click", () => {
    const rows = exportRows(scope);
    if (rows.length < 2){ toast("Rien à copier"); return; }
    copyText(toTSV(rows.slice(1)));
  });

  $("cl-reel").addEventListener("input", updateEcart);
  $("cl-save").addEventListener("click", doCloture);

  $("list").addEventListener("click", async ev => {
    const b = ev.target.closest("[data-fix]"); if (!b) return;
    const e = state.entries.find(x => x.id === b.dataset.fix); if (!e) return;
    if (window.confirm("Contre-passer #" + p3(e.seq) + " (" + TYPES[e.typeKey].label + " " + num2(e.montant) +
        " €) ?\nUne écriture inverse sera créée. La ligne d'origine reste inchangée.")){
      try { await reversal(e.id); toast("Contre-passation créée"); }
      catch (err) { toast("Contre-passation impossible"); }
    }
  });

  // login / logout
  $("lg-btn").addEventListener("click", doLogin);
  $("lg-pwd").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  $("signout").addEventListener("click", async () => { if (sb) await auth.signOut(sb); });
}

// ───────── modes ─────────
async function afterHydrate(){
  $("fond").value = state.fonds[todayKey()] != null ? num2(state.fonds[todayKey()]) : "";
  renderAll();
}

async function startLocal(){
  const store = createLocalStore();
  useAdapter(store);
  setRole("local");
  state.operateur = prefs.getOperateur();
  $("oper").value = state.operateur;
  $("oper").readOnly = false;
  applyRoleUI();
  try { await hydrate(); } catch (e) { console.error(e); }
  if (store.isMemory && store.isMemory())
    banner("Mode session : données non sauvegardées. Ouvre l'appli dans un navigateur (ou héberge-la) pour conserver l'historique.");
  await afterHydrate();
  $("appwrap").style.visibility = "visible";
}

function roleLabel(r){ return r === "admin" ? "Admin" : "Caissier"; }

async function handleSession(session){
  const uid = session && session.user ? session.user.id : null;
  if (uid === currentUid && booted) return;
  currentUid = uid;

  if (!session){
    $("login").hidden = false;
    $("userbox").hidden = true;
    booted = true;
    return;
  }
  $("login").hidden = true;
  $("lg-pwd").value = "";

  const prof = await auth.getProfile(sb, session.user.id);
  setRole(prof.role);
  setOperateur(prof.display_name || (session.user.email || "").split("@")[0]);

  $("ub-name").textContent = state.operateur;
  const rl = $("ub-role"); rl.textContent = roleLabel(prof.role);
  rl.className = "role" + (prof.role === "admin" ? " admin" : "");
  $("userbox").hidden = false;

  $("oper").value = state.operateur;
  $("oper").readOnly = true;   // en mode connecté, l'opérateur = l'utilisateur

  applyRoleUI();
  try { await hydrate(); }
  catch (e) { console.error(e); banner("Connexion au journal impossible. Vérifie la configuration Supabase."); }
  await afterHydrate();
  booted = true;
}

function authError(msg){
  if (!msg) return "Connexion impossible. Vérifie e-mail et mot de passe.";
  if (/invalid login/i.test(msg)) return "E-mail ou mot de passe incorrect.";
  if (/email not confirmed/i.test(msg)) return "Compte non confirmé — préviens l'administrateur.";
  return "Connexion impossible : " + msg;
}
async function doLogin(){
  const email = $("lg-email").value.trim(), pwd = $("lg-pwd").value;
  if (!email || !pwd){ $("lg-err").textContent = "Renseigne l'e-mail et le mot de passe."; return; }
  const btn = $("lg-btn"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "Connexion…"; $("lg-err").textContent = "";
  try {
    const { error } = await auth.signIn(sb, email, pwd);
    if (error) $("lg-err").textContent = authError(error.message);
    // succès -> onAuthChange charge l'appli
  } catch (e) {
    $("lg-err").textContent = "Connexion impossible. Réessaie.";
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

async function startSupabase(){
  let createClient;
  try {
    ({ createClient } = await import("https://esm.sh/@supabase/supabase-js@2"));
  } catch (e) {
    banner("Supabase indisponible — bascule en mode local (cet appareil).");
    return startLocal();
  }
  sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  const { createSupabaseStore } = await import("./storage.supabase.js");
  useAdapter(createSupabaseStore(sb));

  auth.onAuthChange(sb, s => { handleSession(s); });
  const session = await auth.getSession(sb);
  await handleSession(session);
  $("appwrap").style.visibility = "visible";
}

// ───────── init ─────────
async function init(){
  if (supabaseConfigured()) $("appwrap").style.visibility = "hidden";
  onChange(renderAll);
  wireUI();
  tick(); setInterval(tick, 1000);
  if (supabaseConfigured()) await startSupabase();
  else await startLocal();
}

init();
