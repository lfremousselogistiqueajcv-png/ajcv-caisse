// Adaptateur de stockage : localStorage (par défaut, hors-ligne, mono-appareil).
// Interface commune avec storage.supabase.js :
//   list()                  -> { entries:[], fonds:{} }   (entrées : plus récentes d'abord)
//   create(entry)           -> entry   (assigne seq + id, persiste)
//   setFond(dateKey, val)   -> void
//   listClotures()          -> { [dateKey]: cloture }
//   createCloture(cloture)  -> cloture

const KEY = "ajcv_caisse_v3";

export function createLocalStore(){
  let data = { entries: [], fonds: {}, clotures: {}, counter: 0 };
  let mem = false;

  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw){
      const d = JSON.parse(raw);
      data.entries = d.entries || [];
      data.fonds = d.fonds || {};
      data.clotures = d.clotures || {};
      data.counter = d.counter || data.entries.reduce((m, e) => Math.max(m, e.seq || 0), 0);
    }
  } catch (e) { mem = true; }

  function persist(){
    if (mem) return;
    try { window.localStorage.setItem(KEY, JSON.stringify(data)); }
    catch (e) { mem = true; }
  }

  return {
    kind: "local",
    isMemory(){ return mem; },

    async list(){
      return { entries: data.entries.slice(), fonds: Object.assign({}, data.fonds) };
    },

    async create(entry){
      data.counter += 1;
      entry.seq = data.counter;
      if (!entry.id) entry.id = "e" + Date.now() + "_" + data.counter;
      data.entries.unshift(entry);
      persist();
      return entry;
    },

    async setFond(dateKey, val){
      data.fonds[dateKey] = val;
      persist();
    },

    async listClotures(){
      return Object.assign({}, data.clotures);
    },

    async createCloture(c){
      data.clotures[c.dateKey] = c;       // une clôture par jour
      persist();
      return c;
    }
  };
}
