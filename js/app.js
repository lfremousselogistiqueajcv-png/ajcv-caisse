// Point d'entrée. Choisit le stockage (local / Supabase), gère l'authentification
// et les rôles, câble l'écran. La logique métier est dans state.js.

import { CONFIG } from "./config.js";
import { money, num2, parseAmt, esc, frDate, frTime, todayKey } from "./format.js";
import {
  TYPES, state, useAdapter, onChange, hydrate,
  addEntry, reversal, addRemise, chequesEnCaisse, setOperateur, setRole, isAdmin,
  computeTotals, getCloture, addCloture, resetAll, unclosedDays, expectedOpening,
  exportRows, exportFacturesRows, exportAchatsRows, exportRemisesRows, exportCloturesRows,
  daySummary, allDays, exportSuiviRows, dayReport,
  persistFond, lockFond, isFondLocked, uploadPhoto, photoUrl
} from "./state.js";
import * as prefs from "./prefs.js";
import * as auth from "./auth.js";
import { createLocalStore } from "./storage.local.js";

const TYPE_COLOR = { facture: "#0E8A5F", achat: "#9C4221", sortie: "#C9760A", retour: "#0E8A5F", depot: "#0F766E", remise: "#5B62B5", contre: "#15233F" };
const DENOMS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1]; // centimes
const $ = id => document.getElementById(id);
// câblage défensif : un élément manquant (ex. cache mélangé) ne bloque plus le reste
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); else console.warn("[caisse] élément absent:", id); };

const form = { type: null, mode: null };
let scope = "day";
let typeFilter = "all";
let sb = null;
let currentUid = null;
let booted = false;
let setpwdMode = "account";
let ckBuilt = false;
let pendingPhotos = [];   // [{ blob, dataUrl }] photos de l'opération en cours de saisie
const LOGIN_KEY = "ajcv_caisse_login_at";
const EIGHT_H = 8 * 60 * 60 * 1000;
let sessionEnding = false;

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

// ───────── comptage des chèques (une ligne par chèque : n° + montant) ─────────
function chqRowHTML(){
  return '<div class="chq-row">' +
    '<input class="chq-n" inputmode="numeric" placeholder="N° chèque" autocomplete="off">' +
    '<input class="chq-m" inputmode="decimal" placeholder="Montant €" autocomplete="off">' +
    '<button type="button" class="chq-del" aria-label="Retirer ce chèque">✕</button></div>';
}
function addChqRow(prefix){ $(prefix + "-chq-rows").insertAdjacentHTML("beforeend", chqRowHTML()); }
function resetChqRows(prefix){ $(prefix + "-chq-rows").innerHTML = chqRowHTML(); }
function sumChqRows(prefix){
  let total = 0, count = 0; const list = [];
  $(prefix + "-chq-rows").querySelectorAll(".chq-row").forEach(r => {
    const m = parseAmt(r.querySelector(".chq-m").value);
    const n = (r.querySelector(".chq-n").value || "").trim();
    if (!isNaN(m) && m > 0){ total += m; count++; list.push({ nchq: n, montant: m }); }
  });
  return { total, count, list };
}
function wireChqRows(prefix, onChange){
  $(prefix + "-chq-add").addEventListener("click", () => { addChqRow(prefix); onChange(); });
  $(prefix + "-chq-rows").addEventListener("input", onChange);
  $(prefix + "-chq-rows").addEventListener("click", ev => {
    const d = ev.target.closest(".chq-del"); if (!d) return;
    d.closest(".chq-row").remove();
    if (!$(prefix + "-chq-rows").querySelector(".chq-row")) addChqRow(prefix);
    onChange();
  });
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
  $("lockNote").hidden = locked;
  const exp = expectedOpening();
  const fe = $("fond-expected");
  if (!locked && exp != null){ fe.textContent = "Attendu à l'ouverture (dernière clôture) : " + money(exp); fe.hidden = false; }
  else fe.hidden = true;
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
function resetPhotoInputs(){ ["photo-cam", "photo-file"].forEach(id => { const el = $(id); if (el) el.value = ""; }); }
function clearPhotos(){
  pendingPhotos = [];
  resetPhotoInputs();
  renderPhotoStrip();
}
function renderPhotoStrip(){
  const strip = $("photo-strip");
  if (!pendingPhotos.length){ strip.innerHTML = ""; strip.hidden = true; return; }
  strip.hidden = false;
  strip.innerHTML = pendingPhotos.map((p, i) =>
    '<div class="photo-cell"><img src="' + p.dataUrl + '" alt="photo ' + (i + 1) + '">' +
    '<button type="button" class="photo-rm" data-idx="' + i + '" aria-label="Retirer">✕</button></div>'
  ).join("");
}
function onPhotoPick(files){
  if (!files || !files.length) return;
  const arr = Array.from(files);
  let remaining = arr.length;
  arr.forEach(f => resizePhoto(f, res => {
    if (res) pendingPhotos.push(res);
    if (--remaining === 0) renderPhotoStrip();
  }));
  resetPhotoInputs();  // permet de re-choisir les mêmes fichiers
}

// Sources de photos d'une entrée (compat ancien champ unique)
function entryPhotoData(e){ return (e.photos && e.photos.length) ? e.photos : (e.photo ? [e.photo] : []); }
function entryPhotoPaths(e){ return (e.photoPaths && e.photoPaths.length) ? e.photoPaths : (e.photoPath ? [e.photoPath] : []); }
function entryHasPhoto(e){ return entryPhotoData(e).length > 0 || entryPhotoPaths(e).length > 0; }

let lastPhotoEntry = null;

// ───────── export PDF des factures (généré dans le navigateur) ─────────
let _jsPDF = null;
async function loadJsPDF(){
  if (_jsPDF) return _jsPDF;
  const m = await import("https://esm.sh/jspdf@2.5.2");
  _jsPDF = m.jsPDF || (m.default && m.default.jsPDF) || m.default;
  return _jsPDF;
}
async function urlToDataUrl(url){
  if (/^data:/.test(url)) return url;
  const r = await fetch(url); const b = await r.blob();
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); });
}
function imgSize(dataUrl){
  return new Promise(res => { const im = new Image(); im.onload = () => res({ w: im.width, h: im.height }); im.onerror = () => res({ w: 0, h: 0 }); im.src = dataUrl; });
}
async function entryPhotoUrls(e){
  let urls = entryPhotoData(e).slice();
  if (!urls.length){
    for (const p of entryPhotoPaths(e)){ try { urls.push(await photoUrl(p)); } catch (err) {} }
  }
  return urls;
}
function pdfHeader(doc, e, pageW){
  const name = (CONFIG.ENTITY_NAME || "AJCV");
  doc.setFont("helvetica", "bold"); doc.setFontSize(13);
  doc.text(name + " — Justificatif de caisse", pageW / 2, 14, { align: "center" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  const l1 = TYPES[e.typeKey].label + " · " + num2(e.montant) + " € · " + (e.mode || "");
  const who = ((e.nom || "") + " " + (e.prenom || "")).trim();
  const l2 = [e.date + " " + (e.heure || ""), e.ndoc ? ("pièce " + e.ndoc) : "", who, e.nchq ? ("chèque n° " + e.nchq) : ""].filter(Boolean).join("  ·  ");
  doc.text(l1, pageW / 2, 20, { align: "center" });
  doc.setFontSize(9); doc.setTextColor(110);
  doc.text(l2, pageW / 2, 25, { align: "center" });
  doc.setTextColor(0);
}
async function addEntryPages(doc, e, first){
  const urls = await entryPhotoUrls(e);
  const pageW = 210, pageH = 297, margin = 10, top = 32;
  let added = 0;
  for (const u of urls){
    let du; try { du = await urlToDataUrl(u); } catch (err) { continue; }
    const s = await imgSize(du); if (!s.w) continue;
    if (!first || added > 0) doc.addPage();
    pdfHeader(doc, e, pageW);
    const maxW = pageW - 2 * margin, maxH = pageH - top - margin;
    const k = Math.min(maxW / s.w, maxH / s.h);
    const w = s.w * k, h = s.h * k;
    doc.addImage(du, "JPEG", (pageW - w) / 2, top, w, h);
    added++; first = false;
  }
  return added;
}
async function pdfEntry(){
  const e = lastPhotoEntry; if (!e) return;
  const btn = $("ph-pdf"), label = btn.textContent; btn.disabled = true; btn.textContent = "…";
  try {
    const JsPDF = await loadJsPDF();
    const doc = new JsPDF({ unit: "mm", format: "a4" });
    const n = await addEntryPages(doc, e, true);
    if (!n){ toast("Aucune photo exploitable"); return; }
    doc.save("facture_" + p3(e.seq) + "_" + e.dateKey + ".pdf");
  } catch (err) { console.error(err); toast("Génération PDF impossible — vérifie la connexion"); }
  finally { btn.disabled = false; btn.textContent = label; }
}
function histFiltered(){
  const from = $("hi-from").value, to = $("hi-to").value, tf = $("hi-type").value, photoOnly = $("hi-photo").checked;
  let items = state.entries.slice();
  if (from) items = items.filter(e => e.dateKey >= from);
  if (to) items = items.filter(e => e.dateKey <= to);
  if (tf !== "all") items = items.filter(e => e.typeKey === tf);
  if (photoOnly) items = items.filter(e => entryHasPhoto(e));
  return items;
}
async function pdfPeriod(){
  const items = histFiltered().filter(e => entryHasPhoto(e)).sort((a, b) => (a.dateKey + p3(a.seq)).localeCompare(b.dateKey + p3(b.seq)));
  if (!items.length){ toast("Aucune facture (photo) dans la sélection"); return; }
  const btn = $("hi-pdf"), label = btn.textContent; btn.disabled = true; btn.textContent = "Génération…";
  try {
    const JsPDF = await loadJsPDF();
    const doc = new JsPDF({ unit: "mm", format: "a4" });
    // page de garde
    const name = (CONFIG.ENTITY_NAME || "AJCV");
    const from = $("hi-from").value ? frDate(new Date($("hi-from").value + "T00:00:00")) : "début";
    const to = $("hi-to").value ? frDate(new Date($("hi-to").value + "T00:00:00")) : "aujourd'hui";
    doc.setFont("helvetica", "bold"); doc.setFontSize(18);
    doc.text(name + " — Factures de caisse", 105, 120, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(12);
    doc.text("Période : " + from + " → " + to, 105, 132, { align: "center" });
    doc.text(items.length + " opération(s) avec justificatif", 105, 140, { align: "center" });
    let total = 0;
    for (const e of items){ doc.addPage(); await addEntryPages(doc, e, true); total++; btn.textContent = "Génération… " + total + "/" + items.length; }
    doc.save("factures_" + ($("hi-from").value || "debut") + "_" + ($("hi-to").value || "fin") + ".pdf");
    toast("PDF généré (" + items.length + " opération(s))");
  } catch (err) { console.error(err); toast("Génération PDF impossible — vérifie la connexion"); }
  finally { btn.disabled = false; btn.textContent = label; }
}

async function openPhotos(entry){
  lastPhotoEntry = entry;
  const view = $("ph-view");
  view.innerHTML = '<div class="ph-load">Chargement…</div>';
  $("photoModal").hidden = false;
  try {
    let urls = entryPhotoData(entry).slice();
    if (!urls.length){
      for (const p of entryPhotoPaths(entry)){ try { urls.push(await photoUrl(p)); } catch (e) {} }
    }
    view.innerHTML = urls.length
      ? urls.map((u, i) => '<img src="' + u + '" alt="facture ' + (i + 1) + '">').join("")
      : '<div class="ph-load">Photo indisponible.</div>';
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
    const hasPhoto = entryHasPhoto(e); const nPhoto = entryPhotoData(e).length || entryPhotoPaths(e).length;
    html +=
      '<div class="ticket ' + TYPES[e.typeKey].cls + '">' +
        '<div class="tk-top"><span class="tk-id">#' + p3(e.seq) + '</span><span class="tk-lock">🔒 verrouillé</span></div>' +
        '<div class="tk-row"><span class="tk-type">' + typeLabel + "</span>" +
          '<span class="tk-amt">' + sign + " " + money(e.montant) + "</span></div>" +
        '<div class="tk-meta">' + meta + "</div>" +
        '<div class="tk-foot"><span class="tk-time">' + e.date + " · " + e.heure + "</span>" +
          '<span class="tk-actions">' +
            (hasPhoto ? '<button class="tk-photo" data-photo="' + e.id + '">📷 ' + (nPhoto > 1 ? ("Voir les " + nPhoto + " photos") : "Voir la photo") + "</button>" : "") +
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
  const { total, count } = sumChqRows("cl");
  $("cl-chq-total").textContent = money(total);
  $("cl-chq-nb").textContent = count;
  const box = $("cl-ecartBox-chq");
  const ec = total - theo;
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
      (dt ? '<div class="row"><span>Le</span><b>' + frDate(dt) + " " + frTime(dt) + "</b></div>" : "") +
      '<button type="button" class="z-open-btn" id="cl-z">Voir le rapport Z</button>';
  } else {
    $("cl-form").hidden = false;
    $("cl-done").hidden = true;
    updateEcart();
    updateEcartChq();
  }
}

function renderClotureAlert(){
  const days = unclosedDays();
  const el = $("clotureAlert");
  if (!days.length){ el.hidden = true; el.textContent = ""; return; }
  const dates = days.map(d => frDate(new Date(d + "T00:00:00")));
  el.textContent = "⚠ Caisse non clôturée pour " + (dates.length > 1 ? "les jours : " : "le ") + dates.join(", ") + ". Pense à la clôturer.";
  el.hidden = false;
}

function renderAll(){ renderFond(); renderClotureAlert(); renderDash(); renderList(); renderCloture(); }

// ───────── rôle / UI ─────────
function applyRoleUI(){
  const admin = isAdmin();
  $("scope").hidden = !admin;
  $("filters").hidden = !admin;
  $("btn-reset").hidden = !admin;
  $("btn-suivi").hidden = !admin;
  $("btn-hist").hidden = !admin;
  $("btn-param").hidden = !(admin && sb);
  if (!admin){ scope = "day"; typeFilter = "all"; }
}

// ───────── formulaire saisie ─────────
function clearForm(keepTypeMode){
  ["montant", "ndoc", "nom", "prenom", "nchq", "banque"].forEach(id => { $(id).value = ""; });
  $("err").textContent = "";
  clearPhotos();
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
  if ((form.type === "facture" || form.type === "achat") && !$("ndoc").value.trim())
    return "Le n° de document est obligatoire pour ce type.";
  if (form.mode === "Chèque" && !$("nchq").value.trim()) return "Indique le n° du chèque.";
  return "";
}
async function doSave(){
  if (!isFondLocked()){ $("err").textContent = "Valide d'abord le fond de caisse du jour (bouton « Enregistrer le fond »)."; return; }
  const msg = validate();
  if (msg){ $("err").textContent = msg; return; }
  // confirmation avant enregistrement
  const amount = parseAmt($("montant").value);
  const ndoc = $("ndoc").value.trim();
  const who = ($("nom").value.trim() + " " + $("prenom").value.trim()).trim();
  const recap = "Enregistrer cette opération ?\n\n" +
    TYPES[form.type].label + " · " + num2(amount) + " €\n" +
    "Règlement : " + form.mode +
      (form.mode === "Chèque" && $("nchq").value.trim() ? (" n° " + $("nchq").value.trim()) : "") + "\n" +
    (ndoc ? ("Pièce : " + ndoc + "\n") : "") +
    (who ? ("Client : " + who) : "");
  if (!window.confirm(recap)) return;
  const btn = $("save"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "Enregistrement…";
  try {
    let photoPaths = [], photos = [];
    if (pendingPhotos.length){
      if (sb){
        for (const p of pendingPhotos){
          try { photoPaths.push(await uploadPhoto(p.blob)); }
          catch (e) { console.error(e); }
        }
        if (photoPaths.length < pendingPhotos.length) toast("Certaines photos n'ont pas été envoyées");
      } else {
        photos = pendingPhotos.map(p => p.dataUrl);
      }
    }
    await addEntry({
      typeKey: form.type, montant: parseAmt($("montant").value), mode: form.mode,
      ndoc: $("ndoc").value.trim(), nom: $("nom").value.trim(), prenom: $("prenom").value.trim(),
      nchq: form.mode === "Chèque" ? $("nchq").value.trim() : "",
      banque: form.mode === "Chèque" ? $("banque").value.trim() : "",
      operateur: state.operateur, photoPaths, photos
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
function updateRemiseChqSum(){
  let sum = 0, n = 0;
  $("rm-chq-list").querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    sum += parseFloat(cb.dataset.montant) || 0; n++;
  });
  $("rm-chq-sum").textContent = money(sum) + " · " + n + " chèque" + (n > 1 ? "s" : "");
  return { sum, n };
}
function openRemise(){
  const t = computeTotals();
  $("rm-th-esp").textContent = money(t.soldeEspeces);
  $("rm-th-chq").textContent = money(t.soldeCheques);
  $("rm-esp").value = ""; $("rm-err").textContent = ""; $("rm-esp-warn").hidden = true;
  const cheques = chequesEnCaisse();
  const host = $("rm-chq-list");
  if (!cheques.length){
    host.innerHTML = '<div class="rm-empty">Aucun chèque en caisse aujourd\'hui.</div>';
  } else {
    host.innerHTML = cheques.map(rmChqRow).join("");
  }
  updateRemiseChqSum();
  $("remiseModal").hidden = false;
}
function rmChqRow(c){
  const who = (esc(c.nom || "") + (c.prenom ? (" " + esc(c.prenom)) : "")).trim();
  return '<label class="rm-chq-row"><input type="checkbox" data-seq="' + c.seq + '" data-montant="' + c.montant + '">' +
    '<span class="rm-chq-info"><b>N° ' + esc(c.nchq || "—") + "</b>" +
    (who ? (" · " + who) : "") + ' · <span class="rm-chq-amt">' + money(c.montant) + "</span></span></label>";
}
async function doRemise(){
  if (!isFondLocked()){ $("rm-err").textContent = "Valide d'abord le fond de caisse du jour."; return; }
  const esp = parseAmt($("rm-esp").value); const e = isNaN(esp) ? 0 : esp;
  const checked = [...$("rm-chq-list").querySelectorAll('input[type="checkbox"]:checked')];
  const cheques = checked.map(cb => {
    const seq = parseInt(cb.dataset.seq, 10);
    const src = state.entries.find(x => x.seq === seq);
    return { seq, montant: parseFloat(cb.dataset.montant) || 0, nchq: src ? src.nchq : "", nom: src ? src.nom : "" };
  });
  if (e <= 0 && !cheques.length){ $("rm-err").textContent = "Indique des espèces et/ou coche des chèques."; return; }
  const t = computeTotals();
  const totalChq = cheques.reduce((s, c) => s + c.montant, 0);
  let recap = "Enregistrer cette remise à la compta ?\n\n" +
    "Espèces : " + num2(e) + " €\n" +
    "Chèques : " + num2(totalChq) + " € (" + cheques.length + ")\n" +
    "Total remis : " + num2(e + totalChq) + " €";
  if (e > t.soldeEspeces + 0.005){
    recap += "\n\n⚠ Tu remets plus d'espèces que la caisse n'en contient (" + num2(t.soldeEspeces) + " €).";
  }
  if (!window.confirm(recap)) return;
  const btn = $("rm-save"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  try { await addRemise(e, cheques); $("remiseModal").hidden = true; toast("Remise enregistrée"); }
  catch (err) { console.error(err); $("rm-err").textContent = "Enregistrement impossible — vérifie la connexion."; }
  finally { btn.disabled = false; btn.textContent = label; }
}

// ───────── mise en caisse (apport d'espèces par la compta) ─────────
function openDepot(){
  const t = computeTotals();
  $("dp-th").textContent = money(t.soldeEspeces);
  $("dp-amount").value = ""; $("dp-note").value = ""; $("dp-err").textContent = "";
  $("depotModal").hidden = false;
}
async function doDepot(){
  if (!isFondLocked()){ $("dp-err").textContent = "Valide d'abord le fond de caisse du jour."; return; }
  const n = parseAmt($("dp-amount").value);
  if (isNaN(n) || n <= 0){ $("dp-err").textContent = "Indique un montant."; return; }
  const note = $("dp-note").value.trim();
  if (!window.confirm("Enregistrer une mise en caisse ?\n\nMontant reçu : " + num2(n) + " € (espèces)" + (note ? ("\nNote : " + note) : ""))) return;
  const btn = $("dp-save"), label = btn.textContent; btn.disabled = true; btn.textContent = "…";
  try {
    await addEntry({ typeKey: "depot", montant: n, mode: "Espèces", ndoc: note, nom: "", prenom: "", nchq: "", banque: "", operateur: state.operateur, photoPaths: [], photos: [] });
    $("depotModal").hidden = true; toast("Mise en caisse enregistrée");
  } catch (e) { console.error(e); $("dp-err").textContent = "Enregistrement impossible — vérifie la connexion."; }
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
  const chq = sumChqRows("ck");
  $("ck-chq-total").textContent = money(chq.total);
  $("ck-chq-nb").textContent = chq.count;
  $("ck-chq-theo").textContent = money(t.soldeCheques);
  setEcartBox($("ck-chq-ecartBox"), $("ck-chq-ecart"), chq.total - t.soldeCheques);
}
function openCheck(){
  if (!ckBuilt){
    buildDenom("ck", $("ck-denom"));
    on("ck-denom", "input", updateCheck);
    wireChqRows("ck", updateCheck);
    ckBuilt = true;
  }
  resetDenom("ck");
  resetChqRows("ck");
  updateCheck();
  $("checkModal").hidden = false;
}

// ───────── clôture ─────────
async function doCloture(){
  const esp = parseAmt($("cl-reel").value);
  if (isNaN(esp) || esp < 0){ toast("Saisis le comptage espèces"); $("cl-reel").focus(); return; }
  const chq = sumChqRows("cl");
  const compChq = chq.total, nb = chq.count;
  const t = computeTotals();
  const ecEsp = esp - t.soldeEspeces, ecChq = compChq - t.soldeCheques;
  if (!window.confirm(
    "Clôturer la journée ?\n" +
    "Espèces — théorique " + num2(t.soldeEspeces) + " · compté " + num2(esp) + " · écart " + num2(ecEsp) + "\n" +
    "Chèques — théorique " + num2(t.soldeCheques) + " · compté " + num2(compChq) + " (" + nb + ") · écart " + num2(ecChq) + "\n" +
    "La clôture est définitive.")) return;
  const btn = $("cl-save"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "Clôture…";
  try {
    await addCloture({ comptageEspeces: esp, comptageCheques: compChq, nbCheques: nb });
    resetDenom("cl"); resetChqRows("cl"); $("cl-reel").value = "";
    toast("Journée clôturée");
  }
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
    const fa = exportFacturesRows(scope); if (fa.length > 1) add(fa, "Ventes");
    const ac = exportAchatsRows(scope); if (ac.length > 1) add(ac, "Achats");
    const re = exportRemisesRows(scope); if (re.length > 1) add(re, "Remises");
    const sv = exportSuiviRows(); if (sv.length > 1) add(sv, "Suivi");
  }
  XLSX.writeFile(wb, "caisse_AJCV_" + todayKey() + ".xlsx");
}

function svCell(v, danger){ return "<td" + (danger ? ' class="sv-bad"' : "") + ">" + v + "</td>"; }

function zLine(label, val, opts){
  const cls = (opts && opts.bad) ? ' class="z-bad"' : "";
  return '<div class="z-row"' + cls + "><span>" + label + "</span><b>" + val + "</b></div>";
}
function buildZHTML(key){
  const r = dayReport(key), c = r.clot, now = new Date();
  const ecOuvBad = r.ecartOuv != null && Math.abs(r.ecartOuv) >= 0.005;
  const ecEspBad = c && Math.abs(c.ecart) >= 0.005;
  const ecChqBad = c && Math.abs(c.ecartCheque || 0) >= 0.005;
  let h = "";
  h += '<div class="z-head"><div class="z-title">AJCV — Rapport de caisse (Z)</div>' +
       '<div class="z-sub">' + esc(r.date) + "</div>" +
       '<div class="z-meta">' + (c ? ("Clôturé par " + esc(c.operateur || "—")) : "Journée non clôturée") +
       " · édité le " + frDate(now) + " " + frTime(now) + "</div></div>";
  h += '<div class="z-sec"><div class="z-sec-t">Ouverture</div>';
  h += zLine("Fond de caisse", money(r.fond));
  if (r.attendu != null) h += zLine("Attendu (clôture précédente)", money(r.attendu));
  if (r.ecartOuv != null) h += zLine("Écart d’ouverture", signMoney(r.ecartOuv), { bad: ecOuvBad });
  h += "</div>";
  h += '<div class="z-sec"><div class="z-sec-t">Mouvements du jour</div>';
  h += zLine("Ventes (factures)", money(r.ventes));
  h += '<div class="z-detail">' + zLine("· espèces", money(r.ventesEsp)) +
       zLine("· chèques", money(r.ventesChq)) + zLine("· CB", money(r.ventesCb)) + "</div>";
  if (r.depots) h += zLine("Mise en caisse (apport compta)", money(r.depots));
  if (r.achats) h += zLine("Achats payés", money(r.achats));
  if (r.sorties) h += zLine("Sorties d’espèces", money(r.sorties));
  if (r.retours) h += zLine("Retours d'argent (rentrée)", money(r.retours));
  if (r.remises) h += zLine("Remises à la compta", money(r.remises));
  h += zLine("Nombre d’opérations", String(r.nb)) + "</div>";
  h += '<div class="z-sec"><div class="z-sec-t">Espèces</div>';
  h += zLine("Théorique en caisse", money(r.theoEsp));
  if (c){ h += zLine("Compté", money(c.comptage)); h += zLine("Écart espèces", signMoney(c.ecart), { bad: ecEspBad }); }
  else h += '<div class="z-row z-muted"><span>Comptage</span><b>— non clôturé —</b></div>';
  h += "</div>";
  h += '<div class="z-sec"><div class="z-sec-t">Chèques</div>';
  h += zLine("Théorique en caisse", money(r.theoChq));
  if (c){ h += zLine("Compté (" + (c.nbCheque || 0) + ")", money(c.comptageCheque || 0)); h += zLine("Écart chèques", signMoney(c.ecartCheque || 0), { bad: ecChqBad }); }
  else h += '<div class="z-row z-muted"><span>Comptage</span><b>— non clôturé —</b></div>';
  h += "</div>";
  if (r.cbIn) h += '<div class="z-sec"><div class="z-sec-t">CB (information)</div>' + zLine("Encaissé CB", money(r.cbIn)) + "</div>";
  h += '<div class="z-sign"><div>Signature responsable</div><div class="z-sign-line"></div></div>';
  return h;
}
function openZ(key){ $("z-body").innerHTML = buildZHTML(key); $("zModal").hidden = false; }
function printZ(){ $("zPrint").innerHTML = $("z-body").innerHTML; window.print(); }

// ───────── Historique & factures (admin) ─────────
function openHist(){
  $("hi-from").value = ""; $("hi-to").value = ""; $("hi-type").value = "all"; $("hi-photo").checked = false;
  renderHist();
  $("histModal").hidden = false;
}
function renderHist(){
  const items = histFiltered();
  let inn = 0, out = 0;
  items.forEach(e => { const s = e.sens * e.montant; if (s > 0) inn += s; else out += -s; });
  $("hi-sum").textContent = items.length + " opération(s) · encaissé " + money(inn) + " · décaissé " + money(out);
  if (!items.length){ $("hi-list").innerHTML = '<div class="pm-loading">Aucune opération pour ces critères.</div>'; return; }
  $("hi-list").innerHTML = items.map(e => {
    const hasPhoto = entryHasPhoto(e); const nPhoto = entryPhotoData(e).length || entryPhotoPaths(e).length;
    const sign = e.sens > 0 ? "+" : "−";
    const who = (esc(e.nom) + " " + esc(e.prenom || "")).trim();
    const sub = [e.ndoc ? ("N° " + esc(e.ndoc)) : "", who, e.nchq ? ("chèque " + esc(e.nchq)) : ""].filter(Boolean).join(" · ");
    return '<div class="hi-item ' + TYPES[e.typeKey].cls + '">' +
      '<div class="hi-l"><div class="hi-t">#' + p3(e.seq) + " · " + TYPES[e.typeKey].label + "</div>" +
        '<div class="hi-d">' + esc(e.date) + " · " + esc(e.heure) + (sub ? (" · " + sub) : "") + "</div></div>" +
      '<div class="hi-r"><div class="hi-a">' + sign + " " + money(e.montant) + "</div>" +
        (hasPhoto ? '<button type="button" class="tk-photo" data-photo="' + e.id + '">📷 ' + (nPhoto > 1 ? ("Factures (" + nPhoto + ")") : "Facture") + '</button>' : "") +
      "</div></div>";
  }).join("");
}

// ───────── Paramètres : utilisateurs & entités (admin, via la fonction serveur) ─────────
function pmMsg(text, bad){
  const el = $("pm-msg");
  if (!text){ el.hidden = true; el.textContent = ""; el.className = "pm-msg"; return; }
  el.textContent = text; el.hidden = false; el.className = "pm-msg" + (bad ? " bad" : " ok");
}
function genPwd(){
  const cs = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const a = new Uint32Array(12); crypto.getRandomValues(a);
  let s = ""; for (let i = 0; i < 12; i++) s += cs[a[i] % cs.length];
  return s;
}
async function adminCall(action, payload){
  if (!sb) throw new Error("Disponible uniquement en ligne");
  const { data: { session } } = await sb.auth.getSession();
  const token = session && session.access_token;
  if (!token) throw new Error("Session expirée, reconnecte-toi");
  const url = CONFIG.SUPABASE_URL.replace(/\/+$/, "") + "/functions/v1/admin-users";
  const body = Object.assign({ action }, payload || {});
  if (!body.entite_id && entiteCourante) body.entite_id = entiteCourante.id;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": CONFIG.SUPABASE_ANON_KEY, "Authorization": "Bearer " + token },
    body: JSON.stringify(body)
  });
  let j = {}; try { j = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(j.error || ("Erreur " + res.status));
  return j;
}
function roleBadge(role){ return '<span class="pm-role ' + (role === "admin" ? "adm" : "cai") + '">' + (role === "admin" ? "Admin" : "Caissier") + "</span>"; }
function renderUsers(users){
  if (!users || !users.length){ $("pm-list").innerHTML = '<div class="pm-loading">Aucun utilisateur dans cette entité.</div>'; return; }
  $("pm-list").innerHTML = users.map(u => {
    const last = u.last_sign_in_at ? frDate(new Date(u.last_sign_in_at)) : "jamais";
    return '<div class="pm-u" data-id="' + u.id + '" data-email="' + esc(u.email) + '" data-role="' + u.role + '">' +
      '<div class="pm-u-top"><b>' + esc(u.display_name || u.email.split("@")[0]) + "</b>" + roleBadge(u.role) + "</div>" +
      '<div class="pm-u-mail">' + esc(u.email) + "</div>" +
      '<div class="pm-u-meta">Dernière connexion : ' + last + "</div>" +
      '<div class="pm-u-act">' +
        '<button type="button" class="pm-b" data-act="role">' + (u.role === "admin" ? "Passer caissier" : "Passer admin") + "</button>" +
        '<button type="button" class="pm-b" data-act="pwd">Mot de passe</button>' +
        '<button type="button" class="pm-b" data-act="mail">Mail reset</button>' +
        '<button type="button" class="pm-b" data-act="detach">Retirer de l\'entité</button>' +
        '<button type="button" class="pm-b danger" data-act="del">Supprimer le compte</button>' +
      "</div></div>";
  }).join("");
}
async function loadUsers(){
  $("pm-list").innerHTML = '<div class="pm-loading">Chargement…</div>';
  try { const r = await adminCall("list"); renderUsers(r.users); }
  catch (e) { $("pm-list").innerHTML = '<div class="pm-loading">Erreur : ' + esc(e.message) + "</div>"; }
}
async function openParam(){
  pmMsg("");
  $("pm-title").textContent = "Paramètres — " + (entiteCourante ? entiteCourante.nom : "utilisateurs");
  $("pm-email").value = ""; $("pm-name").value = ""; $("pm-role").value = "caissier"; $("pm-pwd").value = genPwd();
  $("pm-att-email").value = ""; $("pm-att-role").value = "caissier";
  $("pm-ent-nom").value = ""; $("pm-ent-code").value = ""; $("pm-ent-coul").value = "";
  $("paramModal").hidden = false;
  await loadUsers();
}
async function doCreateUser(){
  const email = $("pm-email").value.trim();
  const password = $("pm-pwd").value.trim();
  const display_name = $("pm-name").value.trim();
  const role = $("pm-role").value;
  if (!email || !password){ pmMsg("Email et mot de passe requis", true); return; }
  const btn = $("pm-create"), label = btn.textContent; btn.disabled = true; btn.textContent = "Création…";
  try {
    await adminCall("create", { email, password, display_name, role });
    pmMsg("Compte créé et rattaché : " + email + " · mot de passe : " + password);
    $("pm-email").value = ""; $("pm-name").value = ""; $("pm-pwd").value = genPwd();
    await loadUsers();
  } catch (e) { pmMsg(e.message, true); }
  finally { btn.disabled = false; btn.textContent = label; }
}
async function doAttach(){
  const email = $("pm-att-email").value.trim();
  const role = $("pm-att-role").value;
  if (!email){ pmMsg("Indique l'email du compte à rattacher", true); return; }
  const btn = $("pm-attach"), label = btn.textContent; btn.disabled = true; btn.textContent = "…";
  try {
    await adminCall("addMember", { email, role });
    pmMsg("Compte rattaché à " + (entiteCourante ? entiteCourante.nom : "l'entité") + " : " + email);
    $("pm-att-email").value = "";
    await loadUsers();
  } catch (e) { pmMsg(e.message, true); }
  finally { btn.disabled = false; btn.textContent = label; }
}
async function doCreateEntite(){
  const nom = $("pm-ent-nom").value.trim();
  const code = $("pm-ent-code").value.trim();
  const couleur = $("pm-ent-coul").value.trim();
  if (!nom || !code){ pmMsg("Nom et code requis pour l'entité", true); return; }
  const btn = $("pm-ent-create"), label = btn.textContent; btn.disabled = true; btn.textContent = "Création…";
  try {
    await adminCall("createEntity", { nom, code, couleur });
    pmMsg("Entité créée : " + nom + ". Tu y es admin.");
    $("pm-ent-nom").value = ""; $("pm-ent-code").value = ""; $("pm-ent-coul").value = "";
    if (currentUid){
      try {
        entites = await loadMemberships(currentUid);
        $("ent-switch").hidden = entites.length < 2;
      } catch (e) {}
    }
    toast("Bascule via « Changer d'entité » pour l'ouvrir");
  } catch (e) { pmMsg(e.message, true); }
  finally { btn.disabled = false; btn.textContent = label; }
}
async function userAction(act, card){
  const id = card.dataset.id, email = card.dataset.email, role = card.dataset.role;
  const entNom = entiteCourante ? entiteCourante.nom : "cette entité";
  try {
    if (act === "role"){
      const next = role === "admin" ? "caissier" : "admin";
      if (!window.confirm("Changer le rôle de " + email + " dans " + entNom + " en « " + next + " » ?")) return;
      await adminCall("setRole", { user_id: id, role: next });
      pmMsg("Rôle mis à jour dans " + entNom + " : " + email + " → " + next);
    } else if (act === "pwd"){
      const np = window.prompt("Nouveau mot de passe temporaire pour " + email + " :", genPwd());
      if (!np) return;
      await adminCall("setPassword", { user_id: id, password: np.trim() });
      pmMsg("Mot de passe réinitialisé pour " + email + " : " + np.trim());
    } else if (act === "mail"){
      if (!window.confirm("Envoyer un mail de réinitialisation à " + email + " ?")) return;
      await adminCall("resetEmail", { email, redirect_to: location.origin + location.pathname });
      pmMsg("Mail de réinitialisation envoyé à " + email);
    } else if (act === "detach"){
      if (!window.confirm("Retirer " + email + " de " + entNom + " ?\nIl n'aura plus accès à cette caisse (son compte et ses autres entités restent intacts).")) return;
      await adminCall("removeMember", { user_id: id });
      pmMsg("Retiré de " + entNom + " : " + email);
    } else if (act === "del"){
      if (!window.confirm("Supprimer DÉFINITIVEMENT le compte " + email + " (toutes entités) ?")) return;
      if (!window.confirm("Dernière confirmation : suppression irréversible du compte " + email + ".")) return;
      await adminCall("delete", { user_id: id });
      pmMsg("Compte supprimé : " + email);
    }
    await loadUsers();
  } catch (e) { pmMsg(e.message, true); }
}

function openSuivi(){
  const days = allDays();
  const head = "<tr>" +
    "<th>Date</th><th>Fond</th><th>Attendu</th><th>Écart ouv.</th>" +
    "<th>Ventes</th><th>Achats</th><th>Sorties</th><th>Remises</th>" +
    "<th>Compté esp.</th><th>Écart esp.</th><th>Compté chq</th><th>Écart chq</th><th>Clôture</th><th>Z</th>" +
    "</tr>";
  let body = "";
  if (!days.length){
    body = '<tr><td colspan="14" class="sv-empty">Aucune donnée pour le moment.</td></tr>';
  } else {
    days.forEach(k => {
      const s = daySummary(k), c = s.clot;
      const ecOuvBad = s.ecartOuv != null && Math.abs(s.ecartOuv) >= 0.005;
      const ecEspBad = c && Math.abs(c.ecart) >= 0.005;
      const ecChqBad = c && Math.abs(c.ecartCheque || 0) >= 0.005;
      body += "<tr>" +
        '<td class="sv-date">' + esc(s.date) + "</td>" +
        "<td>" + money(s.fond) + "</td>" +
        "<td>" + (s.attendu != null ? money(s.attendu) : "—") + "</td>" +
        svCell(s.ecartOuv != null ? money(s.ecartOuv) : "—", ecOuvBad) +
        "<td>" + money(s.ventes) + "</td>" +
        "<td>" + money(s.achats) + "</td>" +
        "<td>" + money(s.sorties) + "</td>" +
        "<td>" + money(s.remises) + "</td>" +
        "<td>" + (c ? money(c.comptage) : "—") + "</td>" +
        svCell(c ? money(c.ecart) : "—", ecEspBad) +
        "<td>" + (c ? money(c.comptageCheque || 0) : "—") + "</td>" +
        svCell(c ? money(c.ecartCheque || 0) : "—", ecChqBad) +
        "<td>" + (c ? '<span class="sv-ok">clôturé</span>'
                    : (k < todayKey()
                       ? '<span class="sv-no">non clôturé</span> <button type="button" class="sv-clbtn" data-key="' + k + '">Clôturer</button>'
                       : '<span class="sv-no">non clôturé</span>')) + "</td>" +
        '<td class="sv-z"><button type="button" class="sv-zbtn" data-key="' + k + '">Z</button></td>' +
        "</tr>";
    });
  }
  $("suivi-body").innerHTML = head + body;
  $("suiviModal").hidden = false;
}

// ───────── clôture d'une journée passée (depuis le Suivi) ─────────
let retroKey = null;
function updateRetroEcart(){
  const th = computeTotals(retroKey);
  const e = parseAmt($("rt-esp").value);
  const b1 = $("rt-ecartBox-esp");
  if (isNaN(e)){ $("rt-ecart-esp").textContent = "—"; b1.classList.remove("ok", "ko"); }
  else setEcartBox(b1, $("rt-ecart-esp"), e - th.soldeEspeces);
  const cq = parseAmt($("rt-chq").value);
  const b2 = $("rt-ecartBox-chq");
  if (isNaN(cq)){ $("rt-ecart-chq").textContent = "—"; b2.classList.remove("ok", "ko"); }
  else setEcartBox(b2, $("rt-ecart-chq"), cq - th.soldeCheques);
}
function openRetro(key){
  retroKey = key;
  const th = computeTotals(key);
  $("rt-date").textContent = frDate(new Date(key + "T00:00:00"));
  $("rt-th-esp").textContent = money(th.soldeEspeces);
  $("rt-th-chq").textContent = money(th.soldeCheques);
  $("rt-esp").value = num2(th.soldeEspeces);
  $("rt-chq").value = num2(th.soldeCheques);
  $("rt-nb").value = "";
  $("rt-err").textContent = "";
  updateRetroEcart();
  $("retroModal").hidden = false;
}
async function doRetro(){
  if (!retroKey) return;
  const esp = parseAmt($("rt-esp").value);
  if (isNaN(esp) || esp < 0){ $("rt-err").textContent = "Saisis le comptage espèces."; return; }
  const chq = parseAmt($("rt-chq").value); const compChq = isNaN(chq) ? 0 : chq;
  const nb = parseInt($("rt-nb").value, 10) || 0;
  const th = computeTotals(retroKey);
  const d = frDate(new Date(retroKey + "T00:00:00"));
  if (!window.confirm("Clôturer la journée du " + d + " ?\n" +
    "Espèces : théorique " + num2(th.soldeEspeces) + " · compté " + num2(esp) + " · écart " + num2(esp - th.soldeEspeces) + "\n" +
    "Chèques : théorique " + num2(th.soldeCheques) + " · compté " + num2(compChq) + " · écart " + num2(compChq - th.soldeCheques) + "\n" +
    "La clôture est définitive.")) return;
  const btn = $("rt-save"), label = btn.textContent; btn.disabled = true; btn.textContent = "Clôture…";
  try {
    await addCloture({ comptageEspeces: esp, comptageCheques: compChq, nbCheques: nb }, retroKey);
    $("retroModal").hidden = true; toast("Journée du " + d + " clôturée");
    openSuivi();
  } catch (e) { console.error(e); $("rt-err").textContent = "Clôture impossible (déjà clôturée ?)."; }
  finally { btn.disabled = false; btn.textContent = label; }
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
  if (sb && currentUid && !sessionEnding){
    let la = 0; try { la = parseInt(localStorage.getItem(LOGIN_KEY), 10); } catch (e) {}
    if (la && Date.now() - la >= EIGHT_H){ sessionEnding = true; endSession(); }
  }
}
async function endSession(){
  const days = unclosedDays();
  const todayOpen = state.entries.some(e => e.dateKey === todayKey()) && !getCloture(todayKey());
  if (days.length || todayOpen){
    const dates = days.map(d => frDate(new Date(d + "T00:00:00")));
    window.alert("Session de 8 h écoulée — déconnexion.\nPense à clôturer la caisse" +
      (dates.length ? (" (non clôturée : " + dates.join(", ") + ")") : "") + ".");
  }
  try { localStorage.removeItem(LOGIN_KEY); } catch (e) {}
  try { if (sb) await auth.signOut(sb); } catch (e) {}
  $("lg-info").textContent = "Déconnexion automatique après 8 h. Reconnecte-toi.";
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

// ───────── réinitialisation (admin) ─────────
async function doReset(){
  if (!isAdmin()) return;
  if (!window.confirm("Tout effacer ?\nToutes les opérations, fonds et clôtures seront définitivement supprimés.\nAction irréversible.")) return;
  const word = window.prompt("Pour confirmer, tape EFFACER en majuscules :");
  if ((word || "").trim().toUpperCase() !== "EFFACER"){ toast("Réinitialisation annulée"); return; }
  const btn = $("btn-reset"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "Effacement…";
  try {
    await resetAll();
    $("fond").value = ""; $("fond").readOnly = false;
    resetDenom("cl"); resetChqRows("cl"); $("cl-reel").value = "";
    clearForm(false);
    toast("Tout a été réinitialisé");
  } catch (e) {
    console.error(e);
    toast("Réinitialisation impossible (en ligne : la fonction SQL n'est pas encore installée)");
  } finally { btn.disabled = false; btn.textContent = label; }
}

// ───────── fond de caisse (verrou) ─────────
async function doFondLock(){
  if (isFondLocked()) return;
  const n = parseAmt($("fond").value);
  const val = isNaN(n) ? 0 : n;
  state.fonds[todayKey()] = val;
  const exp = expectedOpening();
  let msg = "Valider le fond de caisse à " + num2(val) + " € ?\nIl sera verrouillé pour la journée et ne pourra plus être modifié.";
  if (exp != null && Math.abs(val - exp) >= 0.005){
    msg = "⚠ Le fond ne correspond pas à la dernière clôture.\n\n" +
      "Attendu (clôture précédente) : " + num2(exp) + " €\n" +
      "Saisi : " + num2(val) + " €\n" +
      "Écart : " + num2(val - exp) + " €\n\n" +
      "Sans remise, un écart peut signaler une erreur ou un vol.\nValider quand même et verrouiller ?";
  }
  if (!window.confirm(msg)) return;
  const btn = $("fond-lock"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  try { await lockFond(); $("fond").value = num2(val); toast("Fond de caisse validé et verrouillé"); }
  catch (e) { console.error(e); toast("Validation impossible — réessaie"); }
  finally { btn.disabled = false; btn.textContent = label; }
}

// ───────── câblage statique ─────────
function wireUI(){
  buildDenom("cl", $("cl-denom"));
  on("cl-denom", "input", () => { $("cl-reel").value = num2(sumDenom("cl")); updateEcart(); });
  on("cl-reel", "input", updateEcart);
  resetChqRows("cl");
  wireChqRows("cl", updateEcartChq);
  on("cl-save", "click", doCloture);

  on("seg-type", "click", ev => {
    const b = ev.target.closest("button"); if (!b) return;
    form.type = b.dataset.type;
    ev.currentTarget.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    setAccent(form.type); $("err").textContent = "";
  });
  on("seg-mode", "click", ev => {
    const b = ev.target.closest("button"); if (!b) return;
    form.mode = b.dataset.mode;
    ev.currentTarget.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    toggleCheque(); $("err").textContent = "";
  });
  on("save", "click", doSave);
  on("montant", "keydown", e => { if (e.key === "Enter") doSave(); });

  on("oper", "input", function(){ prefs.setOperateur(this.value); setOperateur(this.value); });

  on("fond", "input", function(){
    if (isFondLocked()) return;
    state.fonds[todayKey()] = isNaN(parseAmt(this.value)) ? 0 : parseAmt(this.value);
    renderDash(); renderCloture();
  });
  on("fond", "blur", async function(){
    if (isFondLocked()) return;
    const n = parseAmt(this.value); this.value = isNaN(n) ? "" : num2(n);
    try { await persistFond(); } catch (e) { toast("Fond de caisse non enregistré"); }
  });
  on("fond-lock", "click", doFondLock);

  on("scope", "click", ev => {
    const b = ev.target.closest("button"); if (!b) return; scope = b.dataset.scope;
    ev.currentTarget.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    renderList();
  });
  on("filters", "click", ev => {
    const b = ev.target.closest("button"); if (!b) return; typeFilter = b.dataset.filter;
    ev.currentTarget.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    renderList();
  });

  on("exp-xlsx", "click", exportXlsx);
  on("exp-copy", "click", () => {
    const rows = exportRows(scope);
    if (rows.length < 2){ toast("Rien à copier"); return; }
    copyText(toTSV(rows.slice(1)));
  });

  // remise + vérif caisse
  on("btn-remise", "click", openRemise);
  on("btn-depot", "click", openDepot);
  on("dp-close", "click", () => { $("depotModal").hidden = true; });
  on("dp-save", "click", doDepot);
  on("rm-close", "click", () => { $("remiseModal").hidden = true; });
  on("rm-save", "click", doRemise);
  on("rm-chq-list", "change", updateRemiseChqSum);
  on("rm-esp", "input", () => {
    const v = parseAmt($("rm-esp").value); const t = computeTotals();
    const w = $("rm-esp-warn");
    if (!isNaN(v) && v > t.soldeEspeces + 0.005){ w.textContent = "⚠ Supérieur aux espèces en caisse (" + money(t.soldeEspeces) + ")"; w.hidden = false; }
    else w.hidden = true;
  });
  on("btn-check", "click", openCheck);
  on("ck-close", "click", () => { $("checkModal").hidden = true; });
  on("btn-suivi", "click", openSuivi);
  on("btn-hist", "click", openHist);
  on("hi-close", "click", () => { $("histModal").hidden = true; });
  on("ph-pdf", "click", pdfEntry);
  on("hi-pdf", "click", pdfPeriod);
  on("ent-switch", "click", openEntitePicker);
  on("ent-list", "click", ev => { const b = ev.target.closest(".ent-choice"); if (b) selectEntite(b.dataset.id, true); });
  ["hi-from", "hi-to", "hi-type", "hi-photo"].forEach(id => on(id, "change", renderHist));
  on("hi-list", "click", ev => {
    const ph = ev.target.closest(".tk-photo"); if (!ph) return;
    const e = state.entries.find(x => x.id === ph.dataset.photo); if (e) openPhotos(e);
  });
  on("sv-close", "click", () => { $("suiviModal").hidden = true; });
  on("suivi-body", "click", ev => {
    const z = ev.target.closest(".sv-zbtn"); if (z){ openZ(z.dataset.key); return; }
    const cl = ev.target.closest(".sv-clbtn"); if (cl){ openRetro(cl.dataset.key); }
  });
  on("rt-close", "click", () => { $("retroModal").hidden = true; });
  on("rt-save", "click", doRetro);
  on("rt-esp", "input", updateRetroEcart);
  on("rt-chq", "input", updateRetroEcart);
  on("z-close", "click", () => { $("zModal").hidden = true; });
  on("z-print-btn", "click", printZ);
  on("cl-done", "click", ev => { if (ev.target.closest("#cl-z")) openZ(todayKey()); });
  on("btn-param", "click", openParam);
  on("pm-close", "click", () => { $("paramModal").hidden = true; });
  on("pm-gen", "click", () => { $("pm-pwd").value = genPwd(); });
  on("pm-create", "click", doCreateUser);
  on("pm-attach", "click", doAttach);
  on("pm-ent-create", "click", doCreateEntite);
  on("pm-list", "click", ev => {
    const b = ev.target.closest(".pm-b"); if (!b) return;
    const card = b.closest(".pm-u"); if (card) userAction(b.dataset.act, card);
  });
  on("ck-done", "click", () => { $("checkModal").hidden = true; });
  on("btn-reset", "click", doReset);

  // photo du paiement
  on("photo-cam", "change", e => onPhotoPick(e.target.files));
  on("photo-file", "change", e => onPhotoPick(e.target.files));
  on("photo-strip", "click", ev => {
    const b = ev.target.closest(".photo-rm"); if (!b) return;
    pendingPhotos.splice(parseInt(b.dataset.idx, 10), 1);
    renderPhotoStrip();
  });
  on("ph-close", "click", () => { $("photoModal").hidden = true; $("ph-view").innerHTML = ""; });

  on("list", "click", async ev => {
    const ph = ev.target.closest("[data-photo]");
    if (ph){ const e = state.entries.find(x => x.id === ph.dataset.photo); if (e) openPhotos(e); return; }
    const b = ev.target.closest("[data-fix]"); if (!b) return;
    const e = state.entries.find(x => x.id === b.dataset.fix); if (!e) return;
    if (window.confirm("Contre-passer #" + p3(e.seq) + " (" + TYPES[e.typeKey].label + " " + num2(e.montant) +
        " €) ?\nUne écriture inverse sera créée. La ligne d'origine reste inchangée.")){
      try { await reversal(e.id); toast("Contre-passation créée"); }
      catch (err) { toast("Contre-passation impossible"); }
    }
  });

  // auth
  on("lg-btn", "click", doLogin);
  on("lg-pwd", "keydown", e => { if (e.key === "Enter") doLogin(); });
  on("lg-forgot", "click", doForgot);
  on("signout", "click", async () => { try { localStorage.removeItem(LOGIN_KEY); } catch (e) {} sessionEnding = false; if (sb) await auth.signOut(sb); });
  on("account", "click", () => openSetPwd("account"));
  on("sp-btn", "click", doSetPwd);
  on("sp-cancel", "click", closeSetPwd);
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

// ───────── entités : appartenances + sélection ─────────
const ENT_KEY = "ajcv_caisse_entite";
let entites = [];          // [{id, code, nom, couleur, role}]
let entiteCourante = null;

async function loadMemberships(uid){
  const { data: mb, error } = await sb.from("membres").select("entite_id, role").eq("user_id", uid);
  if (error) throw error;
  if (!mb || !mb.length) return [];
  const ids = mb.map(m => m.entite_id);
  const { data: es, error: e2 } = await sb.from("entites").select("*").in("id", ids).eq("actif", true);
  if (e2) throw e2;
  const roleById = {}; mb.forEach(m => { roleById[m.entite_id] = m.role; });
  return (es || []).map(e => ({ id: e.id, code: e.code, nom: e.nom, couleur: e.couleur || "", role: roleById[e.id] || "caissier" }))
    .sort((a, b) => a.nom.localeCompare(b.nom));
}
function renderEntitePicker(){
  $("ent-list").innerHTML = entites.map(e =>
    '<button type="button" class="ent-choice" data-id="' + e.id + '">' +
    '<span class="ent-dot" style="background:' + esc(e.couleur || "#9A7B3F") + '"></span>' +
    '<span class="ent-nm">' + esc(e.nom) + '</span>' +
    '<span class="ent-role">' + (e.role === "admin" ? "Admin" : "Caissier") + "</span></button>"
  ).join("");
}
async function selectEntite(id, remember){
  const e = entites.find(x => x.id === id); if (!e) return;
  entiteCourante = e;
  if (remember){ try { localStorage.setItem(ENT_KEY, id); } catch (err) {} }
  applyEntity(e);
  setRole(e.role);
  const rl = $("ub-role"); rl.textContent = roleLabel(e.role);
  rl.className = "role" + (e.role === "admin" ? " admin" : "");
  const { createSupabaseStore } = await import("./storage.supabase.js");
  useAdapter(createSupabaseStore(sb, e.id));
  applyRoleUI();
  try { await hydrate(); }
  catch (err) { console.error(err); banner("Connexion au journal impossible pour « " + e.nom + " »."); }
  await afterHydrate();
  $("entiteModal").hidden = true;
}
function openEntitePicker(){ renderEntitePicker(); $("entiteModal").hidden = false; }

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
  try { if (!localStorage.getItem(LOGIN_KEY)) localStorage.setItem(LOGIN_KEY, "" + Date.now()); } catch (e) {}

  const prof = await auth.getProfile(sb, session.user.id);
  setOperateur(prof.display_name || (session.user.email || "").split("@")[0]);

  $("ub-name").textContent = state.operateur;
  $("userbox").hidden = false;
  $("oper").value = state.operateur;
  $("oper").readOnly = true;

  // appartenances -> sélection d'entité
  let ms = [];
  try { ms = await loadMemberships(session.user.id); } catch (e) { console.error(e); }
  if (ms.length){
    entites = ms;
    $("ent-switch").hidden = ms.length < 2;
    let saved = null; try { saved = localStorage.getItem(ENT_KEY); } catch (e) {}
    const pre = ms.find(x => x.id === saved);
    if (ms.length === 1) await selectEntite(ms[0].id, false);
    else if (pre) await selectEntite(pre.id, false);
    else { openEntitePicker(); booted = true; return; }
  } else {
    // base pas encore migrée (SQL n°1 absent) : mono-entité, comportement historique
    setRole(prof.role);
    const rl = $("ub-role"); rl.textContent = roleLabel(prof.role);
    rl.className = "role" + (prof.role === "admin" ? " admin" : "");
    applyRoleUI();
    try { await hydrate(); }
    catch (e) { console.error(e); banner("Connexion au journal impossible. Vérifie la configuration Supabase."); }
    await afterHydrate();
  }
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
    else { try { localStorage.setItem(LOGIN_KEY, "" + Date.now()); } catch (e) {} sessionEnding = false; }
  } catch (e) {
    $("lg-err").textContent = "Connexion impossible. Réessaie.";
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

async function startSupabase(){
  // quoi qu'il arrive, l'appli devient visible (jamais d'écran vide)
  const reveal = () => { try { $("appwrap").style.visibility = "visible"; } catch (e) {} };
  const guard = setTimeout(() => { reveal(); banner("Connexion à la base lente… vérifie le réseau ou le projet Supabase (peut-être en pause)."); }, 8000);
  try {
    let createClient;
    try {
      ({ createClient } = await import("https://esm.sh/@supabase/supabase-js@2"));
    } catch (e) {
      clearTimeout(guard); reveal();
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
      Promise.resolve(handleSession(s)).catch(e => console.error(e));
    });

    if (isRecovery) openSetPwd("recovery");
    else await handleSession(await auth.getSession(sb));
  } catch (e) {
    console.error(e);
    banner("Base injoignable. Si le projet Supabase est en pause (offre gratuite), ouvre son tableau de bord et clique « Restore project », puis recharge.");
    $("login").hidden = false;
  } finally {
    clearTimeout(guard); reveal();
  }
}

// ───────── init ─────────
function applyEntity(ent){
  const name = ((ent && ent.nom) || CONFIG.ENTITY_NAME || "AJCV").trim();
  const color = ((ent && ent.couleur) || CONFIG.ENTITY_COLOR || "").trim();
  document.querySelectorAll(".ent-name").forEach(el => { el.textContent = name; });
  document.title = name + " · Caisse";
  if (color){
    document.documentElement.style.setProperty("--brass", color);
    document.documentElement.style.setProperty("--brass-soft", color + "22");
  }
}

async function init(){
  applyEntity();
  if (supabaseConfigured()) $("appwrap").style.visibility = "hidden";
  onChange(renderAll);
  wireUI();
  tick(); setInterval(tick, 1000);
  if (supabaseConfigured()) await startSupabase();
  else await startLocal();
}

init();
