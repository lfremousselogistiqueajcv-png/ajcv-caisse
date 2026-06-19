// Adaptateur de stockage : localStorage (par défaut, hors-ligne, mono-appareil).
// Interface commune avec storage.supabase.js :
//   list()                  -> { entries:[], fonds:{} }   (entrées : plus récentes d'abord)
//   create(entry)           -> entry   (assigne seq + id, persiste)
//   setFond(dateKey, val)   -> void
//   listClotures()          -> { [dateKey]: cloture }
//   createCloture(cloture)  -> cloture

const KEY = "ajcv_caisse_v3";

export function createLocalStore(){
  let data = { entries: [], fonds: {}, fondsLocked: {}, fondsMeta: {}, clotures: {}, counter: 0 };
  let mem = false;

  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw){
      const d = JSON.parse(raw);
      data.entries = d.entries || [];
      data.fonds = d.fonds || {};
      data.fondsLocked = d.fondsLocked || {};
      data.fondsMeta = d.fondsMeta || {};
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
      return {
        entries: data.entries.slice(),
        fonds: Object.assign({}, data.fonds),
        fondsLocked: Object.assign({}, data.fondsLocked),
        fondsMeta: Object.assign({}, data.fondsMeta)
      };
    },

    async create(entry){
      data.counter += 1;
      entry.seq = data.counter;
      if (!entry.id) entry.id = "e" + Date.now() + "_" + data.counter;
      data.entries.unshift(entry);
      persist();
      return entry;
    },

    async setFond(dateKey, val, lock, attendu, ecart){
      data.fonds[dateKey] = val;
      if (lock){
        data.fondsLocked[dateKey] = true;
        data.fondsMeta[dateKey] = { attendu: (attendu != null ? attendu : null), ecart: (ecart != null ? ecart : null) };
      }
      persist();
    },

    // photo en mode local : on renvoie la donnée telle quelle (data URL stockée sur l'entrée)
    async uploadPhoto(dataUrl){ return dataUrl; },
    async photoUrl(ref){ return ref; },

    async listClotures(){
      return Object.assign({}, data.clotures);
    },

    async createCloture(c){
      data.clotures[c.dateKey] = c;       // une clôture par jour
      persist();
      return c;
    },

    async reset(){
      data = { entries: [], fonds: {}, fondsLocked: {}, fondsMeta: {}, clotures: {}, counter: 0 };
      persist();
    }
  };
}
