// Kartenvorschau für die Abstimmung am Rundenende.
// Der Weltgenerator (world.js) braucht pro Karte gut eine halbe Sekunde. Damit der Server in dieser Zeit nicht ruckelt, läuft er hier in einem eigenen
// Thread (worker_threads). Ergebnis: ein kleines RGB-Bild (SZ x SZ Pixel, Base64) der Karte von oben: Gelände, Teich, Felder, Wege, Häuser, Gehege.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (isMainThread) {
  module.exports = function renderPreview(cfg) {                      // cfg: { PEN, PEN_R, MAP, seed } -> Promise<{ seed, w, rgb }>
    return new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: cfg });
      let done = false;
      w.once('message', m => { done = true; resolve(m); });
      w.once('error', e => { if (!done) { done = true; reject(e); } });
      w.once('exit', () => { if (!done) { done = true; reject(new Error('Vorschau-Thread beendet')); } });
    });
  };
} else {
  const { PEN, PEN_R, MAP, seed } = workerData, SZ = 96;
  const W = require('./world')({ PEN, PEN_R, MAP, seed });
  const img = Buffer.alloc(SZ * SZ * 3), cell = (2 * MAP) / SZ;
  const set = (i, j, r, g, b) => { if (i < 0 || j < 0 || i >= SZ || j >= SZ) return; const o = 3 * (j * SZ + i); img[o] = r; img[o + 1] = g; img[o + 2] = b; };
  const toI = x => Math.floor((x + MAP) / cell), toJ = z => Math.floor((z + MAP) / cell);
  for (let j = 0; j < SZ; j++) for (let i = 0; i < SZ; i++) {            // Gelände: Gras, Hänge schattiert
    const x = -MAP + (i + 0.5) * cell, z = -MAP + (j + 0.5) * cell, h = W.groundY(x, z), sl = (W.groundY(x - 4, z - 4) - W.groundY(x + 4, z + 4)) * 0.07, k = Math.max(0.6, Math.min(1.3, 0.96 + sl + h * 0.012));
    set(i, j, 108 * k, 148 * k, 76 * k);
  }
  const fillRect = (cx, cz, w, d, col) => { for (let j = toJ(cz - d / 2); j <= toJ(cz + d / 2); j++) for (let i = toI(cx - w / 2); i <= toI(cx + w / 2); i++) set(i, j, col[0], col[1], col[2]); };
  const disc = (cx, cz, r, col) => { for (let j = toJ(cz - r); j <= toJ(cz + r); j++) for (let i = toI(cx - r); i <= toI(cx + r); i++) { const x = -MAP + (i + 0.5) * cell, z = -MAP + (j + 0.5) * cell; if (Math.hypot(x - cx, z - cz) <= r) set(i, j, col[0], col[1], col[2]); } };
  for (const f of W.fields || []) fillRect(f.x, f.z, f.w, f.d, [200, 185, 90]);
  if (W.pond) disc(W.pond.x, W.pond.z, W.pond.r, [74, 134, 184]);
  for (const r of W.roads || []) { const pts = r.pts || []; for (let a = 1; a < pts.length; a++) { const [x0, z0] = pts[a - 1], [x1, z1] = pts[a], n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (cell * 0.5))); for (let s = 0; s <= n; s++) disc(x0 + (x1 - x0) * s / n, z0 + (z1 - z0) * s / n, Math.max(2.5, (r.w || 3) / 2), [205, 180, 138]); } }
  for (const p of W.plazas || []) disc(p.x, p.z, p.r, [212, 191, 151]);
  for (const t of W.trees || []) disc(t.x, t.z, 2.2, [47, 109, 51]);
  for (const h of W.houses || []) fillRect(h.x, h.z, Math.max(h.w, cell * 0.9), Math.max(h.d, cell * 0.9), h.e ? [243, 230, 200] : [180, 83, 47]);
  const TC = [[224, 82, 74], [74, 127, 224], [74, 192, 90]];
  PEN.forEach((p, t) => { const R = PEN_R; for (let j = toJ(p.z - R); j <= toJ(p.z + R); j++) for (let i = toI(p.x - R); i <= toI(p.x + R); i++) { const edge = Math.abs(i - toI(p.x - R)) < 1 || Math.abs(i - toI(p.x + R)) < 1 || Math.abs(j - toJ(p.z - R)) < 1 || Math.abs(j - toJ(p.z + R)) < 1; set(i, j, edge ? TC[t % 3][0] : (TC[t % 3][0] + 108) >> 1, edge ? TC[t % 3][1] : (TC[t % 3][1] + 148) >> 1, edge ? TC[t % 3][2] : (TC[t % 3][2] + 76) >> 1); } });
  parentPort.postMessage({ seed, w: SZ, rgb: img.toString('base64') });
}
