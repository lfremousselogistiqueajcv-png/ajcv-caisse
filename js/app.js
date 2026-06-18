// Point d'entrée. Choisit le stockage (local / Supabase), gère l'authentification
// et les rôles, câble l'écran. La logique métier est dans state.js.

import { CONFIG } from "./config.js";
import { money, num2, parseAmt, esc, frDate, frTime, todayKey } from "./format.js";
import {
  TYPES, state, useAdapter, onChange, hydrate,
  addEntry, reversal, addRemise, setOperateur, setRole, isAdmin,
  computeTotals, getCloture, addCloture,
  exportRows, exportFacturesRows, exportRemisesRows, exportCloturesRows,
  persistFond, lockFond, isFondLocked, uploadPhoto, photoUrl
} from "./state.js";
import * as prefs from "./prefs.js";
import * as auth from "./auth.js";
import { createLocalStore } from "./storage.local.js";

const TYPE_COLOR = { facture: "#0E8A5F", sortie: "#C9760A", retour: "#C2334D", remise: "#5B62B5", contre: "#15233F" };
const DENOMS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1]; // centimes
const $ = id => document.getElementById(id);

const form = { type: null, mode: null };
let scope = "day";
let typeFilter = "all";
let sb = null;
let currentUid = null;
let booted = false;
let setpwdMode = "account";
let ckBuilt = false;
let pendingPhoto = null;   // { blob, dataUrl } photo de l'opération en cours de saisie

function supabaseConfigured(){
  return CONFIG.USE_SUPABASE && CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY &&
         CONFIG.SUPABASE_URL.indexOf("YOUR-") === -1;
}
function p3(n){ n = "" + n; while (n.length < 3) n = "0" + n; return n; }
function signMoney(ec){ return (ec > 0 ? "+ " : "") + money(ec); }

// ───────── comptage pièces/billets ─────────
function denomLabel(c){ return c >= 100 ? (c / 100) + " €" : c + " c"; }
function buildDenom(prefix, host){
  host.innerHTML = DENOMS.map(c =>
    '<div class="denom-row"><span class="dn-lbl">' + denomLabel(c) + "</span>" +
    '<input class="dn-q" inputmode="numeric" placeholder="0" id="' + prefix + "-d-" + c + '">' +
    '<span class="dn-sub" id="' + prefix + "-s-" + c + '">0,00</span></div>'
  ).join("");
}
function sumDenom(prefix){
  let cents = 0;
  DENOMS.forEach(c => {
    const el = $(prefix + "-d-" + c);
    const q = parseInt(el && el.value, 10) || 0;
    const sub = q * c; cents += sub;
    const s = $(prefix + "-s-" + c); if (s) s.textContent = num2(sub / 100);
  });
  return cents / 100;
}
function resetDenom(prefix){
  DENOMS.forEach(c => { const el = $(prefix + "-d-" + c); if (el) el.value = ""; const s = $(prefix + "-s-" + c); if (s) s.textContent = "0,00"; });
}

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

function renderFond(){
  const locked = isFondLocked();
  $("fond").readOnly = locked;
  $("fond-lock").hidden = locked;
  $("fond-state").hidden = !locked;
}

// ───────── photo du paiement ─────────
function dataURLtoBlob(d){
  const parts = d.split(","); const mime = (parts[0].match(/:(.*?);/) || [])[1] || "image/jpeg";
  const bin = atob(parts[1]); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
function resizePhoto(file, cb){
  const fr = new FileReader();
  fr.onerror = () => cb(null);
  fr.onload = () => {
    const raw = fr.result;
    let ctxOk = false;
    try { ctxOk = !!document.createElement("canvas").getContext("2d"); } catch (e) {}
    if (!ctxOk) return cb({ blob: file, dataUrl: raw });   // pas de canvas (ex. tests) -> photo brute
    const img = new Image();
    let settled = false;
    const fallback = () => { if (!settled){ settled = true; cb({ blob: file, dataUrl: raw }); } };
    const tmo = setTimeout(fallback, 4000);
    img.onerror = () => { clearTimeout(tmo); fallback(); };
    img.onload = () => {
      if (settled) return; settled = true; clearTimeout(tmo);
      try {
        const max = 1280; let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h) return cb({ blob: file, dataUrl: raw });
        if (w > max || h > max){ if (w >= h){ h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; } }
        const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        const dataUrl = cv.toDataURL("image/jpeg", 0.7);
        if (cv.toBlob) cv.toBlob(b => cb({ blob: b || dataURLtoBlob(dataUrl), dataUrl }), "image/jpeg", 0.7);
        else cb({ blob: dataURLtoBlob(dataUrl), dataUrl });
      } catch (e) { cb({ blob: file, dataUrl: raw }); }
    };
    img.src = raw;
  };
  fr.readAsDataURL(file);
}
function clearPhoto(){
  pendingPhoto = null;
  $("photo-file").value = "";
  $("photo-prev").hidden = true;
  $("photo-add").hidden = false;
  $("photo-thumb").removeAttribute("src");
}
function onPhotoPick(file){
  if (!file) return;
  resizePhoto(file, res => {
    if (!res){ toast("Image illisible"); return; }
    pendingPhoto = res;
    $("photo-thumb").src = res.dataUrl;
    $("photo-prev").hidden = false;
    $("photo-add").hidden = true;
  });
}
async function openPhoto(entry){
  const view = $("ph-view");
  view.innerHTML = '<div class="ph-load">Chargement…</div>';
  $("photoModal").hidden = false;
  try {
    let url = entry.photo || "";
    if (!url && entry.photoPath) url = await photoUrl(entry.photoPath);
    view.innerHTML = url ? ('<img src="' + url + '" alt="photo du paiement">') : '<div class="ph-load">Photo indisponible.</div>';
  } catch (e) { view.innerHTML = '<div class="ph-load">Photo indisponible.</div>'; }
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
    const hasPhoto = !!(e.photo || e.photoPath);
    html +=
      '<div class="ticket ' + TYPES[e.typeKey].cls + '">' +
        '<div class="tk-top"><span class="tk-id">#' + p3(e.seq) + '</span><span class="tk-lock">🔒 verrouillé</span></div>' +
        '<div class="tk-row"><span class="tk-type">' + typeLabel + "</span>" +
          '<span class="tk-amt">' + sign + " " + money(e.montant) + "</span></div>" +
        '<div class="tk-meta">' + meta + "</div>" +
        '<div class="tk-foot"><span class="tk-time">' + e.date + " · " + e.heure + "</span>" +
          '<span class="tk-actions">' +
            (hasPhoto ? '<button class="tk-photo" data-photo="' + e.id + '">📷 Voir la photo</button>' : "") +
            (e.typeKey === "contre" ? "" : '<button class="tk-fix" data-fix="' + e.id + '">Corriger</button>') +
          "</span>" +
        "</div>" +
      "</div>";
  });
  host.innerHTML = html;
}

function updateEcart(){
  const theo = computeTotals().soldeEspeces;
  const v = parseAmt($("cl-reel").value);
  const box = $("cl-ecartBox");
  if (isNaN(v)){ $("cl-ecart").textContent = "—"; box.classList.remove("ok", "ko"); return; }
  const ec = v - theo;
  $("cl-ecart").textContent = signMoney(ec);
  const nul = Math.abs(ec) < 0.005;
  box.classList.toggle("ok", nul); box.classList.toggle("ko", !nul);
}
function updateEcartChq(){
  const theo = computeTotals().soldeCheques;
  const v = parseAmt($("cl-chq-total").value);
  const box = $("cl-ecartBox-chq");
  if (isNaN(v)){ $("cl-ecart-chq").textContent = "—"; box.classList.remove("ok", "ko"); return; }
  const ec = v - theo;
  $("cl-ecart-chq").textContent = signMoney(ec);
  const nul = Math.abs(ec) < 0.005;
  box.classList.toggle("ok", nul); box.classList.toggle("ko", !nul);
}

function renderCloture(){
  const key = todayKey();
  const t = computeTotals(key);
  $("cl-date").textContent = frDate(new Date(key + "T00:00:00"));
  $("cl-fond").textContent = money(t.fond);
  $("cl-in").textContent  = money(t.espIn);
  $("cl-out").textContent = money(t.espOut);
  $("cl-theo").textContent = money(t.soldeEspeces);
  $("cl-theo-chq").textContent = money(t.soldeCheques);

  const c = getCloture(key);
  if (c){
    $("cl-form").hidden = true;
    const done = $("cl-done");
    done.hidden = false;
    const nul = Math.abs(c.ecart) < 0.005 && Math.abs(c.ecartCheque || 0) < 0.005;
    done.className = "cl-done" + (nul ? "" : " ko");
    const dt = c.closedAt ? new Date(c.closedAt) : null;
    done.innerHTML =
      "<h3>Journée clôturée" + (nul ? " · caisse juste" : " · écart constaté") + "</h3>" +
      '<div class="row"><span>Théorique espèces</span><b>' + money(c.theorique) + "</b></div>" +
      '<div class="row"><span>Comptage espèces</span><b>' + money(c.comptage) + "</b></div>" +
      '<div class="row"><span>Écart espèces</span><b>' + signMoney(c.ecart) + "</b></div>" +
      '<div class="row"><span>Théorique chèques</span><b>' + money(c.theoriqueCheque || 0) + "</b></div>" +
      '<div class="row"><span>Comptage chèques</span><b>' + money(c.comptageCheque || 0) + " (" + (c.nbCheque || 0) + ")</b></div>" +
      '<div class="row"><span>Écart chèques</span><b>' + signMoney(c.ecartCheque || 0) + "</b></div>" +
      '<div class="row"><span>Clôturé par</span><b>' + esc(c.operateur || "—") + "</b></div>" +
      (dt ? '<div class="row"><span>Le</span><b>' + frDate(dt) + " " + frTime(dt) + "</b></div>" : "");
  } else {
    $("cl-form").hidden = false;
    $("cl-done").hidden = true;
    updateEcart();
    updateEcartChq();
  }
}

function renderAll(){ renderFond(); renderDash(); renderList(); renderCloture(); }

// ───────── rôle / UI ─────────
function applyRoleUI(){
  const admin = isAdmin();
  $("scope").hidden = !admin;
  $("filters").hidden = !admin;
  if (!admin){ scope = "day"; typeFilter = "all"; }
}

// ───────── formulaire saisie ─────────
function clearForm(keepTypeMode){
  ["montant", "ndoc", "nom", "prenom", "nchq", "banque"].forEach(id => { $(id).value = ""; });
  $("err").textContent = "";
  clearPhoto();
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
    let photoPath = "", photo = "";
    if (pendingPhoto){
      if (sb){
        try { photoPath = await uploadPhoto(pendingPhoto.blob); }
        catch (e) { console.error(e); toast("Photo non envoyée — opération enregistrée sans photo"); }
      } else {
        photo = pendingPhoto.dataUrl;
      }
    }
    await addEntry({
      typeKey: form.type, montant: parseAmt($("montant").value), mode: form.mode,
      ndoc: $("ndoc").value.trim(), nom: $("nom").value.trim(), prenom: $("prenom").value.trim(),
      nchq: form.mode === "Chèque" ? $("nchq").value.trim() : "",
      banque: form.mode === "Chèque" ? $("banque").value.trim() : "",
      operateur: state.operateur, photoPath, photo
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

// ───────── remise compta ─────────
function openRemise(){
  const t = computeTotals();
  $("rm-th-esp").textContent = money(t.soldeEspeces);
  $("rm-th-chq").textContent = money(t.soldeCheques);
  $("rm-esp").value = ""; $("rm-chq").value = ""; $("rm-err").textContent = "";
  $("remiseModal").hidden = false;
}
async function doRemise(){
  const esp = parseAmt($("rm-esp").value), chq = parseAmt($("rm-chq").value);
  const e = isNaN(esp) ? 0 : esp, c = isNaN(chq) ? 0 : chq;
  if (e <= 0 && c <= 0){ $("rm-err").textContent = "Indique un montant espèces et/ou chèques."; return; }
  const btn = $("rm-save"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  try { await addRemise(e, c); $("remiseModal").hidden = true; toast("Remise enregistrée"); }
  catch (err) { console.error(err); $("rm-err").textContent = "Enregistrement impossible — vérifie la connexion."; }
  finally { btn.disabled = false; btn.textContent = label; }
}

// ───────── vérifier la caisse (à blanc) ─────────
function setEcartBox(box, b, ec){
  b.textContent = signMoney(ec);
  const nul = Math.abs(ec) < 0.005;
  box.classList.toggle("ok", nul); box.classList.toggle("ko", !nul);
}
function updateCheck(){
  const t = computeTotals();
  const cash = sumDenom("ck");
  $("ck-cash-total").textContent = money(cash);
  $("ck-cash-theo").textContent = money(t.soldeEspeces);
  setEcartBox($("ck-cash-ecartBox"), $("ck-cash-ecart"), cash - t.soldeEspeces);
  $("ck-chq-theo").textContent = money(t.soldeCheques);
  const chq = parseAmt($("ck-chq-total").value);
  if (isNaN(chq)){ $("ck-chq-ecart").textContent = "—"; $("ck-chq-ecartBox").classList.remove("ok", "ko"); }
  else setEcartBox($("ck-chq-ecartBox"), $("ck-chq-ecart"), chq - t.soldeCheques);
}
function openCheck(){
  if (!ckBuilt){
    buildDenom("ck", $("ck-denom"));
    $("ck-denom").addEventListener("input", updateCheck);
    $("ck-chq-total").addEventListener("input", updateCheck);
    ckBuilt = true;
  }
  resetDenom("ck");
  $("ck-chq-nb").value = ""; $("ck-chq-total").value = "";
  updateCheck();
  $("checkModal").hidden = false;
}

// ───────── clôture ─────────
async function doCloture(){
  const esp = parseAmt($("cl-reel").value);
  if (isNaN(esp) || esp < 0){ toast("Saisis le comptage espèces"); $("cl-reel").focus(); return; }
  const chq = parseAmt($("cl-chq-total").value);
  const compChq = isNaN(chq) ? 0 : chq;
  const nb = parseInt($("cl-chq-nb").value, 10) || 0;
  const t = computeTotals();
  const ecEsp = esp - t.soldeEspeces, ecChq = compChq - t.soldeCheques;
  if (!window.confirm(
    "Clôturer la journée ?\n" +
    "Espèces — théorique " + num2(t.soldeEspeces) + " · compté " + num2(esp) + " · écart " + num2(ecEsp) + "\n" +
    "Chèques — théorique " + num2(t.soldeCheques) + " · compté " + num2(compChq) + " · écart " + num2(ecChq) + "\n" +
    "La clôture est définitive.")) return;
  const btn = $("cl-save"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "Clôture…";
  try { await addCloture({ comptageEspeces: esp, comptageCheques: compChq, nbCheques: nb }); toast("Journée clôturée"); }
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
  const add = (rows, name) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  add(ops, "Opérations");
  const cl = exportCloturesRows(scope); if (cl.length > 1) add(cl, "Clôtures");
  if (isAdmin()){
    const fa = exportFacturesRows(scope); if (fa.length > 1) add(fa, "Factures");
    const re = exportRemisesRows(scope); if (re.length > 1) add(re, "Remises");
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

// ───────── mot de passe (reset + paramètres) ─────────
function openSetPwd(mode){
  setpwdMode = mode;
  $("sp-title").textContent = mode === "recovery" ? "Nouveau mot de passe" : "Changer mon mot de passe";
  $("sp-cancel").hidden = (mode === "recovery");
  $("sp-err").textContent = ""; $("sp-info").textContent = "";
  $("sp-pwd").value = ""; $("sp-pwd2").value = "";
  $("login").hidden = true;
  $("setpwd").hidden = false;
}
function closeSetPwd(){ $("setpwd").hidden = true; }
async function doSetPwd(){
  const p1 = $("sp-pwd").value, p2 = $("sp-pwd2").value;
  $("sp-err").textContent = ""; $("sp-info").textContent = "";
  if ((p1 || "").length < 6){ $("sp-err").textContent = "6 caractères minimum."; return; }
  if (p1 !== p2){ $("sp-err").textContent = "Les deux mots de passe ne correspondent pas."; return; }
  const btn = $("sp-btn"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  try {
    const { error } = await auth.updatePassword(sb, p1);
    if (error){ $("sp-err").textContent = "Échec : " + error.message; }
    else {
      $("sp-info").textContent = "Mot de passe enregistré.";
      $("sp-pwd").value = ""; $("sp-pwd2").value = "";
      if (setpwdMode === "recovery") setTimeout(() => location.replace(location.origin + location.pathname), 900);
      else setTimeout(closeSetPwd, 900);
    }
  } catch (e) { $("sp-err").textContent = "Échec. Réessaie."; }
  finally { btn.disabled = false; btn.textContent = label; }
}
async function doForgot(){
  const email = $("lg-email").value.trim();
  $("lg-err").textContent = ""; $("lg-info").textContent = "";
  if (!email){ $("lg-err").textContent = "Saisis d'abord ton e-mail ci-dessus."; return; }
  const redirectTo = location.origin + location.pathname;
  try {
    await auth.resetPassword(sb, email, redirectTo);
    $("lg-info").textContent = "Si un compte existe, un e-mail de réinitialisation a été envoyé.";
  } catch (e) { $("lg-err").textContent = "Envoi impossible. Réessaie."; }
}

// ───────── fond de caisse (verrou) ─────────
async function doFondLock(){
  if (isFondLocked()) return;
  const n = parseAmt($("fond").value);
  const val = isNaN(n) ? 0 : n;
  state.fonds[todayKey()] = val;
  if (!window.confirm("Valider le fond de caisse à " + num2(val) + " € ?\nIl sera verrouillé pour la journée et ne pourra plus être modifié.")) return;
  const btn = $("fond-lock"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  try { await lockFond(); $("fond").value = num2(val); toast("Fond de caisse validé et verrouillé"); }
  catch (e) { console.error(e); toast("Validation impossible — réessaie"); }
  finally { btn.disabled = false; btn.textContent = label; }
}

// ───────── câblage statique ─────────
function wireUI(){
  buildDenom("cl", $("cl-denom"));
  $("cl-denom").addEventListener("input", () => { $("cl-reel").value = num2(sumDenom("cl")); updateEcart(); });
  $("cl-reel").addEventListener("input", updateEcart);
  $("cl-chq-total").addEventListener("input", updateEcartChq);
  $("cl-save").addEventListener("click", doCloture);

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
    if (isFondLocked()) return;
    state.fonds[todayKey()] = isNaN(parseAmt(this.value)) ? 0 : parseAmt(this.value);
    renderDash(); renderCloture();
  });
  $("fond").addEventListener("blur", async function(){
    if (isFondLocked()) return;
    const n = parseAmt(this.value); this.value = isNaN(n) ? "" : num2(n);
    try { await persistFond(); } catch (e) { toast("Fond de caisse non enregistré"); }
  });
  $("fond-lock").addEventListener("click", doFondLock);

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

  // remise + vérif caisse
  $("btn-remise").addEventListener("click", openRemise);
  $("rm-close").addEventListener("click", () => { $("remiseModal").hidden = true; });
  $("rm-save").addEventListener("click", doRemise);
  $("btn-check").addEventListener("click", openCheck);
  $("ck-close").addEventListener("click", () => { $("checkModal").hidden = true; });
  $("ck-done").addEventListener("click", () => { $("checkModal").hidden = true; });

  // photo du paiement
  $("photo-add").addEventListener("click", () => $("photo-file").click());
  $("photo-file").addEventListener("change", e => onPhotoPick(e.target.files && e.target.files[0]));
  $("photo-rm").addEventListener("click", clearPhoto);
  $("ph-close").addEventListener("click", () => { $("photoModal").hidden = true; $("ph-view").innerHTML = ""; });

  $("list").addEventListener("click", async ev => {
    const ph = ev.target.closest("[data-photo]");
    if (ph){ const e = state.entries.find(x => x.id === ph.dataset.photo); if (e) openPhoto(e); return; }
    const b = ev.target.closest("[data-fix]"); if (!b) return;
    const e = state.entries.find(x => x.id === b.dataset.fix); if (!e) return;
    if (window.confirm("Contre-passer #" + p3(e.seq) + " (" + TYPES[e.typeKey].label + " " + num2(e.montant) +
        " €) ?\nUne écriture inverse sera créée. La ligne d'origine reste inchangée.")){
      try { await reversal(e.id); toast("Contre-passation créée"); }
      catch (err) { toast("Contre-passation impossible"); }
    }
  });

  // auth
  $("lg-btn").addEventListener("click", doLogin);
  $("lg-pwd").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  $("lg-forgot").addEventListener("click", doForgot);
  $("signout").addEventListener("click", async () => { if (sb) await auth.signOut(sb); });
  $("account").addEventListener("click", () => openSetPwd("account"));
  $("sp-btn").addEventListener("click", doSetPwd);
  $("sp-cancel").addEventListener("click", closeSetPwd);
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
  $("oper").readOnly = true;

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
  btn.disabled = true; btn.textContent = "Connexion…"; $("lg-err").textContent = ""; $("lg-info").textContent = "";
  try {
    const { error } = await auth.signIn(sb, email, pwd);
    if (error) $("lg-err").textContent = authError(error.message);
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

  const isRecovery = location.hash.indexOf("type=recovery") !== -1;

  auth.onAuthChange(sb, (event, s) => {
    if (event === "PASSWORD_RECOVERY"){ openSetPwd("recovery"); return; }
    if (isRecovery) return;       // pendant une récupération, on ignore les autres événements
    handleSession(s);
  });

  if (isRecovery) openSetPwd("recovery");
  else await handleSession(await auth.getSession(sb));

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
