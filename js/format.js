// Helpers de formatage — sans dépendance, testables isolément.

export function p2(n){ return (n < 10 ? "0" : "") + n; }
export function p3(n){ n = "" + n; while (n.length < 3) n = "0" + n; return n; }

export function todayKey(d){
  d = d || new Date();
  return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}
export function frDate(d){ return p2(d.getDate()) + "/" + p2(d.getMonth() + 1) + "/" + d.getFullYear(); }
export function frTime(d){ return p2(d.getHours()) + ":" + p2(d.getMinutes()); }

export function round2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }

// "1 234,56 €" (espace insécable comme séparateur de milliers)
export function money(n){
  const s = round2(n).toFixed(2).replace(".", ",");
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0") + "\u00A0€";
}
// "1234,56" — pour export CSV / collage Excel FR
export function num2(n){ return round2(n).toFixed(2).replace(".", ","); }

// Accepte "1 234,56", "1234.56", "1234,56 €"…
export function parseAmt(v){
  if (v == null) return NaN;
  v = ("" + v).replace(/\s/g, "").replace(/€/g, "").replace(",", ".");
  return parseFloat(v);
}

export function esc(s){
  return ("" + (s == null ? "" : s)).replace(/[&<>"]/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]
  ));
}
