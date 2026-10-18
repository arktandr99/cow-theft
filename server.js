// COW THEFT - Server (Node.js + ws). Start: npm install && npm start
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MATCH_SECONDS = parseInt(process.env.MATCH_SECONDS, 10) || 15 * 60;   // 15 Minuten (zum Testen kürzer: $env:MATCH_SECONDS=30)
const LOBBY_S = process.env.LOBBY_S !== undefined ? Math.max(0, +process.env.LOBBY_S) : 25;   // Warteraum vor jeder Runde (0 = sofort losspielen)
const VOTE_S = process.env.VOTE_S !== undefined ? Math.max(3, +process.env.VOTE_S) : 25;        // Statistik und Kartenwahl am Rundenende
const RANK_FILE = process.env.RANK_FILE || path.join(__dirname, 'rangliste.json');                                          // lokale Rangliste (wird automatisch angelegt)
// Absicherung (alles per Umgebungsvariable änderbar): Obergrenzen gegen Missbrauch und Überlastung
const MAX_CONN = Math.max(1, parseInt(process.env.MAX_CONN, 10) || 40);              // gleichzeitige Verbindungen (Spieler + Zuschauer)
const MAX_PER_IP = Math.max(1, parseInt(process.env.MAX_PER_IP, 10) || 12);          // Verbindungen pro Adresse
const MSG_RATE = +process.env.MSG_RATE || 90, MSG_BURST = +process.env.MSG_BURST || 180;   // erlaubte Nachrichten pro Sekunde je Verbindung (normal: etwa 20-50) und kurzer Spitzenwert
const MAX_PAYLOAD = 8192;                                                            // größte erlaubte Nachricht des Spielers in Byte (normale Nachrichten sind unter 500 Byte)
const RANK_MAX = 1000;                                                               // so viele Namen bleiben in der Rangliste
const JOIN_TIMEOUT_MS = 120000;                                                      // wer sich so lange nicht anmeldet (join), wird getrennt
const COWS_PER_TEAM = 6;
const MAP = 280;                                   // Spielfeld: -MAP..+MAP
const PEN = [{ x: -120, z: 0, s: 1 }, { x: 120, z: -100, s: -1 }, { x: 120, z: 100, s: -1 }]; // Gehege Team 0 (rot) / 1 (blau) / 2 (grün); Lage und Torseite (s = +1: Tor zeigt nach +x) würfelt world.js bei jeder neuen Karte
const TEAMS = PEN.length;                           // Anzahl der Teams
const TEAM_NAMES = ['Rot', 'Blau', 'Grün'], TEAM_ADJ = ['rote', 'blaue', 'grüne'], TEAM_GEN = ['roten', 'blauen', 'grünen'];
const PEN_R = 14;
const QUAD_R = 3.4;                                // Reichweite zum Aufsteigen auf ein Quad (Meter)
const QUAD_MAX = 13.89;                            // Höchsttempo des Quads: 50 km/h in m/s
const QUAD_HOME_MS = 90000;                        // ein verlassenes Quad fährt nach so langer Zeit zurück an seinen Platz
// Traktor mit Anhänger: gleiche Steuerung wie das Quad (gehört zur selben Liste, kind = 1), aber langsam, schwer und laut. Auf den Anhänger passen TRAC_CAP Kühe.
const TRAC_R = 4.2, TRAC_MAX = 6.4, TRAC_SLOW = 0.45, TRAC_CAP = 4;      // Aufsteig-Reichweite (m), Höchsttempo leer (m/s = 23 km/h), Tempoverlust je geladener Kuh, Plätze
const TRAC_HITCH = 2.0, TRAC_DRAW = 3.6, TRAC_HALF = 2.7, TRAC_JACK = 1.25;   // Kupplung hinter der Traktormitte, Kupplung -> Mitte des Anhängers, halbe Ladefläche, größter Knickwinkel (rad)
const TR_LOAD_R = 3.4, TR_UNLOAD_R = 3.0;          // Abstand zur Ladefläche zum Aufladen (Kuhmitte) bzw. Abladen (Spieler)
const TR_SLOTS = [[1.3, -0.62], [1.3, 0.62], [-1.3, -0.62], [-1.3, 0.62]];   // Kuhplätze auf dem Anhänger (vor/zurück, links/rechts) in Metern von der Mitte
const NADE_MAX = 2, NADE_FUSE = 3600, NADE_COOLDOWN = 1300, NADE_SPEED = 25;   // Granaten pro Leben, Zündzeit ab Wurf (ms), Wurfpause (ms), Wurftempo (m/s)
const SMOKE_LIFE = 30000, SMOKE_RMAX = 7.5;        // Rauchwolke: Dauer (ms) und Endradius (m)
const FRAG_N = 420, FRAG_R = 28, FRAG_DMG = 34;    // Splitter pro Explosion, Reichweite (m), Schaden eines Splitters auf Nahdistanz
const FRAGW = { id: 'frag', n: 'Splittergranate' };
const TRACW = { id: 'tractor', n: 'Traktor', pierce: true };
const QUADW = { id: 'quad', n: 'Quad', pierce: true };      // Überfahren: Schaden = (Tempo - RAM_V0) * RAM_K, ab etwa 42 km/h tödlich; Weste hilft kaum
const RAM_V0 = 2.5, RAM_K = 11, RAM_R = 1.7, RAM_CD = 700;   // Mindesttempo m/s, Schaden je m/s darüber, Trefferradius m, Pause je Opfer ms
const RESPAWN = +process.env.RESPAWN || 5;
const MOUNT_R = 4.5;                               // Reichweite zum Aufsteigen auf eine Kuh (Meter)
const HP = 100;                                    // alle Rollen: 100 HP, wenige Treffer töten
const PICKUP_RESPAWN = 45;                         // Sekunden bis ein Item wieder erscheint
const MAX_JUMP = 2.8;                              // größte erlaubte Sprunghöhe (Meter), vom Client gemeldet
const SPRINT_RECOVER = 250;                        // ms nach dem Sprinten, bis die Waffe wieder schussbereit ist (wie in Sandstorm)
const LEG_MULT = 0.75;                             // Beintreffer richten weniger Schaden an
// KI-Spieler: jedes Team wird mit Bots bis zu dieser Größe aufgefüllt (echte Spieler zählen mit).
// Ändern mit Umgebungsvariable, z. B. Windows PowerShell:  $env:TEAM_SIZE=6; npm start    (0 = keine Bots)
const TEAM_SIZE = process.env.TEAM_SIZE !== undefined ? Math.max(0, Math.min(12, parseInt(process.env.TEAM_SIZE, 10) || 0)) : 5;

// ---------- Waffen (Werte angelehnt an Insurgency: Sandstorm) ----------
// Aus Community-Guides übernommen: Feuerrate (rpm), Mündungsgeschwindigkeit (v, m/s), Magazingröße (mag), vertikaler/horizontaler Rückstoß (V/H), Gewicht (wt, % wie im Spiel).
// Sandstorm veröffentlicht keine Schadenswerte: dmg (Körpertreffer, Kopf x3) ist hier aus Kaliber und bekannter "Treffer bis zum Kill"-Wirkung abgeschätzt.
//   cat: ar Sturmgewehr, br Gefechtsgewehr, lmg MG, dmr Selbstlade-Scharfschützengewehr, snp Repetierer, smg MP, sg Schrotflinte, pst Pistole
//   mag: Patronen pro Magazin (bei tube: Röhre/Kasten fest), spare: Ersatzmagazine (bei tube: Reservepatronen)
//   spread: Streuung beim Zielen (Radiant), bloom: Streuungszuwachs pro Schuss, rng/minF: Reichweite des Schadensabfalls und Mindestfaktor
//   rl/rle: Nachladezeit (s) / Aufschlag bei leerem Magazin, rlr: Zeit pro Patrone (tube), pel/pelSp: Schrotkugeln
const CATS = {
  ar:  { mag: 30, spread: 0.006,  bloom: 0.0025, rng: 220, minF: 0.6,  sw: 0.9, ads: 9,  rl: 2.3, rle: 0.7, spare: 6, V: 25, H: 8 },
  br:  { mag: 20, spread: 0.0065, bloom: 0.0035, rng: 260, minF: 0.65, sw: 1.1, ads: 7,  rl: 2.5, rle: 0.8, spare: 5, V: 30, H: 18 },
  lmg: { mag: 100, spread: 0.0075, bloom: 0.003,  rng: 300, minF: 0.6,  sw: 1.4, ads: 5,  rl: 5.2, rle: 1.0, spare: 2, V: 28, H: 16 },
  dmr: { mag: 10, spread: 0.0025, bloom: 0.0012, rng: 450, minF: 0.8,  sw: 1.5, ads: 6,  rl: 2.8, rle: 0.8, spare: 5, V: 36, H: 30 },
  snp: { mag: 5, spread: 0.0008, bloom: 0,      rng: 700, minF: 0.9,  sw: 2.4, ads: 5,  rl: 3.2, rle: 0,   spare: 5, V: 42, H: 30 },
  smg: { mag: 30, spread: 0.010,  bloom: 0.002,  rng: 110, minF: 0.4,  sw: 0.8, ads: 11, rl: 2.0, rle: 0.6, spare: 6, V: 17, H: 18 },
  sg:  { mag: 7, spread: 0.030,  bloom: 0,      rng: 40,  minF: 0.08,  sw: 1.0, ads: 8,  rl: 0,   rle: 0,   spare: 4, V: 100, H: 24, tube: true, rlr: 0.6 },
  pst: { mag: 15, spread: 0.010,  bloom: 0.004,  rng: 70,  minF: 0.35, sw: 0.7, ads: 13, rl: 1.6, rle: 0.5, spare: 4, V: 27, H: 26 }
};
const WEAPONS = {};
// Nahkampfwaffe für alle: Mistgabel (Taste 3). Sie steht nicht in WEAPONS (sonst erschiene sie im Auswahlmenü), der Client bekommt sie extra.
// dmg = Schaden von vorn, back = Schaden in den Rücken (der Getroffene schaut in dieselbe Richtung wie du), reach = Reichweite in Metern, cd = Pause zwischen zwei Stichen (ms)
const FORK = { id: 'fork', cat: 'mel', n: 'Mistgabel', modes: ['s'], mag: 0, ch: 0, spare: 0, rpm: 80, rate: 0.75, v: 0, dmg: 55, back: 100, reach: 2.9, cd: 750, wt: 10, sw: 0.5, ads: 10, scope: 0, rng: 3, minF: 1, spread: 0, bloom: 0, pel: 1, pelSp: 0, sup: false, rl: 0, rle: 0, V: 0, H: 0, rc: { up: 0, side: 0 }, snd: 'fork', pierce: true, open: false, act: null };
function defW(cat, id, name, o) {
  const c = CATS[cat], w = Object.assign({ id, cat, n: name, modes: ['a', 's'], pel: 1, pelSp: 0, open: false, sup: false, scope: 0, act: null, wt: 16 }, c, o);
  if (w.ch === undefined) w.ch = (w.tube || w.open || w.rev || id === 'garand') ? 0 : 1;   // Patrone im Lauf: Waffen mit geschlossenem Verschluss fassen eine Patrone mehr
  if (w.pierce === undefined) w.pierce = cat === 'snp' || cat === 'dmr' || w.dmg >= 70 || id === 'mp7' || id === 'p90';   // panzerbrechend: Weste hilft weniger
  w.rate = +(60 / w.rpm).toFixed(4);                         // Sekunden zwischen zwei Schüssen
  w.rc = { up: +Math.min(0.065, w.V * 0.0004 * (cat === 'snp' || cat === 'dmr' ? 1.7 : 1)).toFixed(4), side: +Math.min(0.016, w.H * 0.0007).toFixed(4) };
  WEAPONS[id] = w; return w;
}
// --- Sturmgewehre und Karabiner ---
defW('ar', 'm4a1', 'M4A1', { rpm: 741, v: 910, dmg: 52, wt: 15, V: 25, H: 7, snd: 'r556', legacy: 'sturm' });
defW('ar', 'mk18', 'Mk 18 CQBR', { rpm: 741, v: 780, dmg: 50, wt: 14, V: 22, H: 11, rng: 180, snd: 'r556' });
defW('ar', 'm16a4', 'M16A4', { rpm: 800, v: 940, dmg: 54, wt: 17, V: 24, H: 6, rng: 250, spread: 0.0045, modes: ['s', 'b'], snd: 'r556' });
defW('ar', 'g36k', 'H&K G36K', { rpm: 741, v: 850, dmg: 52, wt: 18, V: 26, H: 10, snd: 'r556' });
defW('ar', 'l85a2', 'L85A2', { rpm: 652, v: 940, dmg: 53, wt: 18, V: 24, H: 7, spread: 0.0055, snd: 'r556' });
defW('ar', 'famas', 'FAMAS F1', { rpm: 1000, v: 930, dmg: 50, mag: 25, wt: 17, V: 28, H: 21, modes: ['a', 'b', 's'], snd: 'r556' });
defW('ar', 'ak74', 'AK-74', { rpm: 652, v: 900, dmg: 54, wt: 16, V: 25, H: 7, snd: 'r545' });
defW('ar', 'akm', 'AKM', { rpm: 600, v: 715, dmg: 62, wt: 20, V: 28, H: 13, spread: 0.007, snd: 'r762s' });
defW('ar', 'aks74u', 'AKS-74U', { rpm: 700, v: 735, dmg: 50, wt: 12, V: 24, H: 12, rng: 150, spread: 0.007, snd: 'r545' });
defW('ar', 'asval', 'AS Val', { rpm: 1000, v: 295, dmg: 55, mag: 20, wt: 14, V: 28, H: 13, rng: 160, sup: true, snd: 'sup' });
defW('ar', 'honeybadger', 'Honey Badger', { rpm: 857, v: 259, dmg: 58, wt: 13, V: 26, H: 10, rng: 170, sup: true, snd: 'sup' });
// --- Gefechtsgewehre ---
defW('br', 'fal', 'FN FAL', { rpm: 698, v: 810, dmg: 70, mag: 20, wt: 24, V: 33, H: 26, snd: 'r762' });
defW('br', 'g3a3', 'H&K G3A3', { rpm: 500, v: 800, dmg: 72, mag: 20, wt: 24, V: 29, H: 15, snd: 'r762' });
defW('br', 'mk17', 'Mk 17 Mod 0', { rpm: 600, v: 715, dmg: 68, mag: 20, wt: 24, V: 27, H: 12, snd: 'r762' });
// --- Maschinengewehre (Gurt-/Trommelmagazin: ein "Magazin" ist ein Gurtkasten) ---
defW('lmg', 'm249', 'M249 SAW', { rpm: 741, v: 915, dmg: 50, mag: 200, spare: 1, wt: 28, V: 22, H: 12, rl: 6.0, open: true, snd: 'lmg556' });
defW('lmg', 'm60e4', 'M60E4', { rpm: 652, v: 853, dmg: 66, mag: 100, spare: 1, wt: 30, V: 30, H: 18, rl: 5.5, open: true, snd: 'lmg762' });
defW('lmg', 'pkm', 'PKM', { rpm: 652, v: 825, dmg: 66, mag: 100, spare: 1, wt: 26, V: 34, H: 30, rl: 5.5, open: true, snd: 'lmg762' });
defW('lmg', 'mg3', 'MG3', { rpm: 1200, v: 820, dmg: 66, mag: 120, spare: 1, wt: 30, V: 28, H: 18, rl: 6.0, open: true, snd: 'lmg762' });
defW('lmg', 'rpk', 'RPK', { rpm: 600, v: 745, dmg: 62, mag: 40, spare: 4, wt: 22, V: 28, H: 14, rl: 2.8, spread: 0.0065, snd: 'r762s' });
// --- Scharfschützen: Repetierer (Patronen im Gehäuse / Magazin), Selbstlader ---
defW('snp', 'm24', 'M24', { rpm: 55, v: 790, dmg: 135, mag: 5, tube: true, rlr: 0.8, spare: 30, modes: ['s'], wt: 22, V: 42, H: 30, scope: 18, act: 'bolt', snd: 'bolt', legacy: 'scharf' });
defW('snp', 'mosin', 'Mosin-Nagant', { rpm: 55, v: 865, dmg: 140, mag: 5, tube: true, rlr: 0.7, spare: 30, modes: ['s'], wt: 20, V: 41, H: 32, scope: 0, act: 'bolt', snd: 'bolt' });
defW('snp', 'tac338', 'TAC-338', { rpm: 55, v: 869, dmg: 150, mag: 5, tube: false, spare: 5, modes: ['s'], wt: 24, V: 45, H: 31, scope: 18, act: 'bolt', rl: 3.0, rle: 0.9, snd: 'bolt338' });
defW('snp', 'm82a1', 'M82A1 CQ', { rpm: 32, v: 853, dmg: 200, mag: 5, tube: false, spare: 4, modes: ['s'], wt: 28, V: 96, H: 89, scope: 18, rl: 3.8, rle: 1.0, snd: 'amr' });
defW('dmr', 'svd', 'SVD Dragunov', { rpm: 160, v: 830, dmg: 80, mag: 10, modes: ['s'], wt: 22, V: 34, H: 36, scope: 28, snd: 'dmr' });
defW('dmr', 'm110', 'M110 SASS', { rpm: 160, v: 850, dmg: 82, mag: 10, modes: ['s'], wt: 26, V: 34, H: 38, scope: 28, snd: 'dmr' });
defW('dmr', 'mk14', 'Mk 14 EBR', { rpm: 732, v: 850, dmg: 78, mag: 20, modes: ['s', 'b'], wt: 24, V: 39, H: 44, scope: 28, snd: 'dmr' });
defW('dmr', 'garand', 'M1 Garand', { rpm: 160, v: 853, dmg: 75, mag: 8, modes: ['s'], wt: 22, V: 50, H: 50, spare: 6, rl: 2.2, rle: 0.8, spread: 0.003, snd: 'dmr' });
// --- Maschinenpistolen ---
defW('smg', 'mp5a5', 'MP5A5', { rpm: 800, v: 400, dmg: 38, wt: 12, V: 17, H: 19, modes: ['a', 'b', 's'], snd: 'smg9', legacy: 'sani' });
defW('smg', 'mp5a2', 'MP5A2', { rpm: 800, v: 400, dmg: 38, wt: 12, V: 17, H: 19, snd: 'smg9', legacy: 'sani' });
defW('smg', 'mp7', 'MP7A1', { rpm: 952, v: 735, dmg: 36, mag: 20, wt: 9, V: 18, H: 20, rng: 130, snd: 'pdw' });
defW('smg', 'uzi', 'IMI Uzi', { rpm: 600, v: 400, dmg: 38, mag: 25, wt: 10, V: 16, H: 16, rng: 100, spread: 0.011, open: true, snd: 'smg9' });
defW('smg', 'vector', 'Vector', { rpm: 1200, v: 280, dmg: 44, mag: 25, wt: 11, V: 8, H: 30, rng: 90, minF: 0.3, snd: 'smg45' });
defW('smg', 'p90', 'P90', { rpm: 875, v: 715, dmg: 34, mag: 50, wt: 12, V: 22, H: 26, rng: 120, snd: 'pdw' });
defW('smg', 'm3', 'M3 Grease Gun', { rpm: 451, v: 280, dmg: 46, mag: 30, wt: 12, V: 16, H: 16, rng: 90, spread: 0.012, open: true, snd: 'smg45' });
defW('smg', 'sterling', 'Sterling Mk 4', { rpm: 500, v: 381, dmg: 38, mag: 34, wt: 12, V: 17, H: 18, rng: 100, open: true, snd: 'smg9' });
// --- Schrotflinten ---
defW('sg', 'm870', 'Remington 870', { rpm: 80, v: 400, mag: 7, spare: 28, pel: 9, dmg: 34, pelSp: 0, modes: ['s'], wt: 17, act: 'pump', snd: 'sg', legacy: 'hirte' });
defW('sg', 'toz194', 'TOZ-194', { rpm: 80, v: 400, mag: 7, spare: 28, pel: 9, dmg: 34, modes: ['s'], wt: 15, act: 'pump', snd: 'sg', legacy: 'hirte' });
defW('sg', 'ksg', 'Kel-Tec KSG', { rpm: 80, v: 425, mag: 14, spare: 28, pel: 9, dmg: 30, spread: 0.032, modes: ['s'], wt: 20, act: 'pump', rlr: 0.55, snd: 'sg', legacy: 'hirte' });
defW('sg', 'usas12', 'USAS-12', { rpm: 80, v: 400, mag: 10, tube: false, spare: 4, pel: 9, dmg: 28, spread: 0.034, modes: ['a', 's'], wt: 26, rl: 3.4, rle: 0.8, snd: 'sg', legacy: 'hirte' });
defW('sg', 'ks23', 'KS-23', { rpm: 55, v: 415, mag: 3, spare: 21, pel: 8, dmg: 46, spread: 0.045, modes: ['s'], wt: 22, act: 'pump', rlr: 0.9, snd: 'sgh', legacy: 'hirte' });
// --- Pistolen (Zweitwaffe) ---
defW('pst', 'makarov', 'Makarov PM', { rpm: 261, v: 315, dmg: 30, mag: 8, wt: 4, V: 20, H: 21, modes: ['s'], snd: 'pistol9' });
defW('pst', 'm9', 'Beretta M9', { rpm: 261, v: 381, dmg: 34, mag: 15, wt: 5, V: 27, H: 26, modes: ['s'], snd: 'pistol9' });
defW('pst', 'm1911', 'Colt M1911', { rpm: 261, v: 253, dmg: 46, mag: 7, wt: 5, V: 36, H: 46, modes: ['s'], snd: 'pistol45' });
defW('pst', 'pf940', 'PF940', { rpm: 261, v: 450, dmg: 34, mag: 17, wt: 5, V: 26, H: 27, modes: ['s'], snd: 'pistol9' });
defW('pst', 'deagle', 'Desert Eagle', { rpm: 200, v: 440, dmg: 72, mag: 7, wt: 7, V: 70, H: 50, rng: 110, minF: 0.5, spread: 0.008, modes: ['s'], snd: 'magnum' });
defW('pst', 'mr73', 'MR 73', { rpm: 150, v: 430, dmg: 60, mag: 6, wt: 6, V: 60, H: 40, rng: 100, minF: 0.5, spread: 0.007, modes: ['s'], rl: 3.3, rle: 0, rev: true, snd: 'magnum' });

// Klassen: Fähigkeit-Abklingzeit (cd) und wählbare Hauptwaffen. Zweitwaffe: jede Pistole.
const CLASSES = {
  sturm: { n: 'Sturmsoldat', cd: 20, guns: ['m4a1', 'mk18', 'm16a4', 'g36k', 'l85a2', 'famas', 'ak74', 'akm', 'aks74u', 'asval', 'honeybadger', 'fal', 'g3a3', 'mk17'] },
  mg: { n: 'MG-Schütze', cd: 30, guns: ['m249', 'm60e4', 'pkm', 'mg3', 'rpk'] },
  scharf: { n: 'Scharfschütze', cd: 25, guns: ['m24', 'mosin', 'tac338', 'm82a1', 'svd', 'm110', 'mk14', 'garand'] },
  sani: { n: 'Sanitäter', cd: 25, guns: ['mp5a5', 'mp5a2', 'mp7', 'uzi', 'vector', 'p90', 'm3', 'sterling'] },
  hirte: { n: 'Hirte', cd: 20, guns: ['m870', 'toz194', 'ksg', 'usas12', 'ks23'] },
  pionier: { n: 'Pionier', cd: 22, guns: ['aks74u', 'g36k', 'mp7', 'mp5a2', 'm870', 'ksg'] }   // baut Sandsack-Deckungen
};
const ATTS = { sup: 'Schalldämpfer', grip: 'Vordergriff', laser: 'Laser' };               // Aufsätze für die Hauptwaffe
const safeAtt = a => ATTS[a] ? a : '';
const safeNade = v => v === 'smoke' ? 'smoke' : v === 'flash' ? 'flash' : 'frag';
const PISTOLS = ['makarov', 'm9', 'm1911', 'pf940', 'deagle', 'mr73'];
const CLASS_KEYS = Object.keys(CLASSES);
const FAST_RELOAD = 0.62, DOUBLE_R_MS = 450;               // schnelles Nachladen (zweimal R): Zeitfaktor, Zeitfenster für den zweiten Druck
const SWITCH_MS = { pst: 380, other: 620 };                 // Waffenwechsel: Dauer bis zur Schussbereitschaft (Ziel Pistole / Hauptwaffe)
// Ablagen (Taste Q): Sanitäter legt ein Medkit, MG-Schütze eine Munitionskiste ab. Nur das eigene Team kann sie aufnehmen (Drüberlaufen, nur wenn es etwas bringt).
const DROP_LIFE = 90000, DROP_MAX = 24, DROP_HEAL = 60, DROP_AMMO_MAGS = 2, DROP_AMMO_USES = 3, DROP_OWNER_DELAY = 3000;   // Lebensdauer ms, max. gleichzeitig, Heilung je Medkit, Magazine je Entnahme, Entnahmen je Kiste, Sperre für den Ablegenden ms
let drops = [], nextDrop = 1;
const GRAVITY = 9.81, DROP_AFTER = 0.1, MAX_FLIGHT = 3.0;   // Geschosse fallen erst nach 0,1 s (wie in Sandstorm); längste Flugzeit
const safeLoadout = (cls, w1, w2) => {
  const c = CLASSES[cls] ? cls : 'sturm';
  return { cls: c, w1: CLASSES[c].guns.includes(w1) ? w1 : CLASSES[c].guns[0], w2: PISTOLS.includes(w2) ? w2 : PISTOLS[1] };
};
const CLASS_BAG = ['sturm', 'sturm', 'mg', 'scharf', 'sani', 'hirte', 'pionier'];   // Bots würfeln ihre Klasse mit dieser Gewichtung
const randLoadout = () => { const c = CLASS_BAG[Math.floor(Math.random() * CLASS_BAG.length)], g = CLASSES[c].guns; return safeLoadout(c, g[Math.floor(Math.random() * g.length)], PISTOLS[Math.floor(Math.random() * PISTOLS.length)]); };
// ---------- Welt: Dorf mit Gelände (zufällig erzeugt, wird an Clients gesendet) ----------
// world.js erzeugt aus einer Zahl (seed) Höhenkarte, Straßen, Häuser, Kirche, Höfe, Felder, Teich, Bäume und die Orte der Items.
// Bei jedem neuen Spiel (und beim Serverstart) wird ein neuer seed gewürfelt = neue Karte. Feste Karte: Umgebungsvariable SEED, z. B. PowerShell:  $env:SEED=12345; npm start
// Der Client bekommt dieselben Daten und berechnet damit exakt dieselbe Bodenhöhe wie der Server.
const SEED_FIXED = process.env.SEED ? (parseInt(process.env.SEED, 10) >>> 0) : 0;
const newSeed = () => SEED_FIXED || ((Math.floor(Math.random() * 4e9) >>> 0) || 1);
let WORLD, houses, props, trees, groundY, HMAX, PICK, shootBoxes, treeBoxes, glassPanes = [];       // werden von loadWorld() gesetzt
const solidBoxes = [], solidCircles = [];                                          // feste Hindernisse für Bots (siehe buildSolids)
// ---------- Schuss-Hüllen (SHAPES-BEGIN) ----------
// Jede Hülle ist ein Kasten (x, z, w, d, y, h = Hüllkasten, auch für Vorauswahl und Granaten) und trägt optional eine genaue Form:
//   sh 'f': Zylinder / Kegelstumpf mit Achse a (0 = x, 1 = y, 2 = z), Punkt c auf der Achse, Achsbereich s0..s1, Radius r0 bei s0 und r1 bei s1
//   sh 'p': konvexer Körper aus Ebenen n·(p - c) <= k (n ist normiert), z. B. Dachprisma oder Kirchturmspitze
// So blockiert ein Schuss nur dort, wo auch etwas Sichtbares steht (runde Dinge sind nicht eckig, Brunnen und Wagen haben Lücken).
const bboxOf = (x0, x1, y0, y1, z0, z1) => ({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, y: y0, h: y1 - y0 });
function shpFrustum(a, c, s0, s1, r0, r1) {
  const r = Math.max(r0, r1), lo = [c[0] - r, c[1] - r, c[2] - r], hi = [c[0] + r, c[1] + r, c[2] + r]; lo[a] = s0; hi[a] = s1;
  return { ...bboxOf(lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]), sh: 'f', a, c, s0, s1, r0, r1 };
}
function shpPoly(c, planes, ext) {   // ext = Hüllkasten relativ zu c: [x0, x1, y0, y1, z0, z1]
  const pl = planes.map(([nx, ny, nz, k]) => { const l = Math.hypot(nx, ny, nz); return [nx / l, ny / l, nz / l, k / l]; });
  return { ...bboxOf(c[0] + ext[0], c[0] + ext[1], c[1] + ext[2], c[1] + ext[3], c[2] + ext[4], c[2] + ext[5]), sh: 'p', c, pl };
}
function rayFrustum(o, d, b) {
  const a = b.a, p = (a + 1) % 3, q = (a + 2) % 3, op = o[p] - b.c[p], oq = o[q] - b.c[q], vp = d[p], vq = d[q], oa = o[a], va = d[a];
  let lo = 0, hi = 1e9;
  if (Math.abs(va) < 1e-9) { if (oa < b.s0 || oa > b.s1) return 1e9; }
  else { let t1 = (b.s0 - oa) / va, t2 = (b.s1 - oa) / va; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } lo = Math.max(lo, t1); hi = Math.min(hi, t2); if (lo > hi) return 1e9; }
  const g = (b.r1 - b.r0) / (b.s1 - b.s0), sr = b.r0 + g * (oa - b.s0);                       // Radius am Startpunkt und Änderung pro Achsenstrecke
  const A = vp * vp + vq * vq - g * g * va * va, B = op * vp + oq * vq - sr * g * va, C = op * op + oq * oq - sr * sr;   // innen, wenn A t² + 2 B t + C <= 0
  let best = 1e9; const take = (u0, u1) => { if (u0 <= u1 && u0 < best) best = u0; };
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) < 1e-12) { if (C <= 0) take(lo, hi); }
    else { const t = -C / (2 * B); if (B > 0) take(lo, Math.min(hi, t)); else take(Math.max(lo, t), hi); }
  } else {
    const disc = B * B - A * C;
    if (disc < 0) { if (A < 0) take(lo, hi); }
    else {
      const sq = Math.sqrt(disc); let ra = (-B - sq) / A, rb = (-B + sq) / A; if (ra > rb) { const t = ra; ra = rb; rb = t; }
      if (A > 0) take(Math.max(lo, ra), Math.min(hi, rb)); else { take(lo, Math.min(hi, ra)); take(Math.max(lo, rb), hi); }
    }
  }
  return best;
}
function rayPoly(o, d, b) {
  const ox = o[0] - b.c[0], oy = o[1] - b.c[1], oz = o[2] - b.c[2]; let tn = 0, tf = 1e9;
  for (const [nx, ny, nz, k] of b.pl) {
    const dn = nx * d[0] + ny * d[1] + nz * d[2], dist = k - (nx * ox + ny * oy + nz * oz);
    if (Math.abs(dn) < 1e-12) { if (dist < 0) return 1e9; }
    else { const t = dist / dn; if (dn < 0) { if (t > tn) tn = t; } else if (t < tf) tf = t; if (tn > tf) return 1e9; }
  }
  return tn;
}
function rayBox(o, d, b) {
  let tn = 0, tf = 1e9;
  for (const [a, lo, hi] of [[0, b.x - b.w / 2, b.x + b.w / 2], [1, b.y || 0, (b.y || 0) + b.h], [2, b.z - b.d / 2, b.z + b.d / 2]]) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo || o[a] > hi) return 1e9; }
    else {
      let t1 = (lo - o[a]) / d[a], t2 = (hi - o[a]) / d[a];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tn = Math.max(tn, t1); tf = Math.min(tf, t2);
      if (tn > tf) return 1e9;
    }
  }
  return b.sh === 'f' ? rayFrustum(o, d, b) : b.sh === 'p' ? rayPoly(o, d, b) : tn;       // Hüllkasten getroffen: bei runden Formen genau nachrechnen
}
function inShape(x, y, z, b, R) {   // liegt der Punkt (mit Abstand R) in der Hülle? (Granaten)
  if (x <= b.x - b.w / 2 - R || x >= b.x + b.w / 2 + R || z <= b.z - b.d / 2 - R || z >= b.z + b.d / 2 + R || y <= b.y - R || y >= b.y + b.h + R) return false;
  if (b.sh === 'f') {
    const p = [x, y, z], a = b.a, pp = (a + 1) % 3, qq = (a + 2) % 3, s = p[a];
    if (s < b.s0 - R || s > b.s1 + R) return false;
    const rr = Math.max(0, b.r0 + (b.r1 - b.r0) * Math.max(0, Math.min(1, (s - b.s0) / (b.s1 - b.s0)))) + R, dp = p[pp] - b.c[pp], dq = p[qq] - b.c[qq];
    return dp * dp + dq * dq < rr * rr;
  }
  if (b.sh === 'p') { for (const [nx, ny, nz, k] of b.pl) if (nx * (x - b.c[0]) + ny * (y - b.c[1]) + nz * (z - b.c[2]) > k + R) return false; }
  return true;
}
// Satteldach wie im Client (addRoof): zwei dünne Dachplatten (0,14 m) und zwei Giebeldreiecke; darunter ist es hohl, Schüsse treffen nur sichtbare Fläche
function roofShapes(h) {
  const top = h.y + h.h, alongX = h.w >= h.d, lu = (alongX ? h.w : h.d) / 2, lv = (alongX ? h.d : h.w) / 2;
  const rh = 0.4 * Math.min(h.w, h.d) + 0.6 - (h.k === 4 ? 0.7 : 0), ovE = 0.55, ovG = 0.35, th = 0.14, slope = rh / lv, eyRel = -ovE * slope, U = lu + ovG, V = lv + ovE;
  const mk = (nu, ny, nv, k) => alongX ? [nu, ny, nv, k] : [nv, ny, nu, k];                       // (u = entlang des Firsts, y, v = quer) -> (x, y, z)
  const ext = (u0, u1, y0, y1, v0, v1) => alongX ? [u0, u1, y0, y1, v0, v1] : [v0, v1, y0, y1, u0, u1];
  const out = [], c = [h.x, top, h.z], dh = rh - eyRel;
  for (const sv of [-1, 1]) out.push(shpPoly(c, [
    mk(0, V, sv * dh, V * rh), mk(0, -V, -sv * dh, -(V * rh - th * V)),                          // Oberseite und Unterseite der Platte
    mk(0, 0, sv, V), mk(0, 0, -sv, 0), mk(1, 0, 0, U), mk(-1, 0, 0, U)],                         // Traufkante, First, Giebelseiten
    ext(-U, U, eyRel - th, rh, sv > 0 ? 0 : -V, sv > 0 ? V : 0)));
  for (const su of [-1, 1]) out.push(shpPoly(c, [
    mk(su, 0, 0, lu * su * su + 0.04), mk(-su, 0, 0, -lu * su * su + 0.04), mk(0, -1, 0, 0),    // Giebeldreieck: dünne Platte in der Ebene u = su * lu
    mk(0, lv, rh, lv * rh), mk(0, lv, -rh, lv * rh)],
    ext(su * lu - 0.04, su * lu + 0.04, 0, rh, -lv, lv)));
  return { shapes: out, top, rh, lu, alongX };
}
function houseShapes(h) {
  const out = [], top = h.y + h.h;
  if (!h.e) out.push({ x: h.x, z: h.z, w: h.w, d: h.d, y: h.y0, h: top - h.y0 });
  else {
    // begehbares Gebäude: einzelne Wandstücke, ein Sturz über der Tür und die Decke (Schüsse können nur durch die Tür hinein)
    for (const [x, z, hw, hd, y0, y1] of h.wb) out.push({ x, z, w: hw * 2, d: hd * 2, y: y0, h: y1 - y0 });   // Wandstücke mit Fensteröffnungen (Schüsse gehen durch die Fenster)
    const [f, ds, dw, dh] = h.dr, sx = [0, 0, 1, -1][f], sz = [1, -1, 0, 0][f], half = (sz !== 0 ? h.d : h.w) / 2, c = half - h.T / 2;
    out.push(sz !== 0 ? { x: h.x + ds, z: h.z + sz * c, w: dw, d: h.T, y: h.y + dh, h: top - h.y - dh } : { x: h.x + sx * c, z: h.z + ds, w: h.T, d: dw, y: h.y + dh, h: top - h.y - dh });
    out.push({ x: h.x, z: h.z, w: h.w, d: h.d, y: top - 0.3, h: 0.3 });             // Decke
  }
  if (h.k === 3) {                                                                  // Kirche: Turmspitze (vierseitige Pyramide, 9 m hoch)
    const b = h.w / 2 + 0.14;
    out.push(shpPoly([h.x, top, h.z], [[0, -1, 0, 0], [9, b, 0, 9 * b], [-9, b, 0, 9 * b], [0, b, 9, 9 * b], [0, b, -9, 9 * b]], [-b, b, 0, 9, -b, b]));
  } else {
    const r = roofShapes(h); out.push(...r.shapes);
    if (h.k === 0) {                                                                // Schornstein (Client: 0,9 m breit, bis 1,1 m über den First, Deckplatte 1,1 m)
      const qx = r.alongX ? h.x + r.lu * 0.45 : h.x, qz = r.alongX ? h.z : h.z + r.lu * 0.45;
      out.push(bboxOf(qx - 0.45, qx + 0.45, r.top, r.top + r.rh + 1.0, qz - 0.45, qz + 0.45), bboxOf(qx - 0.55, qx + 0.55, r.top + r.rh + 1.0, r.top + r.rh + 1.15, qz - 0.55, qz + 0.55));
    }
  }
  return out;
}
function propShapes(p) {
  const x = p.x, z = p.z, y = p.y, out = [], box = (x0, x1, y0, y1, z0, z1) => out.push(bboxOf(x0, x1, y0, y1, z0, z1));
  if (p.k === 'fence') {                                                            // Pfosten und beide sichtbaren Zaunlatten blockieren Geschosse
    const ax = p.w >= p.d, len = ax ? p.w : p.d, hw = ax ? len / 2 : 0.07, hd = ax ? 0.07 : len / 2;
    for (const sg of [-1, 1]) {
      const px = x + (ax ? sg * (len / 2 - 0.07) : 0), pz = z + (ax ? 0 : sg * (len / 2 - 0.07));
      box(px - 0.07, px + 0.07, y - 0.25, y + 1.15, pz - 0.07, pz + 0.07);
    }
    for (const hh of [0.5, 0.95]) box(x - hw, x + hw, y + hh - 0.07, y + hh + 0.07, z - hd, z + hd);
  } else if (p.k === 'hay') {                                                       // Rundballen: liegender Zylinder (Radius 0,75) entlang der längeren Seite
    const ax = p.w >= p.d, len = ax ? p.w : p.d;
    out.push(shpFrustum(ax ? 0 : 2, [x, y + 0.75, z], (ax ? x : z) - len / 2, (ax ? x : z) + len / 2, 0.73, 0.73));
  } else if (p.k === 'stack') {                                                     // Strohschober: Zylinder (Radius 2,1) mit Kegeldach
    out.push(shpFrustum(1, [x, 0, z], y - 0.2, y + 1.2, 2.05, 2.05), shpFrustum(1, [x, 0, z], y + 1.2, y + 3.6, 2.15, 0));
  } else if (p.k === 'silo') {
    out.push(shpFrustum(1, [x, 0, z], y - 0.3, y + 9, 2.26, 2.26), shpFrustum(1, [x, 0, z], y + 9, y + 10.6, 2.36, 0));
  } else if (p.k === 'well') {                                                      // Brunnen: Steinring, zwei Pfosten, Balken und Dach; dazwischen ist Luft
    out.push(shpFrustum(1, [x, 0, z], y - 0.3, y + 1.0, 1.07, 1.07));
    for (const sg of [-1, 1]) box(x + sg * 0.95 - 0.07, x + sg * 0.95 + 0.07, y, y + 2.3, z - 0.07, z + 0.07);
    box(x - 1.01, x + 1.01, y + 2.14, y + 2.26, z - 0.06, z + 0.06);
    out.push(...roofShapes({ x, z, w: 2.6, d: 1.9, y: y + 2.1, h: 0, k: 4 }).shapes);
  } else if (p.k === 'wagon') {                                                     // Wagen: Boden, zwei Seitenbretter, vier Räder; unter dem Boden und zwischen den Rädern ist frei
    const ax = p.w >= p.d, len = ax ? p.w : p.d, wd = ax ? p.d : p.w;
    box(x - p.w / 2, x + p.w / 2, y + 0.5, y + 0.7, z - p.d / 2, z + p.d / 2);
    for (const sg of [-1, 1]) {
      const off = sg * (wd / 2 - 0.05);
      if (ax) box(x - len / 2, x + len / 2, y + 0.7, y + 1.2, z + off - 0.05, z + off + 0.05); else box(x + off - 0.05, x + off + 0.05, y + 0.7, y + 1.2, z - len / 2, z + len / 2);
    }
    for (const wl of [-1, 1]) for (const sg of [-1, 1]) {
      const cx = x + (ax ? wl * (len / 2 - 0.55) : sg * (wd / 2 + 0.05)), cz = z + (ax ? sg * (wd / 2 + 0.05) : wl * (len / 2 - 0.55));
      out.push(shpFrustum(ax ? 2 : 0, [cx, y + 0.55, cz], (ax ? cz : cx) - 0.07, (ax ? cz : cx) + 0.07, 0.53, 0.53));
    }
  } else if (p.k === 'trough') box(x - p.w / 2, x + p.w / 2, y - 0.1, y + 0.61, z - p.d / 2, z + p.d / 2);
  else if (p.k === 'wood') box(x - p.w / 2, x + p.w / 2, y - 0.2, y + 1.25, z - p.d / 2, z + p.d / 2);
  else if (p.k === 'bench') {
    const ax = p.w >= p.d, len = ax ? p.w : p.d;
    box(x - (ax ? len / 2 : 0.25), x + (ax ? len / 2 : 0.25), y + 0.465, y + 0.535, z - (ax ? 0.25 : len / 2), z + (ax ? 0.25 : len / 2));
    for (const sg of [-1, 1]) box(x + (ax ? sg * (len / 2 - 0.2) : 0) - (ax ? 0.04 : 0.25), x + (ax ? sg * (len / 2 - 0.2) : 0) + (ax ? 0.04 : 0.25), y, y + 0.5, z + (ax ? 0 : sg * (len / 2 - 0.2)) - (ax ? 0.25 : 0.04), z + (ax ? 0 : sg * (len / 2 - 0.2)) + (ax ? 0.25 : 0.04));
  } else if (p.k === 'lamp') {
    out.push(shpFrustum(1, [x, 0, z], y - 0.2, y + 3.6, 0.07, 0.07));
    box(x - 0.2, x + 0.2, y + 3.35, y + 3.85, z - 0.2, z + 0.2);
    out.push(shpFrustum(1, [x, 0, z], y + 3.95, y + 4.25, 0.4, 0));
  } else if (p.k === 'sign') {
    box(x - 0.06, x + 0.06, y - 0.2, y + 2.4, z - 0.06, z + 0.06);
    box(x - 0.75, x + 0.75, y + 1.45, y + 1.95, z - 0.035, z + 0.035);
  }
  return out;
}
function penShotShapes() {
  const out = [], box = (x, z, w, d, y) => out.push(bboxOf(x - w / 2, x + w / 2, y - 0.25, y + 1.25, z - d / 2, z + d / 2));
  PEN.forEach((p, t) => {
    const s = PEN_R * 2, inner = (p.s || (t === 0 ? 1 : -1)) * PEN_R, outer = -inner, y = groundY(p.x, p.z);
    box(p.x, p.z - PEN_R, s, 0.2, y); box(p.x, p.z + PEN_R, s, 0.2, y); box(p.x + outer, p.z, 0.2, s, y);
    const gateHalf = 3, gateSeg = PEN_R - gateHalf, gateOffset = (PEN_R + gateHalf) / 2;
    box(p.x + inner, p.z - gateOffset, 0.2, gateSeg, y); box(p.x + inner, p.z + gateOffset, 0.2, gateSeg, y);
    out.push(shpFrustum(1, [p.x, 0, p.z], y + 0.4, y + 9.1, 0.15, 0.15));
    out.push(shpFrustum(1, [p.x, 0, p.z], y, y + 0.4, 0.55, 0.35));
    for (let i = 0; i < 3; i++) out.push(shpFrustum(0, [p.x + (outer < 0 ? -1 : 1) * (PEN_R - 2.5), y + 0.8, p.z + (i - 1) * 4], p.x + (outer < 0 ? -1 : 1) * (PEN_R - 2.5) - 0.6, p.x + (outer < 0 ? -1 : 1) * (PEN_R - 2.5) + 0.6, 0.8, 0.8));
  });
  return out;
}
function trenchShotShapes(terrain) {
  const out = [];
  for (const q of (terrain && terrain.pits) || []) {
    const lv = (a, b) => a < 0 || b < 0 || a >= q.nx || b >= q.nz ? 0 : q.d.charCodeAt(b * q.nx + a) - 48;
    for (let b = 0; b < q.nz; b++) for (let a = 0; a < q.nx; a++) {
      const l = lv(a, b); if (!l) continue;
      const cx = q.x + (a + 0.5) * q.q, cz = q.z + (b + 0.5) * q.q, floor = groundY(cx, cz);
      for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = lv(a + da, b + db); if (n >= l) continue;
        const hh = (l - n) * q.st, ex = cx + da * q.q / 2, ez = cz + db * q.q / 2, alongX = da === 0;
        out.push(bboxOf(ex - (alongX ? q.q / 2 : 0.06 / 2), ex + (alongX ? q.q / 2 : 0.06 / 2), floor, floor + hh, ez - (alongX ? 0.06 / 2 : q.q / 2), ez + (alongX ? 0.06 / 2 : q.q / 2)));
      }
    }
  }
  return out;
}
function treeShape(t) {                                                             // nur der Stamm blockiert (Laub nicht); Maße wie im Client
  const s = t.s, r = [0.28, 0.30, 0.19][t.k] * s, top = [2.4, 3.0, 1.6][t.k] * s;
  return shpFrustum(1, [t.x, 0, t.z], t.y - 0.3, t.y + top, r, r);
}
// (SHAPES-END)
function loadWorld(seed) {
  const t0 = Date.now();
  WORLD = require('./world')({ PEN, PEN_R, MAP, seed });
  ({ houses, props, trees, groundY } = WORLD);
  HMAX = WORLD.hmax;                                                               // höchster Punkt des Geländes (für die Strahlenprüfung)
  PICK = WORLD.pick.map(k => ({ ...k, until: 0 }));                                // Aufsammelbare Items: Helm, Schutzweste, Munition (vor den Haustüren)
  // Flächen, die Schüsse und Sicht blockieren: Gebäude (vom Fundament bis zum First der Wand), hohe Gegenstände (Brunnen, Silo, Heu, Holz ...) und Baumstämme
  shootBoxes = [];
  for (const h of houses) shootBoxes.push(...houseShapes(h));
  glassPanes = [];                                                                  // Fensterscheiben: das erste Geschoss, das sie trifft, zerstört sie und fliegt weiter
  for (const h of houses) if (h.e && h.gl) for (const g of h.gl) glassPanes.push({ id: glassPanes.length, x: g[0], z: g[1], w: g[2] * 2, d: g[3] * 2, y: g[4], h: g[5], broken: false });
  for (const p of props) shootBoxes.push(...propShapes(p));
  shootBoxes.push(...penShotShapes(), ...trenchShotShapes(WORLD.terrain));
  treeBoxes = trees.map(treeShape);
  buildSolids(); buildDoors(); buildNav();
  console.log(`Neue Karte #${WORLD.seed}: ${houses.length} Gebäude, ${trees.length} Bäume, ${WORLD.fields.length} Felder, ${WORLD.farms.length} Höfe (${Date.now() - t0} ms${WORLD.attempts > 1 ? ', ' + WORLD.attempts + ' Versuche' : ''})`);
}

// ---------- Zustand ----------
const players = {};
let cows = [], nextId = 1, matchEnd = 0, over = false;
let phase = 'play', lobbyEnd = 0, voteEnd = 0, voteOpts = [], voteGen = 0, voteTimer = null;   // Ablauf: 'lobby' (Warteraum) -> 'play' -> 'over' (Statistik + Kartenwahl) -> 'lobby' ...
let quadList = [], nades = [], smokes = [], nextNid = 1;   // Quads, Granaten im Flug, Rauchwolken
let bullets = [], nextBid = 1;
let barricades = [], nextBar = 1;                 // Sandsack-Deckungen der Pioniere                      // Geschosse in der Luft

// ---------- Umgebung (Etappe 7): Tageszeit, Wetter, Wind, Türen, Tarnung im Heu, Funk ----------
// Pro Runde würfelt der Server Tageszeit und Wetter (Umgebungsvariablen TOD 0-3 und WX 0-3 legen sie fest, WIND_S / WIND_A den Wind). Der Client malt Himmel, Licht, Regen und Nebel;
// der Server nutzt es für die Spielregeln: Wind lenkt Geschosse ab, Nacht und Nebel verkürzen die Sicht der Bots, Türen blockieren Bewegung und Schüsse, Heu tarnt.
const TOD_NAMES = ['Morgen', 'Mittag', 'Abend', 'Nacht'], WX_NAMES = ['Klar', 'Bewölkt', 'Regen', 'Nebel'];
const envInt = (k, n) => { const v = process.env[k]; return v !== undefined && v !== '' && Number.isInteger(+v) && +v >= 0 && +v < n ? +v : -1; };
const TOD_FIX = envInt('TOD', 4), WX_FIX = envInt('WX', 4);
const WIND_FIX = process.env.WIND_S !== undefined && process.env.WIND_S !== '' && Number.isFinite(+process.env.WIND_S) ? Math.max(0, +process.env.WIND_S) : -1;
const WIND_ANG_FIX = process.env.WIND_A !== undefined && process.env.WIND_A !== '' && Number.isFinite(+process.env.WIND_A) ? +process.env.WIND_A : null;
const VIS_TOD = [0.85, 1, 0.9, 0.55], VIS_WX = [1, 0.95, 0.75, 0.45];   // Sichtfaktor für Bots
const WIND_K = 0.4;                                                       // Beschleunigung eines Geschosses seitlich = Windstärke (m/s) mal diesen Wert (m/s²)
let env = { tod: 1, wx: 0 }; const wind = { base: 3, ang: 0, s: 0, a: 0 };
const pickW = w => { let r = Math.random() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; } return w.length - 1; };
function stepWind(now) {
  const g = WIND_FIX >= 0 ? 1 : 1 + 0.3 * Math.sin(now / 7000) + 0.2 * Math.sin(now / 2300 + 1);
  wind.s = Math.max(0, wind.base * g); wind.a = wind.ang + (WIND_FIX >= 0 ? 0 : 0.35 * Math.sin(now / 11000));
}
function rollEnv() {
  env = { tod: TOD_FIX >= 0 ? TOD_FIX : pickW([0.25, 0.4, 0.2, 0.15]), wx: WX_FIX >= 0 ? WX_FIX : pickW([0.5, 0.25, 0.15, 0.1]) };
  const rg = [[1, 6], [2, 8], [4, 10], [0, 2]][env.wx];
  wind.base = WIND_FIX >= 0 ? WIND_FIX : rg[0] + Math.random() * (rg[1] - rg[0]);
  wind.ang = WIND_ANG_FIX !== null ? WIND_ANG_FIX : Math.random() * 6.283;
  stepWind(Date.now());
}
const envMsg = () => ({ t: 'env', tod: env.tod, wx: env.wx, wd: [+wind.a.toFixed(2), +wind.s.toFixed(1)] });
const windAcc = () => [+(Math.cos(wind.a) * wind.s * WIND_K).toFixed(3), +(Math.sin(wind.a) * wind.s * WIND_K).toFixed(3)];   // Windrichtung = wohin der Wind weht (x, z)
const visMult = () => VIS_TOD[env.tod] * VIS_WX[env.wx];
// Türen: je begehbares Gebäude eine Tür (Reihenfolge wie houses mit e = 1, der Client baut dieselbe Liste). Geschlossen blockiert sie Bewegung und Schüsse.
let doors = [], hayBoxes = [];
function buildDoors() {
  doors = [];
  for (const h of houses) {
    if (!h.e) continue;
    const [f, ds, dw, dh] = h.dr, sx = [0, 0, 1, -1][f], sz = [1, -1, 0, 0][f], half = (sz !== 0 ? h.d : h.w) / 2, c = half - h.T / 2;
    const x = sz !== 0 ? h.x + ds : h.x + sx * c, z = sz !== 0 ? h.z + sz * c : h.z + ds, w = sz !== 0 ? dw : h.T, d = sz !== 0 ? h.T : dw;
    const dr = { i: doors.length, x, z, w, d, y: h.y, h: dh, open: false };
    dr.sb = { x, z, hw: w / 2, hd: d / 2 }; dr.sh = { x, z, w, d, y: h.y, h: dh };
    solidBoxes.push(dr.sb); shootBoxes.push(dr.sh); doors.push(dr);
  }
  hayBoxes = props.filter(q => q.k === 'hay').map(q => ({ x: q.x, z: q.z, hw: q.w / 2, hd: q.d / 2 }));
  PEN.forEach(pn => { const outer = -pn.s * PEN_R; for (let i = 0; i < 3; i++) hayBoxes.push({ x: pn.x + (outer < 0 ? -1 : 1) * (PEN_R - 2.5), z: pn.z + (i - 1) * 4, hw: 0.6, hd: 0.8 }); });   // Heuballen im Gehege
}
function setDoor(dr, open) {
  if (dr.open === open) return;
  dr.open = open;
  const i = solidBoxes.indexOf(dr.sb), j = shootBoxes.indexOf(dr.sh);
  if (open) { if (i >= 0) solidBoxes.splice(i, 1); if (j >= 0) shootBoxes.splice(j, 1); }
  else { if (i < 0) solidBoxes.push(dr.sb); if (j < 0) shootBoxes.push(dr.sh); }
}
function doorToggle(p, i) {
  if (phase !== 'play' || p.dead || p.down || p.quad !== null || p.cow !== null || !Number.isInteger(i)) return;
  const dr = doors[i], now = Date.now(); if (!dr || now < (p.doorAt || 0)) return;
  p.doorAt = now + 250;
  if (Math.hypot(p.x - dr.x, p.z - dr.z) > 3.4) return;
  if (dr.open && Object.values(players).some(q => !q.dead && !q.obs && Math.abs(q.x - dr.x) < dr.w / 2 + 0.7 && Math.abs(q.z - dr.z) < dr.d / 2 + 0.7)) return send(p, { t: 'msg', x: 'Die Tür ist blockiert' });   // nicht zumachen, wenn jemand im Durchgang steht
  setDoor(dr, !dr.open);
}
// Tarnung: wer geduckt oder liegend regungslos direkt an einem Heuballen verharrt, ist für Bots und für Spieler ab 14 m nicht zu sehen (Schießen verrät ihn für 2,5 s)
const CAM_R = 14;
function camOf(q, now) {
  if (q.dead || q.down || q.moving || q.cow !== null || q.quad !== null || !(q.prone || q.crouch) || now < (q.revealUntil || 0)) return false;
  for (const b of hayBoxes) { const dx = Math.max(0, Math.abs(q.x - b.x) - b.hw), dz = Math.max(0, Math.abs(q.z - b.z) - b.hd); if (dx * dx + dz * dz < 2.25) return true; }
  return false;
}
// Funk: Schnellrufe an das eigene Team (Taste V), mit Markierung auf der Minimap
const RADIO_N = 6;
function radio(p, k, tx, tz) {
  const now = Date.now();
  if (!p.joined || p.obs || p.dead || !Number.isInteger(k) || k < 0 || k >= RADIO_N || now < (p.radioAt || 0)) return;
  p.radioAt = now + 1200;
  let x = p.x, z = p.z;
  if ((k === 0 || k === 4) && Number.isFinite(tx) && Number.isFinite(tz) && Math.hypot(tx - p.x, tz - p.z) < 450) { x = Math.max(-MAP, Math.min(MAP, tx)); z = Math.max(-MAP, Math.min(MAP, tz)); }   // Gegner / Sammelpunkt: dort, wohin du zielst
  const msg = { t: 'radio', i: p.id, n: p.name, k, x: r1(x), z: r1(z) };
  for (const q of Object.values(players)) if (q.team === p.team && !q.bot && !q.obs) send(q, msg);
}

function reset(seed) {
  barricades.slice().forEach(removeBarricade);
  if (seed && !SEED_FIXED && seed !== WORLD.seed) { loadWorld(seed); newMapAt = Date.now(); bc({ t: 'newmap', seed: WORLD.seed }); }
  doors.forEach(d => setDoor(d, false));
  rollEnv(); bc(envMsg());   // neue Karte: Clients laden die Seite neu und bekommen die neue Welt
  cows = []; let id = 0;
  for (let t = 0; t < TEAMS; t++) for (let i = 0; i < COWS_PER_TEAM; i++) {
    const a = Math.random() * 6.28, r = Math.random() * 10;
    cows.push({ id: id++, pen: t, lastName: '', x: PEN[t].x + Math.cos(a) * r, z: PEN[t].z + Math.sin(a) * r, yaw: Math.random() * 6.28, rider: null });
  }
  PICK.forEach(k => k.until = 0);
  if (glassPanes.some(g => g.broken)) { glassPanes.forEach(g => g.broken = false); bc({ t: 'ev', k: 'glassreset', i: 0, x: 0, z: 0 }); }   // gleiche Karte, neue Runde: alle Scheiben wieder ganz
  bullets = []; nades = []; smokes = []; drops = [];
  quadList = (WORLD.quads || []).map((q, i) => ({ id: i, kind: 0, x: q.x, z: q.z, yaw: q.yaw, hx: q.x, hz: q.z, hyaw: q.yaw, rider: null, spd: 0, idleAt: 0 }));
  for (const t of (WORLD.tractors || [])) { const q = { id: quadList.length, kind: 1, x: t.x, z: t.z, yaw: t.yaw, hx: t.x, hz: t.z, hyaw: t.yaw, rider: null, spd: 0, idleAt: 0, load: [] }; initTrailer(q); quadList.push(q); }
  over = false; voteOpts = [];
  if (LOBBY_S > 0) { phase = 'lobby'; lobbyEnd = Date.now() + LOBBY_S * 1000; matchEnd = Date.now() + MATCH_SECONDS * 1000; } else { phase = 'play'; matchEnd = Date.now() + MATCH_SECONDS * 1000; }
  for (const p of Object.values(players)) { p.cow = null; p.quad = null; p.kills = 0; p.deaths = 0; p.dl = 0; p.hs = 0; p.dmg = 0; p.revives = 0; p.ready = false; p.vote = -1; if (p.joined || p.bot) spawn(p); }
  if (voteTimer) clearTimeout(voteTimer);
  voteTimer = null; voteGen++;                                      // ältere Vorschau abbrechen bzw. beim nächsten Ergebnis ignorieren
  if (!SEED_FIXED) {
    const delay = Math.min(90000, Math.max(3000, MATCH_SECONDS * 500));
    voteTimer = setTimeout(() => { voteTimer = null; prepareVote(); }, delay);  // Kartenvorschauen erst erzeugen, wenn der Server und die Runde warm sind
  }
}
// Die Runde beginnt: Zeit läuft, Schüsse sind erlaubt
function startPlay(now) {
  phase = 'play'; matchEnd = now + MATCH_SECONDS * 1000;
  for (const p of Object.values(players)) if (p.bot && p.ai) { p.ai.thinkAt = now + Math.random() * 100; p.ai.lastThink = now; }
  bc({ t: 'msg', x: 'Die Runde beginnt – holt die Kühe!' });
}
// Kartenvorschläge für die Abstimmung (im Hintergrund-Thread erzeugt, damit der Server nicht ruckelt): drei neue Karten + die aktuelle
const renderPreview = require('./preview');
async function prepareVote() {
  if (SEED_FIXED) return;
  const gen = ++voteGen, seeds = [];
  while (seeds.length < 3) { const sd = newSeed(); if (sd !== WORLD.seed && !seeds.includes(sd)) seeds.push(sd); }
  seeds.push(WORLD.seed);
  const cfg = sd => ({ PEN: JSON.parse(JSON.stringify(PEN)), PEN_R, MAP, seed: sd });
  const res = [];
  for (const sd of seeds) {
    if (gen !== voteGen) return;
    try { res.push(await renderPreview(cfg(sd))); }
    catch { res.push({ seed: sd, w: 0, rgb: '' }); }
  }
  if (gen === voteGen) voteOpts = res;                              // nur einen Karten-Worker gleichzeitig ausführen
}

// ---------- Rangliste (Datei rangliste.json im Projektordner) ----------
let RANK = Object.create(null);                      // ohne Prototyp: ein Name wie "__proto__" kann nichts verändern
try { Object.assign(RANK, JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')) || {}); } catch { RANK = Object.create(null); }
delete RANK.__proto__;
// Namen: nur Buchstaben, Ziffern, Leerzeichen, _ . - (kein HTML, keine Sonderzeichen), höchstens 14 Zeichen
const cleanName = (v, fb) => {
  let s = typeof v === 'string' ? v : '';
  try { s = s.normalize('NFKC'); } catch { /* ungültiger Text */ }
  s = s.replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 14).trim();
  return !s || /^(__proto__|constructor|prototype|hasOwnProperty|toString)$/i.test(s) ? fb : s;
};
function saveRank() { try { const ks = Object.keys(RANK); if (ks.length > RANK_MAX) { ks.sort((a, b) => (RANK[b].pts || 0) - (RANK[a].pts || 0)); for (const k of ks.slice(RANK_MAX)) delete RANK[k]; }   // Rangliste begrenzen (schlechteste fliegen raus)
    const tmp = RANK_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(RANK, null, 1)); fs.renameSync(tmp, RANK_FILE); } catch (e) { console.log('Rangliste konnte nicht gespeichert werden:', e.message); } }
const rankTop = n => Object.values(RANK).sort((a, b) => b.pts - a.pts).slice(0, n).map(r => [r.name, r.rounds, r.wins, r.kills, r.mvps, r.pts]);
const roundScore = p => Math.round((p.kills || 0) * 10 + (p.dl || 0) * 50 + (p.revives || 0) * 20 + (p.hs || 0) * 3 + (p.dmg || 0) / 10 - (p.deaths || 0) * 3);

// Ausrüstung einer Waffe: Magazinwaffen führen eine Liste von Magazinen (jedes mit eigener Füllung), Röhrenwaffen eine Reservezahl.
// cur = Patronen in der Waffe (Magazin + Patrone im Lauf, falls die Waffe mit geschlossenem Verschluss lädt)
const mkInv = id => { const w = WEAPONS[id]; return w.tube ? { w: id, cur: w.mag, res: w.spare } : { w: id, cur: w.mag + w.ch, mags: Array(w.spare).fill(w.mag) }; };

const SPAWN_MIN = 55, SPAWN_MAX = 75, SPAWN_ENEMY = 80;        // Abstand zum eigenen Gehege und Mindestabstand zu fremden Gehegen beim Spawn
const SPAWN_FOE = +process.env.SPAWN_FOE || 70;                   // Mindestabstand zum nächsten lebenden Gegner beim Spawn (m); ist das nirgends möglich, gilt der Punkt mit dem größten Abstand
function spawn(p) {
  const L = safeLoadout(p.nextRole, p.next1, p.next2);
  p.role = L.cls; p.w1 = L.w1; p.w2 = L.w2; p.inv = [mkInv(L.w1), mkInv(L.w2)]; p.slot = 0; p.rl = null; p.switchUntil = 0; p.melee = false; p.meleeNext = 0;
  p.hp = HP; p.helm = false; p.vest = 0; p.bloom = 0;
  p.dead = false; p.cow = null; p.quad = null; p.nextShot = 0; p.abilityAt = 0; p.boostUntil = 0; p.spotUntil = 0;
  p.ads = false; p.moving = false; p.sprint = false; p.jy = 0; p.crouch = false; p.prone = false; p.lean = 0; p.sprintOff = 0;
  p.down = false; p.downAt = 0; p.downHp = 0; p.downBy = null; p.rev = 0; p.revAt = 0; p.reviving = false; p.revTarget = null; p.revP = 0;
  p.att = safeAtt(p.nextAtt); if (p.att === 'sup' && WEAPONS[L.w1].sup) p.att = '';                   // Aufsatz der Hauptwaffe (ein Schalldämpfer auf einer leisen Waffe wäre sinnlos)
  p.nadeKind = safeNade(p.nextNade); p.nades = p.bot ? 0 : NADE_MAX; p.nadeNext = 0; p.cook = null; p.cookBlow = 0;   // gewählte Granatenart (Bots haben keine)
  if (p.bot) resetAI(p);
  // Spawn ein gutes Stück vom eigenen Gehege entfernt (SPAWN_MIN..SPAWN_MAX Meter), damit ein Dieb nicht von frisch Wiedergeborenen sofort erschossen wird.
  // Der Punkt muss frei sein (kein Haus, Zaun, Baum, Teich), im Spielfeld liegen und von allen fremden Gehegen mindestens SPAWN_ENEMY Meter entfernt sein.
  { const own = PEN[p.team], others = PEN.filter((_, t) => t !== p.team), clear = (x, z) => {
      if (Math.abs(x) > MAP - 14 || Math.abs(z) > MAP - 14) return false;
      if (others.some(o => Math.hypot(x - o.x, z - o.z) < SPAWN_ENEMY)) return false;
      for (const b of solidBoxes) if (Math.abs(x - b.x) < b.hw + 1.4 && Math.abs(z - b.z) < b.hd + 1.4) return false;
      for (const c of solidCircles) if (Math.hypot(x - c.x, z - c.z) < c.r + 1.6) return false;
      return true;
    };
    const toMid = Math.atan2(-own.z, -own.x);                                          // Richtung Kartenmitte
    const foes = Object.values(players).filter(q => q !== p && q.team !== p.team && !q.dead && !q.obs && (q.joined || q.bot));   // lebende Gegner auf dem Feld
    const foeDist = (x, z) => foes.reduce((m, q) => Math.min(m, Math.hypot(q.x - x, q.z - z)), 1e9);
    let sx = null, sz = null, bx = null, bz = null, bd = -1;                               // bx/bz: bester freier Punkt, falls der Mindestabstand nirgends erreicht wird
    for (let i = 0; i < 120 && sx === null; i++) {
      const a = i < 70 ? toMid + (Math.random() - 0.5) * 2.4 : Math.random() * Math.PI * 2;   // erst zur Kartenmitte hin, dann in jede Richtung
      const r = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN), x = own.x + Math.cos(a) * r, z = own.z + Math.sin(a) * r;
      if (!clear(x, z)) continue;
      const fd = foeDist(x, z);
      if (fd >= SPAWN_FOE) { sx = x; sz = z; } else if (fd > bd) { bd = fd; bx = x; bz = z; }
    }
    if (sx === null && bx !== null) { sx = bx; sz = bz; }
    if (sx === null) { sx = own.x + (Math.random() - 0.5) * 16; sz = own.z + (Math.random() < 0.5 ? -1 : 1) * (PEN_R + 12 + Math.random() * 6); }   // Notlösung: neben dem Gehege
    p.x = sx; p.z = sz; }
  { const os = PEN.filter((_, t) => t !== p.team), ox = os.reduce((a, o) => a + o.x, 0) / os.length, oz = os.reduce((a, o) => a + o.z, 0) / os.length; p.yaw = Math.atan2(-(ox - p.x), -(oz - p.z)); p.pitch = 0; }   // Blick zur Mitte der gegnerischen Gehege
  send(p, { t: 'spawn', x: p.x, z: p.z, yaw: p.yaw });
}

const send = (p, o) => { const w = p.ws; if (!w || w.readyState !== 1) return; if (w.bufferedAmount > 4e6) { try { w.terminate(); } catch { /* schon zu */ } return; } w.send(JSON.stringify(o)); };   // wer Daten nicht abnimmt (4 MB Rückstau), wird getrennt
const bc = o => Object.values(players).forEach(p => send(p, o));
// Sound-Ereignis an alle (Position = Spieler, optional überschrieben)
const ev = (p, k, extra = {}) => bc({ t: 'ev', k, i: p.id, x: p.x, z: p.z, ...extra });
// Ein Gehege ist ein Quadrat um die Mitte. Gezählt wird nur, welche Kühe gerade darin stehen (egal wer sie dorthin gebracht hat).
const inPen = (c, team) => Math.abs(c.x - PEN[team].x) < PEN_R - 0.3 && Math.abs(c.z - PEN[team].z) < PEN_R - 0.3;
const penOf = c => { for (let t = 0; t < TEAMS; t++) if (inPen(c, t)) return t; return -1; };
const score = () => PEN.map((_, t) => cows.filter(c => inPen(c, t)).length);
const teamName = t => TEAM_GEN[t];

// ---------- Nachladen, Waffenwechsel, Munition ----------
// Magazinwaffen: p.inv[slot] = { w, cur, mags: [Füllstände der Ersatzmagazine] }. Beim Nachladen wird das angebrochene Magazin ins Inventar
// zurückgelegt (wie in Sandstorm) und das vollste Ersatzmagazin eingesetzt. Zweimal R kurz hintereinander: schnelleres Nachladen,
// dafür wird das aktuelle Magazin fallen gelassen (verloren). Röhrenwaffen (Schrotflinten, Repetierer): einzelne Patronen, Schießen unterbricht.
const curInv = p => p.inv[p.slot];
const magOf = I => (I.cur > 0 ? Math.max(0, I.cur - WEAPONS[I.w].ch) : 0);          // Patronen im Magazin (ohne die im Lauf)
const fullest = I => { let bi = -1; for (let i = 0; i < I.mags.length; i++) if (bi < 0 || I.mags[i] > I.mags[bi]) bi = i; return bi; };

function startReload(p) {
  const now = Date.now();
  if (p.dead || over || p.rl || p.melee) return false;
  const I = curInv(p), W = WEAPONS[I.w];
  if (W.tube) {
    const need = W.mag - I.cur;
    if (need <= 0 || I.res <= 0) return false;
    const n = Math.min(need, I.res);
    p.rl = { slot: p.slot, tube: true, start: now, next: now + W.rlr * 1000, dur: n * W.rlr, end: now + n * W.rlr * 1000, fast: false };
    ev(p, 'reload', { w: I.w, tube: 1, d: +(n * W.rlr).toFixed(2) });
    return true;
  }
  const bi = fullest(I);
  if (bi < 0 || I.mags[bi] <= magOf(I)) return false;       // kein besseres Magazin vorhanden
  const rk = I.cur === 0 ? W.rle : 0;                          // Durchladen (Spannhebel / Schlitten): nur wenn keine Patrone mehr im Lauf ist, kostet extra Zeit
  const dur = W.rl + rk;
  p.rl = { slot: p.slot, tube: false, start: now, end: now + dur * 1000, dur, fast: false, empty: I.cur === 0, rk };
  ev(p, 'reload', { w: I.w, e: I.cur === 0 ? 1 : 0, d: +dur.toFixed(2), rk: +rk.toFixed(2) });
  return true;
}
// Taste R: Wenn schon nachgeladen wird und der zweite Druck kommt innerhalb von DOUBLE_R_MS, wird schnell nachgeladen (Magazin fällt zu Boden)
function reloadKey(p) {
  const now = Date.now();
  if (p.dead || over || p.quad !== null) return;
  const rl = p.rl;
  if (rl && !rl.tube && !rl.fast && now - rl.start <= DOUBLE_R_MS) {
    const I = p.inv[rl.slot], W = WEAPONS[I.w];
    const dOld = rl.dur;
    rl.fast = true; rl.end = Math.max(now + 250, rl.start + rl.dur * 1000 * FAST_RELOAD); rl.dur = (rl.end - rl.start) / 1000;
    rl.rk = (rl.rk || 0) * rl.dur / Math.max(0.1, dOld);        // der Durchlade-Anteil schrumpft im gleichen Verhältnis mit
    I.cur = Math.min(I.cur, W.ch);                             // Magazin wird abgeworfen: nur die Patrone im Lauf bleibt
    ev(p, 'drop', { w: I.w, d: +rl.dur.toFixed(2), rk: +rl.rk.toFixed(2) });
    return;
  }
  if (!rl) startReload(p);
}
function tickReload(p, now) {
  const rl = p.rl; if (!rl) return;
  const I = p.inv[rl.slot], W = WEAPONS[I.w];
  if (rl.tube) {
    while (p.rl && now >= rl.next) {
      if (I.cur < W.mag && I.res > 0) { I.cur++; I.res--; rl.next += W.rlr * 1000; ev(p, 'shell', { w: I.w }); }
      if (I.cur >= W.mag || I.res <= 0) p.rl = null;
    }
    return;
  }
  if (now < rl.end) return;
  const old = magOf(I), bi = fullest(I);
  p.rl = null;
  if (bi < 0) return;
  const fresh = I.mags.splice(bi, 1)[0];
  if (old > 0) I.mags.push(old);                                // angebrochenes Magazin zurück ins Inventar
  I.cur = fresh + W.ch;
  ev(p, 'reloaded', { w: I.w });
}
function cancelReload(p) { p.rl = null; }
function switchTo(p, s) {
  if (p.dead || over || (s !== 0 && s !== 1 && s !== 2) || p.quad !== null) return;
  const now = Date.now();
  if (s === 2) {                                                // Mistgabel (Nahkampf): nicht im Sattel, kein Nachladen mehr
    if (p.melee || p.cow !== null) return;
    p.rl = null; p.melee = true;
    p.switchUntil = now + SWITCH_MS.other; p.nextShot = Math.max(p.nextShot, p.switchUntil);
    ev(p, 'switch', { w: 'fork' });
    return;
  }
  if (p.cow !== null && s !== 1) { send(p, { t: 'msg', x: 'Auf der Kuh ist nur die Zweitwaffe erlaubt' }); return; }   // im Sattel: nur Pistole bzw. Zweitwaffe
  if (s === p.slot && !p.melee) return;
  p.rl = null; p.slot = s; p.melee = false;
  const W = WEAPONS[curInv(p).w];
  p.switchUntil = now + (W.cat === 'pst' ? SWITCH_MS.pst : SWITCH_MS.other);
  p.nextShot = Math.max(p.nextShot, p.switchUntil);
  ev(p, 'switch', { w: W.id });
}
// Munition auffüllen (Fund, MG-Nachschub). mags = Zahl der Magazine, over = erlaubte Überfüllung. Gibt zurück, ob etwas aufgenommen wurde.
function addAmmo(p, mags, over) {
  let got = false;
  for (const I of p.inv) {
    const W = WEAPONS[I.w];
    if (W.tube) { const cap = W.spare + (over || 0) * W.mag; if (I.res < cap) { I.res = Math.min(cap, I.res + W.mag * mags); got = true; } continue; }
    const cap = W.spare + (over || 0);
    for (let i = 0; i < mags; i++) {
      if (I.mags.length < cap) { I.mags.push(W.mag); got = true; continue; }
      const k = I.mags.reduce((a, v, j) => (v < I.mags[a] ? j : a), 0);   // alle Plätze belegt: das leerste Magazin auffüllen
      if (I.mags.length && I.mags[k] < W.mag) { I.mags[k] = W.mag; got = true; }
    }
  }
  return got;
}

// ---------- Trefferberechnung ----------
function raySphere(o, d, c, r) {
  const oc = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
  const tca = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2];
  if (tca < 0) return 1e9;
  const d2 = oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - tca * tca;
  if (d2 > r * r) return 1e9;
  return tca - Math.sqrt(r * r - d2);
}
// Erster Treffpunkt eines Strahls mit dem Gelände (Abstand t) oder 1e9. Der Strahl wird in 1,5-m-Schritten abgetastet, der Treffer dann per Halbierung genau bestimmt.
function rayTerrain(o, d, tMax) {
  if (o[1] > HMAX + 0.5 && d[1] >= 0) return 1e9;                      // über allem Gelände und nach oben: kein Treffer möglich
  let tPrev = 0;
  for (;;) {
    const t = Math.min(tPrev + (WORLD.nearPit(o[0] + d[0] * tPrev, o[2] + d[2] * tPrev, 3) ? 0.3 : 1.5), tMax);   // in der Nähe eines Schützengrabens feiner abtasten (Kante nur 0,9 m dick)
    const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
    if (y <= groundY(x, z)) {
      let lo = tPrev, hi = t;
      for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (o[1] + d[1] * m <= groundY(o[0] + d[0] * m, o[2] + d[2] * m)) hi = m; else lo = m; }
      return hi;
    }
    if (t >= tMax || (y > HMAX && d[1] >= 0)) return 1e9;
    tPrev = t;
  }
}

// Niedergeschossen (nur echte Spieler, solange noch ein Kamerad steht): man kriecht langsam, kann nicht schießen und wird von einem Kameraden (E halten) wiederbelebt.
// Ohne Hilfe verblutet man nach DOWN_MS; weitere Treffer gehen auf einen eigenen Lebenspool (DOWN_HP).
const DOWN_HP = 60, DOWN_MS = +process.env.DOWN_MS || 30000, REVIVE_T = 4.5, REVIVE_SANI = 2.5, REVIVE_RANGE = 2.4, REVIVE_HP = 40, REVIVE_HP_SANI = 60;
const canGoDown = v => !v.bot && !over && Object.values(players).some(q => q !== v && q.team === v.team && !q.dead && !q.down);
const nameC = (...ps) => ps.filter(Boolean).map(p => [p.name, p.team]);   // Namen mit Teamfarbe für den Killfeed (c: [[Name, Team], …] in der Reihenfolge des Textes)
const distM = (a, b) => Math.round(Math.hypot(a.x - b.x, a.z - b.z));          // Entfernung Schütze -> Opfer in Metern (für den Killfeed)
function goDown(v, k, W, dir) {
  v.down = true; v.downAt = Date.now(); v.downHp = DOWN_HP; v.downBy = k && k !== v ? k.id : null; v.hp = 0; v.rl = null; v.rev = 0; v.reviving = false; v.revTarget = null;
  v.sprint = false; v.ads = false; v.prone = true; v.crouch = false; v.lean = 0; v.melee = false;
  shedGear(v);
  ev(v, 'down', dir ? { dx: +dir[0].toFixed(3), dz: +dir[2].toFixed(3) } : {});
  bc({ t: 'msg', x: k && k !== v ? `${k.name} hat ${v.name} niedergeschossen (${distM(k, v)} m)` : `${v.name} ist niedergegangen`, c: k && k !== v ? nameC(k, v) : nameC(v) });
}
function shedGear(victim) {
  if (victim.cow !== null) { cows[victim.cow].rider = null; victim.cow = null; }
  leaveQuad(victim);
  if (victim.cook) {                                                              // beim Kochen getroffen: die Granate fällt zu Boden und explodiert wie geplant
    const c = victim.cook; victim.cook = null; victim.nades--;
    nades.push({ id: nextNid++, owner: victim.id, team: victim.team, kind: victim.nadeKind, x: victim.x, y: groundY(victim.x, victim.z) + 0.6, z: victim.z, vx: 0, vy: 1, vz: 0, fuse: c.start + NADE_FUSE, bounced: 0 });
  }
}
function reviveDone(t, r) {
  t.down = false; t.rev = 0; t.hp = r.role === 'sani' ? REVIVE_HP_SANI : REVIVE_HP; t.downBy = null; t.hurtAt = Date.now();
  r.reviving = false; r.revTarget = null; r.revP = 0; r.revives = (r.revives || 0) + 1;
  ev(t, 'revive', {});
  bc({ t: 'msg', x: `${r.name} hat ${t.name} wiederbelebt`, c: nameC(r, t) });
}
// jeden Tick: wer E hält, belebt den nächsten niedergeschossenen Kameraden (nur im Stehen, nicht beim Laufen); Fortschritt klingt ohne Helfer langsam ab
function reviveTick(now) {
  const dt = 0.05, all = Object.values(players);
  for (const r of all) {
    if (!r.reviving) continue;
    if (r.dead || r.down || r.sprint || r.moving || r.cow !== null || r.quad !== null) { r.reviving = false; r.revTarget = null; r.revP = 0; continue; }
    let t = null, bd = REVIVE_RANGE;
    for (const q of all) { if (q === r || !q.down || q.dead || q.team !== r.team) continue; const d = Math.hypot(q.x - r.x, q.z - r.z); if (d < bd) { bd = d; t = q; } }
    if (!t) { r.revTarget = null; r.revP = 0; continue; }
    r.revTarget = t.id; t.revAt = now; t.rev += dt / (r.role === 'sani' ? REVIVE_SANI : REVIVE_T); r.revP = Math.min(1, t.rev);
    if (t.rev >= 1) reviveDone(t, r);
  }
  for (const q of all) if (q.down && q.rev > 0 && now - q.revAt > 150) q.rev = Math.max(0, q.rev - dt * 0.5);
}
function kill(victim, killer, W, dir, how) {
  victim.down = false; victim.rev = 0; victim.reviving = false;
  victim.dead = true; victim.rl = null; victim.deaths++; victim.respawnAt = Date.now() + RESPAWN * 1000;
  shedGear(victim);
  const selfK = killer === victim;
  if (killer && !selfK) killer.kills++;
  ev(victim, 'death', dir ? { dx: +dir[0].toFixed(3), dz: +dir[2].toFixed(3) } : {});   // dx/dz: Flugrichtung des tödlichen Geschosses (Wucht für die Ragdoll)
  bc({ t: 'msg', x: how ? `${victim.name} ${how}` : selfK ? `${victim.name} hat sich selbst in die Luft gesprengt` : `${killer ? killer.name : '?'} hat ${victim.name} ausgeschaltet${killer ? ' (' + (W ? W.n + ', ' : '') + distM(killer, victim) + ' m)' : W ? ' (' + W.n + ')' : ''}` , c: how || selfK ? nameC(victim) : nameC(killer, victim) });
}

// Schaden: Kopftreffer x3, Helm fängt einen Kopftreffer ab (dann normaler Schaden), Weste nimmt einen Teil des Körperschadens (panzerbrechende Waffen: weniger)
function damageTo(v, k, W, dmg, head, dir, at) {
  if (phase !== 'play') return;
  let d = dmg;
  if (head) {
    if (v.helm) { v.helm = false; send(v, { t: 'msg', x: 'Dein Helm hat einen Kopftreffer abgefangen!' }); }
    else { d = dmg * 3; if (k && k !== v) k.hs = (k.hs || 0) + 1; }
  } else if (v.vest > 0) {
    const a = Math.min(v.vest, d * (W.pierce ? 0.15 : W.cat === 'sg' ? 0.25 : 0.4));   // Schrotkörner: die Weste schluckt weniger, sonst wäre ein Schuss mit Weste kein Kill mehr
    v.vest -= a; d -= a;
  }
  v.hurtAt = Date.now();
  if (k && k !== v && k.team !== v.team) k.dmg = (k.dmg || 0) + Math.min(d, 150);                  // verursachter Schaden (Statistik)
  const src = at ? { x: at[0], z: at[2] } : k;
  send(v, { t: 'hurt', x: src ? +src.x.toFixed(1) : undefined, z: src ? +src.z.toFixed(1) : undefined, d: Math.round(d) }); // Schützenposition für die Richtungsanzeige
  if (v.cow !== null) v.slowUntil = Date.now() + 1800;                                  // Treffer im Sattel: die Kuh scheut und wird kurz langsamer
  if (v.down) { v.downHp -= d; if (v.downHp <= 0) kill(v, k, W, dir); return; }              // Niedergeschossener: Treffer gehen auf den Lebenspool, danach ist er aus
  v.hp -= d;
  if (v.hp <= 0) { if (k !== v && canGoDown(v)) goDown(v, k, W, dir); else kill(v, k, W, dir); }
}

// Streuung: Zielen verringert sie, Bewegung und Hüftschuss erhöhen sie, dazu der Rückstoß-Aufbau (bloom)
function spreadOf(p, W) {
  let sp = W.spread * (p.ads ? (p.att === 'laser' ? 1.12 : 1) : (p.att === 'laser' ? 1.6 : 2.5));   // Laser: Hüftschuss genauer, beim Zielen etwas schlechter
  if (p.moving) sp *= p.ads ? 1.3 : 1.8;
  if (p.cow !== null) sp *= 2;
  if (p.crouch) sp *= 0.7;                          // aus der Hocke ruhiger
  if (p.prone) sp *= 0.55;                          // liegend am ruhigsten
  if (p.lean) sp *= 0.9;                            // angelehnt etwas stabiler
  return sp + p.bloom;
}

// Teich: ab SWIM_DEPTH Wassertiefe schwimmt man (nur Kopf und Brust ragen heraus). Der Wasserspiegel (WORLD.pond.level) kommt vom Weltgenerator.
const SWIM_DEPTH = 0.85, LEAN_OFF = 0.42;                  // Wassertiefe ab der man schwimmt (m); seitliche Verschiebung des Oberkörpers beim Lehnen (m)
function waterDepth(x, z) { const P = WORLD.pond; if (!P || Math.hypot(x - P.x, z - P.z) >= P.r) return 0; return Math.max(0, P.level - groundY(x, z)); }
const swimming = q => q.cow === null && q.quad === null && waterDepth(q.x, q.z) > SWIM_DEPTH;
const standY = q => swimming(q) ? WORLD.pond.level - 1.1 : groundY(q.x, q.z);            // Fußhöhe (beim Schwimmen: so, dass der Kopf knapp über dem Wasser ist)
const leanVec = q => { const l = (q.lean || 0) * LEAN_OFF; return [Math.cos(q.yaw) * l, -Math.sin(q.yaw) * l]; };   // seitliche Verschiebung (x, z) von Kopf und Oberkörper
// Trefferkugeln eines Spielers: [Höhe, Radius, Zone, dx, dz]; Zone 'l' Beine, 'b' Körper, 'h' Kopf; dx/dz = seitlicher Versatz zur Spielerposition. In der Hocke liegt alles 0,5 m tiefer, liegend ist der Körper lang gestreckt.
function hitSpheres(q) {
  const sw = q.cow === null && q.quad === null && swimming(q);
  const off = standY(q) + (q.cow !== null ? 0.9 : 0) + (q.quad !== null ? 0.3 : 0) + (q.jy || 0);   // Höhe über dem Gelände an seiner Stelle
  const [lx, lz] = leanVec(q);
  if (sw) return [[1.15 + off, 0.5, 'b', 0, 0], [1.65 + off, 0.28, 'h', lx, lz]];                  // im Wasser: nur Brust und Kopf
  if (q.prone && q.cow === null && q.quad === null) {                                              // liegend: Kopf vorn, Rumpf in der Mitte, Beine hinten (Blickrichtung = yaw)
    const fx = -Math.sin(q.yaw), fz = -Math.cos(q.yaw);
    return [[0.24 + off, 0.34, 'l', -fx * 0.7, -fz * 0.7], [0.26 + off, 0.4, 'b', 0, 0], [0.26 + off, 0.36, 'b', fx * 0.38, fz * 0.38], [0.26 + off, 0.26, 'h', fx * 0.8, fz * 0.8]];
  }
  if (q.crouch && q.cow === null) return [[0.3 + off, 0.45, 'l', 0, 0], [0.72 + off, 0.5, 'b', lx, lz], [1.17 + off, 0.28, 'h', lx, lz]];
  return [[0.5 + off, 0.55, 'l', 0, 0], [1.15 + off, 0.5, 'b', lx * 0.6, lz * 0.6], [1.65 + off, 0.28, 'h', lx, lz]];
}

// Welche Seite einer Box wurde getroffen? 0 +x, 1 -x, 2 oben, 3 unten, 4 +z, 5 -z (für Einschusslöcher auf dem Client)
function boxFace(pt, b) {
  const y0 = b.y || 0, c = [Math.abs(pt[0] - (b.x + b.w / 2)), Math.abs(pt[0] - (b.x - b.w / 2)), Math.abs(pt[1] - (y0 + b.h)), Math.abs(pt[1] - y0), Math.abs(pt[2] - (b.z + b.d / 2)), Math.abs(pt[2] - (b.z - b.d / 2))];
  let bi = 0; for (let i = 1; i < 6; i++) if (c[i] < c[bi]) bi = i;
  return bi;
}

// ---------- Kühe erschrecken ----------
// Schüsse und Explosionen in der Nähe scheuchen freie Kühe auf: sie laufen ein Stück vom Lärm weg (in Gehegen weniger empfindlich). Geritten werden sie nicht gescheucht.
const COW_FLEE_V = 3.6, COW_FLEE_V_STRONG = 5.2;
function scareCows(x, z, r, strong) {
  const now = Date.now();
  for (const c of cows) {
    if (c.rider !== null) continue;
    const dx = c.x - x, dz = c.z - z, d = Math.hypot(dx, dz), rr = !strong && penOf(c) >= 0 ? r * 0.4 : r;
    if (d > rr) continue;
    let fx, fz;
    if (d > 0.05) { fx = dx / d; fz = dz / d; } else { const a = Math.random() * 6.2832; fx = Math.cos(a); fz = Math.sin(a); }
    const a2 = (Math.random() - 0.5) * 0.5, ca = Math.cos(a2), sa = Math.sin(a2);   // leicht streuen, nicht alle Kühe exakt in einer Linie
    c.fx = fx * ca - fz * sa; c.fz = fx * sa + fz * ca;
    c.fv = strong ? COW_FLEE_V_STRONG : COW_FLEE_V;
    c.fleeUntil = Math.max(c.fleeUntil || 0, now + (strong ? 3200 : 1700));
    if (now >= (c.mooAt || 0)) { c.mooAt = now + 6000; bc({ t: 'ev', k: 'moo', i: 0, x: r1(c.x), z: r1(c.z) }); }
  }
}
function stepCows(now) {
  for (const c of cows) {
    if (c.rider !== null || !(c.fleeUntil > now)) continue;
    const ox = c.x, oz = c.z, step = c.fv * 0.05;
    c.x += c.fx * step; c.z += c.fz * step; collide(c, 1.0, c);
    c.yaw = Math.atan2(-c.fx, -c.fz);
    if (Math.hypot(c.x - ox, c.z - oz) < step * 0.25) c.fleeUntil = 0;   // blockiert (Zaun, Baum, andere Kuh): bleibt stehen
  }
}

// ---------- Geschosse ----------
// Jedes Geschoss (bei Schrot jedes Schrotkorn) fliegt mit der Mündungsgeschwindigkeit der Waffe. Wie in Sandstorm fliegt es 0,1 s geradeaus und fällt dann
// mit 9,81 m/s². Der Flugweg ist eine feste Formel (Start o, Richtung d, Tempo v): Server und Client rechnen dasselbe. Der Server prüft pro Tick das Wegstück.
const bPos = (b, t) => { const g = Math.max(0, t - DROP_AFTER), w2 = 0.5 * t * t; return [b.o[0] + b.d[0] * b.v * t + (b.wx || 0) * w2, b.o[1] + b.d[1] * b.v * t - 0.5 * GRAVITY * g * g, b.o[2] + b.d[2] * b.v * t + (b.wz || 0) * w2]; };   // wx, wz: seitliche Windbeschleunigung beim Abschuss
function rayVehicle(o, d, x, z, yaw, hw, hd, y, h) {                         // Schuss in den lokalen Fahrzeugraum drehen und gegen die Fahrzeughülle prüfen
  const rx = Math.cos(yaw), rz = -Math.sin(yaw), fx = -Math.sin(yaw), fz = -Math.cos(yaw), dx = o[0] - x, dz = o[2] - z;
  const lo = [dx * rx + dz * rz, o[1], dx * fx + dz * fz], ld = [d[0] * rx + d[2] * rz, d[1], d[0] * fx + d[2] * fz];
  return rayBox(lo, ld, { x: 0, z: 0, w: hw * 2, d: hd * 2, y, h });
}
function rayVehicleParts(o, d, x, z, yaw, baseY, parts) {
  const rx = Math.cos(yaw), rz = -Math.sin(yaw), fx = -Math.sin(yaw), fz = -Math.cos(yaw); let best = 1e9;
  for (const [lx, lz, hw, hd, y, h] of parts) best = Math.min(best, rayVehicle(o, d, x + rx * lx + fx * lz, z + rz * lx + fz * lz, yaw, hw, hd, baseY + y, h));
  return best;
}
const QUAD_SHOT_PARTS = [ // Radboxen folgen Rahmen, Kotflügeln, Anbauteilen, Lenker und vier Reifen
  [0, 0, 0.31, 0.78, 0.38, 0.16], [0, -0.68, 0.475, 0.26, 0.56, 0.2], [0, 0.72, 0.475, 0.3, 0.57, 0.22],
  [0, -0.3, 0.3, 0.275, 0.67, 0.3], [0, 0.42, 0.18, 0.4, 0.75, 0.14], [0, -0.8, 0.26, 0.21, 0.78, 0.1], [0, 1.02, 0.28, 0.2, 0.81, 0.1],
  [0, -0.3, 0.5, 0.08, 1.12, 0.08], [0, -0.3, 0.04, 0.04, 0.84, 0.3],
  ...[-0.64, 0.64].flatMap(x => [-0.72, 0.72].map(z => [x, z, 0.15, 0.31, 0, 0.62]))
];
const TRACTOR_SHOT_PARTS = [ // offene Kabine bleibt offen; Motor, Rahmen, Dach, Stützen, Anbauteile und Räder blockieren einzeln
  [0, -0.05, 0.5, 1.55, 0.555, 0.45], [0, -1, 0.525, 0.775, 0.9, 0.8], [0, -1.82, 0.425, 0.05, 0.95, 0.5],
  [0.36, -1.2, 0.06, 0.06, 1.575, 0.95], [-1.02, 0.8, 0.25, 0.75, 1.61, 0.14], [1.02, 0.8, 0.25, 0.75, 1.61, 0.14],
  [0, 0.75, 0.775, 0.8, 1.06, 0.12], [-0.72, 0.05, 0.05, 0.05, 1.17, 1.3], [0.72, 0.05, 0.05, 0.05, 1.17, 1.3],
  [-0.72, 1.45, 0.05, 0.05, 1.17, 1.3], [0.72, 1.45, 0.05, 0.05, 1.17, 1.3], [0, 0.75, 0.85, 0.9, 2.45, 0.1],
  [0, 0.95, 0.275, 0.25, 1.28, 0.16], [0, 1.2, 0.275, 0.05, 1.385, 0.55], [0, 1.85, 0.17, 0.2, 0.72, 0.2],
  ...[-1.05, 1.05].map(x => [x, 0.8, 0.25, 0.78, 0, 1.56]), ...[-0.85, 0.85].map(x => [x, -1.3, 0.17, 0.45, 0, 0.9])
];
const TRAILER_SHOT_PARTS = [ // Boden, Seitenwände, Stirnwand, Heckklappe, Deichsel und Räder
  [0, 0, 1.2, 2.7, 0.75, 0.14], [-1.2, 0, 0.05, 2.7, 0.91, 0.7], [1.2, 0, 0.05, 2.7, 0.91, 0.7],
  [0, -2.65, 1.2, 0.05, 0.86, 0.9], [0, 2.65, 1.2, 0.05, 0.86, 0.4], [0, -3.15, 0.07, 0.45, 0.68, 0.14], [0, -3.58, 0.15, 0.08, 0.65, 0.2],
  ...[-1.4, 1.4].map(x => [x, 0.5, 0.275, 0.55, 0, 1.1])
];
const r1 = v => Math.round(v * 10) / 10;
let impQ = [], hitQ = {};                              // pro Tick gesammelte Einschläge (an alle) und Trefferbestätigungen (an die Schützen)
function breakGlass(g, at) {
  g.broken = true;
  bc({ t: 'ev', k: 'glass', i: 0, id: g.id, x: r1(g.x), z: r1(g.z), y: r1(g.y + g.h / 2), ax: at ? +at[0].toFixed(2) : 0, az: at ? +at[2].toFixed(2) : 0 });
}
function endBullet(b, pt, kind, face) { b.dead = true; impQ.push([b.id, r1(pt[0]), r1(pt[1]), r1(pt[2]), kind, face === undefined ? -1 : face]); }

function stepBullet(b, now) {
  const tN = Math.min(MAX_FLIGHT, (now - b.born) / 1000);
  if (tN <= b.t) { if (tN >= MAX_FLIGHT) endBullet(b, bPos(b, tN), 0); return; }
  const p0 = bPos(b, b.t), p1 = bPos(b, tN);
  b.t = tN;
  const dv = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], len = Math.hypot(dv[0], dv[1], dv[2]);
  if (len < 1e-6) return;
  const d = [dv[0] / len, dv[1] / len, dv[2] / len];
  let tMax = len, kind = 0, hb = null;                 // Art des Einschlags: 0 Luft, 1 Boden, 2 Haus, 3 Baum, 4 Spieler; hb = getroffene Box
  for (const h of shootBoxes) { const t = rayBox(p0, d, h); if (t < tMax) { tMax = t; kind = 2; hb = h; } }
  for (const tb of treeBoxes) { const t = rayBox(p0, d, tb); if (t < tMax) { tMax = t; kind = 3; hb = tb; } }
  for (const q of quadList) {
    const y = groundY(q.x, q.z), tk = q.kind === 1;
    const t = rayVehicleParts(p0, d, q.x, q.z, q.yaw, y, tk ? TRACTOR_SHOT_PARTS : QUAD_SHOT_PARTS);
    if (t < tMax) { tMax = t; kind = 5; hb = null; }
    if (tk) { const tt = rayVehicleParts(p0, d, q.ax, q.az, q.ty, groundY(q.ax, q.az), TRAILER_SHOT_PARTS); if (tt < tMax) { tMax = tt; kind = 5; hb = null; } }
  }
  { const tg = rayTerrain(p0, d, tMax); if (tg < tMax) { tMax = tg; kind = 1; hb = null; } }       // das Gelände (Boden, Hügel) stoppt Schüsse ebenfalls
  let best = null, bt = tMax, head = false, zone = 'b';
  for (const q of Object.values(players)) {
    if (q.id === b.owner || q.dead || q.team === b.team) continue;   // kein Friendly Fire
    for (const [h, r, z, sx, sz] of hitSpheres(q)) {
      const t = raySphere(p0, d, [q.x + (sx || 0), h, q.z + (sz || 0)], r);
      if (t < bt) { bt = t; best = q; head = z === 'h'; zone = z; }
    }
  }
  for (const g of glassPanes) {                                                     // Fensterscheiben vor dem Einschlagspunkt / Treffer zerspringen, das Geschoss fliegt weiter
    if (g.broken || Math.abs(g.x - p0[0]) > bt + 1.5 && Math.abs(g.x - p1[0]) > bt + 1.5) continue;
    const t = rayBox(p0, d, g); if (t < bt) breakGlass(g, [p0[0] + d[0] * t, 0, p0[2] + d[2] * t]);
  }
  const W = b.W;
  if (best) {
    const trav = b.dist + bt, f = 1 - (1 - W.minF) * Math.max(0, Math.min(1, (trav - W.rng * 0.25) / (W.rng * 0.75)));   // Schadensabfall mit der Flugstrecke
    const owner = players[b.owner] || null;
    damageTo(best, owner, W, W.dmg * f * (b.dm || 1) * (zone === 'l' ? LEG_MULT : 1), head, d);
    const h = hitQ[b.owner] || (hitQ[b.owner] = { head: false, body: false });
    if (head) h.head = true; else if (zone === 'b') h.body = true;
    endBullet(b, [p0[0] + d[0] * bt, p0[1] + d[1] * bt, p0[2] + d[2] * bt], 4);
    return;
  }
  if (kind > 0) { const e = [p0[0] + d[0] * tMax, p0[1] + d[1] * tMax, p0[2] + d[2] * tMax]; endBullet(b, e, kind, hb && kind !== 1 ? boxFace(e, hb) : -1); return; }
  b.dist += len;
  if (tN >= MAX_FLIGHT || Math.abs(p1[0]) > MAP + 60 || Math.abs(p1[2]) > MAP + 60 || p1[1] < -60) endBullet(b, p1, 0);
}
function stepBullets(now) {
  for (const b of bullets) if (!b.dead) stepBullet(b, now);
  if (bullets.some(b => b.dead)) bullets = bullets.filter(b => !b.dead);
  if (impQ.length) { bc({ t: 'imp', l: impQ.slice(0, 60) }); impQ = []; }
  for (const id in hitQ) { const q = players[id], h = hitQ[id]; if (q) send(q, { t: 'hit', head: h.head, z: h.head ? 'h' : (h.body ? 'b' : 'l') }); }
  hitQ = {};
}

function shoot(p, dir) {
  if (phase !== 'play') return;
  const now = Date.now();
  if (p.dead || over || p.quad !== null || p.melee || p.sprint || now < (p.sprintOff || 0) + SPRINT_RECOVER || now < p.nextShot - 12 || now < p.switchUntil) return;   // 12 ms Toleranz für Netz-Jitter
  const I = curInv(p), W = WEAPONS[I.w];
  if (p.rl) { if (p.rl.tube && I.cur > 0) p.rl = null; else return; }             // Röhrenwaffen: Schießen unterbricht das Nachladen
  if (I.cur <= 0) {
    if (!startReload(p)) send(p, { t: 'msg', x: 'Keine Munition mehr!' });
    return;
  }
  p.nextShot = Math.max(p.nextShot, now - 12) + W.rate * 1000; I.cur--;   // Takt bleibt exakt (Jitter gleicht sich aus), schneller als die Feuerrate geht es im Schnitt nie
  const sp = spreadOf(p, W);
  p.bloom = Math.min(0.03, p.bloom + W.bloom * (p.att === 'grip' ? 0.55 : 1));   // Vordergriff: weniger Rückstoß-Aufbau
  const len = Math.hypot(...dir) || 1;
  const base = dir.map(v => v / len);
  const [lnx, lnz] = leanVec(p), o = [p.x + lnx, eyeY(p), p.z + lnz];                 // beim Lehnen kommen die Schüsse aus der seitlich verschobenen Kamera
  let first = null;
  const [wax, waz] = windAcc(); p.revealUntil = now + 2500;                              // Schießen verrät einen Getarnten
  for (let i = 0; i < W.pel; i++) {
    let d = base.map(v => v + (Math.random() + Math.random() - 1) * (sp + W.pelSp));
    const l = Math.hypot(...d); d = d.map(v => v / l);
    const b = { id: nextBid++, owner: p.id, team: p.team, W, o, d, v: W.v, born: now, t: 0, dist: 0, dead: false, wx: wax, wz: waz };
    bullets.push(b);
    if (i === 0) first = b;
  }
  const quiet = p.att === 'sup' || !!W.sup;
  scareCows(p.x, p.z, quiet ? 7 : 24, false);                                   // Schalldämpfer scheucht Kühe kaum auf
  if (p.att === 'sup') for (const b of bullets) if (b.owner === p.id && b.born === now) b.dm = 0.92;   // Schalldämpfer: etwas weniger Schaden
  bc({ t: 'fx', id: first.id, n: W.pel, o: o.map(r1), d: first.d.map(v => +v.toFixed(4)), w: W.id, i: p.id, tm: p.team, s: p.att === 'sup' ? 1 : 0, em: I.cur <= 0 ? 1 : 0, wx: wax, wz: waz });   // em: war es der letzte Schuss? (Schlitten bleibt hinten)
  if (I.cur === 0) startReload(p);                                                 // leer: automatisch nachladen (wenn Ersatz da)
}

// ---------- Nahkampf: Mistgabel ----------
// Stich in Blickrichtung (Reichweite FORK.reach). Wände, Bäume und Gelände stoppen ihn. Von vorn FORK.dmg (zwei Stiche töten), in den Rücken FORK.back (ein Stich).
function melee(p, dir) {
  if (phase !== 'play') return;
  const now = Date.now();
  if (p.dead || over || !p.melee || p.cow !== null || p.sprint || now < p.meleeNext || now < p.switchUntil) return;
  p.meleeNext = now + FORK.cd;
  let d = Array.isArray(dir) && dir.length === 3 && dir.every(Number.isFinite) ? dir.slice() : [-Math.sin(p.yaw), 0, -Math.cos(p.yaw)];
  const l = Math.hypot(d[0], d[1], d[2]) || 1; d = d.map(v => v / l);
  const o = [p.x, eyeY(p) - 0.25, p.z];                                             // Stich geht etwas unterhalb der Augen los (Brusthöhe)
  let tMax = FORK.reach;
  for (const h of shootBoxes) { const t = rayBox(o, d, h); if (t < tMax) tMax = t; }
  for (const tb of treeBoxes) { const t = rayBox(o, d, tb); if (t < tMax) tMax = t; }
  { const tg = rayTerrain(o, d, tMax); if (tg < tMax) tMax = tg; }
  let best = null, bt = tMax;
  for (const q of Object.values(players)) {
    if (q.id === p.id || q.dead || q.team === p.team) continue;
    for (const [h, r, , sx, sz] of hitSpheres(q)) {
      const t = raySphere(o, d, [q.x + (sx || 0), h, q.z + (sz || 0)], r + 0.22);                           // etwas großzügiger als bei Kugeln (Gabel hat drei Zinken)
      if (t < bt) { bt = t; best = q; }
    }
  }
  let back = false;
  if (best) {
    back = Math.cos(best.yaw - p.yaw) > 0.5;                                        // Blickrichtungen ähnlich = von hinten
    damageTo(best, p, FORK, back ? FORK.back : FORK.dmg, false, d);
    send(p, { t: 'hit', head: false, z: 'b' });
  }
  bc({ t: 'ev', k: 'stab', i: p.id, x: p.x, z: p.z, hit: best ? (best.cow !== null ? 2 : 1) : 0, back: back ? 1 : 0, hx: +(o[0] + d[0] * bt).toFixed(1), hy: +(o[1] + d[1] * bt).toFixed(1), hz: +(o[2] + d[2] * bt).toFixed(1) });
}

function dropItem(p, type) {
  const d = { id: nextDrop++, type, team: p.team, owner: p.id, ownerAt: Date.now() + DROP_OWNER_DELAY, until: Date.now() + DROP_LIFE, uses: type === 'ammo' ? DROP_AMMO_USES : 1 };
  d.x = Math.max(-MAP + 2, Math.min(MAP - 2, p.x - Math.sin(p.yaw) * 1.6)); d.z = Math.max(-MAP + 2, Math.min(MAP - 2, p.z - Math.cos(p.yaw) * 1.6));
  drops.push(d); while (drops.length > DROP_MAX) drops.shift();
  send(p, { t: 'msg', x: type === 'med' ? 'Medkit abgelegt – Teamkameraden können es aufnehmen' : 'Munitionskiste abgelegt – Teamkameraden können sich bedienen' });
}
// ---------- Sandsäcke (Pionier, Taste Q) ----------
// Eine niedrige Mauer (3,2 x 0,7 m, 1,15 m hoch) vor dem Pionier, parallel zur nächsten Achse. Sie blockiert Laufen, Schüsse, Granaten und Sicht; man kann darüber klettern.
// Höchstens BAR_MAX je Pionier (die älteste verschwindet), sie halten BAR_LIFE ms. Nur auf freiem Platz (kein Spieler, keine Kuh, kein Hindernis, kein tiefes Wasser).
const BAR_LIFE = +process.env.BAR_LIFE || 75000, CD_SCALE = +process.env.CD_SCALE || 1, BAR_MAX = 3, BAR_LEN = 3.2, BAR_THK = 0.7, BAR_H = 1.15;
function removeBarricade(b) {
  barricades = barricades.filter(x => x !== b);
  const i = solidBoxes.indexOf(b.sb); if (i >= 0) { solidBoxes.splice(i, 1); navBox(b.sb, -1); }
  const j = shootBoxes.indexOf(b.sh); if (j >= 0) shootBoxes.splice(j, 1);
}
function placeBarricade(p, now) {
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), cx = p.x + fx * 2.4, cz = p.z + fz * 2.4;
  const long = Math.abs(fz) >= Math.abs(fx);                                       // schaut er eher nach vorn/hinten (z), liegt die Mauer quer (lang in x)
  const w = long ? BAR_LEN : BAR_THK, d = long ? BAR_THK : BAR_LEN, hw = w / 2, hd = d / 2;
  if (Math.abs(cx) > MAP - 6 || Math.abs(cz) > MAP - 6 || waterDepth(cx, cz) > 0.3) return false;
  const near = (px, pz) => Math.hypot(px - Math.max(cx - hw, Math.min(px, cx + hw)), pz - Math.max(cz - hd, Math.min(pz, cz + hd)));   // Abstand eines Punkts zum Rechteck
  for (const b of solidBoxes) if (Math.abs(cx - b.x) < hw + b.hw + 0.3 && Math.abs(cz - b.z) < hd + b.hd + 0.3) return false;
  for (const c of solidCircles) if (near(c.x, c.z) < c.r + 0.3) return false;
  for (const q of Object.values(players)) if (!q.dead && !q.obs && near(q.x, q.z) < 0.9) return false;
  for (const c of cows) if (near(c.x, c.z) < 1.4) return false;
  const y = Math.min(groundY(cx, cz), groundY(cx - hw, cz - hd), groundY(cx + hw, cz - hd), groundY(cx - hw, cz + hd), groundY(cx + hw, cz + hd)) - 0.15;
  const mine = barricades.filter(b => b.owner === p.id); if (mine.length >= BAR_MAX) removeBarricade(mine[0]);
  const b = { id: nextBar++, owner: p.id, team: p.team, x: cx, z: cz, w, d, y, h: BAR_H + 0.15, until: now + BAR_LIFE };
  b.sb = { x: cx, z: cz, hw, hd }; b.sh = { x: cx, z: cz, w, d, y, h: b.h };
  barricades.push(b); solidBoxes.push(b.sb); shootBoxes.push(b.sh); navBox(b.sb, 1);
  return true;
}
function ability(p) {
  if (phase !== 'play') return;
  const now = Date.now();
  if (p.dead || over || p.quad !== null || now < p.abilityAt) return;
  if (p.role === 'sturm') { if (p.cow !== null) return send(p, { t: 'msg', x: 'Sprint-Fähigkeit geht nicht auf der Kuh' }); p.boostUntil = now + 4000; }   // auf der Kuh gesperrt (kein Abklingen)
  else if (p.role === 'mg') dropItem(p, 'ammo');           // Munitionskiste ablegen: Teamkameraden holen sich Magazine
  else if (p.role === 'hirte') { if (p.cow === null) return send(p, { t: 'msg', x: 'Kuh antreiben geht nur im Sattel' }); p.boostUntil = now + 4000; }
  else if (p.role === 'pionier') {
    if (p.cow !== null) return send(p, { t: 'msg', x: 'Auf der Kuh kann man nichts bauen' });
    if (!placeBarricade(p, now)) return send(p, { t: 'msg', x: 'Hier ist kein Platz für Sandsäcke' });
  }
  else if (p.role === 'scharf') {
    for (const q of Object.values(players)) if (q.team !== p.team && !q.dead && Math.hypot(q.x - p.x, q.z - p.z) < 120) q.spotUntil = now + 6000;
  } else if (p.role === 'sani') dropItem(p, 'med');      // Medkit ablegen: Teamkameraden holen sich Lebenspunkte
  p.abilityAt = now + CLASSES[p.role].cd * 1000 * CD_SCALE;
  ev(p, 'ability', { r: p.role });
}

// ---------- Quad ----------
// Das Quad fährt der Client (wie das Laufen); der Server merkt sich Platz, Fahrtrichtung und Tempo und gibt sie an alle weiter.
// Auf dem Quad gibt es keine Waffen. Wird es verlassen, bleibt es stehen und fährt nach QUAD_HOME_MS von allein zu seinem Platz zurück.
// Überfahren: aus der gemessenen Bewegung des Quads (letzte Position -> jetzt) ergibt sich Tempo und Richtung. Gegner, die der Strecke nahe kommen
// (vorn oder seitlich), bekommen Schaden nach Tempo. Teamkameraden und Springende (über 1 m hoch) bleiben unversehrt.
// Anhänger: Die Kupplung H sitzt TRAC_HITCH hinter der Traktormitte. Die Mitte des Anhängers A bleibt immer TRAC_DRAW von H entfernt und wird von H gezogen
// (wie eine Deichsel). Blickrichtung des Anhängers ty = von A nach H. Der Knickwinkel ist begrenzt (Einknicken beim Rückwärtsfahren).
function hitchOf(q) { return [q.x + Math.sin(q.yaw) * TRAC_HITCH, q.z + Math.cos(q.yaw) * TRAC_HITCH]; }
function initTrailer(q) { const [hx, hz] = hitchOf(q); q.ax = hx + Math.sin(q.yaw) * TRAC_DRAW; q.az = hz + Math.cos(q.yaw) * TRAC_DRAW; q.ty = q.yaw; }
const angD = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
function stepTrailer(q) {
  const [hx, hz] = hitchOf(q);
  let dx = q.ax - hx, dz = q.az - hz, d = Math.hypot(dx, dz);
  if (d < 1e-6) { dx = Math.sin(q.yaw); dz = Math.cos(q.yaw); d = 1; }
  q.ax = hx + dx / d * TRAC_DRAW; q.az = hz + dz / d * TRAC_DRAW;
  let ty = Math.atan2(q.ax - hx, q.az - hz);
  const df = angD(ty, q.yaw);
  if (Math.abs(df) > TRAC_JACK) { ty = q.yaw + Math.sign(df) * TRAC_JACK; q.ax = hx + Math.sin(ty) * TRAC_DRAW; q.az = hz + Math.cos(ty) * TRAC_DRAW; }
  q.ty = ty;
}
const tracMax = q => TRAC_MAX - TRAC_SLOW * (q.load ? q.load.length : 0);
// Abstand eines Punktes zur Ladefläche (Strecke durch die Anhängermitte, Länge 2 * TRAC_HALF)
function trailerDist(q, x, z) {
  const fx = -Math.sin(q.ty), fz = -Math.cos(q.ty), wx = x - q.ax, wz = z - q.az;
  const s = Math.max(-TRAC_HALF, Math.min(TRAC_HALF, wx * fx + wz * fz));
  return Math.hypot(wx - fx * s, wz - fz * s);
}
function trailerFor(x, z, R) { let best = null, bd = R; for (const q of quadList) { if (!q.kind) continue; const d = trailerDist(q, x, z); if (d < bd) { bd = d; best = q; } } return best; }
function placeLoad(q) {                                                         // geladene Kühe folgen dem Anhänger
  const fx = -Math.sin(q.ty), fz = -Math.cos(q.ty), rx = Math.cos(q.ty), rz = -Math.sin(q.ty);
  q.load.forEach((id, i) => { const c = cows[id]; if (!c) return; const sl = TR_SLOTS[i]; c.x = q.ax + fx * sl[0] + rx * sl[1]; c.z = q.az + fz * sl[0] + rz * sl[1]; c.yaw = q.ty; c.tr = q.id; c.slot = i; });
}
function loadCow(p, q) {
  const c = cows[p.cow]; if (!c) return;
  c.rider = -1; c.tr = q.id; c.lastName = p.name; q.load.push(c.id); p.cow = null; p.cowIn = false;
  ev(p, 'cowload', { x: r1(q.ax), z: r1(q.az) });
  if (p.slotBefore === 0) switchTo(p, 0);
  placeLoad(q);
  send(p, { t: 'msg', x: `Kuh verladen (${q.load.length}/${TRAC_CAP})` });
}
function unloadCow(p, q) {                                                      // die letzte Kuh vom Anhänger holen: der Spieler sitzt gleich auf ihr
  const id = q.load.pop(), c = cows[id]; if (!c) return;
  c.tr = null; c.rider = null; c.x = p.x; c.z = p.z;
  ev(p, 'cowload', { x: r1(q.ax), z: r1(q.az) });
  mountCow(p, c);
  placeLoad(q);
  send(p, { t: 'msg', x: `Kuh abgeladen (${q.load.length}/${TRAC_CAP} auf dem Anhänger)` });
}
function ramCheck(q, r, now) {
  if (!q.pt) { q.px = q.x; q.pz = q.z; q.pt = now; return; }
  const dtm = (now - q.pt) / 1000; if (dtm < 0.04) return;
  const dx = q.x - q.px, dz = q.z - q.pz, dist = Math.hypot(dx, dz), ax = q.px, az = q.pz;
  q.px = q.x; q.pz = q.z; q.pt = now;
  if (dist > 4) return;                                                         // Sprung (Netz, Neuaufstieg): kein Schaden
  const tk = q.kind === 1, v0 = tk ? 2.0 : RAM_V0;                               // der schwere Traktor richtet schon bei niedrigem Tempo Schaden an
  const v = Math.min((tk ? TRAC_MAX : QUAD_MAX) + 1, dist / dtm); if (v < v0 + 0.5 || dist < 1e-3) return;
  const ux = dx / dist, uz = dz / dist, dmg = Math.min(220, (v - v0) * (tk ? 22 : RAM_K));
  for (const t of Object.values(players)) {
    if (t.dead || t.team === r.team || t.id === r.id || (t.jy || 0) > 1.0 || now < (t.ramAt || 0)) continue;
    const wx = t.x - ax, wz = t.z - az, s = Math.max(0, Math.min(1, (wx * ux + wz * uz) / dist)), cx = ax + dx * s, cz = az + dz * s;   // nächster Punkt der Strecke
    if (Math.hypot(t.x - cx, t.z - cz) > RAM_R + (t.cow !== null ? 0.6 : 0)) continue;
    if ((t.x - cx) * ux + (t.z - cz) * uz < -0.8) continue;                      // nicht hinter dem Quad
    t.ramAt = now + RAM_CD;
    ev(r, 'ram', { x: t.x, z: t.z });
    hitQ[r.id] = hitQ[r.id] || { head: false, body: true };
    damageTo(t, r, tk ? TRACW : QUADW, dmg, false, [ux, 0.3, uz], [cx, 0, cz]);
  }
}
function mountQuad(p, q) {
  q.rider = p.id; p.quad = q.id; p.rl = null; p.melee = false; p.ads = false; p.sprint = false; p.crouch = false; p.prone = false; p.lean = 0; p.jy = 0;
  p.x = q.x; p.z = q.z; q.spd = 0;
  ev(p, 'mountq', q.kind ? { v: 1 } : {});
  send(p, { t: 'msg', x: q.kind ? 'Traktor: W/S Gas und Bremse, A/D Lenken – langsam und laut, keine Waffen! Kühe: reite sie an den Anhänger und steige dort ab.' : 'Quad: W/S Gas und Bremse, A/D Lenken – keine Waffen!' });
}
function leaveQuad(p) {
  if (p.quad === null) return;
  const q = quadList[p.quad]; p.quad = null;
  if (q) { q.rider = null; q.spd = 0; q.idleAt = Date.now(); }
}
function mountCow(p, best) {
  best.rider = p.id; best.lastName = p.name; p.cow = best.id; p.cowIn = inPen(best, p.team); p.slotBefore = p.melee ? 0 : p.slot; if (p.melee) { p.melee = false; ev(p, 'switch', { w: curInv(p).w }); } ev(p, 'mount'); if (p.slot !== 1) switchTo(p, 1);
}
function mount(p) {
  if (phase !== 'play') return;
  if (p.dead || over) return;
  if (p.quad !== null) { leaveQuad(p); ev(p, 'dismount'); return; }
  if (!p.bot && p.cow === null) {                                   // ein Quad oder Traktor in Reichweite, das näher steht als jede freie Kuh?
    let bq = null, bd = 1e9, busy = false;
    for (const q of quadList) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d >= (q.kind ? TRAC_R : QUAD_R)) continue; if (q.rider !== null) { busy = true; continue; } if (d < bd) { bd = d; bq = q; } }
    if (bq && !cows.some(c => c.rider === null && Math.hypot(c.x - p.x, c.z - p.z) < bd)) { mountQuad(p, bq); return; }
    if (busy && !bq) { send(p, { t: 'msg', x: 'Dieses Fahrzeug ist schon besetzt' }); return; }
  }
  if (p.cow !== null) {
    if (!p.bot) {                                                   // an einem Anhänger: Kuh verladen
      const tq = trailerFor(p.x, p.z, TR_LOAD_R);
      if (tq) {
        if (tq.load.length >= TRAC_CAP) send(p, { t: 'msg', x: 'Der Anhänger ist voll' });
        else if (Math.abs(tq.spd) > 1.2) send(p, { t: 'msg', x: 'Der Traktor muss zum Verladen stehen' });
        else { loadCow(p, tq); return; }
      }
    }
    cows[p.cow].rider = null; p.cow = null; ev(p, 'dismount'); if (p.slotBefore === 0) switchTo(p, 0); return;   // absteigen, dann wieder die Hauptwaffe
  }
  let best = null, bd = MOUNT_R, why = null;
  for (const c of cows) {
    const d = Math.hypot(c.x - p.x, c.z - p.z);
    if (d >= MOUNT_R) continue;
    if (c.rider !== null) { if (c.tr == null) why = why || 'Diese Kuh wird schon geritten'; continue; }
    if (d < bd) { bd = d; best = c; }
  }
  if (!p.bot) {                                                     // Kuh vom Anhänger holen (wenn keine freie Kuh näher ist)
    const tq = trailerFor(p.x, p.z, TR_UNLOAD_R);
    if (tq && tq.load.length && (!best || trailerDist(tq, p.x, p.z) <= bd)) { unloadCow(p, tq); return; }
  }
  if (best) mountCow(p, best);
  else send(p, { t: 'msg', x: why || 'Keine Kuh in Reichweite - stell dich direkt neben eine Kuh' });
}

// ---------- Granaten ----------
// Wurf: Der Client schickt die Blickrichtung, der Server rechnet die Flugbahn (Schwerkraft, Abprall an Boden, Wänden und Stämmen) und zündet nach NADE_FUSE.
// Splittergranate: Es gibt KEINE Druckwelle - der Schaden entsteht nur durch FRAG_N einzeln verfolgte Splitter, die Wänden, Boden und Körpern folgen:
// Deckung hilft, je näher desto mehr Treffer, und jeder Splitter verliert mit der Strecke an Wucht. Rauchgranate: Wolke, die Bots die Sicht nimmt.
const cap8 = v => Math.max(-8, Math.min(8, v || 0));                // Eigenbewegung des Werfers wird nur begrenzt mitgegeben (Netzsprünge sollen keine Superwürfe machen)
// Kochen: G drücken zieht den Stift und die Zündschnur (NADE_FUSE) läuft; beim Loslassen wird geworfen. Wer zu lange hält, dem explodiert sie in der Hand.
function cookStart(p) {
  if (phase !== 'play') return;
  const now = Date.now();
  if (p.dead || over || p.quad !== null || p.nades <= 0 || now < p.nadeNext || p.cook || now - (p.cookBlow || 0) < 1500) return;
  p.cook = { start: now }; ev(p, 'pin');
}
function stepCooks(now) {
  for (const p of Object.values(players)) {
    if (!p.cook) continue;
    if (p.dead || p.quad !== null) { p.cook = null; continue; }
    if (now < p.cook.start + NADE_FUSE) continue;
    p.cook = null; p.cookBlow = now; p.nades--; p.nadeNext = now + NADE_COOLDOWN;           // in der Hand explodiert
    const n = { id: nextNid++, owner: p.id, team: p.team, kind: p.nadeKind, x: p.x, y: groundY(p.x, p.z) + 1.0 + (p.jy || 0), z: p.z };
    detonate(n);
  }
}
function throwNade(p, dir) {
  if (phase !== 'play') return;
  const now = Date.now();
  if (!p.cook && now - (p.cookBlow || 0) < 1500) return;                          // kurz nach einer Explosion in der Hand kein Nachwurf (spätes Loslassen)
  if (p.dead || over || p.quad !== null || p.nades <= 0 || now < p.nadeNext) { p.cook = null; return; }
  const fuseAt = p.cook ? p.cook.start + NADE_FUSE : now + NADE_FUSE; p.cook = null;   // ohne vorheriges Ziehen: volle Zündzeit ab Wurf
  const len = Math.hypot(...dir) || 1; let d = dir.map(v => v / len); d[1] += 0.22; { const l = Math.hypot(...d); d = d.map(v => v / l); }   // leicht nach oben werfen (Bogen)
  const eye = [p.x, eyeY(p), p.z];
  let t0 = 0.6; for (const b of shootBoxes) if (Math.abs(b.x - eye[0]) < 3 + b.w / 2 && Math.abs(b.z - eye[2]) < 3 + b.d / 2) t0 = Math.min(t0, rayBox(eye, d, b) - 0.15);   // direkt vor einer Wand: gleich am Auge starten
  t0 = Math.max(0, t0);
  p.nades--; p.nadeNext = now + NADE_COOLDOWN;
  const n = { id: nextNid++, owner: p.id, team: p.team, kind: p.nadeKind, x: eye[0] + d[0] * t0, y: eye[1] + d[1] * t0 - 0.15, z: eye[2] + d[2] * t0,
    vx: d[0] * NADE_SPEED + cap8(p.vx) * 0.6, vy: d[1] * NADE_SPEED, vz: d[2] * NADE_SPEED + cap8(p.vz) * 0.6, fuse: fuseAt, bounced: 0 };
  nades.push(n);
  ev(p, 'throw');
}
function moveNade(n, h) {
  n.vy -= GRAVITY * h; const dr = Math.exp(-0.12 * h); n.vx *= dr; n.vz *= dr;
  let nx = n.x + n.vx * h, ny = n.y + n.vy * h, nz = n.z + n.vz * h;
  const R = 0.07;
  const hit = b => nx > b.x - b.w / 2 - R && nx < b.x + b.w / 2 + R && nz > b.z - b.d / 2 - R && nz < b.z + b.d / 2 + R && ny > b.y - R && ny < b.y + b.h + R;
  const inside = (x, y, z, b) => inShape(x, y, z, b, R);
  const near = [];
  for (const b of shootBoxes) if (Math.abs(b.x - n.x) < 3 + b.w / 2 && Math.abs(b.z - n.z) < 3 + b.d / 2) near.push(b);
  for (const b of treeBoxes) if (Math.abs(b.x - n.x) < 3 && Math.abs(b.z - n.z) < 3) near.push(b);
  for (const g of glassPanes) if (!g.broken && Math.abs(g.x - n.x) < 3 && Math.abs(g.z - n.z) < 3 && hit(g)) { breakGlass(g, [n.x, 0, n.z]); n.vx *= 0.6; n.vz *= 0.6; }   // Granate durchschlägt eine Scheibe
  for (const b of near) {                                            // achsenweise: wo der Weg in die Box führt, prallt die Granate ab
    if (inside(nx, n.y, n.z, b)) { n.vx *= -0.4; n.vy *= 0.8; n.vz *= 0.8; nx = n.x; n.bounced++; }
    if (inside(nx, ny, n.z, b)) { n.vy *= -0.3; n.vx *= 0.7; n.vz *= 0.7; ny = n.y; n.bounced++; }
    if (inside(nx, ny, nz, b)) { n.vz *= -0.4; n.vx *= 0.8; n.vy *= 0.8; nz = n.z; n.bounced++; }
  }
  nx = Math.max(-MAP, Math.min(MAP, nx)); nz = Math.max(-MAP, Math.min(MAP, nz));
  if (WORLD.pitDepth(n.x, n.z) - WORLD.pitDepth(nx, nz) > 0.3 && ny < groundY(nx, nz) + R) { n.vx *= -0.4; n.vz *= -0.4; nx = n.x; nz = n.z; n.bounced++; }   // Granate im Graben prallt an der Grabenwand ab, statt hinaufzuspringen
  const gy = groundY(nx, nz) + R;
  if (ny < gy) {                                                     // Boden: Abprall mit Reibung, am Ende bleibt sie liegen
    ny = gy; if (n.vy < -1.2) { n.vy *= -0.3; n.bounced++; } else n.vy = 0;
    const fr = Math.exp(-(n.vy === 0 ? 4.5 : 9) * h); n.vx *= fr; n.vz *= fr;
  }
  n.x = nx; n.y = ny; n.z = nz;
}
function explodeFrag(n) {
  const owner = players[n.owner] || null, c = [n.x, n.y + 0.25, n.z];
  bc({ t: 'ev', k: 'boom', i: n.owner, x: r1(n.x), y: r1(n.y), z: r1(n.z) });
  scareCows(n.x, n.z, 45, true);
  for (const g of glassPanes) if (!g.broken && Math.hypot(g.x - c[0], g.z - c[2]) < 10) breakGlass(g, c);   // Druck und Splitter lassen Fenster in der Nähe zerspringen
  const nearB = [];
  for (const b of shootBoxes) if (Math.abs(b.x - c[0]) < FRAG_R + b.w / 2 && Math.abs(b.z - c[2]) < FRAG_R + b.d / 2) nearB.push(b);   // nur Hindernisse in Reichweite prüfen
  for (const b of treeBoxes) if (Math.abs(b.x - c[0]) < FRAG_R + 0.4 && Math.abs(b.z - c[2]) < FRAG_R + 0.4) nearB.push(b);
  const tg = Object.values(players).filter(q => !q.dead && (q.team !== n.team || q.id === n.owner) && Math.hypot(q.x - c[0], q.z - c[2]) < FRAG_R + 1.5);   // Mitspieler bleiben verschont, du selbst nicht
  const sph = tg.map(q => hitSpheres(q)), acc = tg.map(() => 0);
  for (let i = 0; i < FRAG_N; i++) {
    let u = Math.random() * 2 - 1; if (u < -0.15) u = -u * 0.5 - 0.05;                    // die untere Hälfte würde fast nur in den Boden fliegen: dort streifen Splitter flach über den Boden (Abprall)
    const a = Math.random() * 6.2832, sn = Math.sqrt(1 - u * u), d = [sn * Math.cos(a), u, sn * Math.sin(a)];   // Richtung
    let tMax = FRAG_R;
    for (const b of nearB) { const t = rayBox(c, d, b); if (t < tMax) tMax = t; }
    { const tg2 = rayTerrain(c, d, tMax); if (tg2 < tMax) tMax = tg2; }
    let bq = -1, bt = tMax, bz = 'b';
    for (let k = 0; k < tg.length; k++) for (const [h, r, z, sx, sz] of sph[k]) { const t = raySphere(c, d, [tg[k].x + (sx || 0), h, tg[k].z + (sz || 0)], r); if (t < bt) { bt = t; bq = k; bz = z; } }
    if (bq < 0) continue;
    if (bt < 0) bt = 0;
    let dm = (4 + FRAG_DMG * Math.pow(1 - bt / FRAG_R, 1.3)) * (bz === 'l' ? LEG_MULT : bz === 'h' ? 1.4 : 1);   // Wucht sinkt mit der Strecke; Kopf mehr, Beine weniger
    if (bz === 'h' && tg[bq].helm) dm *= 0.5;
    acc[bq] = Math.min(400, acc[bq] + dm);
  }
  tg.forEach((q, k) => {
    if (acc[k] <= 0 || q.dead) return;
    const dd = [q.x - c[0], 0.3, q.z - c[2]], l = Math.hypot(...dd) || 1;
    damageTo(q, owner, FRAGW, acc[k], false, dd.map(v => v / l), c);
    if (owner && owner !== q) hitQ[owner.id] = hitQ[owner.id] || { head: false, body: true };
  });
}
// Blendgranate: Blitz und Knall. Wer den Blitz sehen kann (freie Sicht, bis FLASH_R Meter), ist bis zu FLASH_MAX Sekunden geblendet: je näher und je mehr man hineinschaut, desto länger.
// Bots sehen und zielen währenddessen nicht; Menschen bekommen einen weißen Bildschirm (Meldung 'flash'). Teamkameraden und der Werfer sind genauso betroffen.
const FLASH_R = 28, FLASH_MAX = 5;
function popFlash(n) {
  const now = Date.now(), o = [n.x, n.y + 0.2, n.z];
  bc({ t: 'ev', k: 'flash', i: n.owner, x: r1(n.x), y: r1(n.y), z: r1(n.z) });
  scareCows(n.x, n.z, 30, true);
  for (const q of Object.values(players)) {
    if (q.dead || q.obs) continue;
    const dx = q.x - n.x, dz = q.z - n.z, d = Math.hypot(dx, dz); if (d > FLASH_R) continue;
    const eye = [q.x, eyeY(q), q.z];
    if (!losClear(o, eye)) continue;
    const dy = eye[1] - o[1], dl = Math.hypot(d, dy) || 1;
    const fx = -Math.sin(q.yaw) * Math.cos(q.pitch), fy = Math.sin(q.pitch), fz = -Math.cos(q.yaw) * Math.cos(q.pitch);
    const facing = (fx * -dx + fy * -dy + fz * -dz) / dl;                           // 1 = direkt hineingeschaut, -1 = abgewandt
    const k = Math.max(0.25, Math.min(1, 0.45 + facing * 0.55));
    const dur = FLASH_MAX * (1 - d / FLASH_R) * k;
    if (dur < 0.4) continue;
    q.flashUntil = Math.max(q.flashUntil || 0, now + dur * 1000);
    if (q.bot) q.blindUntil = q.flashUntil; else send(q, { t: 'flash', d: +dur.toFixed(2) });
  }
}
function detonate(n) { if (n.kind === 'smoke') popSmoke(n); else if (n.kind === 'flash') popFlash(n); else explodeFrag(n); }
function popSmoke(n) {
  smokes.push({ id: n.id, x: n.x, y: n.y, z: n.z, born: Date.now() });
  bc({ t: 'ev', k: 'pop', i: n.owner, x: r1(n.x), y: r1(n.y), z: r1(n.z) });
}
const smokeR = (s, now) => Math.min(SMOKE_RMAX, 1.2 + (now - s.born) / 1000 * 2.2);
function stepNades(now) {
  stepCooks(now);
  for (const n of nades) { moveNade(n, 0.025); moveNade(n, 0.025); }
  for (const n of nades) if (now >= n.fuse) { n.done = true; detonate(n); }
  if (nades.some(n => n.done)) nades = nades.filter(n => !n.done);
  if (smokes.some(s => now - s.born > SMOKE_LIFE)) smokes = smokes.filter(s => now - s.born <= SMOKE_LIFE);
}
function smokeBlocks(o, tp, now) {                                   // Sichtlinie o -> tp durch eine Rauchwolke?
  for (const s of smokes) {
    const r = smokeR(s, now) * 0.85; if (r < 2.2) continue;
    const dx = tp[0] - o[0], dy = tp[1] - o[1], dz = tp[2] - o[2], L2 = dx * dx + dy * dy + dz * dz || 1e-6;
    let t = ((s.x - o[0]) * dx + (s.y + 1 - o[1]) * dy + (s.z - o[2]) * dz) / L2; t = Math.max(0, Math.min(1, t));
    if (Math.hypot(o[0] + dx * t - s.x, o[1] + dy * t - s.y - 1, o[2] + dz * t - s.z) < r) return true;
  }
  return false;
}

// Items einsammeln (automatisch beim Drüberlaufen, nur wenn es etwas bringt)
function pickups(p, now) {
  for (const k of PICK) {
    if (now < k.until || Math.hypot(k.x - p.x, k.z - p.z) > 1.8) continue;
    let msg = null;
    if (k.type === 'helm' && !p.helm) { p.helm = true; msg = 'Helm aufgenommen'; }
    else if (k.type === 'vest' && p.vest < 100) { p.vest = 100; msg = 'Schutzweste aufgenommen'; }
    else if (k.type === 'ammo' && addAmmo(p, 2, 0)) msg = 'Munition aufgenommen';
    if (msg) { k.until = now + PICKUP_RESPAWN * 1000; ev(p, 'pickup'); send(p, { t: 'msg', x: msg }); }
  }
  for (let i = drops.length - 1; i >= 0; i--) {                                    // abgelegte Medkits und Munitionskisten (nur eigenes Team)
    const d = drops[i];
    if (d.team !== p.team || Math.hypot(d.x - p.x, d.z - p.z) > 1.8 || (d.owner === p.id && now < d.ownerAt)) continue;
    let msg = null;
    if (d.type === 'med' && p.hp < HP) { p.hp = Math.min(HP, p.hp + DROP_HEAL); msg = 'Medkit aufgenommen (+' + DROP_HEAL + ' HP)'; }
    else if (d.type === 'ammo' && addAmmo(p, DROP_AMMO_MAGS, 1)) msg = 'Munition aus der Kiste genommen';
    if (!msg) continue;
    d.uses--; if (d.uses <= 0) drops.splice(i, 1);
    ev(p, 'pickup'); send(p, { t: 'msg', x: msg });
  }
}

// ---------- KI-Spieler (Bots) ----------
// Bots sind normale Spieler ohne Verbindung. Sie nutzen dieselben Funktionen (shoot, mount, ability) wie Menschen,
// werden aber vom Server gesteuert: Kühe holen, ins eigene Gehege bringen, Gegner bekämpfen, Hindernissen ausweichen.
const BOT_NAMES = ['Hans', 'Lena', 'Jonas', 'Mia', 'Emil', 'Anna', 'Paul', 'Nele', 'Ben', 'Lotta', 'Finn', 'Greta', 'Karl', 'Frieda', 'Otto', 'Ida'];
const BOT_RANGE = { ar: 90, br: 110, lmg: 100, dmr: 160, snp: 220, smg: 55, sg: 28, pst: 30 };   // ab dieser Entfernung sehen Bots Gegner (je nach Waffenart)
const BOT_STOP = { ar: 35, br: 45, lmg: 45, dmr: 60, snp: 70, smg: 25, sg: 15, pst: 15 };       // innerhalb dieser Entfernung bleiben sie stehen und kämpfen
const botCat = p => WEAPONS[p.inv[0].w].cat;
const BOT_LEVELS = [                                                   // Schwierigkeit: Reaktionszeit (ms), Zielgeschwindigkeit, Zielfehler, Suchintervall, Feuerpausen (Faktoren)
  { n: 'Leicht', react: [900, 1500], turn: 0.6, err: 1.9, scan: 1.4, pause: 1.5 },
  { n: 'Normal', react: [500, 900], turn: 1, err: 1, scan: 1, pause: 1 },
  { n: 'Schwer', react: [220, 480], turn: 1.5, err: 0.55, scan: 0.7, pause: 0.6 },
];
let botLevel = process.env.BOT_LEVEL !== undefined && process.env.BOT_LEVEL !== '' ? Math.max(0, Math.min(2, Math.round(+process.env.BOT_LEVEL) || 0)) : 1;
const BOT_ERR = 0.018;                                                  // Zielfehler (Radiant) - größer = schlechtere Bots
const RAD = r => Math.random() * r;
const rnd = (a, b) => a + Math.random() * (b - a);
const angDiff = (a, b) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };
const turnTo = (cur, want, max) => cur + Math.max(-max, Math.min(max, angDiff(cur, want)));
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);                         // gleiche Konvention wie der Client: Blick = (-sin yaw, -cos yaw)
const eyeY = p => standY(p) + (p.cow !== null ? 2.6 : (p.prone ? 0.5 : (p.crouch ? 1.2 : 1.7))) + (p.jy || 0);   // Augenhöhe über dem Meeresniveau der Karte (Gelände + Haltung)
const burstOf = W => W.cat === 'ar' ? Math.floor(rnd(3, 7)) : W.cat === 'br' ? Math.floor(rnd(2, 5)) : W.cat === 'smg' ? Math.floor(rnd(4, 9)) : W.cat === 'lmg' ? Math.floor(rnd(8, 16)) : 1;

// Feste Hindernisse (gleich wie im Client), damit Bots nicht durch Häuser, Zäune und Bäume laufen
function buildSolids() {
  solidBoxes.length = 0; solidCircles.length = 0;
  for (const h of houses) {
    if (!h.e) { solidBoxes.push({ x: h.x, z: h.z, hw: h.w / 2, hd: h.d / 2 }); continue; }
    for (const [x, z, hw, hd] of h.wl) solidBoxes.push({ x, z, hw, hd });                    // Wände mit Türöffnung
    for (const f of h.fu) solidBoxes.push({ x: f.x, z: f.z, hw: f.hw, hd: f.hd });          // Möbel
  }
  const ROUND_PROP = { well: 1.2, stack: 2.1, silo: 2.35 };                                                          // runde Gegenstände blockieren rund (Client: dieselben Werte)
  for (const p of props) if (p.k !== 'trench' && WORLD.PROP[p.k][1]) { if (ROUND_PROP[p.k]) solidCircles.push({ x: p.x, z: p.z, r: ROUND_PROP[p.k] }); else solidBoxes.push({ x: p.x, z: p.z, hw: p.w / 2, hd: p.d / 2 }); }   // Unsichtbare Graben-Sperrkästen blockieren Spieler und Bots nicht
  solidCircles.push({ x: WORLD.pond.x, z: WORLD.pond.z, r: WORLD.pond.r });                                          // Teich
  PEN.forEach((p, t) => {
    const s = PEN_R * 2, side = (w, d, x, z) => solidBoxes.push({ x: p.x + x, z: p.z + z, hw: w / 2, hd: d / 2 });
    side(s, 0.2, 0, -PEN_R); side(s, 0.2, 0, PEN_R);
    const inner = p.s * PEN_R, outer = -inner;
    side(0.2, s, outer, 0);
    const gateHalf = 3, gateSeg = PEN_R - gateHalf, gateOffset = (PEN_R + gateHalf) / 2;
    side(0.2, gateSeg, inner, -gateOffset); side(0.2, gateSeg, inner, gateOffset);   // sechs Meter breite Durchfahrt
    for (let i = 0; i < 3; i++) solidBoxes.push({ x: p.x + (outer < 0 ? -1 : 1) * (PEN_R - 2.5), z: p.z + (i - 1) * 4, hw: 0.6, hd: 0.8 }); // Heuballen
    solidCircles.push({ x: p.x, z: p.z, r: 0.2 });                                      // Fahnenmast
  });
  for (const t of trees) solidCircles.push({ x: t.x, z: t.z, r: [0.28, 0.30, 0.19][t.k] * t.s });   // so dick wie der sichtbare Stamm (Client: dieselben Werte)
}

// ---------- Wegfindung der Bots (NAV-BEGIN) ----------
// Raster mit 1-m-Zellen über die ganze Karte. Eine Zelle ist gesperrt, wenn ein Bot dort (mit Körperradius) in ein festes Hindernis ragen würde (Häuser, Wände, Möbel, Zäune, Bäume, Teich ...).
// Raster: Fußgänger (Radius 0,55 m), Reiter auf der Kuh (Radius 1,3 m) und die nackten Hindernisse (Radius 0,1 m, nur für Sichtprüfungen am Start). Türen gelten als offen (Bots öffnen sie im Vorbeigehen); durch jede Tür führt eine freie Gasse.
// A* sucht den Weg; die Bots folgen den Wegpunkten und kürzen mit Sichtprüfung ab. Sandsack-Mauern tragen sich als bewegliche Sperre ein (navDyn).
const NAV_C = 1, NAV_RAD = [0.55, 1.3, 0.1], NAV_MAXEXP = 90000, NAV_HEAP = 1 << 19;
const NAV_N = Math.ceil(2 * MAP / NAV_C) + 1, NAV_O = -MAP, NAV_NN = NAV_N * NAV_N;
const navSt = [new Uint8Array(NAV_NN), new Uint8Array(NAV_NN), new Uint8Array(NAV_NN)], navDyn = [new Uint8Array(NAV_NN), new Uint8Array(NAV_NN), new Uint8Array(NAV_NN)], navPortFlag = new Uint8Array(NAV_NN);
const navSeen = new Int32Array(NAV_NN), navClosed = new Int32Array(NAV_NN), navG = new Float32Array(NAV_NN), navPar = new Int32Array(NAV_NN);
const navHeapI = new Int32Array(NAV_HEAP), navHeapF = new Float32Array(NAV_HEAP);
const navPortals = new Map();
let navStamp = 0, navHn = 0, navPopF = 0;
const navCx = v => { const i = Math.round((v - NAV_O) / NAV_C); return i < 0 ? 0 : i >= NAV_N ? NAV_N - 1 : i; };
const navCell = (x, z) => navCx(z) * NAV_N + navCx(x);
const navBlocked = (l, i) => (navSt[l][i] !== 0 && (l === 1 || navPortFlag[i] === 0)) || navDyn[l][i] !== 0;
function navMarkBox(arr, bx, bz, hw, hd, rad, v) {
  const x0 = navCx(bx - hw - rad), x1 = navCx(bx + hw + rad), z0 = navCx(bz - hd - rad), z1 = navCx(bz + hd + rad);
  for (let iz = z0; iz <= z1; iz++) {
    if (!(Math.abs(NAV_O + iz * NAV_C - bz) < hd + rad)) continue;
    for (let ix = x0; ix <= x1; ix++) if (Math.abs(NAV_O + ix * NAV_C - bx) < hw + rad) arr[iz * NAV_N + ix] += v;
  }
}
function navMarkCircle(arr, cx, cz, r, rad, v) {
  const x0 = navCx(cx - r - rad), x1 = navCx(cx + r + rad), z0 = navCx(cz - r - rad), z1 = navCx(cz + r + rad), R = r + rad;
  for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) { const dx = NAV_O + ix * NAV_C - cx, dz = NAV_O + iz * NAV_C - cz; if (dx * dx + dz * dz < R * R) arr[iz * NAV_N + ix] += v; }
}
function buildNav() {   // nach buildSolids() und buildDoors() aufrufen
  for (let l = 0; l < 3; l++) { navSt[l].fill(0); navDyn[l].fill(0); }
  navPortFlag.fill(0); navPortals.clear();
  const skip = new Set(doors.map(d => d.sb));
  for (let l = 0; l < 3; l++) {
    for (const b of solidBoxes) if (!skip.has(b)) navMarkBox(navSt[l], b.x, b.z, b.hw, b.hd, NAV_RAD[l], 1);
    for (const c of solidCircles) navMarkCircle(navSt[l], c.x, c.z, c.r, NAV_RAD[l], 1);
  }
  for (const dr of doors) {                                                         // Gasse durch jede Tür (Mitte der Öffnung), Wegpunkte laufen dort genau in der Türmitte
    const lat = dr.w >= dr.d ? 'x' : 'z', half = (lat === 'x' ? dr.d : dr.w) / 2 + 1.7;
    const col = navCx(lat === 'x' ? dr.x : dr.z), a0 = navCx((lat === 'x' ? dr.z : dr.x) - half), a1 = navCx((lat === 'x' ? dr.z : dr.x) + half);
    for (let a = a0; a <= a1; a++) { const i = lat === 'x' ? a * NAV_N + col : col * NAV_N + a; navPortFlag[i] = 1; navPortals.set(i, { lat, v: lat === 'x' ? dr.x : dr.z }); }
  }
}
function navBox(sb, v) { for (let l = 0; l < 3; l++) navMarkBox(navDyn[l], sb.x, sb.z, sb.hw, sb.hd, NAV_RAD[l], v); }   // bewegliche Sperre (Sandsackmauer) ein- oder austragen
const navRaw = i => navSt[2][i] !== 0 || navDyn[2][i] !== 0;                    // steht hier wirklich ein Hindernis (ohne Körperradius)?
function navRawLine(x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz), n = Math.max(1, Math.ceil(len / 0.3));
  for (let k = 0; k <= n; k++) if (navRaw(navCell(x0 + dx * k / n, z0 + dz * k / n))) return false;
  return true;
}
function navFreeNear(l, i, x, z) {   // nächste freie Zelle zu (x, z); bevorzugt eine, die ohne Wand dazwischen erreichbar ist (der Bot kann dicht an einer Wand stehen)
  if (!navBlocked(l, i)) return i;
  const cx = i % NAV_N, cz = (i / NAV_N) | 0; let best = -1, bd = 1e9, any = -1, ad = 1e9;
  for (let r = 1; r <= 8; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const gx = cx + dx, gz = cz + dz; if (gx < 0 || gz < 0 || gx >= NAV_N || gz >= NAV_N) continue;
      const j = gz * NAV_N + gx; if (navBlocked(l, j)) continue;
      const d = (NAV_O + gx * NAV_C - x) ** 2 + (NAV_O + gz * NAV_C - z) ** 2;
      if (d < ad) { ad = d; any = j; }
      if (d < bd && navRawLine(x, z, NAV_O + gx * NAV_C, NAV_O + gz * NAV_C)) { bd = d; best = j; }
    }
    if (best >= 0 && r >= 2) return best;                                                // ein Ring weiter prüfen: eine nähere Zelle könnte knapp dahinter liegen
    if (r >= 4 && best < 0 && any >= 0) return any;
  }
  return best >= 0 ? best : any;
}
function navHPush(i, f) { let k = navHn++; while (k > 0) { const p = (k - 1) >> 1; if (navHeapF[p] <= f) break; navHeapF[k] = navHeapF[p]; navHeapI[k] = navHeapI[p]; k = p; } navHeapF[k] = f; navHeapI[k] = i; }
function navHPop() {
  const top = navHeapI[0]; navPopF = navHeapF[0]; const n = --navHn;
  if (n > 0) { const f = navHeapF[n], i = navHeapI[n]; let k = 0; for (;;) { let c = 2 * k + 1; if (c >= n) break; if (c + 1 < n && navHeapF[c + 1] < navHeapF[c]) c++; if (navHeapF[c] >= f) break; navHeapF[k] = navHeapF[c]; navHeapI[k] = navHeapI[c]; k = c; } navHeapF[k] = f; navHeapI[k] = i; }
  return top;
}
const NAV_DX = [1, -1, 0, 0, 1, 1, -1, -1], NAV_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
function navSeeds(l, x, z) {   // Startzellen: die eigene Zelle, oder (steht der Bot in der Sperrzone dicht an einer Wand) alle freien Zellen in der Nähe, die ohne Wand dazwischen erreichbar sind
  const i = navCell(x, z); if (!navBlocked(l, i)) return [[i, 0]];
  const cx = i % NAV_N, cz = (i / NAV_N) | 0, out = [], all = [];
  for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
    const gx = cx + dx, gz = cz + dz; if (gx < 0 || gz < 0 || gx >= NAV_N || gz >= NAV_N) continue;
    const j = gz * NAV_N + gx; if (navBlocked(l, j)) continue;
    const d = Math.hypot(NAV_O + gx * NAV_C - x, NAV_O + gz * NAV_C - z);
    all.push([j, d]); if (navRawLine(x, z, NAV_O + gx * NAV_C, NAV_O + gz * NAV_C)) out.push([j, d]);
  }
  if (out.length) return out;
  if (all.length) return all;
  const j = navFreeNear(l, i, x, z); return j >= 0 ? [[j, 0]] : [];
}
function navFind(l, sx, sz, gx, gz, avoid) {   // A*: Liste von Wegpunkten [x, z] oder null
  const seeds = navSeeds(l, sx, sz), g = navFreeNear(l, navCell(gx, gz), gx, gz); if (!seeds.length || g < 0) return null;
  const N = NAV_N, gcx = g % N, gcz = (g / N) | 0, stamp = ++navStamp; navHn = 0;
  for (const [si, sd] of seeds) { navSeen[si] = stamp; navG[si] = sd; navPar[si] = -1; const hx = Math.abs(si % N - gcx), hz = Math.abs(((si / N) | 0) - gcz); navHPush(si, sd + 1.1 * (Math.max(hx, hz) + 0.4142 * Math.min(hx, hz))); }
  let exp = 0, found = false;
  while (navHn > 0) {
    const cur = navHPop(); if (navClosed[cur] === stamp) continue; navClosed[cur] = stamp;
    if (cur === g) { found = true; break; }
    if (++exp > NAV_MAXEXP || navHn > NAV_HEAP - 16) return null;
    const cx = cur % N, cz = (cur / N) | 0, gc = navG[cur];
    for (let k = 0; k < 8; k++) {
      const nx = cx + NAV_DX[k], nz = cz + NAV_DZ[k]; if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
      const ni = nz * N + nx; if (navClosed[ni] === stamp || navBlocked(l, ni) || (avoid && avoid.has(ni))) continue;
      if (k >= 4 && (navBlocked(l, cz * N + nx) || navBlocked(l, nz * N + cx))) continue;                 // keine Ecken schneiden
      const ng = gc + (k < 4 ? 1 : 1.4142);
      if (navSeen[ni] !== stamp || ng < navG[ni]) { navSeen[ni] = stamp; navG[ni] = ng; navPar[ni] = cur; const hx = Math.abs(nx - gcx), hz = Math.abs(nz - gcz); navHPush(ni, ng + 1.1 * (Math.max(hx, hz) + 0.4142 * Math.min(hx, hz))); }
    }
  }
  if (!found) return null;
  const cells = []; for (let c = g; c >= 0; c = navPar[c]) cells.push(c); cells.reverse();
  return cells.map(c => { let x = NAV_O + (c % N) * NAV_C, z = NAV_O + ((c / N) | 0) * NAV_C; const pf = l === 0 ? navPortals.get(c) : undefined; if (pf) { if (pf.lat === 'x') x = pf.v; else z = pf.v; } return [x, z]; });
}
function navLine(l, x0, z0, x1, z1) {   // freie Strecke? An jedem Punkt müssen alle vier umliegenden Zellen frei sein, damit der Körper nicht an Ecken streift
  const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz); if (len < 1e-6) return true;
  const n = Math.ceil(len / 0.4);
  for (let k = 0; k <= n; k++) {
    const fx = (x0 + dx * k / n - NAV_O) / NAV_C, fz = (z0 + dz * k / n - NAV_O) / NAV_C, ix = Math.floor(fx), iz = Math.floor(fz);
    if (navBlocked(l, navCx(NAV_O + ix * NAV_C) + navCx(NAV_O + iz * NAV_C) * NAV_N) || navBlocked(l, navCx(NAV_O + (ix + 1) * NAV_C) + navCx(NAV_O + iz * NAV_C) * NAV_N) ||
        navBlocked(l, navCx(NAV_O + ix * NAV_C) + navCx(NAV_O + (iz + 1) * NAV_C) * NAV_N) || navBlocked(l, navCx(NAV_O + (ix + 1) * NAV_C) + navCx(NAV_O + (iz + 1) * NAV_C) * NAV_N)) return false;
  }
  return true;
}
// Nächster Wegpunkt auf dem Weg zum Ziel (tx, tz) oder null, wenn es keinen Weg gibt (dann gilt die alte Steuerung). Der Weg wird neu gesucht, wenn er alt ist, das Ziel weit gewandert ist oder der Bot festhängt (nv.reset).
function navNext(p, ai, tx, tz, now, l) {
  let nv = ai.nav; const moved = nv ? Math.hypot(nv.tx - tx, nv.tz - tz) : 1e9;
  if (!nv || nv.l !== l || nv.reset || nv.i >= nv.pts.length || now - nv.at > nv.life || moved > 10) {
    if (nv && nv.l === l && nv.failUntil > now && moved < 6) return null;           // zuletzt kein Weg: nicht in jedem Takt erneut suchen
    const pts = navFind(l, p.x, p.z, tx, tz, ai.avoid && ai.avoid.until > now ? ai.avoid.set : null);
    if (!pts) { ai.nav = { l, tx, tz, pts: [], i: 0, at: now, life: 0, failUntil: now + 1200 }; return null; }
    const lastP = pts[pts.length - 1]; if (Math.hypot(lastP[0] - tx, lastP[1] - tz) < 3 && !navBlocked(l, navCell(tx, tz))) pts.push([tx, tz]);   // zuletzt genau zum Ziel
    nv = ai.nav = { l, tx, tz, pts, i: 0, at: now, life: 1800 + Math.random() * 700, failUntil: 0, reset: false };
  }
  const pts = nv.pts, last = pts.length - 1, reach = l ? 1.6 : 0.9;
  while (nv.i < last && Math.hypot(pts[nv.i][0] - p.x, pts[nv.i][1] - p.z) < reach) nv.i++;
  for (let j = Math.min(last, nv.i + 10); j > nv.i; j--) if (navLine(l, p.x, p.z, pts[j][0], pts[j][1])) { nv.i = j; break; }   // so weit vorauslaufen, wie die Sicht frei ist
  return pts[nv.i];
}
// (NAV-END)
function collide(p, radOv, skip) {   // Kreis (Bot oder fliehende Kuh) aus Rechtecken und Kreisen herausschieben, wie move() im Client
  const rad = radOv || (p.cow !== null ? 1.2 : 0.5);
  const boxOut = (bx, bz, hw, hd) => {
    const hx = hw + rad, hz = hd + rad, dx = p.x - bx, dz = p.z - bz;
    if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
      if (hx - Math.abs(dx) < hz - Math.abs(dz)) p.x = bx + Math.sign(dx || 1) * hx; else p.z = bz + Math.sign(dz || 1) * hz;
    }
  };
  const circleOut = (cx, cz, r) => {
    const R = r + rad, dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
    if (d2 < R * R) { const d = Math.sqrt(d2); if (d < 1e-4) p.x = cx + R; else { p.x = cx + dx / d * R; p.z = cz + dz / d * R; } }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (const b of solidBoxes) boxOut(b.x, b.z, b.hw, b.hd);
    for (const c of solidCircles) circleOut(c.x, c.z, c.r);
    for (const c of cows) if (c.rider === null && c !== skip) circleOut(c.x, c.z, 1.0);   // freie Kühe sind Hindernisse (außer sich selbst)
  }
  p.x = Math.max(-MAP, Math.min(MAP, p.x)); p.z = Math.max(-MAP, Math.min(MAP, p.z));
}

const inSq = (x, z, t) => Math.abs(x - PEN[t].x) < PEN_R && Math.abs(z - PEN[t].z) < PEN_R;
// Wegpunkt: Gehege dürfen nur durch das Tor (Innenseite, Mitte) betreten und verlassen werden
function route(p, g) {
  for (let t = 0; t < TEAMS; t++) {
    const fi = inSq(p.x, p.z, t), ti = inSq(g.x, g.z, t);
    const s = PEN[t].s, gx = PEN[t].x + s * PEN_R, gz = PEN[t].z;
    const u = (p.x - PEN[t].x) * s;                      // > 0: Richtung Torseite
    if (fi && !ti) {                                     // hinaus: erst zum Tor, dann nach draußen
      if (u > PEN_R - 4 && Math.abs(p.z - gz) < 3.5) return { x: gx + s * 8, z: gz };
      return { x: gx - s * 3, z: gz };
    }
    if (!fi && ti) {                                     // hinein: erst vor das Tor, dann hindurch
      if (u >= PEN_R) {
        if (Math.abs(p.z - gz) < 3.5 && u < PEN_R + 10) return { x: gx - s * 5, z: gz };
        return { x: gx + s * 8, z: gz };
      }
      return { x: PEN[t].x + s * (PEN_R + 8), z: PEN[t].z + (p.z >= PEN[t].z ? 1 : -1) * (PEN_R + 8) }; // um die Ecke herum
    }
  }
  return g;
}

function visible(p, q) {   // Sichtlinie von p zu q
  return losClear([p.x, eyeY(p), p.z], [q.x, standY(q) + (q.prone ? 0.35 : q.crouch ? 0.75 : 1.2) + (q.cow !== null ? 0.9 : 0) + (q.jy || 0), q.z]);
}
function losClear(o, tp) {   // freie Sicht zwischen zwei Punkten? Gebäude, Baumstämme, Sandsäcke, Gelände und Rauch blockieren
  const dv = [tp[0] - o[0], tp[1] - o[1], tp[2] - o[2]], len = Math.hypot(...dv);
  if (len < 0.1) return true;
  const d = dv.map(v => v / len);
  let t = 1e9;
  for (const h of shootBoxes) t = Math.min(t, rayBox(o, d, h));
  for (const tb of treeBoxes) t = Math.min(t, rayBox(o, d, tb));
  for (const q of quadList) {
    const tk = q.kind === 1;
    t = Math.min(t, rayVehicleParts(o, d, q.x, q.z, q.yaw, groundY(q.x, q.z), tk ? TRACTOR_SHOT_PARTS : QUAD_SHOT_PARTS));
    if (tk) t = Math.min(t, rayVehicleParts(o, d, q.ax, q.az, q.ty, groundY(q.ax, q.az), TRAILER_SHOT_PARTS));
  }
  if (t > len - 0.5) t = Math.min(t, rayTerrain(o, d, len));                      // Hügel verdecken ebenfalls
  if (t > len - 0.5 && smokes.length && smokeBlocks(o, tp, Date.now())) return false;   // Rauchwolken verdecken auch
  return t > len - 0.5;
}
function pickEnemy(p) {
  let best = null, bd = BOT_RANGE[botCat(p)] * visMult();                       // Nacht, Regen und Nebel verkürzen die Sicht der Bots
  const nowE = Date.now();
  for (const q of Object.values(players)) {
    if (q.team === p.team || q.dead || q.obs) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < bd && (d < CAM_R || !camOf(q, nowE)) && visible(p, q)) { bd = d; best = q; }
  }
  return best;
}
function pickCow(p) {      // nächste freie Kuh, die nicht im eigenen Gehege steht und die kein Teamkamerad schon ansteuert
  const taken = new Set(Object.values(players).filter(q => q.bot && q !== p && q.team === p.team && q.ai.cowId >= 0).map(q => q.ai.cowId));
  let best = null, bd = 1e9;
  for (const c of cows) {
    if (c.rider !== null || inPen(c, p.team) || taken.has(c.id)) continue;
    const d = Math.hypot(c.x - p.x, c.z - p.z) + RAD(15);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function newAI(job) { return { job, lane: (Math.random() < 0.5 ? -1 : 1) * rnd(30, 70), via: null, viaKey: '', viaDone: false, target: null, nextScan: 0, reactAt: 0, burst: 3, pauseUntil: 0, cowId: -1, stuck: 0, detourUntil: 0, detourDir: 1, mountAt: 0, wz: rnd(-12, 12), wzAt: 0, thinkAt: 0, lastThink: 0 }; }
function resetAI(p) {   // nach jedem Spawn: Gedächtnis löschen; die Rolle für den nächsten Spawn wird neu gewürfelt
  p.ai = newAI(p.ai.job); p.ai.nextScan = Date.now() + RAD(400);
  p.ai.thinkAt = Date.now() + Math.random() * 100; p.ai.lastThink = Date.now();
  const L = randLoadout(); p.nextRole = L.cls; p.next1 = L.w1; p.next2 = L.w2;
}

function botThink(p, now, dt) {
  const ai = p.ai, BL = BOT_LEVELS[botLevel];
  p.reviving = false;                                                            // wird unten nur gesetzt, wenn der Bot gerade einen Kameraden wiederbelebt
  if (p.dead || over) { p.moving = false; p.sprint = false; return; }
  if (now >= (ai.doorAt || 0) && p.cow === null) {                              // Bots öffnen Türen, an denen sie vorbeilaufen
    for (const dr of doors) if (!dr.open && Math.abs(dr.x - p.x) < 2.2 && Math.abs(dr.z - p.z) < 2.2) { setDoor(dr, true); ai.doorAt = now + 700; break; }
  }
  const I = curInv(p), W = WEAPONS[I.w], cat = botCat(p);
  if (p.slot !== 0 && !ai.target) switchTo(p, 0);                                // Bots kämpfen immer mit der Hauptwaffe
  for (const J of p.inv) {                                                       // Bots gehen nie ganz ohne Munition aus
    if (J.mags && J.mags.length < 2) J.mags.push(WEAPONS[J.w].mag);
    if (J.mags === undefined && J.res < WEAPONS[J.w].mag) J.res = WEAPONS[J.w].mag * 2;
  }
  if (!p.rl && p.cow === null && !ai.target && I.cur < (W.tube ? W.mag : W.mag * 0.3 + 1)) startReload(p);
  // --- Gegner suchen (ca. 4x pro Sekunde) ---
  if (now >= ai.nextScan) {
    ai.nextScan = now + (200 + RAD(80)) * BL.scan;
    const e = p.cow !== null || now < (p.blindUntil || 0) ? null : pickEnemy(p);                // geblendete Bots sehen nichts
    if (e && ai.target !== e.id) ai.reactAt = now + rnd(BL.react[0], BL.react[1]);               // Reaktionszeit
    ai.target = e ? e.id : null;
  }
  let enemy = ai.target !== null ? players[ai.target] : null;
  if (enemy && (enemy.dead || now < (p.blindUntil || 0))) { enemy = null; ai.target = null; }
  const edist = enemy ? Math.hypot(enemy.x - p.x, enemy.z - p.z) : 0;
  // Kuhdiebe laufen an Gegnern vorbei und kämpfen nur, wenn der Gegner sehr nah ist oder sie gerade getroffen wurden; Jäger kämpfen immer
  const hurt = now - (p.hurtAt || 0) < 3000;
  const fightD = ai.job === 'hunter' ? BOT_STOP[cat] : Math.min(hurt ? 20 : 8, BOT_STOP[cat]);
  const fight = !!enemy && edist <= fightD && p.cow === null;
  // --- Fähigkeiten ---
  if (now >= p.abilityAt) {
    if (p.role === 'sani' && !fight && Object.values(players).some(q => q !== p && q.team === p.team && !q.dead && q.hp < 70 && Math.hypot(q.x - p.x, q.z - p.z) < 10)) ability(p);   // legt ein Medkit ab, wenn ein Kamerad in der Nähe verletzt ist
    else if (p.role === 'mg' && !fight && Object.values(players).some(q => q !== p && q.team === p.team && !q.dead && Math.hypot(q.x - p.x, q.z - p.z) < 8)) ability(p);
    else if (p.role === 'hirte' && p.cow !== null) ability(p);
    else if (p.role === 'pionier' && enemy && p.cow === null && edist > 10 && edist < 70) ability(p);   // baut Deckung in Richtung des Gegners
    else if (p.role === 'scharf' && enemy) ability(p);
    else if (p.role === 'sturm' && !fight && p.cow === null && ai.cowId >= 0) ability(p);
  }
  if (fight) {                                                                   // --- Kampf: stehen bleiben, zielen, schießen ---
    p.moving = false; p.sprint = false;
    const dx = enemy.x - p.x, dz = enemy.z - p.z, dh = Math.hypot(dx, dz);
    p.crouch = p.cow === null && (dh > 28 || cat === 'snp' || cat === 'dmr' || cat === 'lmg');           // auf Entfernung gehen Bots in die Hocke (kleineres Ziel, ruhigere Waffe)
    // Vorhalt: Flugzeit des Geschosses (dh / v) mal Bewegung des Gegners, dazu der Fall nach 0,1 s
    const ft = dh / W.v, fall = 0.5 * GRAVITY * Math.max(0, ft - DROP_AFTER) ** 2;
    const tx = enemy.x + (enemy.vx || 0) * ft, tz = enemy.z + (enemy.vz || 0) * ft, tdx = tx - p.x, tdz = tz - p.z;
    const ey = standY(enemy) + (enemy.prone ? 0.3 : enemy.crouch ? 0.8 : 1.3) + (enemy.cow !== null ? 0.9 : 0) + (enemy.jy || 0) + fall;
    const wantYaw = yawTo(tdx, tdz), wantPitch = Math.atan2(ey - eyeY(p), dh);
    p.yaw = turnTo(p.yaw, wantYaw, 5 * dt * BL.turn); p.pitch = turnTo(p.pitch, wantPitch, 3 * dt * BL.turn);
    const err = Math.abs(angDiff(p.yaw, wantYaw)) + Math.abs(angDiff(p.pitch, wantPitch));
    p.ads = dh > 22;
    if (now >= ai.reactAt && now >= ai.pauseUntil && err < 0.06) {
      const e = (BOT_ERR + dh * 0.00012) * BL.err * (cat === 'snp' ? 1.8 : cat === 'lmg' ? 1.3 : 1) * (enemy.moving ? 1.5 : 1), c = Math.cos(wantPitch); // laufende Ziele sind schwerer zu treffen
      const dir = [-Math.sin(wantYaw) * c, Math.sin(wantPitch), -Math.cos(wantYaw) * c].map(v => v + (Math.random() + Math.random() - 1) * e);
      const before = I.cur; shoot(p, dir);
      if (I.cur < before) { ai.burst--; if (ai.burst <= 0) { ai.burst = burstOf(W); ai.pauseUntil = now + (ai.burst > 1 ? rnd(350, 900) * BL.pause : 0); } }
    }
    return;
  }
  p.ads = false; p.crouch = false;
  // --- Niedergeschossene Kameraden: der nächste Bot (ohne Kuh, nicht im Kampf) läuft hin und belebt wieder ---
  let revGoal = null;
  if (p.cow === null && p.quad === null) {
    let dn = null, dd = 80;
    for (const q of Object.values(players)) { if (q.team !== p.team || !q.down || q.dead) continue; const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < dd) { dd = d; dn = q; } }
    if (dn) {
      const mine = !Object.values(players).some(q => q !== p && q.bot && q.team === p.team && !q.dead && !q.down && q.cow === null && q.quad === null && Math.hypot(q.x - dn.x, q.z - dn.z) < dd - 2);   // nur der nächste Bot kommt
      if (mine) revGoal = { x: dn.x, z: dn.z, rev: dn };
    }
  }
  // --- Ziel bestimmen ---
  let goal = null, cow = null;
  if (revGoal) goal = revGoal;
  else if (p.cow !== null) goal = { x: PEN[p.team].x, z: PEN[p.team].z };       // mit Kuh: ab ins eigene Gehege
  else {
    if (ai.job === 'thief') {
      cow = ai.cowId >= 0 ? cows[ai.cowId] : null;
      if (!cow || cow.rider !== null || inPen(cow, p.team)) { cow = pickCow(p); ai.cowId = cow ? cow.id : -1; }
    }
    if (ai.job === 'hunter' || !cow) {                                           // Verteidiger: Gegner mit Kuh jagen oder Gegner nahe am eigenen Gehege angreifen
      let bq = null, bd = 1e9;
      for (const q of Object.values(players)) {
        if (q.team === p.team || q.dead) continue;
        const nearPen = Math.hypot(q.x - PEN[p.team].x, q.z - PEN[p.team].z) < 100;
        if (!(q.cow !== null || (ai.job === 'hunter' && nearPen))) continue;
        const d = Math.hypot(q.x - p.x, q.z - p.z) - (q.cow !== null ? 40 : 0);
        if (d < bd) { bd = d; bq = q; }
      }
      if (bq) goal = { x: bq.x, z: bq.z };
    }
    if (!goal && cow) goal = { x: cow.x, z: cow.z, cow };
    if (!goal) {                                                                 // Wache vor dem eigenen Tor
      if (now >= ai.wzAt) { ai.wz = rnd(-12, 12); ai.wzAt = now + 8000; }
      goal = { x: PEN[p.team].x + PEN[p.team].s * 24, z: PEN[p.team].z + ai.wz };
    }
  }
  // --- Aufsteigen ---
  if (p.cow === null && goal.cow) {
    const dc = Math.hypot(goal.x - p.x, goal.z - p.z);
    if (dc < 3.4 && now >= ai.mountAt) { ai.mountAt = now + 900; mount(p); if (p.cow === null) ai.cowId = -1; }
  }
  // --- Bewegung ---
  botMove(p, ai, goal, enemy, now, dt);
}
// Bewegung eines Bots zum Ziel: Wegfindung (A* um Häuser, Zäune, Bäume), alte Steuerung nur noch als Rückfall, wenn es keinen Weg gibt
function botMove(p, ai, goal, enemy, now, dt) {
  let wx = goal.x, wz = goal.z;
  const key = (p.cow !== null ? 'pen' : 'cow' + ai.cowId) + ai.job;
  if (ai.viaKey !== key) { ai.viaKey = key; ai.via = null; ai.viaDone = false; }
  if ((ai.job === 'thief' || p.cow !== null) && !goal.rev) {                     // weite Strecken über einen eigenen Zwischenpunkt (Seitenspur), damit nicht alle durch die Mitte laufen
    const wd = Math.hypot(wx - p.x, wz - p.z);
    if (!ai.via && !ai.viaDone && wd > 110) {
      const qx = -(wz - p.z) / wd, qz = (wx - p.x) / wd, off = ai.lane;
      ai.via = { x: Math.max(-MAP + 8, Math.min(MAP - 8, (p.x + wx) / 2 + qx * off)), z: Math.max(-MAP + 8, Math.min(MAP - 8, (p.z + wz) / 2 + qz * off)) };
    }
    if (ai.via) {
      if (Math.hypot(ai.via.x - p.x, ai.via.z - p.z) < 14) { ai.via = null; ai.viaDone = true; }
      else { wx = ai.via.x; wz = ai.via.z; }
    }
  }
  const viaOn = wx !== goal.x || wz !== goal.z;
  if (ai.esc) { if (now < ai.esc.until && Math.hypot(ai.esc.x - p.x, ai.esc.z - p.z) > 2.5) { wx = ai.esc.x; wz = ai.esc.z; } else ai.esc = null; }   // Ausbruch aus einer Sackgasse (Rückfall ohne Weg): erst dieses Ziel ansteuern
  const tx = wx, tz = wz;                                                                // Ziel dieses Takts (Ziel, Zwischenpunkt oder Ausbruchspunkt)
  const riding = p.cow !== null;
  const np = ai.esc ? null : navNext(p, ai, tx, tz, now, riding ? 1 : 0);           // nächster Wegpunkt auf dem gefundenen Weg
  if (np) { wx = np[0]; wz = np[1]; }
  else if (!ai.esc && !viaOn) { const w0 = route(p, goal); wx = w0.x; wz = w0.z; }  // kein Weg gefunden: alte Torsteuerung der Gehege
  const hx = wx - p.x, hz = wz - p.z, dist = Math.hypot(hx, hz), gdist = Math.hypot(tx - p.x, tz - p.z);
  const stopAt = goal.cow && p.cow === null ? 3.2 : goal.rev ? 1.6 : 1.2;
  if (Math.hypot(goal.x - p.x, goal.z - p.z) < stopAt) {
    p.moving = false; p.sprint = false;
    if (goal.rev) { p.reviving = true; p.yaw = turnTo(p.yaw, yawTo(goal.x - p.x, goal.z - p.z), 6 * dt); }   // E halten: wiederbeleben
    return;
  }
  let heading = Math.atan2(hz, hx);
  if (!np && now < ai.detourUntil && !ai.esc) heading += ai.detourDir * 1.1;             // ohne Weg und festgefahren: seitlich ausweichen
  p.sprint = !riding && !enemy && gdist > 12;   // (auch auf dem Weg zu einem Kameraden)
  let sp = riding ? 9 : (p.sprint ? 6.2 : 3.6);
  if (now < p.boostUntil && !(riding && p.role === 'sturm')) sp *= 1.6;   // Sturm-Sprint wirkt nicht auf der Kuh
  const step = Math.min(sp * dt, Math.max(dist, 0.2)), ox = p.x, oz = p.z, nx = Math.cos(heading), nz = Math.sin(heading);
  p.x += nx * step; p.z += nz * step; collide(p);
  if (Math.hypot(p.x - ox, p.z - oz) < step * 0.3) ai.stuck++; else ai.stuck = 0;
  if (ai.stuck > 8) {
    ai.stuck = 0;
    if (np && now - (ai.navStuckAt || 0) > 3500) {                                        // am Weg hängengeblieben (Kuh, Spieler, Sandsäcke): Zelle davor sperren und neu suchen
      ai.navStuckAt = now; if (ai.nav) ai.nav.reset = true;
      const set = ai.avoid && ai.avoid.until > now ? ai.avoid.set : new Set(); set.add(navCell(p.x + nx * 1.3, p.z + nz * 1.3)); ai.avoid = { set, until: now + 5000 };
    } else if (now >= ai.detourUntil) {
      ai.detourUntil = now + rnd(900, 1800); ai.detourDir = Math.random() < 0.5 ? -1 : 1;
      // Bleibt der Bot immer wieder am selben Hindernis hängen (Zaunecke, Sackgasse), läuft er einen immer weiteren Bogen zu einem Ausweichpunkt
      ai.escN = now - (ai.escAt || 0) < 15000 ? Math.min(5, (ai.escN || 0) + 1) : 1; ai.escAt = now;
      if (ai.escN >= 2) {
        const a = heading + ai.detourDir * (1.0 + 0.45 * ai.escN), len = 9 + 5 * ai.escN;
        ai.esc = { x: Math.max(-MAP + 8, Math.min(MAP - 8, p.x + Math.cos(a) * len)), z: Math.max(-MAP + 8, Math.min(MAP - 8, p.z + Math.sin(a) * len)), until: now + 2500 + 700 * ai.escN };
        if (ai.nav) ai.nav.reset = true;
      }
    }
  }
  p.yaw = turnTo(p.yaw, yawTo(nx, nz), 8 * dt); p.pitch = turnTo(p.pitch, 0, 2 * dt);
  p.moving = true;
}

function newPlayer(ws, team, name, bot) {
  const L = safeLoadout('sturm', 'm4a1', 'm9');
  const p = { id: nextId++, ws, team, name, nextRole: L.cls, next1: L.w1, next2: L.w2, kills: 0, deaths: 0, cow: null, quad: null, nextNade: 'frag', nadeKind: 'frag', nades: 0, nadeNext: 0, dead: true, x: 0, z: 0, yaw: 0, pitch: 0, role: L.cls, w1: L.w1, w2: L.w2, slot: 0, rl: null, switchUntil: 0, hp: 0, helm: false, vest: 0, bloom: 0, ads: false, moving: false, sprint: false, jy: 0, respawnAt: 0, abilityAt: 0, boostUntil: 0, spotUntil: 0, nextShot: 0, cowIn: false, bot: !!bot, vx: 0, vz: 0, lx: 0, lz: 0 };
  p.inv = [mkInv(L.w1), mkInv(L.w2)];
  return p;
}
function addBot(team) {
  const used = new Set(Object.values(players).map(q => q.name));
  const free = BOT_NAMES.filter(n => !used.has('[KI] ' + n)), nm = (free.length ? free[Math.floor(Math.random() * free.length)] : 'Bot' + nextId);
  const p = newPlayer({ readyState: 3, send() {} }, team, '[KI] ' + nm, true);
  const nBots = Object.values(players).filter(q => q.bot && q.team === team).length;
  p.ai = newAI(nBots % 3 === 2 ? 'hunter' : 'thief');                            // jeder dritte Bot jagt Gegner, die anderen holen Kühe
  const L = randLoadout(); p.nextRole = L.cls; p.next1 = L.w1; p.next2 = L.w2;
  p.joined = true; players[p.id] = p; spawn(p);
  return p;
}
function removeBot(b) { leaveQuad(b); if (b.cow !== null) { cows[b.cow].rider = null; b.cow = null; } delete players[b.id]; }
function balanceBots() {   // Teams mit Bots auf TEAM_SIZE auffüllen; kommt ein Mensch, geht ein Bot
  for (let t = 0; t < TEAMS; t++) {
    const all = Object.values(players).filter(q => q.team === t), humans = all.filter(q => !q.bot && !q.obs).length, bots = all.filter(q => q.bot);
    const want = Math.max(0, TEAM_SIZE - humans);
    while (bots.length > want) removeBot(bots.pop());
    for (let i = bots.length; i < want; i++) addBot(t);
  }
}

// ---------- Netzwerk ----------
const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }   // nur Lesen erlaubt
  if ((req.url || '').length > 2000) { res.writeHead(414); return res.end(); }
  let url = '/';
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { /* ungültige Adresse: wie Startseite behandeln */ }
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); }   // für die Zustandsprüfung des Hosters
  if (url === '/weapons') {                              // Waffentabelle für das Menü (wird vor dem Verbinden geladen)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify({ ver: 12, weapons: Object.assign({}, WEAPONS, { fork: FORK }), classes: CLASSES, pistols: PISTOLS, cfg: { fastReload: FAST_RELOAD, doubleR: DOUBLE_R_MS, gravity: GRAVITY, dropAfter: DROP_AFTER, maxFlight: MAX_FLIGHT, switchMs: SWITCH_MS } }));
  }
  if (url === '/sounds-list') {                           // Liste aller Audiodateien im Ordner "sounds" (der Client sucht sich daraus Waffen- und Einschlagsounds)
    return fs.readdir(path.join(__dirname, 'sounds'), (e, files) => {
      const list = e ? [] : files.filter(f => AUDIO_TYPES[path.extname(f).toLowerCase()]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); res.end(JSON.stringify(list));
    });
  }
  if (url.startsWith('/sounds/')) {                       // Audiodateien aus dem Ordner "sounds" (nur Dateiname, kein Verzeichniswechsel)
    const name = path.basename(url), type = AUDIO_TYPES[path.extname(name).toLowerCase()];
    if (!type) { res.writeHead(404); return res.end(); }
    return fs.readFile(path.join(__dirname, 'sounds', name), (e, data) => {
      if (e) { res.writeHead(404); return res.end('Sound nicht gefunden'); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(data);
    });
  }
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, data) => {
    if (e) { res.writeHead(500); return res.end('index.html fehlt'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data);
  });
});
server.keepAliveTimeout = 120000; server.headersTimeout = 125000;   // hinter Proxys (z. B. Render) keine abgebrochenen Verbindungen
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
const HEARTBEAT_MISS = +process.env.HEARTBEAT_MISS || 4;                 // so viele Herzschlag-Runden (je 25 s) ohne Antwort, dann wird die Verbindung getrennt
const ipCount = new Map();                                              // Verbindungen je Adresse
const ipOf = req => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '?').slice(0, 64);
setInterval(() => {                                                      // Herzschlag: tote Verbindungen (Netz weg, Tab zu) werden aufgeräumt
  for (const w of wss.clients) { if (w.isAlive === false && ++w.missed >= HEARTBEAT_MISS) { try { w.terminate(); } catch { /* schon zu */ } continue; } w.isAlive = false; try { w.ping(); } catch { /* schon zu */ } }   // erst nach mehreren verpassten Pongs trennen: langsame oder eingefrorene Browser-Tabs sollen nicht sofort fliegen
}, 25000);

wss.on('connection', (ws, req) => {
  ws.on('error', () => { /* Fehler einer einzelnen Verbindung (zu große Nachricht, Abbruch) dürfen den Server nicht stoppen */ });
  const ip = ipOf(req), n = ipCount.get(ip) || 0;
  if (wss.clients.size > MAX_CONN || n >= MAX_PER_IP) {                   // voll oder zu viele Verbindungen von einer Adresse
    try { ws.send(JSON.stringify({ t: 'msg', x: 'Server voll – bitte später noch einmal versuchen' })); } catch { /* egal */ }
    return ws.close(1013, 'voll');
  }
  ipCount.set(ip, n + 1);
  ws.isAlive = true; ws.missed = 0; ws.on('pong', () => { ws.isAlive = true; ws.missed = 0; });
  const counts = PEN.map(() => 0);
  Object.values(players).forEach(q => { if (!q.bot && !q.obs) counts[q.team]++; });   // Teams nach echten Spielern verteilen (Bots füllen auf)
  const p = newPlayer(ws, counts.indexOf(Math.min(...counts)), 'Spieler', false);
  players[p.id] = p;
  balanceBots();
  send(p, { t: 'welcome', id: p.id, team: p.team, ver: 17, seed: WORLD.seed, env: { tod: env.tod, wx: env.wx, wd: [+wind.a.toFixed(2), +wind.s.toFixed(1)] }, dor: doors.filter(d => d.open).map(d => d.i), map: MAP, pen: PEN, penR: PEN_R, houses, props, trees, roads: WORLD.roads, plazas: WORLD.plazas, fields: WORLD.fields, pond: WORLD.pond, terrain: WORLD.terrain, gb: glassPanes.filter(g => g.broken).map(g => g.id), pick: PICK.map(k => ({ id: k.id, type: k.type, x: k.x, z: k.z })) });

  let tok = MSG_BURST, tokAt = Date.now(), drops = 0, dropT = 0;           // Nachrichten-Budget dieser Verbindung
  const joinTimer = setTimeout(() => { if (!p.joined && !p.obs && ws.readyState === 1) ws.close(1008, 'keine Anmeldung'); }, JOIN_TIMEOUT_MS);
  const onMsg = m => {
    if (p.down && !['state', 'revive', 'giveup', 'loadout', 'join', 'vote'].includes(m.t)) return;   // Niedergeschossene können nur kriechen (und am Rundenende mit abstimmen)
    if (m.t === 'join' && m.obs) {                                                                  // Beobachter: schaut nur zu, hat kein Team, keine Figur und zählt nirgends
      p.name = cleanName(m.name, 'Zuschauer'); p.obs = true; p.joined = false; p.dead = true; p.respawnAt = 0; p.ready = false;
      balanceBots(); sendVote(p); send(p, { t: 'obs' });
    } else if (m.t === 'join' && !p.obs) {
      p.name = cleanName(m.name, 'Spieler');
      const L = safeLoadout(m.role, m.w1, m.w2); p.nextRole = L.cls; p.next1 = L.w1; p.next2 = L.w2; p.nextNade = safeNade(m.nd); p.nextAtt = safeAtt(m.at);
      p.joined = true; p.ready = false; if (phase === 'lobby') lobbyEnd = Math.max(lobbyEnd, Date.now() + 8000);   // Nachzügler bekommen noch etwas Zeit
      spawn(p);
      sendVote(p);
      announceJoin(p);
    } else if (m.t === 'loadout') { const L = safeLoadout(m.role, m.w1, m.w2); p.nextRole = L.cls; p.next1 = L.w1; p.next2 = L.w2; p.nextNade = safeNade(m.nd); p.nextAtt = safeAtt(m.at); }   // gilt ab dem nächsten Respawn
    else if (m.t === 'laser') { if (p.att === 'laser' && !p.dead) { p.laserOn = p.laserOn === false; send(p, { t: 'msg', x: p.laserOn ? 'Laser an' : 'Laser aus' }); } }   // V: Laser an/aus
    else if (m.t === 'switch') switchTo(p, m.s === 2 ? 2 : (m.s === 1 ? 1 : 0));
    else if (m.t === 'melee') melee(p, m.d);
    else if (m.t === 'state' && !p.dead) {
      if ([m.x, m.z, m.yaw, m.pitch].every(Number.isFinite)) {
        p.x = Math.max(-MAP, Math.min(MAP, m.x)); p.z = Math.max(-MAP, Math.min(MAP, m.z)); p.yaw = m.yaw; p.pitch = m.pitch;
        p.ads = !!m.ads && p.quad === null; p.moving = !!m.mv;
        if (m.fm === 'a' || m.fm === 's' || m.fm === 'b') p.fm = m.fm; else if (m.fm === undefined) p.fm = '';   // Feuermodus (nur Anzeige: Wahlhebel der Waffe bei anderen Spielern)
        if (p.quad !== null) { const q = quadList[p.quad]; if (q && Number.isFinite(m.qy)) q.yaw = m.qy; if (q && Number.isFinite(m.qs)) q.spd = q.kind ? Math.max(-3.5, Math.min(tracMax(q) + 0.6, m.qs)) : Math.max(-6, Math.min(QUAD_MAX + 0.6, m.qs)); }
        const spNow = !!m.sp; if (p.sprint && !spNow) p.sprintOff = Date.now(); p.sprint = spNow;   // Sprint beendet: kurze Erholzeit vor dem ersten Schuss
        p.prone = p.down || (p.cow === null && p.quad === null && !!m.pr && !swimming(p));                                          // liegend (nicht im Sattel, nicht im Wasser)
        p.crouch = p.cow === null && p.quad === null && !!m.cr && !p.prone;                                             // Hocke (nicht im Sattel)
        p.lean = p.cow === null && p.quad === null && !p.sprint && Number.isFinite(m.ln) ? Math.round(Math.max(-1, Math.min(1, m.ln)) * 20) / 20 : 0;   // seitliches Lehnen -1 links .. +1 rechts
        p.jy = (p.cow === null && p.quad === null && Number.isFinite(m.j)) ? Math.max(0, Math.min(MAX_JUMP, m.j)) : 0; // Sprunghöhe
      }
    }
    else if (m.t === 'shoot' && Array.isArray(m.d) && m.d.length === 3 && m.d.every(Number.isFinite)) shoot(p, m.d);
    else if (m.t === 'mount') mount(p);
    else if (m.t === 'nade' && Array.isArray(m.d) && m.d.length === 3 && m.d.every(Number.isFinite)) throwNade(p, m.d);
    else if (m.t === 'ability') ability(p);
    else if (m.t === 'pin') cookStart(p);
    else if (m.t === 'reload') reloadKey(p);
    else if (m.t === 'revive') { p.reviving = !!m.on && !p.dead && !p.down; if (!p.reviving) { p.revTarget = null; p.revP = 0; } }   // E halten: Kameraden wiederbeleben
    else if (m.t === 'rank') send(p, { t: 'rank', lb: rankTop(20) });
    else if (m.t === 'door') doorToggle(p, m.i);
    else if (m.t === 'radio') radio(p, m.k, m.x, m.z);
    else if (m.t === 'botlvl') {                                                                    // Warteraum: Bot-Stärke einstellen (gilt für alle)
      if (phase === 'lobby' && p.joined && Number.isInteger(m.lvl) && m.lvl >= 0 && m.lvl < BOT_LEVELS.length && m.lvl !== botLevel) { botLevel = m.lvl; bc({ t: 'msg', x: `${p.name} stellt die Bots auf „${BOT_LEVELS[botLevel].n}"` }); }
    }
    else if (m.t === 'ready') { if (phase === 'lobby' && p.joined) p.ready = !p.ready; }
    else if (m.t === 'team') {                                                                      // Warteraum: Team wechseln (nur zu einem Team, das nicht größer ist als dein jetziges)
      if (phase === 'lobby' && p.joined && Number.isInteger(m.team) && m.team >= 0 && m.team < TEAMS && m.team !== p.team) {
        const hc = t => Object.values(players).filter(q => !q.bot && q.joined && q.team === t && q !== p).length;
        if (hc(m.team) <= hc(p.team)) { p.team = m.team; p.ready = false; balanceBots(); spawn(p); send(p, { t: 'teamset', team: p.team }); bc({ t: 'msg', x: `${p.name} wechselt zu Team ${TEAM_NAMES[p.team]}` }); }
        else send(p, { t: 'msg', x: `Team ${TEAM_NAMES[m.team]} ist schon voller – die Teams sollen ausgeglichen bleiben` });
      }
    }
    else if (m.t === 'vote') { if (phase === 'over' && p.joined && Number.isInteger(m.i) && m.i >= 0 && m.i < voteOpts.length) { p.vote = m.i; bc({ t: 'votes', v: voteCounts() }); } }
    else if (m.t === 'giveup') { if (p.down) kill(p, p.downBy !== null && players[p.downBy] ? players[p.downBy] : null, null, null, 'hat aufgegeben'); }
  };
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const now = Date.now(); tok = Math.min(MSG_BURST, tok + (now - tokAt) * MSG_RATE / 1000); tokAt = now;
    if (tok < 1) {                                                         // zu viele Nachrichten: verwerfen, bei Dauerfeuer trennen
      if (now - dropT > 10000) { drops = 0; dropT = now; }
      if (++drops > 600) ws.close(1008, 'zu viele Nachrichten');
      return;
    }
    tok--;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;           // "null", Zahlen, Listen: ignorieren (früher stürzte der Server dabei ab)
    try { onMsg(m); } catch (err) { console.log('Fehler bei Nachricht', String(m.t).slice(0, 20), '-', err && err.message); }   // eine kaputte Nachricht darf nie den Server stoppen
  });
  ws.on('close', () => {
    clearTimeout(joinTimer); { const c = (ipCount.get(ip) || 1) - 1; if (c > 0) ipCount.set(ip, c); else ipCount.delete(ip); }
    if (p.cow !== null) cows[p.cow].rider = null;
    leaveQuad(p);
    announceLeave(p);
    delete players[p.id];
    balanceBots();
  });
});

// Beitritt / Austritt: kurze Meldung an die anderen Spieler (rechts im Bild, getrennt vom Killfeed). Bei einem Kartenwechsel laden alle Clients neu und melden sich wieder an – das ist kein echter Beitritt:
// Wer innerhalb von 5 s wieder erscheint (Neuladen), wird still wieder eingesetzt, und kurz nach dem Kartenwechsel gibt es gar keine Meldungen.
const pendingLeave = new Map(); let newMapAt = 0;
const NEWMAP_QUIET_MS = 40000, LEAVE_DELAY_MS = 5000;
function announceJoin(p) {
  const key = p.name.toLowerCase();
  if (pendingLeave.has(key)) { clearTimeout(pendingLeave.get(key)); pendingLeave.delete(key); return; }
  if (Date.now() - newMapAt < NEWMAP_QUIET_MS) return;
  for (const q of Object.values(players)) if (q !== p && !q.bot) send(q, { t: 'jn', k: 'join', n: p.name, tm: p.team });
}
function announceLeave(p) {
  if (!p.joined || p.bot) return;
  const key = p.name.toLowerCase(), name = p.name, team = p.team;
  if (pendingLeave.has(key)) clearTimeout(pendingLeave.get(key));
  pendingLeave.set(key, setTimeout(() => { pendingLeave.delete(key); if (Date.now() - newMapAt < NEWMAP_QUIET_MS) return; bc({ t: 'jn', k: 'leave', n: name, tm: team }); }, LEAVE_DELAY_MS));
}
const voteCounts = () => { const c = voteOpts.map(() => 0); for (const q of Object.values(players)) if (!q.bot && q.joined && q.vote >= 0 && q.vote < c.length) c[q.vote]++; return c; };
const voteMsg = () => ({ t: 'voteopts', opts: voteOpts.map((o, i) => ({ i, seed: o.seed, same: o.seed === WORLD.seed, w: o.w, rgb: o.rgb })), v: voteCounts() });
function sendVote(p) { if (phase === 'over' && voteOpts.length) send(p, voteMsg()); }
function endRound(now) {
  over = true; phase = 'over'; voteEnd = now + (SEED_FIXED || !voteOpts.length ? 15 : VOTE_S) * 1000;
  const s = score(), top = Math.max(...s), lead = s.map((v, t) => v === top ? t : -1).filter(t => t >= 0);
  const head = lead.length === 1 ? `Team ${TEAM_NAMES[lead[0]]} gewinnt!` : lead.length === TEAMS ? 'Unentschieden!' : `Unentschieden zwischen ${lead.map(t => TEAM_NAMES[t]).join(' und ')}!`;
  const part = Object.values(players).filter(q => q.joined || q.bot);
  for (const q of part) q.vote = -1;
  const rows = part.map(q => ({ n: q.name, t: q.team, k: q.kills || 0, d: q.deaths || 0, dl: q.dl || 0, rv: q.revives || 0, hs: q.hs || 0, dm: Math.round(q.dmg || 0), pt: roundScore(q), b: q.bot ? 1 : 0, id: q.id })).sort((a, b) => b.pt - a.pt);
  const mvp = rows.length && rows[0].pt > 0 ? rows[0] : null;
  for (const q of part) {                                                         // Rangliste: nur echte Spieler
    if (q.bot) continue;
    const key = q.name.toLowerCase(), r = RANK[key] || (RANK[key] = { name: q.name, rounds: 0, wins: 0, kills: 0, deaths: 0, delivers: 0, revives: 0, mvps: 0, dmg: 0, pts: 0 });
    r.name = q.name; r.rounds++; if (lead.length === 1 && lead[0] === q.team) r.wins++; r.kills += q.kills || 0; r.deaths += q.deaths || 0; r.delivers += q.dl || 0; r.revives += q.revives || 0; r.dmg += Math.round(q.dmg || 0);
    if (mvp && mvp.id === q.id) r.mvps++; r.pts += Math.max(0, roundScore(q));
  }
  saveRank();
  bc({ t: 'end', text: head + ` (${s.join(' : ')})`, win: lead, rows, mvp: mvp ? mvp.n : '', lb: rankTop(10), secs: Math.round((voteEnd - now) / 1000), fixed: SEED_FIXED ? 1 : 0 });
  if (!SEED_FIXED && voteOpts.length) { const m = voteMsg(); for (const q of Object.values(players)) if (!q.bot) send(q, m); }
  console.log('Runde beendet: ' + head + ' ' + s.join(':'));
}
function finishVote() {                                                          // Abstimmung auswerten: meiste Stimmen; bei Gleichstand oder ohne Stimmen entscheidet das Los unter den neuen Karten
  let seed = null;
  if (!SEED_FIXED && voteOpts.length) {
    const c = voteCounts(), mx = Math.max(...c);
    const pool = mx > 0 ? c.map((n, i) => n === mx ? i : -1).filter(i => i >= 0) : voteOpts.map((o, i) => o.seed !== WORLD.seed ? i : -1).filter(i => i >= 0);
    const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : 0;
    seed = voteOpts[pick].seed;
    bc({ t: 'msg', x: seed === WORLD.seed ? 'Abstimmung: gleiche Karte noch einmal' : `Abstimmung: neue Karte #${seed}` });
  }
  reset(seed);
}

// ---------- Spielschleife: 20 Hz ----------
setInterval(() => {
  const now = Date.now();
  for (const p of Object.values(players)) {
    tickReload(p, now);
    p.bloom = Math.max(0, p.bloom - 0.00075); // Rückstoß-Streuung klingt ab
    if (p.dead && !over && p.respawnAt && now >= p.respawnAt) { p.respawnAt = 0; spawn(p); }
    if (p.down && !p.dead && now - p.downAt >= DOWN_MS) kill(p, p.downBy !== null && players[p.downBy] ? players[p.downBy] : null, null, null, 'ist verblutet');
    if (p.bot && phase === 'play' && p.ai && now >= p.ai.thinkAt) {
      const ai = p.ai, dt = Math.min(0.12, Math.max(0.05, (now - (ai.lastThink || now - 50)) / 1000));
      ai.lastThink = now; ai.thinkAt = now + 90 + Math.random() * 20;   // KI halb so oft aktualisieren und die Bots über die Zeit verteilen
      botThink(p, now, dt);
    }
    { const k = 0.5; p.vx = p.vx * (1 - k) + (p.x - p.lx) / 0.05 * k; p.vz = p.vz * (1 - k) + (p.z - p.lz) / 0.05 * k; p.lx = p.x; p.lz = p.z; if (p.dead) { p.vx = 0; p.vz = 0; } }   // geschätzte Geschwindigkeit (Vorhalt der Bots)
    if (!p.dead && !p.down) pickups(p, now);
    if (!p.dead && p.cow !== null) {
      const c = cows[p.cow];
      c.x = p.x; c.z = p.z; c.yaw = p.yaw;
      c.lastName = p.name;
      const inOwn = inPen(c, p.team);
      if (p.cowIn) { if (!inOwn) p.cowIn = false; }   // Kuh wurde aus dem eigenen Gehege geholt: erst nach dem Verlassen zählt eine neue Abgabe
      else if (inOwn) {                                 // Abgabe: Reiter steigt ab, Kuh bleibt tiefer im Gehege stehen
        c.rider = null; p.cow = null; if (p.slotBefore === 0) switchTo(p, 0);
        c.x = PEN[p.team].x + (c.x - PEN[p.team].x) * 0.5 + (Math.random() - 0.5) * 3;
        c.z = PEN[p.team].z + (c.z - PEN[p.team].z) * 0.5 + (Math.random() - 0.5) * 3;
        p.dl = (p.dl || 0) + 1;
        bc({ t: 'ev', k: 'deliver', i: p.id, x: c.x, z: c.z, team: p.team });
      }
    }
  }
  for (const c of cows) { // Kuh betritt oder verlässt ein Gehege: Meldung (Punktestand folgt automatisch der Position)
    const pen = penOf(c);
    if (pen === c.pen) continue;
    if (c.pen >= 0 && c.lastName) bc({ t: 'msg', x: `${c.lastName} holt eine Kuh aus dem ${teamName(c.pen)} Gehege` });
    if (pen >= 0 && c.lastName) bc({ t: 'msg', x: `${c.lastName} bringt eine Kuh ins ${TEAM_ADJ[pen]} Gehege` });
    c.pen = pen;
  }
  if (phase === 'lobby') {                                                      // Warteraum: Start, wenn alle bereit sind oder die Zeit abgelaufen ist
    const hum = Object.values(players).filter(q => !q.bot && q.joined);
    if (!hum.length) lobbyEnd = now + LOBBY_S * 1000;
    else if (hum.every(q => q.ready) || now >= lobbyEnd) startPlay(now);
  }
  if (phase === 'play' && !over && now >= matchEnd) endRound(now);
  if (phase === 'over' && now >= voteEnd) finishVote();
  for (const q of quadList) {                                                  // Quad folgt seinem Fahrer; verlassene Quads fahren nach einer Weile heim
    if (q.rider !== null) { const r = players[q.rider]; if (r) { q.x = r.x; q.z = r.z; ramCheck(q, r, now); } else { q.rider = null; q.idleAt = now; } }
    if (q.rider === null) {
      q.pt = 0;
      if (q.idleAt && now - q.idleAt > QUAD_HOME_MS && Math.hypot(q.x - q.hx, q.z - q.hz) > 4 && !(q.kind && q.load.length)) { q.x = q.hx; q.z = q.hz; q.yaw = q.hyaw; q.spd = 0; if (q.kind) initTrailer(q); }   // ein beladener Traktor bleibt stehen, wo er ist
    }
    if (q.kind) { stepTrailer(q); placeLoad(q); if (q.rider !== null && q.load.length) { const r = players[q.rider]; if (r) for (const id of q.load) if (cows[id]) cows[id].lastName = r.name; } }
  }
  stepCows(now); stepWind(now);
  for (const b of barricades.slice()) if (now >= b.until) removeBarricade(b);
  reviveTick(now);
  stepNades(now);
  stepBullets(now);
  const pl = Object.values(players).filter(p => !p.obs).map(p => ({ i: p.id, n: p.name, t: p.team, x: p.x, z: p.z, y: p.yaw, p: p.pitch, h: Math.round(p.hp), d: p.dead ? 1 : 0, c: p.cow, q: p.quad, j: +(p.jy || 0).toFixed(2), sp: p.sprint ? 1 : 0, cr: p.crouch ? 1 : 0, pr: p.prone ? 1 : 0, rd: p.ready ? 1 : 0, jn: p.joined ? 1 : 0, dn: p.down ? 1 : 0, rv: p.down ? +(p.rev || 0).toFixed(2) : 0, ln: p.lean || 0, ad: p.ads ? 1 : 0, em: !p.melee && p.inv[p.slot] && p.inv[p.slot].cur <= 0 ? 1 : 0, fm: p.fm || '', la: p.att === 'laser' && p.slot === 0 && !p.melee && !p.dead && !p.down ? (p.laserOn === false ? 2 : 1) : 0, rl: p.rl ? (p.rl.tube ? 3 : (p.rl.fast ? 2 : 1)) : 0, sw: swimming(p) ? 1 : 0, b: now < p.boostUntil && !(p.role === 'sturm' && p.cow !== null) ? 1 : 0, s: now < p.spotUntil ? 1 : 0, r: p.role, w: p.melee ? 'fork' : p.inv[p.slot].w, k: p.kills, de: p.deaths, cm: camOf(p, now) ? 1 : 0 }));
  const cw = cows.map(c => [c.id, c.pen, +c.x.toFixed(1), +c.z.toFixed(1), +c.yaw.toFixed(2), c.tr != null ? 2 : c.rider !== null ? 1 : 0, c.tr != null ? c.tr : -1, c.tr != null ? c.slot : 0]);
  for (let i = drops.length - 1; i >= 0; i--) if (now >= drops[i].until) drops.splice(i, 1);
  const dr = drops.map(d => [d.id, d.type === 'med' ? 0 : 1, +d.x.toFixed(1), +d.z.toFixed(1), d.team, d.uses]);
  const pk = PICK.filter(k => now >= k.until).map(k => k.id);
  const qd = quadList.map(q => [q.id, +q.x.toFixed(1), +q.z.toFixed(1), +q.yaw.toFixed(2), +q.spd.toFixed(1), q.rider !== null ? 1 : 0, q.kind || 0, q.kind ? +q.ty.toFixed(3) : 0, q.kind ? q.load.length : 0]);
  const gn = nades.map(n => [n.id, n.kind === 'smoke' ? 1 : n.kind === 'flash' ? 2 : 0, +n.x.toFixed(2), +n.y.toFixed(2), +n.z.toFixed(2)]);
  const sm = smokes.map(s => [s.id, +s.x.toFixed(1), +s.y.toFixed(1), +s.z.toFixed(1), now - s.born]);
  const br = barricades.map(b => [b.id, +b.x.toFixed(2), +b.z.toFixed(2), b.w, b.d, +b.y.toFixed(2), +b.h.toFixed(2)]);
  const base = { t: 'snap', pl, cw, qd, gn, sm, dr, pk, br, wd: [+wind.a.toFixed(2), +wind.s.toFixed(1)], dor: doors.filter(d => d.open).map(d => d.i), sc: score(), left: phase === 'lobby' ? MATCH_SECONDS : Math.max(0, Math.round((matchEnd - now) / 1000)), over, bl: botLevel, ph: phase === 'play' ? 0 : phase === 'lobby' ? 1 : 2, lt: phase === 'lobby' ? Math.max(0, Math.ceil((lobbyEnd - now) / 1000)) : phase === 'over' ? Math.max(0, Math.ceil((voteEnd - now) / 1000)) : 0 };
  for (const p of Object.values(players)) {
    const I = p.inv[p.slot], W = WEAPONS[I.w], J = p.inv[1 - p.slot], V = WEAPONS[J.w], rl = p.rl;
    const mg = I.mags ? I.mags.slice().sort((a, b) => b - a) : null;
    send(p, { ...base, me: { lo: p.laserOn === false ? 0 : 1, hp: Math.round(p.hp), w: p.melee ? 'fork' : I.w, wg: I.w, slot: p.slot, mel: p.melee ? 1 : 0, mcd: Math.max(0, +((p.meleeNext - now) / 1000).toFixed(2)), ammo: I.cur, cap: W.mag + W.ch, mags: mg, res: I.res !== undefined ? I.res : 0, w2: J.w, a2: J.cur, m2: J.mags ? J.mags.length : J.res, helm: p.helm, vest: Math.round(p.vest),
      rl: rl ? (rl.tube ? 3 : rl.fast ? 2 : 1) : 0, rld: rl ? +rl.dur.toFixed(2) : 0, rk: rl && rl.rk ? +rl.rk.toFixed(2) : 0, rlt: rl ? +Math.max(0, (rl.end - now) / 1000).toFixed(2) : 0, sw: Math.max(0, +((p.switchUntil - now) / 1000).toFixed(2)),
      cd: Math.max(0, (p.abilityAt - now) / 1000), dead: p.dead, dn: p.down ? 1 : 0, dnt: p.down ? Math.max(0, Math.ceil((p.downAt + DOWN_MS - now) / 1000)) : 0, dhp: p.down ? Math.round(p.downHp) : 0, rv: p.down ? +(p.rev || 0).toFixed(2) : +(p.revP || 0).toFixed(2), revs: p.revives || 0, rdy: p.ready ? 1 : 0, rs: Math.max(0, Math.ceil((p.respawnAt - now) / 1000)), role: p.role, cow: p.cow, quad: p.quad, nd: p.nadeKind, nn: p.nades, at: p.att || '', sl: now < (p.slowUntil || 0) ? 1 : 0, cm: camOf(p, now) ? 1 : 0 } });
  }
}, 50);

loadWorld(newSeed());
reset(null);
balanceBots();
process.on('uncaughtException', e => console.log('Unerwarteter Fehler (Server läuft weiter):', e && e.stack || e));
process.on('unhandledRejection', e => console.log('Unerwarteter Fehler (Server läuft weiter):', e && e.stack || e));
server.listen(PORT, () => console.log(`Cow Theft läuft auf http://localhost:${PORT}  (KI-Spieler pro Team: bis ${TEAM_SIZE})`));
