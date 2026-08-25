/* Refresca el PL (rango de SoloQ) de todos los jugadores del torneo y el promedio por
   equipo, dentro de torneo-data.js. Lee el archivo, consulta Riot para cada Riot ID y
   reescribe el mismo archivo con `rank` por jugador y `avg` por equipo.

   Uso:  RIOT_API_KEY=xxxx node tools/refresh-tourney-pl.js
   Región: LAS (cluster de cuentas: americas · plataforma: la2). Lo corre el workflow
   .github/workflows/refresh-tourney-pl.yml cada 6 h. */
const fs = require('fs');
const path = require('path');

const KEY = process.env.RIOT_API_KEY;
if (!KEY) { console.error('Falta RIOT_API_KEY'); process.exit(1); }
const CLUSTER = 'americas', PLATFORM = 'la2';
const FILE = path.join(__dirname, '..', 'torneo-data.js');

// ---- lee torneo-data.js -> objeto ----
const raw = fs.readFileSync(FILE, 'utf8');
const m = raw.match(/window\.TDATA\s*=\s*([\s\S]*);\s*$/);
if (!m) { console.error('No pude parsear torneo-data.js'); process.exit(1); }
const data = JSON.parse(m[1]);

// ---- rate-limited fetch a Riot ----
let last = 0;
async function riot(url) {
  const wait = Math.max(0, 1350 - (Date.now() - last)); if (wait) await new Promise(r => setTimeout(r, wait)); last = Date.now();
  for (let a = 0; a < 6; a++) {
    let res; try { res = await fetch(url, { headers: { 'X-Riot-Token': KEY } }); } catch { await new Promise(r => setTimeout(r, 1500)); continue; }
    if (res.status === 429) { const ra = +(res.headers.get('retry-after') || 3); await new Promise(r => setTimeout(r, (ra + 1) * 1000)); last = Date.now(); continue; }
    if (res.status === 404) return null;
    if (res.status >= 500) { await new Promise(r => setTimeout(r, 1500)); continue; }
    if (!res.ok) return { __err: res.status };
    return res.json();
  }
  return { __err: 'retry' };
}
async function leagueOn(plat, puuid) {
  let e = await riot(`https://${plat}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`);
  if (e && e.__err) e = null;
  if (e === null) {
    const s = await riot(`https://${plat}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`);
    if (s && s.id && !s.__err) e = await riot(`https://${plat}.api.riotgames.com/lol/league/v4/entries/by-summoner/${s.id}`);
  }
  return Array.isArray(e) ? e : null;
}
async function rankOf(rid) {
  const i = rid.lastIndexOf('#'); const name = rid.slice(0, i).trim(), tag = rid.slice(i + 1).trim();
  const acc = await riot(`https://${CLUSTER}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  if (!acc || acc.__err || !acc.puuid) return null;
  let entries = await leagueOn(PLATFORM, acc.puuid);
  if (entries === null) {
    const reg = await riot(`https://${CLUSTER}.api.riotgames.com/riot/account/v1/region/by-game/lol/by-puuid/${acc.puuid}`);
    if (reg && reg.region && !reg.__err && reg.region !== PLATFORM) entries = await leagueOn(reg.region, acc.puuid);
  }
  const e = (Array.isArray(entries) ? entries : []).find(x => x.queueType === 'RANKED_SOLO_5x5');
  return e ? { tier: e.tier, div: e.rank, lp: e.leaguePoints } : null;
}

// ---- LP absoluto para promediar y mapear de vuelta a tier ----
const TIERV = { IRON: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4, EMERALD: 5, DIAMOND: 6 };
const DIVV = { IV: 0, III: 1, II: 2, I: 3 };
const APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const abs = r => { if (!r || !r.tier || r.tier === 'UNRANKED') return null; if (APEX.has(r.tier)) return 2800 + (r.lp || 0); return (TIERV[r.tier] || 0) * 400 + (DIVV[r.div] || 0) * 100 + (r.lp || 0); };
function fromAbs(a) {
  if (a == null) return null;
  if (a >= 2800) return { tier: 'MASTER', div: '', lp: Math.round(a - 2800) };
  const N = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'], D = ['IV', 'III', 'II', 'I'];
  let x = Math.max(0, a); const ti = Math.min(6, Math.floor(x / 400)); x -= ti * 400; const di = Math.min(3, Math.floor(x / 100)); x -= di * 100;
  return { tier: N[ti], div: D[di], lp: Math.round(x) };
}

(async () => {
  // riotids únicos
  const rids = []; const seen = new Set();
  (data.teams || []).forEach(t => (t.players || []).forEach(p => { const r = (p.rid || '').trim(); if (r && !seen.has(r.toLowerCase())) { seen.add(r.toLowerCase()); rids.push(r); } }));
  const ranks = {}; let done = 0, ok = 0;
  for (const rid of rids) {
    try { const r = await rankOf(rid); ranks[rid.toLowerCase()] = r; if (r) ok++; }
    catch { ranks[rid.toLowerCase()] = null; }
    if (++done % 20 === 0) console.log(`  ${done}/${rids.length}…`);
  }
  // aplica rank por jugador + avg por equipo
  let nRanked = 0;
  (data.teams || []).forEach(t => {
    const absList = [];
    (t.players || []).forEach(p => {
      const r = ranks[(p.rid || '').toLowerCase()];
      if (r && r.tier && r.tier !== 'UNRANKED') { p.rank = { tier: r.tier, div: (r.div || ''), lp: r.lp }; nRanked++; const a = abs(p.rank); if (a != null) absList.push(a); }
      else delete p.rank;
    });
    t.avg = absList.length ? fromAbs(absList.reduce((s, v) => s + v, 0) / absList.length) : null;
    t.ranked = absList.length;
  });
  data.plUpdatedAt = new Date().toISOString();
  fs.writeFileSync(FILE, '/* Datos oficiales del Torneo LoL UDPORROS 2026 + rango (PL) por jugador y promedio por equipo. Generado del Excel + Riot API (refresh-tourney-pl.js). */\nwindow.TDATA = ' + JSON.stringify(data) + ';\n');
  console.log(`Listo: ${nRanked}/${rids.length} jugadores con rango. Escrito ${FILE}`);
})();
