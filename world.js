'use strict';
// COW THEFT - Weltgenerator: Gelände mit Hügeln, Dorf mit Straßen, Kirche, Höfen, Feldern, Teich und Wäldern.
// Die Karte wird aus einer Zahl (seed) erzeugt: gleicher seed = gleiche Karte, anderer seed = andere Karte. Der Server würfelt bei jedem
// neuen Spiel einen neuen seed und schickt die fertige Welt beim Verbinden an jeden Client, damit Server (Schüsse, Bots) und Client
// (Laufen, Anzeige) exakt dieselbe Höhe und dieselben Hindernisse benutzen.
//
// Was bei jeder Karte gleich bleibt (damit sie immer logisch aufgebaut und fair ist):
//   - Die Gehege liegen auf ebenem Grund, Vorplatz und Tor zeigen zur Mitte; eine Dorfstraße verbindet beide Tore.
//   - Das Dorf liegt auf halbem Weg dazwischen (beide Teams gleich weit entfernt): Dorfplatz an der Kreuzung, Querstraße mit Kirche an einem Ende,
//     Häuser stehen an den Straßen mit der Tür zur Straße.
//   - Bauernhöfe (3 bis 4) liegen abseits der Straße, jeder mit eigenem Weg zur Dorfstraße, Feldern und Obstgarten.
//   - Schützengräben liegen in wechselnden Längen und Formen auf ebenem, freiem Land und sind 1,4 m in den Boden eingelassen (siehe 3b und pitDepth()).
// Was sich ändert: Lage der beiden Gehege (zufällig verteilt, mit Mindestabstand; auch welches Team auf welcher Seite liegt), Verlauf der Straßen mit
// Bögen zu den Toren, Größe und Lage des Dorfes, Kirche (Nord oder Süd), Höfen, Teich, Hügeln, Wäldern, Feldern, Häusern, Items.
// Nach dem Erzeugen prüft check(), ob man von Gehege zu Gehege, zu jedem Hof und zu jedem Item zu Fuß kommt; sonst wird neu gewürfelt.

const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

module.exports = function buildWorld(cfg) {
  const base = (cfg.seed >>> 0) || 1;
  let last = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    const seed = (base + attempt * 7919) >>> 0;
    const w = generate(cfg, seed);
    const why = check(w, cfg);
    w.seed = seed; w.attempts = attempt + 1; last = w;
    if (!why) return w;
    console.log('Karte ' + seed + ' verworfen: ' + why);
  }
  return last;   // sollte nie vorkommen
};

function generate(cfg, seed) {
  const { PEN, PEN_R, MAP } = cfg;
  const CELL = 4, HALF = 300, N = (HALF * 2) / CELL + 1;       // Höhenraster: 151 x 151 Punkte, alle 4 m
  const EDGE_H = 14;                                             // Höhe des bewaldeten Randwalls

  // ---------- Hilfsfunktionen ----------
  const R = rng(seed), pick = n => Math.floor(R() * n), rr = (a, b) => a + R() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
  const hash = (ix, iz, s) => { let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(s, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const vnoise = (x, z, s) => {
    const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const a = hash(ix, iz, s), b = hash(ix + 1, iz, s), c = hash(ix, iz + 1, s), d = hash(ix + 1, iz + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x, z, s, oct) => { let sum = 0, amp = 1, tot = 0, f = 1; for (let i = 0; i < oct; i++) { sum += amp * vnoise(x * f, z * f, s + i * 17); tot += amp; amp *= 0.5; f *= 2.03; } return sum / tot; };
  const rectGap = (a, b) => Math.hypot(Math.max(Math.abs(a.x - b.x) - a.hw - b.hw, 0), Math.max(Math.abs(a.z - b.z) - a.hd - b.hd, 0));

  // ---------- 0. Gehege würfeln (drei Teams) ----------
  // Ein Gehege liegt im Westen, zwei im Osten (eins eher nördlich, eins eher südlich); alle Tore zeigen zum Dorf in der Mitte. Je zwei Gehege haben
  // mindestens MIN_PEN_DIST Abstand. Die Hauptstraße führt vom westlichen Tor durchs Dorf zum ersten östlichen Tor, eine Abzweigung zum zweiten.
  // PEN wird hier direkt verändert (Lage, Torseite), Server und Client lesen es danach. Welches Team wo liegt, wird gewürfelt.
  const MIN_PEN_DIST = 190, MAX_PEN_DIST = 360;                                              // Mindest- und Höchstabstand je zweier Gehegemitten (m)
  let wx = -150, wz = 0, ex = 130, ez = -105, fx = 130, fz = 105;                           // Rückfall: eine klassische Lage (West / Ost 1 / Ost 2)
  for (let tries = 0; tries < 1500; tries++) {
    const a = -rr(88, 205), c = rr(-150, 150); let b = rr(110, 215), d = rr(-165, 165), b2 = rr(110, 215), d2 = rr(-165, 165);
    if (R() < 0.5) { [b, b2] = [b2, b]; [d, d2] = [d2, d]; }                                  // welches Ost-Gehege an der Hauptstraße liegt (b, d)
    const dist = (x1, z1, x2, z2) => Math.hypot(x2 - x1, z2 - z1);
    if ([dist(a, c, b, d), dist(a, c, b2, d2), dist(b, d, b2, d2)].some(v => v < MIN_PEN_DIST || v > MAX_PEN_DIST)) continue;
    if ((b - PEN_R) - (a + PEN_R) < 152 + 0.95 * Math.abs(d - c)) continue;                  // Dorf (mind. 50 m je Seite) plus Straßenbogen muss zwischen West und Ost 1 passen
    { const g0 = a + PEN_R, g1 = b - PEN_R, h = clamp((g1 - g0) / 2 - (0.95 * Math.abs(d - c) / 2 + 14) - 12, 50, 84);
      if ((b2 - PEN_R) - ((g0 + g1) / 2 + 12 + h + 10) < 45) continue; }                      // Abzweigung: zwischen Dorfende und Tor von Ost 2 müssen mindestens 45 m Platz sein
    wx = a; wz = c; ex = b; ez = d; fx = b2; fz = d2; break;
  }
  const slots = [[wx, wz, 1], [ex, ez, -1], [fx, fz, -1]];                                  // Lage und Torseite (+1 = Tor zeigt nach +x)
  const perm = [0, 1, 2]; for (let i = 2; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }   // perm[Team] = Lage
  PEN.forEach((p, t) => { const sl = slots[perm[t]]; p.x = sl[0]; p.z = sl[1]; p.s = sl[2]; });
  const teamAt = [perm.indexOf(0), perm.indexOf(1), perm.indexOf(2)];                       // Team an West / Ost 1 / Ost 2
  const gxW = wx + PEN_R, gxE = ex - PEN_R, gx2 = fx - PEN_R, dzg = ez - wz, mzg = (wz + ez) / 2, mxg = (gxW + gxE) / 2;   // Tore West/Ost 1/Ost 2, Höhenunterschied, Mitte
  const swing = 0.95 * Math.abs(dzg) / 2 + 14, hv = clamp((gxE - gxW) / 2 - swing - 12, 50, 84);       // Länge des Straßenbogens je Seite, halbe Länge des geraden Dorfstücks
  const minPenDist = Math.round(Math.min(Math.hypot(ex - wx, ez - wz), Math.hypot(fx - wx, fz - wz), Math.hypot(fx - ex, fz - ez)));

  // ---------- 1. Straßen (nur Lage, noch ohne Höhe) ----------
  const L = {
    vx: mxg + rr(-12, 12),                                              // Dorfmitte (x): Kreuzung von Dorfstraße und Querstraße
    S: R() < 0.5 ? -1 : 1,                                        // Kirche am Nordende (-1) oder am Südende (+1) der Querstraße
    cd: rr(31, 38),                                               // Abstand Kirchplatz - Dorfplatz
    a1: rr(2.6, 5.4), p1: rr(26, 40), ph1: rr(0, 6.28), a2: rr(1, 2.8), p2: rr(11, 17), ph2: rr(0, 6.28),   // Windungen der Dorfstraße
    ca: rr(1.5, 4), cp: rr(20, 32), len: rr(64, 82), cw: rr(4.6, 5.6)                                    // Querstraße: Schwung, Länge, Breite
  };
  const xl = L.vx - hv, xh = L.vx + hv;                                                       // gerades Dorfstück zwischen xl und xh, davor und dahinter der Bogen zu den Toren
  const baseZ = x => x <= xl ? wz + (mzg - wz) * sstep(gxW + 8, xl, x) : x >= xh ? mzg + (ez - mzg) * sstep(xh, gxE - 8, x) : mzg;
  const taper = x => Math.min(sstep(gxW + 8, gxW + 45, x), 1 - sstep(gxE - 45, gxE - 8, x));
  const roadZ = x => baseZ(x) + taper(x) * (L.a1 * Math.sin(x / L.p1 + L.ph1) + L.a2 * Math.sin(x / L.p2 + L.ph2));   // Dorfstraße von Tor zu Tor, schlängelt sich leicht; an den Toren auf Höhe des Tores
  const roads = [], plazas = [];
  const addRoad = (w, pts) => roads.push({ w, pts: pts.map(([x, z]) => [r1(x), r1(z)]) });
  const gx0 = gxW, gx1 = gxE;                                                             // Torseiten des westlichen und östlichen Geheges
  { const pts = [], n = Math.ceil((gx1 - gx0) / 6); for (let i = 0; i <= n; i++) { const x = gx0 + (gx1 - gx0) * i / n; pts.push([x, roadZ(x)]); } addRoad(6, pts); }
  const pzc = roadZ(L.vx), S = L.S, zc = pzc + S * L.cd, clen = Math.min(L.len, (MAP - 40) + S * pzc);                                  // Dorfplatz-Mitte (z), Kirchplatz-Mitte (z)
  const xr = z => L.vx + L.ca * Math.sin((z - pzc) / L.cp);                               // Querstraße: x in Abhängigkeit von z (geht durch die Dorfmitte)
  { const pts = [], z0 = zc + S * 3, z1 = pzc - S * clen, n = Math.ceil(Math.abs(z1 - z0) / 6); for (let i = 0; i <= n; i++) { const z = z0 + (z1 - z0) * i / n; pts.push([xr(z), z]); } addRoad(r1(L.cw), pts); }
  plazas.push({ x: r1(L.vx), z: r1(pzc), r: r1(rr(10.5, 13)), k: 0 });                    // Dorfplatz
  plazas.push({ x: r1(xr(zc)), z: r1(zc), r: 7.5, k: 1 });                                // Kirchvorplatz
  // Abzweigung zum zweiten Ost-Gehege: beginnt kurz hinter dem Dorfstück an der Hauptstraße und biegt weich zum Tor ab
  const xj = L.vx + hv + 10, zj = roadZ(xj), spurPh = rr(0, 6.28);
  const spurZ = x => zj + (fz - zj) * sstep(xj + 4, gx2 - 10, x) + 2.4 * Math.sin(x / 15 + spurPh) * sstep(xj, xj + 30, x) * (1 - sstep(gx2 - 40, gx2 - 8, x));
  const spur = []; { const n = Math.ceil((gx2 - xj) / 6); for (let i = 0; i <= n; i++) { const x = xj + (gx2 - xj) * i / n; spur.push([x, spurZ(x)]); } addRoad(6, spur); }
  const roadsMain = [roads[0], roads[roads.length - 1]];                                    // Hauptstraße und Abzweigung (für Abstandsprüfungen)
  plazas.push({ x: gx0 + 6, z: wz, r: 7, k: 2 }, { x: gx1 - 6, z: ez, r: 7, k: 2 }, { x: gx2 - 6, z: fz, r: 7, k: 2 });        // Vorplätze vor den Gehegetoren

  // ---------- 2. Höfe, Kirche, Häuser (Lage) ----------
  const houses = [], props = [], trees = [], fields = [], occ = [], fieldWish = [], orchards = [];
  const PROP = {                                                                           // Kind: [Höhe, blockiert Bewegung, blockiert Schüsse]
    fence: [1.1, 1, 0], hay: [1.5, 1, 1], stack: [3.4, 1, 1], well: [3.0, 1, 1], silo: [10.5, 1, 1], wood: [1.2, 1, 1],
    wagon: [1.3, 1, 1], trough: [0.7, 1, 1], bench: [0.9, 0, 0], lamp: [4.2, 0, 0], sign: [2.4, 0, 0],
    trench: [1.4, 1, 0]                                                // Schützengraben: Wallstücke (1,5 m hoch) und Laufbretter am Boden des Ganges
  };
  const addOcc = (x, z, hw, hd) => occ.push({ x, z, hw, hd });
  PEN.forEach(p => addOcc(p.x, p.z, 34, 40));                                              // Gehege samt Vorplatz bleiben frei von Bauten und Bäumen
  const addProp = (k, x, z, w, d) => { props.push({ k, x: r2(x), z: r2(z), w: r2(w), d: r2(d), h: PROP[k][0], s: PROP[k][1] }); };
  function house(x, z, w, d, h, f, k) {
    const b = { x: r2(x), z: r2(z), w: r2(w), d: r2(d), h: r2(h), f, k, c: pick(6), rc: pick(4), sh: pick(4) };
    houses.push(b); addOcc(b.x, b.z, b.w / 2, b.d / 2); return b;
  }

  // Bauernhöfe. Lokale Koordinaten: der Hof liegt um (0,0), die Front/Einfahrt zeigt nach +z. o = Drehung (0..3), fl = gespiegelt.
  const ROTF = [[0, 1, 2, 3], [2, 3, 1, 0], [1, 0, 3, 2], [3, 2, 0, 1]];                  // Türseite lokal -> Welt (0 +z, 1 -z, 2 +x, 3 -x)
  const rot = (o, lx, lz) => o === 0 ? [lx, lz] : o === 1 ? [lz, -lx] : o === 2 ? [-lx, -lz] : [-lz, lx];
  const FARMS = [];                                                                        // je ein Hof pro Viertel (einer kann fehlen), Einfahrt zeigt zur Dorfstraße
  { let skipped = 0;
    for (const [fx, fz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (!skipped && R() < 0.18) { skipped = 1; continue; }
      for (let tr = 0; tr < 28; tr++) {                                                    // Platz suchen: weg von Gehegen, Hauptstraße und Kartenrand
        const x = L.vx + fx * rr(62, 96), z = roadZ(x) + fz * rr(78, 100), g = { x, z, hw: 33, hd: 23 };
        if (Math.abs(x) + 33 > MAP - 14 || Math.abs(z) + 23 > MAP - 14) continue;
        if (occ.some(o => rectGap(g, o) < 8)) continue;
        if (roadsMain.some(r => r.pts.some(([px, pz]) => Math.hypot(Math.max(Math.abs(px - g.x) - g.hw, 0), Math.max(Math.abs(pz - g.z) - g.hd, 0)) < 12))) continue;
        FARMS.push({ x, z, o: fz < 0 ? 0 : 2, fl: R() < 0.5 ? 1 : 0, fz }); break;
      }
    } }
  const farmInfo = [];
  for (const F of FARMS) {
    const sx = F.fl ? -1 : 1, odd = F.o % 2 === 1;
    const W = (lx, lz) => { const [a, b] = rot(F.o, lx * sx, lz); return [F.x + a, F.z + b]; };
    const FD = f => { if (F.fl && f >= 2) f = f === 2 ? 3 : 2; return ROTF[F.o][f]; };
    const dims = (w, d) => odd ? [d, w] : [w, d];
    const bld = (lx, lz, w, d, h, f, k) => { const [x, z] = W(lx, lz), [ww, dd] = dims(w, d); return house(x, z, ww, dd, h, FD(f), k); };
    const prop = (k, lx, lz, w, d) => { const [x, z] = W(lx, lz), [ww, dd] = dims(w, d); addProp(k, x, z, ww, dd); };
    bld(-14, -8, 11 + rr(-0.8, 1), 9 + rr(-0.5, 0.8), 5.4, 0, 0);          // Wohnhaus
    bld(14, -10, 16 + rr(-1, 1.2), 11 + rr(-0.6, 0.8), 5.5, 0, 1);         // Scheune
    if (R() < 0.85) bld(0, -12.5, 5, 4, 2.7, 0, 4);                        // Schuppen
    prop('well', 0, 5, 2.6, 2.6);
    if (R() < 0.75) prop('wagon', -11, 7.5, 3.4, 1.7);
    if (R() < 0.8) prop('trough', 7, 11, 2.4, 0.8);
    if (R() < 0.85) prop('hay', 22, 5, 1.6, 1.5);
    if (R() < 0.85) prop('hay', 24.5, 5.6, 1.6, 1.5);
    if (R() < 0.7) prop('hay', 23.2, 8, 1.5, 1.6);
    if (R() < 0.8) prop('stack', 25, -1.5, 4.2, 4.2);
    if (R() < 0.7) prop('silo', 26, -9.5, 4.8, 4.8);
    if (R() < 0.8) prop('wood', -21.3, -8, 1.1, 3);
    // Zaun um den Hof: Einfahrt vorn (8 m breit) und Lücke an der Seite
    const gap = (lx, lz) => (lz > 17 && Math.abs(lx) < 4.5) || (lx > 29 && lz > -4 && lz < 3.5);
    for (const [ax, az, bx, bz] of [[-30, -20, 30, -20], [30, -20, 30, 18], [30, 18, -30, 18], [-30, 18, -30, -20]]) {
      const L = Math.hypot(bx - ax, bz - az), n = Math.ceil(L / 3), seg = L / n, horiz = az === bz;
      for (let i = 0; i < n; i++) { const t = (i + 0.5) / n, lx = ax + (bx - ax) * t, lz = az + (bz - az) * t; if (gap(lx, lz)) continue; const [ex, ez] = horiz ? [seg, 0.16] : [0.16, seg]; prop('fence', lx, lz, ex, ez); }
    }
    const [cx, cz] = W(0, -1), [yw, yd] = dims(62, 42);
    addOcc(cx, cz, yw / 2, yd / 2);                                                         // Hofgelände: nichts anderes darf hineinragen
    // Weg vom Hoftor zur Dorfstraße
    const [gx, gz] = W(0, 19), tx = clamp(F.x + (F.fl ? -6 : 6), gxW + 30, gxE - 30), tz = roadZ(tx) + (F.fz < 0 ? -3.4 : 3.4), lane = [];
    for (let i = 0; i <= 10; i++) { const t = i / 10; lane.push([gx + (tx - gx) * t + 4 * Math.sin(t * Math.PI) * (F.fl ? -1 : 1), gz + (tz - gz) * t]); }
    addRoad(3.6, lane);
    // Obstgarten neben dem Hof, Feld hinter dem Hof
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) { const [x, z] = W(-40 - a * 6.5, -14 + b * 7); orchards.push({ x, z }); }
    { const [x, z] = W(0, -41), [fw, fd] = dims(56, 28); fieldWish.push({ x, z, w: fw, d: fd, k: F.fl ? 1 : 0, rt: odd ? 0 : 1 }); }
    { const [x, z] = W(-50, -42), [fw, fd] = dims(30, 26); fieldWish.push({ x, z, w: fw, d: fd, k: F.fl ? 2 : 1, rt: odd ? 1 : 0 }); }
    farmInfo.push({ x: F.x, z: F.z, o: F.o, fl: F.fl, gate: [r1(gx), r1(gz)], cx, cz, yw, yd });
  }

  // Straßenpunkte (alle 1,5 m) für Abstandsprüfungen
  const samples = [];
  for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) {
    const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 1.5));
    for (let j = 0; j <= n; j++) samples.push({ x: ax + (bx - ax) * j / n, z: az + (bz - az) * j / n, hw: r.w / 2 });
  }
  for (const p of plazas) samples.push({ x: p.x, z: p.z, hw: p.r });
  const roadEdge = (x, z) => { let m = 1e9; for (const s of samples) { const d = Math.hypot(x - s.x, z - s.z) - s.hw; if (d < m) m = d; } return m; };
  const boxEdge = b => { let m = 1e9; for (const s of samples) { const d = Math.hypot(Math.max(Math.abs(s.x - b.x) - b.hw, 0), Math.max(Math.abs(s.z - b.z) - b.hd, 0)) - s.hw; if (d < m) m = d; } return m; };

  // Kirche am Ende der Querstraße (Nord oder Süd): Kirchenschiff + Turm, die Tür zeigt zum Kirchplatz
  const churchX = xr(zc);
  { const fdir = S < 0 ? 0 : 1, nz = pzc + S * (L.cd + 19);
    const nave = house(churchX, nz, 9, 17, 7.5, fdir, 2); nave.c = 0; nave.rc = 2;
    const tw = house(churchX, nz - S * (8.5 + 2.8), 5.6, 5.6, 15, fdir, 3); tw.c = 5; tw.rc = 2;
    addOcc(churchX, nz - S * 4, 10, 17); }

  // Teich: zufälliger Platz mit Abstand zu Straßen, Höfen und Kirche (je größer der freie Abstand, desto besser)
  let pond = null;
  { let best = null;
    for (let i = 0; i < 600 && !pond; i++) {
      const pr = rr(7.2, 10), a = R() * 6.283, d = rr(28, 150), x = L.vx + Math.cos(a) * d, z = pzc + Math.sin(a) * d * 0.85;
      if (Math.abs(x) > MAP - 45 || Math.abs(z) > MAP - 45) continue;
      const g = { x, z, hw: pr + 9, hd: pr + 9 };
      const gapOcc = occ.reduce((m, o) => Math.min(m, rectGap(g, o)), 1e9), re = roadEdge(x, z) - (pr + 9), sc = Math.min(gapOcc, re);
      if (!best || sc > best.sc) best = { x, z, r: pr, sc };
      if (gapOcc >= 2 && re >= 3) pond = { x: r1(x), z: r1(z), r: r1(pr) };
    }
    if (!pond) pond = { x: r1(best.x), z: r1(best.z), r: r1(best.r) };
    addOcc(pond.x, pond.z, pond.r + 7, pond.r + 7); }

  // Häuser entlang der Straßen (die Tür zeigt zur Straße, die Giebelrichtung folgt der längeren Seite)
  function tryHouse(x, z, w, d, h, f, k) {
    const g = { x, z, hw: w / 2, hd: d / 2 };
    if (Math.abs(x) > MAP - 24 || Math.abs(z) > MAP - 24) return null;
    if (occ.some(o => rectGap(g, o) < 2.4)) return null;
    if (boxEdge(g) < 2.0) return null;
    return house(x, z, w, d, h, f, k);
  }
  for (const s of [-1, 1]) {                                                               // Dorfstraße: Nord- und Südseite
    let x = xl + R() * 3, guard = 0;
    while (x < xh && guard++ < 300) {
      const k = R() < 0.13 ? 1 : 0;
      const w = k ? 12 + R() * 3 : 7.6 + R() * 3.4, d = k ? 8.5 + R() * 2 : 6.8 + R() * 2.2, h = k ? 5 : [4, 5.2, 5.6][pick(3)];
      const cx = x + w / 2, zc = roadZ(cx) + s * (3 + 3.4 + R() * 3.2 + d / 2), f = s < 0 ? 0 : 1;
      const b = tryHouse(cx, zc, w, d, h, f, k);
      if (!b) { x += 3; continue; }
      x += w + 2.5 + R() * 4.5;
      if (R() < 0.45) { const sw = 4.5 + R() * 1.5, sd = 3.5 + R(); tryHouse(cx + (R() - 0.5) * (w - sw), zc + s * (d / 2 + 2.4 + sd / 2), sw, sd, 2.7, f, 4); }   // Schuppen hinter dem Haus
    }
  }
  const segs = S < 0 ? [[pzc - L.cd + 2, pzc - 16], [pzc + 17, pzc + clen - 8]] : [[pzc + 16, pzc + L.cd - 2], [pzc - clen + 8, pzc - 17]];   // Querstraße: Kirchseite und andere Seite der Dorfstraße
  for (const s of [-1, 1]) for (const [z0, z1] of segs) {                                  // West- und Ostseite
    let z = z0 + R() * 2, guard = 0;
    while (z < z1 && guard++ < 300) {
      const w = 6.8 + R() * 2.4, d = 7.6 + R() * 3, h = [4, 5.2, 5.6][pick(3)], cz = z + d / 2, xc = xr(cz) + s * (L.cw / 2 + 2.5 + R() * 3 + w / 2), f = s < 0 ? 2 : 3;
      const b = tryHouse(xc, cz, w, d, h, f, 0);
      if (!b) { z += 3; continue; }
      z += d + 2.5 + R() * 4;
      if (R() < 0.4) { const sw = 3.5 + R(), sd = 4.5 + R() * 1.5; tryHouse(xc + s * (w / 2 + 2.4 + sw / 2), cz + (R() - 0.5) * (d - sd), sw, sd, 2.7, f, 4); }
    }
  }

  // Dorfplatz: Brunnen, Bänke, Laternen
  const vx = L.vx;
  addProp('well', vx, pzc, 2.6, 2.6);
  addProp('bench', vx, pzc - 6.5, 2.2, 0.7); addProp('bench', vx, pzc + 6.5, 2.2, 0.7); addProp('bench', vx - 6.5, pzc, 0.7, 2.2); addProp('bench', vx + 6.5, pzc, 0.7, 2.2);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) addProp('lamp', vx + sx * 9, pzc + sz * 9, 0.3, 0.3);
  addProp('lamp', churchX - 4.5, zc - S * 3, 0.3, 0.3); addProp('lamp', churchX + 4.5, zc - S * 3, 0.3, 0.3);   // am Kirchvorplatz
  addProp('sign', gx0 + 3, wz + 4.6, 0.3, 0.3); addProp('sign', gx1 - 3, ez - 4.6, 0.3, 0.3); addProp('sign', gx2 - 3, fz - 4.6, 0.3, 0.3);        // Wegweiser an den Toren
  // Holzstapel, Heuballen, Karren und Tröge an Wohnhäusern und Scheunen im Dorf
  const propClear = (x, z, hw, hd, m = 1.4) => !occ.some(o => rectGap({ x, z, hw, hd }, o) < m) && !props.some(p => PROP[p.k][1] && rectGap({ x, z, hw, hd }, { x: p.x, z: p.z, hw: p.w / 2, hd: p.d / 2 }) < m) && boxEdge({ x, z, hw, hd }) > 1.5;
  // ---------- 2b. Zwischenland: Weiler, Gehöfte und Zaunreihen zwischen je zwei Gehegen ----------
  // Zwischen zwei Gehegen soll kein leeres Flachland liegen: auf der Verbindungslinie (und etwas daneben) entstehen je drei Stationen
  // (kleiner Weiler mit Häusern und Brunnen, einzelnes Gehöft mit Scheune oder Zaunreihe mit Heuballen) als Deckung und Hindernisse.
  const stations = [];                                                                      // fertige Stationen (zum Zählen und Testen)
  const hdoor = (ox, oz) => Math.abs(oz) > Math.abs(ox) ? (oz > 0 ? 1 : 0) : (ox > 0 ? 3 : 2);   // Tür zeigt zur Mitte (0: +z, 1: -z, 2: +x, 3: -x)
  const hamlet = (cx, cz) => {
    const offs = [[-15, -11], [15, -11], [-15, 11], [15, 11], [0, -19], [0, 19], [-24, 0], [24, 0]];
    for (let i = offs.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [offs[i], offs[j]] = [offs[j], offs[i]]; }
    let n = 0; const want = 3 + (R() < 0.5 ? 1 : 0);
    for (const [ox, oz] of offs) {
      if (n >= want) break;
      const w = 7.4 + R() * 3, d = 6.6 + R() * 2.2, h = [4, 5.2, 5.6][pick(3)], x = cx + ox + rr(-2.5, 2.5), z = cz + oz + rr(-2.5, 2.5);
      if (tryHouse(x, z, w, d, h, hdoor(ox, oz), 0)) { n++; if (R() < 0.4) tryHouse(x + (ox < 0 ? -1 : 1) * (w / 2 + 3.5), z + rr(-2, 2), 4.5 + R(), 3.8, 2.7, hdoor(ox, oz), 4); }
    }
    if (n >= 2) { if (propClear(cx, cz, 1.3, 1.3)) addProp('well', cx, cz, 2.6, 2.6); return n; }
    return 0;
  };
  const barnyard = (cx, cz) => {
    const bw = 15 + R() * 2.5, bd = 10 + R() * 2, f = pick(4);
    if (!tryHouse(cx, cz, bw, bd, 5.5, f, 1)) return 0;
    let n = 1;
    if (tryHouse(cx + (R() < 0.5 ? -1 : 1) * (bw / 2 + 10), cz + rr(-6, 6), 8.4 + R() * 2, 7 + R() * 1.5, 5.2, f === 0 || f === 1 ? 3 : 0, 0)) n++;
    for (let i = 0; i < 4; i++) {
      const kind = ['hay', 'hay', 'wagon', 'wood'][pick(4)], sz = kind === 'wood' ? [2.8, 1.1] : kind === 'wagon' ? [3.4, 1.7] : [1.6, 1.5], a = R() * 6.283, d = rr(11, 16);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d * 0.8;
      if (propClear(x, z, sz[0] / 2, sz[1] / 2)) addProp(kind, x, z, sz[0], sz[1]);
    }
    return n;
  };
  const fenceRow = (cx, cz) => {
    const alongX = R() < 0.5, segs = 7, step = 4.2; let n = 0;
    const gaps = new Set([pick(segs), pick(segs)]);                                         // zwei Lücken zum Durchlaufen
    for (let i = 0; i < segs; i++) {
      if (gaps.has(i)) continue;
      const o = (i - (segs - 1) / 2) * step, x = cx + (alongX ? o : 0), z = cz + (alongX ? 0 : o), w = alongX ? 3.6 : 0.16, d = alongX ? 0.16 : 3.6;
      if (propClear(x, z, w / 2, d / 2, 0.6)) { addProp('fence', x, z, w, d); n++; }
    }
    for (let i = 0; i < 4; i++) {                                                           // Heuballen und Holz an der Reihe: Deckung
      const kind = R() < 0.6 ? 'hay' : 'wood', sz = kind === 'wood' ? [2.8, 1.1] : [1.6, 1.5], o = rr(-13, 13), side = (R() < 0.5 ? -1 : 1) * rr(2.5, 4.5);
      const x = cx + (alongX ? o : side), z = cz + (alongX ? side : o);
      if (propClear(x, z, sz[0] / 2, sz[1] / 2)) { addProp(kind, x, z, sz[0], sz[1]); n++; }
    }
    return n >= 6 ? n : 0;
  };
  for (let a = 0; a < PEN.length; a++) for (let b = a + 1; b < PEN.length; b++) {
    const P = PEN[a], Q = PEN[b], dx = Q.x - P.x, dz = Q.z - P.z, len = Math.hypot(dx, dz), px = -dz / len, pz = dx / len;   // Verbindungslinie und Querrichtung
    const kinds = ['hamlet', R() < 0.5 ? 'barn' : 'hamlet', 'fence']; for (let i = 2; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
    [0.36, 0.5, 0.64].forEach((t0, si) => {
      for (let tr = 0; tr < 24; tr++) {
        const t = t0 + rr(-0.07, 0.07), off = rr(-26, 26), cx = P.x + dx * t + px * off, cz = P.z + dz * t + pz * off;
        if (Math.abs(cx) > MAP - 50 || Math.abs(cz) > MAP - 45) continue;
        if (PEN.some(p => Math.hypot(cx - p.x, cz - p.z) < 62) || Math.hypot(cx - L.vx, cz - pzc) < 78) continue;    // nicht vor einem Gehege und nicht im Dorf
        if (Math.hypot(cx - pond.x, cz - pond.z) < pond.r + 30 || roadEdge(cx, cz) < 10) continue;
        if (occ.some(o => rectGap({ x: cx, z: cz, hw: 16, hd: 16 }, o) < 3)) continue;                              // Platz für die ganze Station
        const n = kinds[si] === 'hamlet' ? hamlet(cx, cz) : kinds[si] === 'barn' ? barnyard(cx, cz) : fenceRow(cx, cz);
        if (n) { stations.push({ k: kinds[si], x: r1(cx), z: r1(cz), pair: [a, b], n }); addOcc(cx, cz, 14, 14); break; }
      }
    });
  }

  for (const h of houses.slice()) {
    if (h.k === 2 || h.k === 3 || h.k === 4 || R() > 0.5) continue;
    const back = { 0: [0, -1], 1: [0, 1], 2: [-1, 0], 3: [1, 0] }[h.f];                    // Rückseite = gegenüber der Tür
    const along = back[0] === 0 ? [1, 0] : [0, 1], off = (R() - 0.5) * 3;
    const dist = (back[0] === 0 ? h.d : h.w) / 2 + 1.2;
    const bx = h.x + back[0] * dist + along[0] * off, bz = h.z + back[1] * dist + along[1] * off;
    const kind = h.k === 1 ? (R() < 0.5 ? 'hay' : 'wagon') : (R() < 0.6 ? 'wood' : 'trough');
    const sz = kind === 'wood' ? [2.8, 1.1] : kind === 'wagon' ? [3.4, 1.7] : kind === 'hay' ? [1.6, 1.5] : [2.4, 0.8];
    const [pw, pd] = back[0] === 0 ? sz : [sz[1], sz[0]];
    if (propClear(bx, bz, pw / 2, pd / 2)) addProp(kind, bx, bz, pw, pd);
  }

  // ---------- 3. Gelände ----------
  const HILLS = [];                                                                         // 9 bis 12 Hügel ringsum, nicht auf den Gehegen und nicht zu dicht beieinander
  for (let i = 0, tries = 0, want = 9 + pick(4); i < want && tries++ < 400;) {
    const a = R() * 6.283, d = rr(95, 255), hx = Math.cos(a) * d, hz = Math.sin(a) * d;
    if (Math.abs(hx) > 250 || Math.abs(hz) > 250) continue;
    if (PEN.some(p => Math.hypot(hx - p.x, hz - p.z) < 70) || Math.hypot(hx - L.vx, hz - pzc) < 80 || HILLS.some(h => Math.hypot(hx - h[0], hz - h[1]) < 55)) continue;
    HILLS.push([hx, hz, rr(6, 11), rr(28, 42)]); i++;
  }
  const NS1 = 11 + (seed % 9973), NS2 = 23 + ((seed >>> 4) % 9973), NO = rr(0, 60), NA = rr(0.8, 1.25);   // Rauschmuster und Stärke der sanften Wellen
  const core = (x, z) => 1 - sstep(55, 100, Math.hypot((x - L.vx) * 0.75, z - pzc));                      // im Dorf sanfteres Land
  const raw = (x, z) => {
    let h = (fbm(x / 120 + 3.1 + NO, z / 120 + 7.7 + NO, NS1, 3) - 0.5) * 2 * 9 * NA + (fbm(x / 38 + 40, z / 38 + 9, NS2, 2) - 0.5) * 2 * 1.6;
    for (const [hx, hz, hh, hr] of HILLS) { const dx = x - hx, dz = z - hz; h += 0.75 * hh * Math.exp(-(dx * dx + dz * dz) / (2 * hr * hr)); }
    const re = Math.max(0, roadEdge(x, z));
    return h * (1 - 0.5 * core(x, z)) * (1 - 0.45 * (1 - sstep(3, 18, re)));               // Straßen liegen ruhiger im Gelände
  };
  const pads = [];                                                                          // eingeebnete Flächen (Gehege, Plätze, Höfe, Häuser)
  const padW = (p, x, z) => {
    const d = p.t === 0 ? Math.hypot(Math.max(Math.abs(x - p.x) - p.hw, 0), Math.max(Math.abs(z - p.z) - p.hd, 0)) : Math.max(Math.hypot(x - p.x, z - p.z) - p.r, 0);
    return d >= p.bl ? 0 : 1 - sstep(0, p.bl, d);
  };
  const H = (x, z, n = pads.length) => { let h = raw(x, z); for (let i = 0; i < n; i++) { const w = padW(pads[i], x, z); if (w > 0) h += (pads[i].tg - h) * w; } return h; };
  const addPad = (t, x, z, a, b, bl, tg) => pads.push({ t, x, z, hw: a, hd: b, r: a, bl, tg: tg === undefined ? H(x, z) : tg });
  PEN.forEach(p => addPad(0, p.x, p.z, PEN_R + 4, PEN_R + 4, 26, 0));                      // Gehege liegen eben auf Höhe 0
  for (const p of plazas) addPad(1, p.x, p.z, p.r, 0, 12, p.k === 2 ? 0 : undefined);   // Vorplätze der Gehege liegen auf Höhe 0
  for (const f of farmInfo) addPad(0, f.cx, f.cz, f.yw / 2 + 2, f.yd / 2 + 2, 26);
  for (const h of houses) addPad(0, h.x, h.z, h.w / 2 + 1.5, h.d / 2 + 1.5, 6);
  addPad(1, pond.x, pond.z, 14, 0, 18);
  pond.level = r2(pads[pads.length - 1].tg - 1.0);                                          // Wasserspiegel
  const pondDig = (x, z) => 2.6 * (1 - sstep(0, 14, Math.hypot(x - pond.x, z - pond.z)));
  const finalH = (x, z) => {
    let h = H(x, z) - pondDig(x, z);
    const k = sstep(250, 300, Math.max(Math.abs(x), Math.abs(z)));                         // bewaldeter Randwall
    return h + (EDGE_H - h) * k;
  };
  const pitSys = [];                                                                         // Schützengräben (siehe 3b): Zellraster mit Stufen 0..4, Tiefe = Stufe * 0,35 m
  const G = new Int16Array(N * N);
  let hmax = -1e9;
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const v = Math.round(finalH(-HALF + ix * CELL, -HALF + iz * CELL) * 100);
    G[iz * N + ix] = v; if (v > hmax) hmax = v;
  }
  hmax /= 100;
  // Höhe an einer Stelle: Dreiecke wie im Client (Diagonale von (ix+1,iz) nach (ix,iz+1))
  // Tiefe eines Grabens an einer Stelle (0 außerhalb): Zellraster jedes Grabens, Stufe 0..4 mal 0,35 m
  function pitDepth(x, z) {
    for (let i = 0; i < pitSys.length; i++) {
      const s = pitSys[i];
      if (x < s.x || z < s.z || x >= s.x1 || z >= s.z1) continue;
      const lv = s.d.charCodeAt(Math.floor((z - s.z) / s.q) * s.nx + Math.floor((x - s.x) / s.q)) - 48;
      return lv > 0 ? lv * s.step : 0;
    }
    return 0;
  }
  const nearPit = (x, z, m = 2) => { for (let i = 0; i < pitSys.length; i++) { const s = pitSys[i]; if (x > s.x - m && x < s.x1 + m && z > s.z - m && z < s.z1 + m) return true; } return false; };
  function groundY(x, z) { return groundBase(x, z) - pitDepth(x, z); }
  function groundBase(x, z) {
    let fx = (x + HALF) / CELL, fz = (z + HALF) / CELL;
    if (fx < 0) fx = 0; else if (fx > N - 1.000001) fx = N - 1.000001;
    if (fz < 0) fz = 0; else if (fz > N - 1.000001) fz = N - 1.000001;
    const ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz, i = iz * N + ix;
    const h00 = G[i] * 0.01, h10 = G[i + 1] * 0.01, h01 = G[i + N] * 0.01, h11 = G[i + N + 1] * 0.01;
    return u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  }

  // Höhen der Bauten: Boden = höchster Punkt unter dem Haus, y0 = tiefster (Fundament reicht bis dorthin)
  // Begehbare Gebäude (Wohnhaus k0, Scheune k1, Schuppen k4): Das Gelände unter dem Haus wird eben gemacht (Boden = Innenboden), die Wände bestehen
  // aus einzelnen Segmenten mit Türöffnung (wl = Wandkästen x, z, Halbbreite, Halbtiefe), dazu einige Möbel (fu) als Hindernisse.
  const SIDE = [[0, 1], [0, -1], [1, 0], [-1, 0]];                                            // Türseite f: 0 = +z, 1 = -z, 2 = +x, 3 = -x
  const claimed = new Map();                                                                  // bereits eingeebnete Gitterpunkte (samt Rand von einem Punkt)
  const ENTER = { 0: { T: 0.35, dw: 1.7, dh: 2.5, minD: 5.0 }, 1: { T: 0.3, dw: 3.8, dh: 3.6, minD: 6.0 }, 4: { T: 0.25, dw: 1.5, dh: 2.0, minD: 3.2 } };
  for (const b of houses) {
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i <= 6; i++) for (let j = 0; j < 7; j++) { const g = groundY(b.x - b.w / 2 + b.w * i / 6, b.z - b.d / 2 + b.d * j / 6); lo = Math.min(lo, g); hi = Math.max(hi, g); }
    b.y = r2(hi); b.y0 = r2(lo);
    const E = ENTER[b.k];
    if (!E || Math.min(b.w, b.d) < E.minD || b.h < 2.4) continue;
    // Gelände einebnen: genau die Gitterpunkte, die Dreiecke des Grundrisses berühren, kommen auf Bodenhöhe (die Fläche im Haus wird exakt eben).
    // Teilen sich zwei Häuser Gitterpunkte, übernimmt das zweite die Bodenhöhe des ersten (bei mehr als 0,5 m Unterschied oder drei Beteiligten bleibt es ein geschlossener Block).
    const i0 = Math.max(0, Math.floor((b.x - b.w / 2 + HALF) / CELL)), i1 = Math.min(N - 1, Math.ceil((b.x + b.w / 2 + HALF) / CELL));
    const j0 = Math.max(0, Math.floor((b.z - b.d / 2 + HALF) / CELL)), j1 = Math.min(N - 1, Math.ceil((b.z + b.d / 2 + HALF) / CELL));
    const vals = new Set();
    for (let iz = j0; iz <= j1; iz++) for (let ix = i0; ix <= i1; ix++) if (claimed.has(iz * N + ix)) vals.add(claimed.get(iz * N + ix));
    let gv = Math.round(hi * 100);
    if (vals.size > 1) continue;                                                              // Gitterpunkte mit zwei verschiedenen Nachbarn geteilt: bleibt geschlossener Block
    if (vals.size === 1) { gv = [...vals][0]; if (Math.abs(gv - hi * 100) > 50) continue; }  // Nachbarhaus gibt die Bodenhöhe vor (maximal 0,5 m Unterschied)
    for (let iz = j0; iz <= j1; iz++) for (let ix = i0; ix <= i1; ix++) { G[iz * N + ix] = gv; claimed.set(iz * N + ix, gv); }
    hi = gv / 100;
    b.y = r2(hi); b.y0 = r2(hi);
    const [nx, nz] = SIDE[b.f], L = nz !== 0 ? b.w : b.d, T = E.T, dw = E.dw, half = (nz !== 0 ? b.d : b.w) / 2;
    let ds = b.k === 1 ? 0 : ((b.sh % 3) - 1) * L * 0.14;
    ds = Math.max(-(L / 2 - dw / 2 - 0.7), Math.min(L / 2 - dw / 2 - 0.7, ds));
    b.e = 1; b.T = T; b.dr = [b.f, r2(ds), dw, E.dh];
    const wl = [];
    for (let f = 0; f < 4; f++) {
      const [sx, sz] = SIDE[f], LL = sz !== 0 ? b.w : b.d, hf = (sz !== 0 ? b.d : b.w) / 2, c = hf - T / 2;
      const segs = f === b.f ? [[-LL / 2, ds - dw / 2], [ds + dw / 2, LL / 2]] : [[-LL / 2, LL / 2]];
      for (const [s0, s1] of segs) { const len = s1 - s0, mid = (s0 + s1) / 2;
        if (len < 0.05) continue;
        if (sz !== 0) wl.push([r2(b.x + mid), r2(b.z + sz * c), r2(len / 2), r2(T / 2)]); else wl.push([r2(b.x + sx * c), r2(b.z + mid), r2(T / 2), r2(len / 2)]);
      }
    }
    b.wl = wl;
    // Möbel: lokal (u = quer zur Rückwand, v = Tiefe von der Rückwand zur Tür hin), Größen in m
    const tx = -nz, tz = nx, depth = half * 2, wid = L, iw = wid - 2 * T, id = depth - 2 * T, fu = [];
    const put = (kind, u, v, sw, sd, h) => {                                                // Mitte (u, v) -> Weltkästen
      const cx = b.x - nx * (half - T) + nx * v + tx * u, cz = b.z - nz * (half - T) + nz * v + tz * u;
      const hwx = nz !== 0 ? sw / 2 : sd / 2, hdz = nz !== 0 ? sd / 2 : sw / 2;
      fu.push({ k: kind, x: r2(cx), z: r2(cz), hw: r2(hwx), hd: r2(hdz), h: h, o: nz !== 0 ? 0 : 1 });
    };
    const clr = (u, sw) => Math.abs(u - ds) > dw / 2 + sw / 2 + 0.3;                         // nicht vor der Tür
    if (b.k === 0) {
      const sgn = (b.sh % 2) ? 1 : -1;
      put('cab', sgn * (iw / 2 - 0.65), 0.3, 1.2, 0.55, 1.9);                                // Schrank an der Rückwand
      put('bed', -sgn * (iw / 2 - 0.55), 1.15, 1.05, 2.0, 0.55);                              // Bett in der Rückecke
      put('tab', sgn * 0.2, id * 0.55, 1.5, 0.9, 0.8);                                       // Tisch in der Mitte
      if (id > 5.4) put('stv', sgn * (iw / 2 - 0.5), id - 0.5, 0.8, 0.7, 1.0);               // Ofen/Bank vorn an der Wand (nur große Häuser)
    } else if (b.k === 1) {
      for (let i = 0; i < 3; i++) put('hay', -iw / 2 + 0.7 + i * 1.5, 0.55, 1.3, 0.9, 0.9 + (i % 2) * 0.8);   // Heuballen an der Rückwand
      put('hay', iw / 2 - 0.7, 1.4, 1.3, 1.5, 1.6);
      put('crt', iw / 2 - 0.5, id - 0.8, 0.9, 0.9, 0.9);
      if (iw > 10) put('wag', -iw / 4, id * 0.55, 2.6, 1.4, 1.2);                          // Handkarren in großen Scheunen
    } else {
      put('crt', iw / 2 - 0.45, 0.45, 0.8, 0.8, 0.8);
      if (iw > 2.6) put('tab', -iw / 2 + 0.45, 0.55, 0.9, 0.6, 0.9);
    }
    b.fu = fu;
    // Fenster (nur Wohnhäuser): echte Öffnungen in den Wänden. wb = Wandkästen mit Höhenbereich [x, z, hw, hd, y0, y1] (Sicht und Schüsse gehen durch die Öffnungen),
    // gl = Glasscheiben [x, z, hw, hd, y0, Höhe]; wl (voll hohe Wände) bleibt für die Kollision: durch ein Fenster läuft man nicht.
    const WW = 1.0, WH = 1.3, top = b.y + b.h, base = b.y - 1.4, wins = [], gl = [];
    if (b.k === 0) for (let f = 0; f < 4; f++) {
      const L2 = SIDE[f][1] !== 0 ? b.w : b.d, nWin = Math.max(1, Math.round(L2 / 3.6)), step = L2 / nWin, floors = b.h >= 5 ? 2 : 1;
      for (let i = 0; i < nWin; i++) {
        const sc = -L2 / 2 + step * (i + 0.5);
        for (let fl = 0; fl < floors; fl++) {
          if (f === b.f && fl === 0 && Math.abs(sc - ds) < dw / 2 + 1.0) continue;                // nicht neben der Tür
          wins.push({ f, s: sc, y: b.y + 1.0 + fl * 2.6 });
        }
      }
    }
    const wb = [];
    for (const [x, z, hw, hd] of wl) {
      const alongX = hw > hd, f = alongX ? (z > b.z ? 0 : 1) : (x > b.x ? 2 : 3), c0 = alongX ? x : z, h0 = alongX ? hw : hd;
      const mine = wins.filter(w => w.f === f && w.s + (alongX ? b.x : b.z) > c0 - h0 + WW / 2 && w.s + (alongX ? b.x : b.z) < c0 + h0 - WW / 2);
      const box = (a0, a1, y0, y1) => { if (a1 - a0 < 0.02 || y1 - y0 < 0.02) return; const m = (a0 + a1) / 2, hl = (a1 - a0) / 2; wb.push(alongX ? [r2(m), r2(z), r2(hl), r2(hd), r2(y0), r2(y1)] : [r2(x), r2(m), r2(hw), r2(hl), r2(y0), r2(y1)]); };
      const cols = [...new Set(mine.map(w => w.s))].sort((p, q) => p - q);
      let cur = c0 - h0;
      for (const sc of cols) {
        const wc = sc + (alongX ? b.x : b.z), ys = mine.filter(w => w.s === sc).map(w => w.y).sort((p, q) => p - q);
        box(cur, wc - WW / 2, base, top);                                                          // Wand bis zur Öffnung
        let yc = base; for (const wy of ys) { box(wc - WW / 2, wc + WW / 2, yc, wy); yc = wy + WH; gl.push(alongX ? [r2(wc), r2(z), r2(WW / 2), 0.02, r2(wy), WH] : [r2(x), r2(wc), 0.02, r2(WW / 2), r2(wy), WH]); }
        box(wc - WW / 2, wc + WW / 2, yc, top);                                                    // Brüstung unten / Sturz oben
        cur = wc + WW / 2;
      }
      box(cur, c0 + h0, base, top);
    }
    b.wb = wb; b.gl = gl;
  }
  // ---------- 3b. Schützengräben ----------
  // Ein Graben ist in den Boden eingelassen: ein 1,8 m breiter Gang (2 Zellen à 0,9 m) liegt 1,4 m unter dem Gelände, Gerade oder Zickzack. Wer steht, schaut mit Kopf und Schultern
  // über den Rand und kann schießen (Augen 1,7 m); wer hockt (Augen 1,2 m, Kopf 1,35 m) ist unter der Kante gedeckt. Die offenen Enden haben vier Stufen (je 0,35 m), an den Seiten
  // kommt man nur durch Klettern (Vorwärts + Leertaste) hinein und hinaus. Die Höhe des Bodens wird in groundY() abgezogen (pitDepth), damit Server, Client, Bots und Schüsse dasselbe sehen.
  // Rund um den Gang liegt ein 0,9 m breiter Ring aus unsichtbaren Sperrkästen (Spieler und Bots laufen nicht einfach in die Kante), die Mündungen bleiben frei.
  { const TQ = 0.9, DSTEP = 0.35, MAXL = 4, key = (a, b) => a + ',' + b;
    const makeShape = () => {                                                                  // Gänge aus geraden, gestaffelten, gezackten und verzweigten Segmenten
      const style = pick(6), free = new Set(), mouths = [], width = style === 5 ? 3 : 2;
      const addH = (x0, x1, z) => { for (let x = x0; x <= x1; x++) for (let dz = 0; dz < width; dz++) free.add(key(x, z + dz)); };
      let xc = 0, zz = 0, dir = R() < 0.5 ? 1 : -1, xe = 0, zl = 0, branchAt = 0, branchZ = 0;
      const nSeg = style === 0 ? 1 : style === 1 ? 1 : style === 2 ? 2 + pick(3) : style === 3 ? 3 : 2 + pick(4);
      for (let i = 0; i < nSeg; i++) {
        const len = style === 0 ? 24 + pick(21) : style === 1 ? 44 + pick(32) : (i === 0 ? 11 + pick(13) : 8 + pick(13));
        xe = xc + len - 1; addH(xc, xe, zz); zl = zz;
        if (style === 5 && i === Math.floor(nSeg / 2)) { branchAt = xc + Math.floor(len * (0.35 + R() * 0.3)); branchZ = zz; }
        if (i < nSeg - 1) {
          const nz = zz + dir * (3 + pick(style === 3 ? 8 : 6)), lo = Math.min(zz, nz), hi = Math.max(zz, nz) + width - 1;
          for (let cz = lo; cz <= hi; cz++) for (let dx = 0; dx < width; dx++) free.add(key(xe - 1 + dx, cz));
          zz = nz; xc = xe - 1;
          if (style === 3) dir = Math.sign(dir); else if (R() < (style === 4 ? 0.35 : 0.75)) dir = -dir;
        }
      }
      for (let dz = 0; dz < width; dz++) { mouths.push([-1, dz], [xe + 1, zl + dz]); }
      if (style === 5 && branchAt) {
        const sign = R() < 0.5 ? -1 : 1, bl = 10 + pick(15), endZ = branchZ + sign * bl;
        for (let z = Math.min(branchZ, endZ); z <= Math.max(branchZ + width - 1, endZ + width - 1); z++) for (let x = branchAt; x < branchAt + width; x++) free.add(key(x, z));
        const mouthZ = sign > 0 ? endZ + width : endZ - 1;
        for (let dx = 0; dx < width; dx++) mouths.push([branchAt + dx, mouthZ]);
      }
      return { free, mouth: mouths };
    };
    const rot = (cx, cz, r, m) => { let a = m ? -cx : cx, b = cz; for (let i = 0; i < r; i++) { const t = a; a = -b; b = t; } return [a, b]; };
    const cellOf = k => k.split(',').map(Number);
    const GROUP_SIZE = 4, GROUPS = 4, want = GROUP_SIZE * GROUPS, centers = [], groupAttempts = [];
    const newCenter = () => {
      for (let n = 0; n < 80; n++) {
        const a = R() * Math.PI * 2, r = Math.sqrt(rr(125 * 125, (MAP - 75) * (MAP - 75))), c = { x: Math.cos(a) * r, z: Math.sin(a) * r };
        if (PEN.some(p => Math.hypot(c.x - p.x, c.z - p.z) < 92) || Math.hypot(c.x - L.vx, c.z - pzc) < 100) continue;
        if (centers.some(q => Math.hypot(c.x - q.x, c.z - q.z) < 125)) continue;
        return c;
      }
      return { x: rr(-150, 150), z: rr(-150, 150) };
    };
    let tries = 0;
    while (pitSys.length < want && tries++ < 5000) {
      const sh = makeShape(), r = pick(4), m = R() < 0.5;
      const group = Math.floor(pitSys.length / GROUP_SIZE);
      if (!centers[group] || groupAttempts[group] > 180) { centers[group] = newCenter(); groupAttempts[group] = 0; }
      groupAttempts[group]++;
      const free = new Set(), mouth = new Set(), wall = new Set();
      for (const k of sh.free) { const [a, b] = cellOf(k), [c, d] = rot(a, b, r, m); free.add(key(c, d)); }
      for (const [a, b] of sh.mouth) { const [c, d] = rot(a, b, r, m); mouth.add(key(c, d)); }
      for (const k of free) { const [a, b] = cellOf(k); for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) { const kk = key(a + da, b + db); if (!free.has(kk) && !mouth.has(kk)) wall.add(kk); } }
      let mnA = 1e9, mnB = 1e9, mxA = -1e9, mxB = -1e9;
      for (const k of [...free, ...wall, ...mouth]) { const [a, b] = cellOf(k); mnA = Math.min(mnA, a); mnB = Math.min(mnB, b); mxA = Math.max(mxA, a); mxB = Math.max(mxB, b); }
      const nx = mxA - mnA + 1, nz = mxB - mnB + 1, bw = nx * TQ, bd = nz * TQ;
      let cx, cz;
      { const a = R() * Math.PI * 2, off = rr(18, 48); cx = centers[group].x + Math.cos(a) * off; cz = centers[group].z + Math.sin(a) * off; } // mehrere Gräben bilden ein zufälliges System im selben Landstrich
      if (Math.abs(cx) > MAP - 45 || Math.abs(cz) > MAP - 45) continue;
      const g = { x: cx, z: cz, hw: bw / 2 + 1, hd: bd / 2 + 1 };
      if (PEN.some(p => Math.hypot(cx - p.x, cz - p.z) < 62) || Math.hypot(cx - L.vx, cz - pzc) < 52) continue;
      if (Math.hypot(Math.max(Math.abs(pond.x - cx) - g.hw, 0), Math.max(Math.abs(pond.z - cz) - g.hd, 0)) < pond.r + 14) continue;
      if (occ.some(o => rectGap(g, o) < 7) || boxEdge(g) < 6) continue;
      if (props.some(p => PROP[p.k][1] && rectGap(g, { x: p.x, z: p.z, hw: p.w / 2, hd: p.d / 2 }) < 6)) continue;
      if (pitSys.some(t => rectGap(g, { x: t.cx, z: t.cz, hw: t.hw, hd: t.hd }) < (t.group === group ? 5 : 38))) continue;
      { let lo = 1e9, hi = -1e9; for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) { const y = groundY(cx - g.hw + 2 * g.hw * i / 8, cz - g.hd + 2 * g.hd * j / 8); lo = Math.min(lo, y); hi = Math.max(hi, y); } if (hi - lo > 1.1) continue; }
      const i0 = Math.max(0, Math.floor((cx - g.hw - 2 + HALF) / CELL)), i1 = Math.min(N - 1, Math.ceil((cx + g.hw + 2 + HALF) / CELL));
      const j0 = Math.max(0, Math.floor((cz - g.hd - 2 + HALF) / CELL)), j1 = Math.min(N - 1, Math.ceil((cz + g.hd + 2 + HALF) / CELL));
      let clash = false; for (let iz = j0; iz <= j1 && !clash; iz++) for (let ix = i0; ix <= i1; ix++) if (claimed.has(iz * N + ix)) { clash = true; break; }
      if (clash) continue;
      const gv = Math.round(groundY(cx, cz) * 100);                                           // Gelände unter und um den Graben einebnen (Gitterpunkte, die den Platz berühren)
      for (let iz = j0; iz <= j1; iz++) for (let ix = i0; ix <= i1; ix++) { G[iz * N + ix] = gv; claimed.set(iz * N + ix, gv); }
      const ox = cx - (mnA + nx / 2) * TQ, oz = cz - (mnB + nz / 2) * TQ;                      // Zelle (a, b) liegt von ox + a*TQ bis ox + (a+1)*TQ
      const x0 = Math.round((ox + mnA * TQ) * 1000) / 1000, z0 = Math.round((oz + mnB * TQ) * 1000) / 1000;
      const dist = new Map(); let fr = [];                                                     // Stufen: Abstand zur nächsten Mündung (4er-Nachbarschaft)
      for (const k of mouth) { dist.set(k, 0); fr.push(k); }
      while (fr.length) { const nxt = []; for (const k of fr) { const [a, b] = cellOf(k), d0 = dist.get(k); for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const kk = key(a + da, b + db); if (free.has(kk) && !dist.has(kk)) { dist.set(kk, d0 + 1); nxt.push(kk); } } } fr = nxt; }
      let digits = '';
      for (let b = mnB; b <= mxB; b++) for (let a = mnA; a <= mxA; a++) { const k = key(a, b); digits += free.has(k) ? Math.min(MAXL, dist.has(k) ? dist.get(k) : MAXL) : 0; }
      pitSys.push({ x: x0, z: z0, q: TQ, nx, nz, d: digits, step: DSTEP, cx, cz, hw: bw / 2, hd: bd / 2, x1: x0 + nx * TQ, z1: z0 + nz * TQ, group });
      const wx = a => ox + (a + 0.5) * TQ, wz = b => oz + (b + 0.5) * TQ;
      { let open = new Map();                                                                  // Ringzellen zu wenigen Rechtecken zusammenfassen: erst Zeilenläufe, dann gleiche Läufe untereinander
        const out = [];
        for (let b = mnB; b <= mxB + 1; b++) {
          const runs = []; if (b <= mxB) { let st = null; for (let a = mnA; a <= mxA + 1; a++) { const on = a <= mxA && wall.has(key(a, b)); if (on && st === null) st = a; else if (!on && st !== null) { runs.push([st, a - 1]); st = null; } } }
          const nxt = new Map();
          for (const [a0, a1] of runs) { const kk = a0 + ',' + a1, o = open.get(kk); if (o) { o.b1 = b; nxt.set(kk, o); open.delete(kk); } else { const q = { a0, a1, b0: b, b1: b }; out.push(q); nxt.set(kk, q); } }
          open = nxt;
        }
        for (const q of out) props.push({ k: 'trench', x: r2((wx(q.a0) + wx(q.a1)) / 2), z: r2((wz(q.b0) + wz(q.b1)) / 2), w: r2((q.a1 - q.a0 + 1) * TQ), d: r2((q.b1 - q.b0 + 1) * TQ), h: 1.4, s: 1 });   // Sperrkästen (unsichtbar)
      }
      addOcc(cx, cz, g.hw + 1.5, g.hd + 1.5);
    }
  }
  // Höchster Punkt des Geländes neu bestimmen (durch das Einebnen kann er sich geändert haben)
  hmax = -1e9; for (let i = 0; i < G.length; i++) if (G[i] > hmax) hmax = G[i]; hmax /= 100;
  for (const p of props) p.y = r2(groundY(p.x, p.z));

  // ---------- 4. Felder (nur auf flachem Land) ----------
  const flat = (x, z, w, d) => { const c = groundY(x, z); let m = 0; for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) m = Math.max(m, Math.abs(groundY(x + a * w / 2, z + b * d / 2) - c)); return m; };
  const fieldOK = (f, margin) => {
    const g = { x: f.x, z: f.z, hw: f.w / 2, hd: f.d / 2 };
    if (Math.abs(f.x) + f.w / 2 > MAP - 8 || Math.abs(f.z) + f.d / 2 > MAP - 8) return false;
    if (occ.some(o => rectGap(g, o) < margin)) return false;
    if (fields.some(o => rectGap(g, { x: o.x, z: o.z, hw: o.w / 2, hd: o.d / 2 }) < 0.5)) return false;
    if (props.some(p => PROP[p.k][1] && rectGap(g, { x: p.x, z: p.z, hw: p.w / 2, hd: p.d / 2 }) < 1)) return false;
    if (boxEdge(g) < 1.5) return false;
    if (Math.hypot(Math.max(Math.abs(pond.x - g.x) - g.hw, 0), Math.max(Math.abs(pond.z - g.z) - g.hd, 0)) < pond.r + 6) return false;
    return true;
  };
  const addField = f => { fields.push({ x: r1(f.x), z: r1(f.z), w: r1(f.w), d: r1(f.d), k: f.k, rt: f.rt }); };
  for (const f of fieldWish) if (fieldOK(f, 2.5) && flat(f.x, f.z, f.w, f.d) < 3.2) addField(f);
  { let tries = 0; const want = 9, base = fields.length;
    while (fields.length < base + want && tries++ < 800) {
      const w = 24 + R() * 22, d = 22 + R() * 16, x = (R() - 0.5) * 2 * (MAP - 30), z = (R() - 0.5) * 2 * (MAP - 30);
      const f = { x, z, w, d, k: pick(4), rt: pick(2) };
      if (fieldOK(f, 3) && flat(x, z, w, d) < 2.4) addField(f);
    } }

  // ---------- 5. Aufsammelbare Items: vor den Haustüren im Dorf ----------
  const types = ['helm', 'vest', 'ammo', 'ammo', 'vest', 'helm', 'ammo', 'ammo', 'vest', 'helm', 'ammo', 'vest', 'ammo', 'helm'];
  const PICK = [];
  const itemClear = (x, z) => {                                                              // frei von Häusern, festen Gegenständen, Gehegeflächen und Teich (Höfe zählen mit, dort liegen auch Items)
    if (Math.abs(x) > MAP - 10 || Math.abs(z) > MAP - 10) return false;
    if (PEN.some(p => Math.abs(x - p.x) < 34 && Math.abs(z - p.z) < 40)) return false;
    if (Math.hypot(x - pond.x, z - pond.z) < pond.r + 3) return false;
    const g = { x, z, hw: 0.5, hd: 0.5 };
    if (houses.some(h => rectGap(g, { x: h.x, z: h.z, hw: h.w / 2, hd: h.d / 2 }) < 1.2)) return false;
    if (props.some(p => PROP[p.k][1] && rectGap(g, { x: p.x, z: p.z, hw: p.w / 2, hd: p.d / 2 }) < 1.2)) return false;
    if (PICK.some(k => Math.hypot(k.x - x, k.z - z) < 9)) return false;
    return true;
  };
  { const cand = houses.filter(h => h.k === 0 || h.k === 1);
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const groups = PEN.map(() => []);                                                      // Häuser nach dem nächsten Gehege sortiert, damit alle drei Teams gleich viele Items in der Nähe haben
    for (const h of shuffle(cand)) { let bi = 0, bd = 1e9; PEN.forEach((p, t) => { const d = Math.hypot(h.x - p.x, h.z - p.z); if (d < bd) { bd = d; bi = t; } }); groups[bi].push(h); }
    const tryItem = h => {
      const out = { 0: [0, 1], 1: [0, -1], 2: [1, 0], 3: [-1, 0] }[h.f];                   // Richtung der Tür
      const base = (out[0] === 0 ? h.d : h.w) / 2;
      for (const lat of [(R() - 0.5) * 3, -2, 2, 0, -3.5, 3.5]) for (const gap of [2.8 + R() * 1.0, 4.2]) {
        const x = h.x + out[0] * (base + gap) + (out[0] === 0 ? lat : 0), z = h.z + out[1] * (base + gap) + (out[1] === 0 ? lat : 0);
        if (itemClear(x, z)) { PICK.push({ id: PICK.length, type: types[PICK.length], x: r1(x), z: r1(z) }); return true; }
      }
      return false;
    };
    const gi = [0, 0, 0];
    for (let n = 0; PICK.length < types.length && n < 200; n++) {                           // reihum: Team 0, 1, 2, 0, 1, ...
      const t = n % 3, h = groups[t][gi[t]++];
      if (h) tryItem(h);
      else if (groups.every((g, k) => gi[k] >= g.length)) break;
    }
  }

  // ---------- 6. Bäume ----------
  const solidRects = props.filter(p => PROP[p.k][1]).map(p => ({ x: p.x, z: p.z, hw: p.w / 2, hd: p.d / 2 }));
  function treeOK(x, z, force) {
    if (Math.abs(x) > MAP - 3 || Math.abs(z) > MAP - 3) return false;
    const pt = { x, z, hw: 0, hd: 0 };
    if (Math.hypot(x - pond.x, z - pond.z) < pond.r + 2.2) return false;
    if (PICK.some(k => Math.hypot(k.x - x, k.z - z) < 2.5)) return false;
    if (solidRects.some(o => rectGap(pt, o) < 1.4)) return false;
    if (trees.some(t => Math.hypot(t.x - x, t.z - z) < 2.2)) return false;
    if (force) return true;
    if (occ.some(o => rectGap(pt, o) < 1.8)) return false;
    if (roadEdge(x, z) < 1.7) return false;
    for (const f of fields) if (f.k !== 3 && Math.abs(x - f.x) < f.w / 2 + 1 && Math.abs(z - f.z) < f.d / 2 + 1) return false;
    return true;
  }
  const addTree = (x, z, k, force) => {
    if (!treeOK(x, z, force)) return false;
    const s = k === 0 ? 0.9 + R() * 0.6 : k === 1 ? 0.85 + R() * 0.5 : 0.7 + R() * 0.25;
    trees.push({ x: r1(x), z: r1(z), k, s: r2(s), v: pick(4) }); return true;
  };
  // Alleebäume vor Kirche und am Dorfplatz
  for (const [x, z] of [[vx - 9.5, pzc - 4.5], [vx + 9.5, pzc + 4.5], [churchX - 8.5, zc], [churchX + 8.5, zc], [churchX - 11, zc + S * 12], [churchX + 11, zc + S * 12]]) addTree(x, z, 1, true);
  // Bäume entlang der Dorfstraße (nur wo Platz ist)
  for (let x = gxW + 12; x <= gxE - 12; x += 11.5) for (const s of [-1, 1]) addTree(x + (R() - 0.5) * 3, roadZ(x) + s * 5.2, 1, false);
  for (let x = xj + 14; x <= gx2 - 12; x += 11.5) for (const s of [-1, 1]) addTree(x + (R() - 0.5) * 3, spurZ(x) + s * 5.2, 1, false);   // Abzweigung
  // Obstgärten
  for (const o of orchards) addTree(o.x + (R() - 0.5) * 0.8, o.z + (R() - 0.5) * 0.8, 2, false);
  // Weiden am Teich
  for (let i = 0; i < 7; i++) { const a = R() * 6.28, r = pond.r + 3 + R() * 3; addTree(pond.x + Math.cos(a) * r, pond.z + Math.sin(a) * r, 1, false); }
  // Wälder und Wäldchen
  const GROVES = [];                                                                        // [x, z, Radius, Bäume, Art]: große Wälder (Art 0) weit draußen, kleine Wäldchen (Art 1) dazwischen
  const grovePlace = (count, d0, d1, g0, g1, n0, n1, kind, sep, penClear) => {
    for (let i = 0, tries = 0; i < count && tries++ < 300;) {
      const ang = R() * 6.283, d = rr(d0, d1), x = Math.cos(ang) * d * 1.1, z = Math.sin(ang) * d, gr = rr(g0, g1);
      if (Math.abs(x) > 245 || Math.abs(z) > 245) continue;
      if (PEN.some(p => Math.hypot(x - p.x, z - p.z) < penClear) || GROVES.some(g => Math.hypot(x - g[0], z - g[1]) < sep)) continue;
      GROVES.push([x, z, gr, Math.round(rr(n0, n1)), kind]); i++;
    }
  };
  grovePlace(6 + pick(2), 115, 230, 26, 38, 26, 36, 0, 70, 60);
  grovePlace(10 + pick(3), 50, 195, 8, 17, 8, 18, 1, 30, 32);
  for (let a = 0; a < PEN.length; a++) for (let b = a + 1; b < PEN.length; b++) {            // Baumgruppen auf der Strecke zwischen je zwei Gehegen (Sichtschutz)
    const P = PEN[a], Q = PEN[b], dx = Q.x - P.x, dz = Q.z - P.z, len = Math.hypot(dx, dz), px = -dz / len, pz = dx / len;
    for (const t0 of [0.28, 0.44, 0.58, 0.72]) for (let tr = 0; tr < 12; tr++) {
      const t = t0 + rr(-0.05, 0.05), off = rr(-34, 34), x = P.x + dx * t + px * off, z = P.z + dz * t + pz * off, gr = rr(8, 13);
      if (Math.abs(x) > 238 || Math.abs(z) > 238) continue;
      if (PEN.some(p => Math.hypot(x - p.x, z - p.z) < 55) || Math.hypot(x - L.vx, z - pzc) < 70 || GROVES.some(g => Math.hypot(x - g[0], z - g[1]) < 24)) continue;
      GROVES.push([x, z, gr, Math.round(rr(14, 24)), 1]); break;
    }
  }
  for (const [gx, gz, gr, n, kind] of GROVES) { let ok = 0, tries = 0; while (ok < n && tries++ < n * 8) { const a = R() * 6.28, r = Math.sqrt(R()) * gr; if (addTree(gx + Math.cos(a) * r, gz + Math.sin(a) * r, kind === 0 ? (R() < 0.8 ? 0 : 1) : (R() < 0.7 ? 1 : 0), false)) ok++; } }
  // Waldrand rund um die Karte
  for (let i = 0, tries = 0; i < 150 && tries++ < 600;) {
    const e = 238 + R() * 40, a = (R() - 0.5) * 2 * 276, side = pick(4);
    const x = side === 0 ? e : side === 1 ? -e : a, z = side === 2 ? e : side === 3 ? -e : a;
    if (addTree(x, z, R() < 0.8 ? 0 : 1, false)) i++;
  }
  // einzelne Bäume auf Wiesen
  for (let i = 0, tries = 0; i < 40 && tries++ < 400;) { if (addTree((R() - 0.5) * 2 * (MAP - 20), (R() - 0.5) * 2 * (MAP - 20), R() < 0.5 ? 1 : 0, false)) i++; }
  for (const t of trees) t.y = r2(groundY(t.x, t.z));

  // Quads: stehen mittig in der Welt (rund um den Dorfplatz bzw. die Kartenmitte), nicht am Spawn der Spieler
  const quads = [];
  { const pz = plazas[0] || { x: 0, z: 0, r: 10 }, cx = pz.x, cz = pz.z;
    const qFree = (x, z) => {
      if (nearPit(x, z, 4)) return false;
      if (Math.abs(x) > MAP - 20 || Math.abs(z) > MAP - 20) return false;
      if (PEN.some(p => Math.abs(x - p.x) < 36 && Math.abs(z - p.z) < 42)) return false;
      if (Math.hypot(x - pond.x, z - pond.z) < pond.r + 4) return false;
      const g = { x, z, hw: 1.1, hd: 0.8 };
      if (houses.some(h => rectGap(g, { x: h.x, z: h.z, hw: h.w / 2, hd: h.d / 2 }) < 2.5)) return false;
      if (props.some(p => PROP[p.k][1] && rectGap(g, { x: p.x, z: p.z, hw: p.w / 2, hd: p.d / 2 }) < 2)) return false;
      if (trees.some(t => Math.hypot(t.x - x, t.z - z) < 2.5)) return false;
      if (quads.some(q => Math.hypot(q.x - x, q.z - z) < 7)) return false;
      return true;
    };
    for (let ring = 0; ring < 14 && quads.length < 3; ring++) {                              // vom Dorfplatz aus nach außen suchen
      const rad = 3 + ring * 5, a0 = R() * 6.28;
      for (let k = 0; k < 8 && quads.length < 3; k++) {
        const a = a0 + k * Math.PI / 4, x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
        if (qFree(x, z)) quads.push({ x: r1(x), z: r1(z), yaw: r2(R() * 6.28) });
      }
    }
  }

  // Traktoren (mit Anhänger): brauchen einen freien Streifen von etwa 3 m x 13 m (Traktor vorn, Anhänger dahinter). Die Fahrtrichtung ist -Z bei yaw 0; der Anhänger steht hinter dem Traktor.
  const tractors = [];
  { const pz = plazas[0] || { x: 0, z: 0, r: 10 }, cx = pz.x, cz = pz.z;
    const ptFree = (x, z) => {
      if (Math.abs(x) > MAP - 24 || Math.abs(z) > MAP - 24) return false;
      if (PEN.some(p => Math.abs(x - p.x) < 36 && Math.abs(z - p.z) < 42)) return false;
      if (Math.hypot(x - pond.x, z - pond.z) < pond.r + 5) return false;
      const g = { x, z, hw: 1.9, hd: 1.9 };
      if (houses.some(h => rectGap(g, { x: h.x, z: h.z, hw: h.w / 2, hd: h.d / 2 }) < 1.5)) return false;
      if (props.some(p => PROP[p.k][1] && rectGap(g, { x: p.x, z: p.z, hw: p.w / 2, hd: p.d / 2 }) < 1.2)) return false;
      if (trees.some(t => Math.hypot(t.x - x, t.z - z) < 3.2)) return false;
      if (quads.some(q => Math.hypot(q.x - x, q.z - z) < 4)) return false;
      return true;
    };
    const stripFree = (x, z, yaw) => {                                                      // Traktor bei (x, z), Anhänger hinten (+Z bei yaw 0): neun Stichproben entlang des Streifens
      if (nearPit(x, z, 9)) return false;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      for (let s = -3; s <= 11; s += 1.75) if (!ptFree(x - fx * s, z - fz * s)) return false;
      return true;
    };
    for (let ring = 0; ring < 20 && tractors.length < 2; ring++) {
      const rad = 14 + ring * 6, a0 = R() * 6.28;
      for (let k = 0; k < 8 && tractors.length < 2; k++) {
        const a = a0 + k * Math.PI / 4, x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
        if (tractors.some(t => Math.hypot(t.x - x, t.z - z) < 40)) continue;
        for (let j = 0; j < 8; j++) {
          const yaw = R() * 6.28;
          if (stripFree(x, z, yaw)) { tractors.push({ x: r1(x), z: r1(z), yaw: r2(yaw) }); break; }
        }
      }
    }
  }

  // Teichgrund liegt im Gelände; Fahnenmast-Höhe der Gehege = 0 (eben)
  const b64 = (() => { const b = Buffer.alloc(G.length * 2); for (let i = 0; i < G.length; i++) b.writeInt16LE(G[i], i * 2); return b.toString('base64'); })();
  return {
    CELL, HALF, N, G, hmax, groundY, pitDepth, nearPit, houses, props, trees, roads, plazas, fields, pond, pick: PICK, farms: farmInfo, PROP, quads, tractors,
    terrain: { cell: CELL, half: HALF, n: N, g: b64, pits: pitSys.map(t => ({ x: t.x, z: t.z, q: t.q, nx: t.nx, nz: t.nz, d: t.d, st: t.step })) }, layout: { stations: stations, vx: r1(L.vx), churchSouth: S > 0, west: teamAt[0], teams: teamAt, pens: PEN.map(p => [r1(p.x), r1(p.z)]), dist: minPenDist }
  };
}

// Prüfung: Ist die Karte spielbar? Raster mit 2 m Zellen, Hindernisse (Häuser, feste Gegenstände, Zäune, Bäume, Teich) gesperrt,
// dann Suche (Flutfüllung) vom Tor des roten Geheges aus: blaues Tor, jeder Hof und jedes Item müssen erreichbar sein.
// Gibt null zurück, wenn alles in Ordnung ist, sonst den Grund.
function check(w, cfg) {
  const { PEN, PEN_R, MAP } = cfg, CS = 1, M = Math.ceil(MAP / CS), W = 2 * M + 1, blocked = new Uint8Array(W * W);
  const ci = v => Math.round(v / CS) + M, inside = (i, j) => i >= 0 && j >= 0 && i < W && j < W;
  const box = (x, z, hw, hd) => { for (let i = ci(x - hw - 1); i <= ci(x + hw + 1); i++) for (let j = ci(z - hd - 1); j <= ci(z + hd + 1); j++) if (inside(i, j) && Math.abs((i - M) * CS - x) <= hw + 0.5 && Math.abs((j - M) * CS - z) <= hd + 0.5) blocked[j * W + i] = 1; };
  const circle = (x, z, r) => { const q = Math.ceil(r + 1.5); for (let i = ci(x) - q; i <= ci(x) + q; i++) for (let j = ci(z) - q; j <= ci(z) + q; j++) if (inside(i, j) && Math.hypot((i - M) * CS - x, (j - M) * CS - z) <= r + 0.5) blocked[j * W + i] = 1; };
  for (const h of w.houses) box(h.x, h.z, h.w / 2, h.d / 2);
  for (const p of w.props) if (w.PROP[p.k][1]) box(p.x, p.z, p.w / 2, p.d / 2);
  circle(w.pond.x, w.pond.z, w.pond.r);
  for (const t of w.trees) circle(t.x, t.z, 0.45);
  PEN.forEach((p, t) => {                                                                   // Zäune wie in Server und Client
    const s = PEN_R * 2, inner = p.s * PEN_R, outer = -inner;
    box(p.x, p.z - PEN_R, s / 2, 0.1); box(p.x, p.z + PEN_R, s / 2, 0.1); box(p.x + outer, p.z, 0.1, s / 2);
    box(p.x + inner, p.z - PEN_R * 0.7, 0.1, s * 0.15); box(p.x + inner, p.z + PEN_R * 0.7, 0.1, s * 0.15);
    for (let i = 0; i < 3; i++) box(p.x + (outer < 0 ? -1 : 1) * (PEN_R - 2.5), p.z + (i - 1) * 4, 0.6, 0.8);
  });
  const seen = new Uint8Array(W * W), q = [];
  const free = (x, z) => { const i = ci(x), j = ci(z); return inside(i, j) && !blocked[j * W + i]; };
  const wi = PEN.findIndex(p => p.s > 0);                                                     // das westliche Gehege (Tor nach Osten)
  const start = [PEN[wi].x + PEN_R + 3, PEN[wi].z];
  if (!free(start[0], start[1])) return 'Start vor dem westlichen Tor blockiert';
  { const i = ci(start[0]), j = ci(start[1]); seen[j * W + i] = 1; q.push(i, j); }
  for (let h = 0; h < q.length; h += 2) {
    const i = q[h], j = q[h + 1];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = i + di, b = j + dj; if (inside(a, b) && !blocked[b * W + a] && !seen[b * W + a]) { seen[b * W + a] = 1; q.push(a, b); } }
  }
  const reach = (x, z) => { const i = ci(x), j = ci(z); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (inside(i + a, j + b) && seen[(j + b) * W + i + a]) return true; return false; };   // Zelle oder Nachbarzelle
  for (const p of PEN) if (p.s < 0 && !reach(p.x - PEN_R - 3, p.z)) return 'östliches Tor nicht erreichbar';
  for (const f of w.farms) if (!reach(f.gate[0], f.gate[1])) return 'Hoftor nicht erreichbar';
  for (const k of w.pick) if (!reach(k.x, k.z)) return 'Item ' + k.id + ' nicht erreichbar';
  if (w.houses.length < 24) return 'zu wenige Häuser (' + w.houses.length + ')';
  if (w.pick.length < 12) return 'zu wenige Items (' + w.pick.length + ')';
  if (w.fields.length < 8) return 'zu wenige Felder (' + w.fields.length + ')';
  if (w.trees.length < 450) return 'zu wenige Bäume (' + w.trees.length + ')';
  if (w.farms.length < 3) return 'zu wenige Höfe';
  return null;
}
