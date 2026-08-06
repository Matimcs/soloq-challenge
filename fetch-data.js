/* ============================================================
   fetch-data.js  —  Consulta la Riot API y escribe players.json / players.js
   ------------------------------------------------------------
   La API key SOLO vive aquí (backend). Nunca en el frontend.
   Uso:  RIOT_API_KEY=xxxx node fetch-data.js
   Región: LAS  (cluster de cuentas: americas · plataforma: la2)

   Genera:
     - Ranking (tabla)
     - Live Games estilo scoreboard: ambos equipos, 10 jugadores con
       campeón + hechizos + rango, bans, y el jugador del challenge
       resaltado con su posición.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.RIOT_API_KEY;
if (!API_KEY) { console.error('Falta RIOT_API_KEY'); process.exit(1); }

const CLUSTER  = 'americas';   // account-v1
const PLATFORM = 'la2';        // league-v4 / spectator-v5  (LAS = la2)

const RIOT_IDS = [
  'SionAntisionista#SAS', 'Krok#DEUS', 'Petu#99999', 'Plüs#SICK', 'Sunless#0410',
  'Yoyobox#1899', 'SKT T1 seiya157#LAS', 'Kriida#7777', 'HudsonHornet#gueon',
  'Yutsero#LAS', 'Lacosabuena#LAS', 'Dekai#LAS', 'vishh#LAS', 'kıwı#wıkı',
  'elmaio04#LAS', 'DeSean#Elba', 'Henry Miller#379',
  'AntisionistaSion#SMURF', 'Hunßatz#LAS',
];

const TIER_ORDER = { CHALLENGER:9, GRANDMASTER:8, MASTER:7, DIAMOND:6, EMERALD:5,
                     PLATINUM:4, GOLD:3, SILVER:2, BRONZE:1, IRON:0, UNRANKED:-1 };
const DIV_VAL = { I:4, II:3, III:2, IV:1, '':0 };
const NO_DIVISION = new Set(['MASTER','GRANDMASTER','CHALLENGER']);
const HIGH_ELO = new Set(['CHALLENGER','GRANDMASTER','MASTER']);
const QUEUES = { 420:'Ranked SoloQ', 440:'Flex', 400:'Normal Draft', 430:'Normal',
                 450:'ARAM', 490:'Quickplay', 700:'Clash', 720:'ARAM Clash',
                 1700:'Arena', 900:'ARURF', 1900:'URF' };
// Nombre de tier en formato "Master" (como el sitio original)
const ROLE_LBL = { TOP:'Top', JUNGLE:'Jungla', MIDDLE:'Medio', BOTTOM:'ADC', UTILITY:'Support' };
const TIER_LABEL = { CHALLENGER:'Challenger', GRANDMASTER:'Grandmaster', MASTER:'Master',
                     DIAMOND:'Diamond', EMERALD:'Emerald', PLATINUM:'Platinum', GOLD:'Gold',
                     SILVER:'Silver', BRONZE:'Bronze', IRON:'Iron' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===== Caché persistente (reduce requests entre ciclos) =====
const CACHE_DIR  = path.join(__dirname, 'cache');
const PUUID_FILE = path.join(CACHE_DIR, 'puuids.json');
const RANK_FILE  = path.join(CACHE_DIR, 'ranks.json');
const RANK_TTL   = 15 * 60 * 1000;   // rango de un RIVAL vale 15 min (dura ~1 partida)
function loadJSON(f, def){ try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return def; } }
const MATCH_FILE = path.join(CACHE_DIR, 'matches.json');
const puuidCache = loadJSON(PUUID_FILE, {});   // "RiotId#TAG" -> puuid  (nunca caduca)
const rankStore  = loadJSON(RANK_FILE,  {});   // puuid -> { entry, at }
const matchStore = loadJSON(MATCH_FILE, {});   // puuid -> { games:[{id,win,champ,end}], lastAbsLP, lpGames:[{win,delta}] }
let REQ_COUNT = 0;                             // requests reales a Riot este ciclo

async function riot(url) {
  REQ_COUNT++;
  const res = await fetch(url, { headers: { 'X-Riot-Token': API_KEY } });
  if (res.status === 404) return null;
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') || 2);
    console.warn(`  429 rate limit, esperando ${retry}s...`);
    await sleep(retry * 1000);
    return riot(url);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}

/* ===== Data Dragon (campeones, hechizos, runas) — sin API key ===== */
async function getDDragon() {
  const version = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
  const base = `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US`;
  const [cj, sj, rr] = await Promise.all([
    (await fetch(`${base}/champion.json`)).json(),
    (await fetch(`${base}/summoner.json`)).json(),
    (await fetch(`${base}/runesReforged.json`)).json(),
  ]);
  const champById = {}, spellByKey = {}, runeById = {};
  for (const k in cj.data) { const c = cj.data[k]; champById[c.key] = { id:c.id, name:c.name }; }
  for (const k in sj.data) { const s = sj.data[k]; spellByKey[s.key] = s.id; }
  rr.forEach(st => { runeById[st.id] = st.icon; }); // icon: "perk-images/Styles/7200_Domination.png"
  return { version, champById, spellByKey, runeById };
}

async function getPuuid(riotId) {
  if (puuidCache[riotId]) return puuidCache[riotId];   // ya resuelto antes → 0 requests
  const [name, tag] = riotId.split('#');
  const data = await riot(`https://${CLUSTER}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/`
            + `${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  if (data && data.puuid) puuidCache[riotId] = data.puuid;
  return data ? data.puuid : null;
}

async function getSoloEntry(puuid) {
  if (!puuid || puuid.length < 10) return null;   // participante anonimizado
  let entries = await riot(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`)
                  .catch(() => null);
  if (!entries) {
    const summ = await riot(`https://${PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`);
    if (summ && summ.id)
      entries = await riot(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-summoner/${summ.id}`);
  }
  if (!Array.isArray(entries)) return null;
  return entries.find(e => e.queueType === 'RANKED_SOLO_5x5') || null;
}

async function getSpectator(puuid) {
  return riot(`https://${PLATFORM}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}`)
           .catch(() => null);
}

/* ===== Historial de partidas (match-v5) + tracking de LP ===== */
// LP absoluto para calcular deltas entre snapshots (cada división = 100 LP)
const TIER_IDX = { IRON:0,BRONZE:1,SILVER:2,GOLD:3,PLATINUM:4,EMERALD:5,DIAMOND:6,MASTER:7,GRANDMASTER:7,CHALLENGER:7 };
const DIV_OFF  = { I:300, II:200, III:100, IV:0, '':0 };
function absLP(e){
  if (!e) return null;
  if (e.tier==='MASTER'||e.tier==='GRANDMASTER'||e.tier==='CHALLENGER') return 2800 + e.leaguePoints;
  return (TIER_IDX[e.tier] ?? 0) * 400 + (DIV_OFF[e.rank] || 0) + e.leaguePoints;
}
const avg    = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : null;
const median = a => { if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };

// Sesión = racha de partidas sin un hueco >= 5h entre una y otra.
// Tras 5h de inactividad, se reinicia (0-0-0).
const SESSION_GAP = 5 * 60 * 60 * 1000;
function computeSession(games, lpGames){
  if (!games || !games.length) return { w:0, l:0, lp:0 };
  const sorted = games.filter(g => g.end).sort((a,b) => b.end - a.end);   // nuevas→viejas
  if (!sorted.length || (Date.now() - sorted[0].end) >= SESSION_GAP) return { w:0, l:0, lp:0 };
  const ses = [sorted[0]];
  for (let i = 1; i < sorted.length; i++){
    if (sorted[i-1].end - sorted[i].end < SESSION_GAP) ses.push(sorted[i]); else break;
  }
  const startEnd = ses[ses.length-1].end;
  const w = ses.filter(g => g.win).length;
  const lp = (lpGames||[]).filter(g => g.end && g.end >= startEnd).reduce((s,g) => s + g.delta, 0);
  return { w, l: ses.length - w, lp };
}

async function getMatchIds(puuid, count){
  const r = await riot(`https://${CLUSTER}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&count=${count}`).catch(()=>null);
  return Array.isArray(r) ? r : [];
}
async function getMatch(id){
  return riot(`https://${CLUSTER}.api.riotgames.com/lol/match/v5/matches/${id}`).catch(()=>null);
}

// Actualiza historial (solo pide detalles de partidas NUEVAS) y trackea ±LP.
async function updatePlayerStats(puuid, entry){
  const store = matchStore[puuid] || { games:[], lpGames:[], lastAbsLP:null };
  const known = new Set(store.games.map(g=>g.id));
  const backfill = store.games.length === 0;
  const ids = await getMatchIds(puuid, backfill ? 10 : 3); await sleep(110);
  const newIds = ids.filter(id => !known.has(id));

  const fetched = [];
  for (const id of newIds.reverse()) {           // viejas→nuevas; unshift mantiene orden
    const m = await getMatch(id); await sleep(110);
    if (!m || !m.info) continue;
    const me = (m.info.participants || []).find(p => p.puuid === puuid);
    if (!me) continue;
    const g = { id, win: !!me.win, champ: me.championName, end: m.info.gameEndTimestamp || 0, pos: me.teamPosition || me.individualPosition || '' };
    store.games.unshift(g); fetched.push(g);
  }
  store.games = store.games.slice(0, 15);

  // ±LP: solo hacia adelante. Si apareció EXACTAMENTE 1 partida nueva, el delta de LP es de esa partida.
  const cur = absLP(entry);
  if (cur != null && store.lastAbsLP != null && fetched.length === 1) {
    const delta = cur - store.lastAbsLP;
    if (Math.abs(delta) <= 100) {                // descarta saltos raros (promo de tier, decay, reset)
      store.lpGames.unshift({ win: fetched[0].win, delta, end: fetched[0].end });
      store.lpGames = store.lpGames.slice(0, 40);
    }
  }
  if (cur != null) store.lastAbsLP = cur;
  matchStore[puuid] = store;

  // Métricas para el frontend
  const form = store.games.slice(0, 15).reverse().map(g => g.win);   // viejas→nuevas (para sparkline)
  // Rol principal = posición más jugada en el historial (se llena a medida que entran partidas)
  const posCount = {};
  store.games.forEach(g => { if (g.pos) posCount[g.pos] = (posCount[g.pos] || 0) + 1; });
  let mainPos = null, mainN = 0;
  for (const k in posCount) if (posCount[k] > mainN){ mainN = posCount[k]; mainPos = k; }
  const winD  = store.lpGames.filter(g=>g.delta>0).map(g=>g.delta);
  const lossD = store.lpGames.filter(g=>g.delta<0).map(g=>-g.delta);
  // Aegis: en las últimas 15 partidas, cuenta las victorias que dieron ~el DOBLE
  // del promedio de LP (bonus tipo Aegis of Valor / primera victoria del día).
  const win15 = store.lpGames.slice(0, 15).filter(g=>g.delta>0).map(g=>g.delta);
  const baseA = avg(win15);
  return {
    form,
    role: mainPos ? (ROLE_LBL[mainPos] || null) : null,
    up:   winD.length  ? Math.round(avg(winD))  : null,
    down: lossD.length ? Math.round(avg(lossD)) : null,
    aegis: baseA ? win15.filter(d => d >= 1.8 * baseA).length : 0,   // ~doble del promedio (últimas 15)
    session: computeSession(store.games, store.lpGames),
    recent: store.games.slice(0, 5).map(g => ({ win: g.win, champ: g.champ })),   // últimas 5 (borde + campeón)
  };
}

function ladderValue(p) {
  return (TIER_ORDER[p.tier] ?? -1) * 1e7 + DIV_VAL[p.div] * 1e5 + (p.lp || 0);
}
// "Master · 643 LP" / "Diamond II · 75 LP" / "Unranked"
function rankText(entry) {
  if (!entry) return { tier:'UNRANKED', label:'Unranked', lp:null };
  const tier = entry.tier;
  const div  = NO_DIVISION.has(tier) ? '' : ` ${entry.rank}`;
  return { tier, label:`${TIER_LABEL[tier]||tier}${div} · ${entry.leaguePoints} LP`, lp:entry.leaguePoints };
}

(async () => {
  process.stdout.write('Cargando Data Dragon... ');
  const DD = await getDDragon();
  console.log(`v${DD.version}\n`);
  const champImg = id => (DD.champById[id] ? DD.champById[id].id : null);
  const champName = id => (DD.champById[id] ? DD.champById[id].name : ('#' + id));

  const rankCache = new Map();  // puuid -> entry (para no repetir lookups)
  const trackedByPuuid = new Map();

  // ---- PASS 1: ranking + guardar spectator crudo de cada jugador ----
  const players = [];
  const rawByPlayer = [];  // {puuid, raw}
  for (const rid of RIOT_IDS) {
    process.stdout.write(`→ ${rid} ... `);
    try {
      const puuid = await getPuuid(rid); await sleep(110);
      if (!puuid) { console.log('cuenta no encontrada'); continue; }
      const entry = await getSoloEntry(puuid); await sleep(110);
      const raw   = await getSpectator(puuid); await sleep(110);

      rankCache.set(puuid, entry);
      rankStore[puuid] = { entry, at: Date.now() };   // trackeado → siempre fresco
      const [name] = rid.split('#');
      trackedByPuuid.set(puuid, { nm:name, rid });

      const stats = await updatePlayerStats(puuid, entry);   // historial + ±LP + aegis

      const tier = entry ? entry.tier : 'UNRANKED';
      const div  = entry ? (NO_DIVISION.has(tier) ? '' : entry.rank) : '';
      const soloRaw = (raw && raw.gameQueueConfigId === 420) ? raw : null;   // SOLO SoloQ (420)
      players.push({
        nm:name, rid, puuid, role: stats.role || '—',
        tier, div, lp: entry ? entry.leaguePoints : 0,
        w: entry ? entry.wins : 0, l: entry ? entry.losses : 0,
        inGame: !!soloRaw, hotStreak: entry ? !!entry.hotStreak : false,
        game: soloRaw ? { queue: 'Ranked SoloQ' } : null,
        form: stats.form, up: stats.up, down: stats.down, aegis: stats.aegis,
        session: stats.session, recent: stats.recent,
      });
      if (soloRaw) rawByPlayer.push({ puuid, raw: soloRaw });
      console.log(`${tier} ${div} ${entry?entry.leaguePoints+'LP':''}`.trim() + (soloRaw ? ' [EN SOLOQ]' : ''));
    } catch (e) { console.log('ERROR ' + e.message); }
  }

  // Orden del ranking y mapa de posiciones
  players.sort((a, b) => ladderValue(b) - ladderValue(a));
  const posByPuuid = new Map();
  players.forEach((p, i) => { posByPuuid.set(p.puuid, i + 1); });

  // ---- PASS 2: construir scoreboards de Live Games ----
  async function entryFor(puuid) {
    if (!puuid || puuid.length < 10) return null;
    if (rankCache.has(puuid)) return rankCache.get(puuid);          // ya resuelto este ciclo
    const cached = rankStore[puuid];
    if (cached && (Date.now() - cached.at) < RANK_TTL) {           // rival cacheado y fresco → 0 requests
      rankCache.set(puuid, cached.entry);
      return cached.entry;
    }
    const e = await getSoloEntry(puuid); await sleep(110);          // fetch fresco
    rankCache.set(puuid, e);
    rankStore[puuid] = { entry: e, at: Date.now() };
    return e;
  }
  async function buildParticipant(pt) {
    const entry = await entryFor(pt.puuid);
    const rt = rankText(entry);
    const tracked = trackedByPuuid.get(pt.puuid) || null;
    const [gn, tg] = (pt.riotId || '#').split('#');
    return {
      champion: champName(pt.championId),
      championImg: champImg(pt.championId),
      spell1: DD.spellByKey[pt.spell1Id] || null,
      spell2: DD.spellByKey[pt.spell2Id] || null,
      runeIcon: (pt.perks && DD.runeById[pt.perks.perkStyle]) || null,
      name: gn || (tracked ? tracked.nm : '—'),
      tag: tg || '',
      tier: rt.tier, rankLabel: rt.label,
      tracked: !!tracked,
      position: tracked ? (posByPuuid.get(pt.puuid) || null) : null,
    };
  }

  const liveGames = [];
  const seenGames = new Set();
  console.log('\nConstruyendo scoreboards de partidas en vivo...');
  for (const { puuid, raw } of rawByPlayer) {
    if (seenGames.has(raw.gameId)) continue;
    seenGames.add(raw.gameId);

    const blue = [], red = [];
    for (const pt of raw.participants) {
      const row = await buildParticipant(pt);
      (pt.teamId === 100 ? blue : red).push(row);
    }
    const bansBlue = raw.bannedChampions.filter(b => b.teamId === 100 && b.championId > 0).map(b => champImg(b.championId));
    const bansRed  = raw.bannedChampions.filter(b => b.teamId === 200 && b.championId > 0).map(b => champImg(b.championId));

    // Jugador(es) del challenge en esta partida → elo y título de la tarjeta
    const trackedRows = [...blue, ...red].filter(r => r.tracked);
    const mainTier = trackedRows[0] ? trackedRows[0].tier : 'UNRANKED';
    liveGames.push({
      gameId: String(raw.gameId),
      elo: HIGH_ELO.has(mainTier) ? 'HIGH ELO' : 'LOW ELO',
      queue: QUEUES[raw.gameQueueConfigId] || 'Partida',
      gameStartTime: raw.gameStartTime || 0,
      gameLength: raw.gameLength || 0,
      tracked: trackedRows.map(r => ({ nm:r.name, position:r.position })),
      blue, red, bansBlue, bansRed,
    });
    const who = trackedRows.map(r => r.name).join(', ');
    console.log(`  ✔ ${who} — ${blue.length}v${red.length}`);
  }

  const out = {
    updatedAt: new Date().toISOString(), region: 'LAS',
    ddragonVersion: DD.version, players, liveGames,
  };
  fs.writeFileSync(path.join(__dirname, 'players.json'), JSON.stringify(out, null, 2), 'utf8');
  fs.writeFileSync(path.join(__dirname, 'players.js'),
    'window.SQC_DATA = ' + JSON.stringify(out) + ';\n', 'utf8');

  // Guardar cachés (poda rangos con más de 1 día)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const k in rankStore) if (rankStore[k].at < cutoff) delete rankStore[k];
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
  fs.writeFileSync(PUUID_FILE, JSON.stringify(puuidCache));
  fs.writeFileSync(RANK_FILE,  JSON.stringify(rankStore));
  fs.writeFileSync(MATCH_FILE, JSON.stringify(matchStore));

  console.log(`\n✔ ${players.length} jugadores · ${liveGames.length} live games → players.json + players.js`);
  console.log(`   Requests a Riot este ciclo: ${REQ_COUNT}`
    + ` · PUUIDs en caché: ${Object.keys(puuidCache).length}`
    + ` · rangos en caché: ${Object.keys(rankStore).length}`);
})();
