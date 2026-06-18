// Préférences propres à l'appareil (pas envoyées au serveur).

const KEY = "ajcv_caisse_oper";

export function getOperateur(){
  try { return window.localStorage.getItem(KEY) || ""; }
  catch (e) { return ""; }
}
export function setOperateur(v){
  try { window.localStorage.setItem(KEY, v || ""); }
  catch (e) { /* mode session : ignoré */ }
}
