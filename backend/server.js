/* ============================================================
   server.js — Backend del SoloQ Challenge (Express + Postgres)
   Sirve la web estática + API REST. Auth con JWT + bcrypt.
   Requiere:  DATABASE_URL  (Postgres/Supabase)
   Uso:  DATABASE_URL=... node server.js
   ============================================================ */
const path = require('path');
const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Carga backend/.env (sin dependencias) antes de conectar a la DB
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch {}

const { q, q1, init } = require('./db');
const { runCheck } = require('./checker');
const { runGrant } = require('./granter');

const PORT = process.env.PORT || 8123;
const JWT_SECRET = process.env.JWT_SECRET || 'sqc-dev-secret-cambiar-en-produccion';
const ADMIN_RIDS = new Set(['SionAntisionista#SAS', 'SKT T1 seiya157#LAS']);
// Secreto opcional para que el overlay (exe) reporte datos y ahorre API a la nube.
// Si no está configurado, se aceptan reportes solo de cuentas conocidas (registradas o en roster).
const REPORT_SECRET = process.env.REPORT_SECRET || null;
const ROOT = path.join(__dirname, '..');

// ---- Anti-egress (Supabase) ----
// El gran blob de ±LP/historial (fetch_cache id='matches') lo mantiene el runner EMBEBIDO
// (mismo proceso) en cache/matches.json. Leerlo del disco local en cada request evita
// bajarlo de Supabase (eran varios MB por cada apertura de ficha / cada /api/stats).
let _mcCache = { at: 0, data: null };
function localMatchesCache(){
  if (Date.now() - _mcCache.at < 15000) return _mcCache.data;   // relee del disco máx. cada 15s
  try { const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', 'matches.json'), 'utf8'));
    _mcCache = { at: Date.now(), data: (d && Object.keys(d).length) ? d : null };   // vacío => null (cae al fallback de DB)
  }
  catch { _mcCache = { at: Date.now(), data: null }; }
  return _mcCache.data;
}
// Blob de historial (±LP/partidas por cuenta): primero del disco local (runner embebido);
// si no está (en Render no hay runner), cae a Supabase PERO cacheado en memoria 60s. Antes se
// bajaba el blob (varios MB) en CADA apertura de ficha/jugador → era el gran consumo de egress.
let _dbMatchesCache = { at: 0, data: null };
async function matchesBlob(){
  const local = localMatchesCache();
  if (local) return local;
  if (Date.now() - _dbMatchesCache.at >= 60000){
    const r = await q1("SELECT data FROM fetch_cache WHERE id='matches'");
    _dbMatchesCache = { at: Date.now(), data: (r && r.data) || null };
  }
  return _dbMatchesCache.data;
}
async function playerMatchCache(puuid){
  const d = await matchesBlob();
  return d && d[puuid];
}
// Blobs de partidas (JSON de Riot): INMUTABLES → se cachean en memoria (acotado) para no
// re-bajarlos de Supabase. Solo consulta la DB por los ids que aún no están en memoria.
const MATCH_BLOBS = new Map();   // match_id -> data
async function matchBlobs(ids){
  const out = {}; const missing = [];
  for (const id of ids){ if (MATCH_BLOBS.has(id)) out[id] = MATCH_BLOBS.get(id); else missing.push(id); }
  if (missing.length){
    const rows = await q('SELECT match_id, data FROM matches WHERE match_id = ANY($1)', [missing]);
    rows.forEach(r => { MATCH_BLOBS.set(r.match_id, r.data); out[r.match_id] = r.data; });
    if (MATCH_BLOBS.size > 3000){ let drop = MATCH_BLOBS.size - 3000; for (const k of MATCH_BLOBS.keys()){ if (drop-- <= 0) break; MATCH_BLOBS.delete(k); } }
  }
  return out;
}

const SHELLS = [
  { name:'Sin tus 3 campeones más jugados', w:17 }, { name:'Una partida con Yuumi', w:11 },
  { name:'Campeón aleatorio', w:11 }, { name:'Sin Flash', w:11 }, { name:'Autofill', w:11 },
  { name:'Sin botas y sin pies veloces', w:11 }, { name:'Hechizos cambiados', w:6 },
  { name:'Sin pociones ni pinks', w:6 }, { name:'Sin objetos completos hasta min 15', w:6 },
  { name:'Reverse', w:6 }, { name:'Clase de campeón aleatoria', w:4 },
];
// Clases de campeón (tags de Data Dragon). El castigo "Clase de campeón aleatoria" sortea una y
// el jugador debe jugar un campeón que la tenga. extra guarda el tag en inglés (para el
// checker); CLASS_ES es solo para mostrar.
const CLASSES = ['Fighter','Tank','Mage','Assassin','Marksman','Support'];
const CLASS_ES = { Fighter:'Luchador', Tank:'Tanque', Mage:'Mago', Assassin:'Asesino', Marksman:'Tirador', Support:'Soporte' };
const MAX_SHELLS = 3;
function rollShell(){ const t = SHELLS.reduce((a,s)=>a+s.w,0); let r = Math.random()*t; for (const s of SHELLS){ if ((r-=s.w)<=0) return s.name; } return SHELLS[0].name; }
function reverseChance(pos){ return (pos && pos<=5) ? pos : 15; }
function ladderPos(riotid){
  const i = (liveSnapshot().players||[]).findIndex(p => p.rid === riotid); return i >= 0 ? i+1 : null;
}

// Lista de campeones (Data Dragon): para validar los del registro y sortear el "Campeón aleatorio".
let CHAMP_IDS = [], CHAMP_TAGS = {}, DD_VER = '15.1.1';
async function loadChampions(){
  try {
    DD_VER = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0] || DD_VER;
    const cj = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${DD_VER}/data/en_US/champion.json`)).json();
    const real = Object.values(cj.data).filter(c => !c.id.includes('_'));
    CHAMP_IDS = real.map(c => c.id);
    CHAMP_TAGS = {}; real.forEach(c => { CHAMP_TAGS[c.id] = c.tags || []; });
    console.log(`✔ ${CHAMP_IDS.length} campeones (DDragon ${DD_VER})`);
  } catch (e) { console.error('champions:', e.message); }
}
const champIconUrl = id => `https://ddragon.leagueoflegends.com/cdn/${DD_VER}/img/champion/${id}.png`;

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use((req,res,next)=>{ res.header('Access-Control-Allow-Origin','*'); res.header('Access-Control-Allow-Headers','Content-Type,Authorization'); res.header('Access-Control-Allow-Methods','GET,POST,OPTIONS'); if(req.method==='OPTIONS') return res.sendStatus(204); next(); });

const wrap = fn => (req,res) => fn(req,res).catch(e => { console.error(e); res.status(500).json({ error:'Error del servidor' }); });
const sign = u => jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: '30d' });
const TEAMS = new Set(['Exilium', 'Tide', 'Zenith', 'Hundred Blossom']);
const ROLES = new Set(['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT']);   // rol dentro del equipo (puede diferir del de SoloQ)
const publicUser = u => ({ id:u.id, email:u.email, nickname:u.nickname, realname:u.realname, riotid:u.riotid, main:u.main, discord:u.discord, pos1:u.pos1, pos2:u.pos2, avatar:u.avatar, champ1:u.champ1, champ2:u.champ2, champ3:u.champ3, flashSlot:u.flash_slot, team:u.team || null, confirmed: !!u.confirmed, isAdmin: !!u.is_admin });
async function auth(req,res,next){
  const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error:'No autenticado' });
  try { const { uid } = jwt.verify(t, JWT_SECRET); const u = await q1('SELECT * FROM users WHERE id=$1', [uid]);
    if (!u) return res.status(401).json({ error:'Sesión inválida' }); req.user = u; next(); }
  catch { return res.status(401).json({ error:'Sesión inválida' }); }
}
const requireAdmin = (req,res,next) => req.user.is_admin ? next() : res.status(403).json({ error:'Solo admin' });

// ================= AUTH =================
app.post('/api/register', wrap(async (req,res) => {
  const b = req.body || {};
  for (const f of ['email','password','nickname','realname','riotid','discord','pos1','pos2','avatar','champ1','champ2','champ3'])
    if (!b[f]) return res.status(400).json({ error:`Falta el campo: ${f}` });
  if (!/^.+#.+$/.test(b.riotid)) return res.status(400).json({ error:'Riot ID debe ser Nombre#TAG' });
  const flash = Number(b.flashSlot);
  if (flash !== 1 && flash !== 2) return res.status(400).json({ error:'Indica en qué slot usas el Flash (1 o 2)' });
  if (CHAMP_IDS.length && ![b.champ1,b.champ2,b.champ3].every(c => CHAMP_IDS.includes(c))) return res.status(400).json({ error:'Algún campeón no existe (revisa que esté bien escrito)' });
  if (await q1('SELECT 1 FROM users WHERE email=$1', [b.email])) return res.status(409).json({ error:'Ese email ya está registrado' });
  // Evita duplicar una cuenta ya tomada (case-insensitive: "Pancho…" == "pancho…").
  if (await q1('SELECT 1 FROM users WHERE lower(riotid)=lower($1) UNION SELECT 1 FROM smurfs WHERE lower(riotid)=lower($1)', [b.riotid]))
    return res.status(409).json({ error:'Ese Riot ID ya está registrado por alguien' });
  const team = TEAMS.has(b.team) ? b.team : null;
  const riotid = b.riotid;   // la cuenta principal del jugador (la que se trackea)
  const hash = await bcrypt.hash(b.password, 10);
  const u = await q1(`INSERT INTO users (email,password_hash,nickname,realname,riotid,main,discord,pos1,pos2,avatar,champ1,champ2,champ3,flash_slot,team,confirmed,is_admin)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16) RETURNING *`,
    [b.email, hash, b.nickname, b.realname, riotid, b.main||null, b.discord, b.pos1, b.pos2, b.avatar||null, b.champ1, b.champ2, b.champ3, flash, team, ADMIN_RIDS.has(riotid)]);
  // El equipo se guarda en team_members (fuente única, multi-equipo). Si eligió uno al registrarse,
  // lo añade (conserva lo que el admin haya sembrado para esta cuenta).
  if (team) await q('INSERT INTO team_members (riotid, team) VALUES ($1,$2) ON CONFLICT (riotid, team) DO NOTHING', [riotid, team]);
  // Cuentas smurf opcionales indicadas en el registro.
  if (Array.isArray(b.smurfs)){
    const seen = new Set([riotid.toLowerCase()]); let n = 0;
    for (const raw of b.smurfs){
      const rid = (raw || '').trim();
      if (!/^.+#.+$/.test(rid) || seen.has(rid.toLowerCase()) || n >= 8) continue;
      seen.add(rid.toLowerCase());
      const dup = await q1('SELECT 1 FROM users WHERE lower(riotid)=lower($1) UNION SELECT 1 FROM smurfs WHERE lower(riotid)=lower($1)', [rid]);
      if (dup) continue;
      await q('INSERT INTO smurfs (user_id,riotid) VALUES ($1,$2) ON CONFLICT (riotid) DO NOTHING', [u.id, rid]);
      // Si esta smurf tenía equipo sembrado, lo mueve a la cuenta canónica (la main) y limpia el de la smurf.
      await q('INSERT INTO team_members (riotid, team) SELECT $1, team FROM team_members WHERE lower(riotid)=lower($2) ON CONFLICT (riotid, team) DO NOTHING', [riotid, rid]);
      await q('DELETE FROM team_members WHERE lower(riotid)=lower($1)', [rid]);
      n++;
    }
  }
  res.json({ token: sign(u), user: publicUser(u) });
}));

app.post('/api/login', wrap(async (req,res) => {
  const { email, password } = req.body || {};
  const u = email && await q1('SELECT * FROM users WHERE email=$1', [email]);
  if (!u || !(await bcrypt.compare(password||'', u.password_hash))) return res.status(401).json({ error:'Email o contraseña incorrectos' });
  res.json({ token: sign(u), user: publicUser(u) });
}));

app.get('/api/me', auth, (req,res) => res.json({ user: publicUser(req.user) }));

// Editar el propio perfil (los datos del registro). password opcional (en blanco = sin cambio).
app.post('/api/me/update', auth, wrap(async (req,res) => {
  const b = req.body || {};
  if (b.riotid !== undefined && !/^.+#.+$/.test(b.riotid)) return res.status(400).json({ error:'Riot ID debe ser Nombre#TAG' });
  if (b.riotid !== undefined && b.riotid.toLowerCase() !== (req.user.riotid||'').toLowerCase()
      && await q1('SELECT 1 FROM users WHERE lower(riotid)=lower($1) AND id<>$2 UNION SELECT 1 FROM smurfs WHERE lower(riotid)=lower($1)', [b.riotid, req.user.id]))
    return res.status(409).json({ error:'Ese Riot ID ya está tomado' });
  if (b.email){ const other = await q1('SELECT id FROM users WHERE email=$1 AND id<>$2', [b.email, req.user.id]); if (other) return res.status(409).json({ error:'Ese email ya está en uso' }); }
  if (CHAMP_IDS.length && [b.champ1,b.champ2,b.champ3].some(c => c !== undefined && c && !CHAMP_IDS.includes(c)))
    return res.status(400).json({ error:'Algún campeón no existe (revisa que esté bien escrito)' });
  const sets = [], vals = []; let i = 1;
  for (const f of ['nickname','realname','riotid','main','discord','pos1','pos2','avatar','email','champ1','champ2','champ3'])
    if (b[f] !== undefined){ sets.push(`${f}=$${i++}`); vals.push(b[f] || null); }
  if (b.flashSlot !== undefined){ const fl = Number(b.flashSlot); if (fl === 1 || fl === 2){ sets.push(`flash_slot=$${i++}`); vals.push(fl); } }
  if (b.team !== undefined){ sets.push(`team=$${i++}`); vals.push(TEAMS.has(b.team) ? b.team : null); }
  // Si cambian datos que el admin verifica, el perfil vuelve a quedar "por confirmar".
  const changedVerif = (b.riotid !== undefined && b.riotid !== req.user.riotid)
    || (b.champ1 !== undefined && b.champ1 !== req.user.champ1)
    || (b.champ2 !== undefined && b.champ2 !== req.user.champ2)
    || (b.champ3 !== undefined && b.champ3 !== req.user.champ3)
    || (b.flashSlot !== undefined && Number(b.flashSlot) !== req.user.flash_slot);
  if (changedVerif){ sets.push(`confirmed=$${i++}`); vals.push(false); }
  if (b.password){ if (String(b.password).length < 6) return res.status(400).json({ error:'La contraseña debe tener al menos 6 caracteres' });
    sets.push(`password_hash=$${i++}`); vals.push(await bcrypt.hash(b.password, 10)); }
  if (!sets.length) return res.json({ user: publicUser(req.user) });
  vals.push(req.user.id);
  const u = await q1(`UPDATE users SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
  // Nota: los equipos ahora los administra el staff (multi-equipo en team_members); no se tocan aquí.
  invalidateAvatars();   // refresca el ranking público si cambió avatar/nick/pos/champs
  res.json({ user: publicUser(u) });
}));

// Avatares públicos (para el ranking y los popups del sitio). Sin auth: el leaderboard es público.
// Devuelve una entrada por CUENTA: la main del usuario + sus smurfs, con etiqueta Main/Smurf N.
// Cache en MEMORIA de los avatares: el SELECT trae los avatares (base64, ~cientos de KB) de
// TODOS los usuarios; se pegaba en cada golpe al origen (la página más visitada) → era el
// mayor consumo de egress de Supabase. Ahora la DB se toca a lo más 1 vez cada 10 min; los
// avatares cambian muy poco y la caché se invalida al editar el perfil (invalidateAvatars()).
let AVATARS_CACHE = { at: 0, data: null };
function invalidateAvatars(){ AVATARS_CACHE = { at: 0, data: null }; }
const AVATARS_TTL = 10 * 60 * 1000;
app.get('/api/avatars', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=600');   // avatares cambian muy poco
  if (AVATARS_CACHE.data && Date.now() - AVATARS_CACHE.at < AVATARS_TTL) return res.json(AVATARS_CACHE.data);
  const users = await q('SELECT id, riotid, nickname, realname, avatar, pos1, pos2, main, champ1, champ2, champ3, flash_slot FROM users');
  const smurfs = await q('SELECT user_id, riotid FROM smurfs ORDER BY id');
  const byUser = {}; smurfs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s.riotid); });
  const out = [];
  users.forEach(u => {
    const base = { nickname:u.nickname, realname:u.realname, avatar:u.avatar, pos1:u.pos1, pos2:u.pos2, main:u.main, champ1:u.champ1, champ2:u.champ2, champ3:u.champ3, flashSlot:u.flash_slot, owner:u.nickname };
    out.push({ ...base, riotid:u.riotid, label:'Main' });
    const list = byUser[u.id] || [];
    list.forEach((rid, i) => out.push({ ...base, riotid:rid, label: list.length > 1 ? `Smurf ${i+1}` : 'Smurf' }));
  });
  AVATARS_CACHE = { at: Date.now(), data: out };
  res.json(out);
}));

// Equipo por cuenta (Exilium/Tide/Zenith) para la etiqueta del ranking. Público.
// Mezcla: cuentas de usuarios registrados con equipo (main + smurfs) + tabla team_members.
app.get('/api/teams', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=180');
  // Fuente única: team_members (multi-equipo, keyeado por la cuenta canónica). Se propaga a las smurfs.
  const tm     = await q("SELECT riotid, team FROM team_members WHERE team IS NOT NULL AND team<>''");
  const users  = await q("SELECT id, riotid FROM users");
  const smurfs = await q('SELECT user_id, riotid FROM smurfs');
  const byUser = {}; smurfs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s.riotid); });
  const map = {};   // ridLower -> { riotid, teams:Set }
  const add = (rid, team) => { const k = rid.toLowerCase(); (map[k] = map[k] || { riotid:rid, teams:new Set() }).teams.add(team); };
  tm.forEach(r => add(r.riotid, r.team));
  users.forEach(u => { const m = map[u.riotid.toLowerCase()];   // propaga los equipos de la main a sus smurfs
    if (m && m.teams.size) (byUser[u.id] || []).forEach(rid => m.teams.forEach(t => add(rid, t))); });
  res.json(Object.values(map).map(x => ({ riotid:x.riotid, teams:[...x.teams] })));
}));

// Rosters por equipo: UNA fila por jugador (su cuenta main de team_members), mostrando el
// elo de su CUENTA MÁS ALTA (main + smurfs), su rol en el equipo y si es titular o suplente.
// El elo se toma del ranking ya trackeado (liveSnapshot), sin llamar a la Riot API. Público.
app.get('/api/rosters', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=20');
  const players = liveSnapshot().players || [];
  const byRid = {}; players.forEach(p => { byRid[(p.rid || '').toLowerCase()] = p; });

  const tm     = await q("SELECT riotid, team, role, starter FROM team_members WHERE team IS NOT NULL AND team<>''");
  const users  = await q("SELECT id, riotid, nickname FROM users");
  const smurfs = await q('SELECT user_id, riotid FROM smurfs');
  const links  = await q('SELECT smurf_riotid, main_riotid FROM smurf_links');
  const userByRid  = {}; users.forEach(u => { userByRid[u.riotid.toLowerCase()] = u; });
  const userById   = {}; users.forEach(u => { userById[u.id] = u; });
  const smurfsByUser = {}; smurfs.forEach(s => { (smurfsByUser[s.user_id] = smurfsByUser[s.user_id] || []).push(s.riotid); });
  // Mapa smurf→main. Primero las smurfs REGISTRADAS (tabla smurfs, colgadas de un usuario),
  // luego los vínculos manuales de jugadores no registrados (smurf_links).
  const mainOf = {}, linkSmurfs = {};
  smurfs.forEach(s => { const m = userById[s.user_id]; if (m) mainOf[s.riotid.toLowerCase()] = m.riotid; });
  links.forEach(l => { mainOf[l.smurf_riotid.toLowerCase()] = l.main_riotid;
    (linkSmurfs[l.main_riotid.toLowerCase()] = linkSmurfs[l.main_riotid.toLowerCase()] || []).push(l.smurf_riotid); });
  const canon = rid => mainOf[(rid || '').toLowerCase()] || rid;   // resuelve una smurf a su main

  // Todas las cuentas de un jugador (main + smurfs registradas + smurfs vinculadas a mano).
  const accountsOf = mainRid => {
    const set = new Map(); const add = r => { if (r) set.set(r.toLowerCase(), r); };
    add(mainRid);
    const u = userByRid[mainRid.toLowerCase()]; if (u) (smurfsByUser[u.id] || []).forEach(add);
    (linkSmurfs[mainRid.toLowerCase()] || []).forEach(add);
    return [...set.values()];
  };
  // Mejor cuenta (mayor elo absoluto) entre una lista de riotids, usando el ranking.
  const bestOf = rids => {
    let best = null, bestAbs = -1;
    rids.forEach(rid => { const p = byRid[(rid || '').toLowerCase()]; if (!p) return;
      const abs = absLPof(p.tier, p.div, p.lp); if (abs != null && abs > bestAbs){ bestAbs = abs; best = p; } });
    return best;
  };

  const out = {}; [...TEAMS].forEach(t => out[t] = new Map());   // equipo -> Map(lower(main) -> entrada)
  tm.forEach(row => {
    if (!out[row.team]) return;
    const mainRid = canon(row.riotid);           // si esta fila es una smurf vinculada, la absorbe la main
    const key = mainRid.toLowerCase();
    const isMainRow = row.riotid.toLowerCase() === key;
    let e = out[row.team].get(key);
    if (!e){
      const u = userByRid[key];
      const best = bestOf(accountsOf(mainRid));
      e = { riotid: mainRid, nickname: u ? u.nickname : mainRid.split('#')[0],
        role: null, starter: true, _main:false,
        tier: best ? best.tier : null, div: best ? (best.div || '') : null, lp: best ? best.lp : null,
        bestRiotid: best ? best.rid : mainRid };
      out[row.team].set(key, e);
    }
    // Rol/titularidad: manda la fila de la main; una fila smurf solo aporta si aún no vimos la main.
    if (isMainRow || !e._main){ e.role = ROLES.has(row.role) ? row.role : null; e.starter = row.starter !== false; if (isMainRow) e._main = true; }
  });
  const result = {};
  Object.keys(out).forEach(t => result[t] = [...out[t].values()].map(({ _main, ...e }) => e));
  res.json(result);
}));

// Resultados de la fase de grupos del torneo. Público (los lee la pestaña Fixture).
app.get('/api/tourney-results', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=15');
  const rows = await q('SELECT match_id, winner FROM tourney_results');
  const out = {}; rows.forEach(r => { out[r.match_id] = r.winner; });
  res.json(out);
}));
// El admin pone (o borra) el ganador de un partido. winner vacío/null = borra el resultado.
app.post('/api/admin/tourney-result', auth, requireAdmin, wrap(async (req,res) => {
  const matchId = ((req.body && req.body.matchId) || '').trim();
  if (!matchId) return res.status(400).json({ error:'Falta matchId' });
  const winner = ((req.body && req.body.winner) || '').trim();
  if (!winner) { await q('DELETE FROM tourney_results WHERE match_id=$1', [matchId]); return res.json({ ok:true, cleared:true }); }
  await q(`INSERT INTO tourney_results (match_id, winner, updated_at) VALUES ($1,$2,now())
           ON CONFLICT (match_id) DO UPDATE SET winner=EXCLUDED.winner, updated_at=now()`, [matchId, winner]);
  res.json({ ok:true, matchId, winner });
}));

// Resultados de las CLASIFICATORIAS INTERNAS (round-robin Bo3 de nuestros 4 equipos). Público.
app.get('/api/qualifier-results', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=15');
  const rows = await q('SELECT match_id, winner, loser_maps FROM qualifier_results');
  const out = {}; rows.forEach(r => { out[r.match_id] = { winner: r.winner || '', loserMaps: r.loser_maps|0 }; });
  res.json(out);
}));
// El admin fija (o borra) el resultado de una serie. winner vacío = serie sin resultado (se conserva
// la fila como "vacía" para que gane a un posible default del front). loserMaps = 0 (2-0) o 1 (2-1).
app.post('/api/admin/qualifier-result', auth, requireAdmin, wrap(async (req,res) => {
  const matchId = ((req.body && req.body.matchId) || '').trim();
  if (!matchId) return res.status(400).json({ error:'Falta matchId' });
  const winner = ((req.body && req.body.winner) || '').trim();
  const loserMaps = Math.max(0, Math.min(1, parseInt(req.body && req.body.loserMaps, 10) || 0));
  await q(`INSERT INTO qualifier_results (match_id, winner, loser_maps, updated_at) VALUES ($1,$2,$3,now())
           ON CONFLICT (match_id) DO UPDATE SET winner=EXCLUDED.winner, loser_maps=EXCLUDED.loser_maps, updated_at=now()`,
          [matchId, winner, loserMaps]);
  res.json({ ok:true, matchId, winner, loserMaps });
}));
// Mapa Riot ID -> equipo del torneo (nombre + abreviatura). Lo usa el overlay para avisar
// si juegas con/contra alguien inscrito en un torneo, aunque NO esté en el SoloQ Challenge.
// Se lee de torneo-data.js (cache por mtime del archivo). Público.
let _tourneyPlayers = { at: 0, map: {} };
// Normaliza un Riot ID para cruzarlo con lo que reporta el juego: minúsculas y SIN espacios
// alrededor del '#'. Muchos rids del Excel vienen como "Nombre #tag" (con espacio) y en partida
// el riotId es "Nombre#tag", así que sin esto no se detectan (ni en el overlay ni en Live Games).
function normRid(s){ return (s || '').trim().toLowerCase().replace(/\s*#\s*/g, '#'); }
async function buildTourneyMap(){
  const map = {};
  try {
    const m = fs.readFileSync(path.join(ROOT, 'torneo-data.js'), 'utf8').match(/window\.TDATA\s*=\s*([\s\S]*);\s*$/);
    const data = m ? JSON.parse(m[1]) : { teams: [] };
    (data.teams || []).forEach(t => (t.players || []).forEach(p => {
      const rid = normRid(p.rid); if (rid) map[rid] = { tag: t.tag || '', team: t.team || '' };
    }));
  } catch {}
  // Propaga el equipo del torneo a TODAS las cuentas de un jugador (registradas o vinculadas a mano),
  // así una smurf como "pancho pistolas2#LAS" o "BEST JG LAS#LAS" también muestra el tag. Es SIMÉTRICO:
  // si CUALQUIER cuenta del usuario (su main O una smurf) figura en el torneo, se etiquetan todas —
  // no solo si la que está en el torneo es la main.
  try {
    const users  = await q('SELECT id, riotid FROM users');
    const smurfs = await q('SELECT user_id, riotid FROM smurfs');
    const links  = await q('SELECT smurf_riotid, main_riotid FROM smurf_links');
    // Agrupa todas las cuentas por usuario (main + smurfs).
    const acctsByUser = {};
    users.forEach(u => { (acctsByUser[u.id] = acctsByUser[u.id] || []).push(u.riotid); });
    smurfs.forEach(s => { (acctsByUser[s.user_id] = acctsByUser[s.user_id] || []).push(s.riotid); });
    Object.values(acctsByUser).forEach(accts => {
      let m = null; for (const rid of accts){ const f = map[normRid(rid)]; if (f){ m = f; break; } }   // ¿alguna en el torneo?
      if (m) accts.forEach(rid => { const k = normRid(rid); if (!map[k]) map[k] = m; });                // etiqueta todas
    });
    // Vínculos manuales (jugadores no registrados): propaga en ambos sentidos.
    links.forEach(l => {
      const km = normRid(l.main_riotid), ks = normRid(l.smurf_riotid);
      if (map[km] && !map[ks]) map[ks] = map[km];
      if (map[ks] && !map[km]) map[km] = map[ks];
    });
  } catch {}
  return map;
}
app.get('/api/tourney-players', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=300');
  if (_tourneyPlayers.map && Object.keys(_tourneyPlayers.map).length && Date.now() - _tourneyPlayers.at < 300000)
    return res.json(_tourneyPlayers.map);
  _tourneyPlayers = { at: Date.now(), map: await buildTourneyMap() };
  res.json(_tourneyPlayers.map);
}));
// Etiquetas de jugador (PRO / Streamer / Competitivo). Público (ranking + live games).
const PLAYER_TAGS = new Set(['PRO', 'STREAMER', 'COMPETITIVO']);
let _tagsCache = { at: 0, data: null };
function invalidateTags(){ _tagsCache = { at: 0, data: null }; }
app.get('/api/player-tags', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=120');
  if (_tagsCache.data && Date.now() - _tagsCache.at < 120000) return res.json(_tagsCache.data);
  const rows = await q('SELECT riotid, tag FROM player_tags');
  const out = {}; rows.forEach(r => { out[r.riotid.toLowerCase()] = r.tag; });
  _tagsCache = { at: Date.now(), data: out };
  res.json(out);
}));
app.post('/api/admin/player-tag', auth, requireAdmin, wrap(async (req,res) => {
  const riotid = ((req.body && req.body.riotid) || '').trim();
  if (!/^.+#.+$/.test(riotid)) return res.status(400).json({ error:'Riot ID debe ser Nombre#TAG' });
  const tag = ((req.body && req.body.tag) || '').trim().toUpperCase();
  if (!tag){ await q('DELETE FROM player_tags WHERE lower(riotid)=lower($1)', [riotid]); invalidateTags(); return res.json({ ok:true, cleared:true }); }
  if (!PLAYER_TAGS.has(tag)) return res.status(400).json({ error:'Etiqueta inválida' });
  await q(`INSERT INTO player_tags (riotid, tag, updated_at) VALUES ($1,$2,now())
           ON CONFLICT (riotid) DO UPDATE SET tag=EXCLUDED.tag, updated_at=now()`, [riotid, tag]);
  invalidateTags();
  res.json({ ok:true, riotid, tag });
}));
app.get('/api/admin/player-tags', auth, requireAdmin, wrap(async (req,res) =>
  res.json(await q('SELECT riotid, tag, updated_at FROM player_tags ORDER BY updated_at DESC'))));

// Cuentas smurf del jugador (asociadas a su cuenta). Aparecen en el ranking con su nick + etiqueta.
app.get('/api/me/smurfs', auth, wrap(async (req,res) =>
  res.json(await q('SELECT id, riotid FROM smurfs WHERE user_id=$1 ORDER BY id', [req.user.id]))));
app.post('/api/me/smurfs', auth, wrap(async (req,res) => {
  const riotid = ((req.body && req.body.riotid) || '').trim();
  if (!/^.+#.+$/.test(riotid)) return res.status(400).json({ error:'Riot ID debe ser Nombre#TAG' });
  if (riotid.toLowerCase() === (req.user.riotid || '').toLowerCase()) return res.status(400).json({ error:'Esa ya es tu cuenta principal' });
  const dupUser = await q1('SELECT 1 FROM users WHERE lower(riotid)=lower($1)', [riotid]);
  const dupSmurf = await q1('SELECT 1 FROM smurfs WHERE lower(riotid)=lower($1)', [riotid]);
  if (dupUser || dupSmurf) return res.status(400).json({ error:'Esa cuenta ya está registrada' });
  const c = await q1('SELECT COUNT(*)::int c FROM smurfs WHERE user_id=$1', [req.user.id]);
  if (c.c >= 8) return res.status(400).json({ error:'Máximo 8 cuentas smurf' });
  await q('INSERT INTO smurfs (user_id,riotid) VALUES ($1,$2)', [req.user.id, riotid]);
  // Mueve el equipo sembrado de la smurf a la cuenta canónica (la main) y limpia el de la smurf.
  await q('INSERT INTO team_members (riotid, team) SELECT $1, team FROM team_members WHERE lower(riotid)=lower($2) ON CONFLICT (riotid, team) DO NOTHING', [req.user.riotid, riotid]);
  await q('DELETE FROM team_members WHERE lower(riotid)=lower($1)', [riotid]);
  invalidateAvatars();   // para que la nueva smurf salga etiquetada en el ranking sin esperar la caché
  res.json({ ok:true });
}));
app.post('/api/me/smurfs/remove', auth, wrap(async (req,res) => {
  await q('DELETE FROM smurfs WHERE id=$1 AND user_id=$2', [Number(req.body && req.body.id), req.user.id]);
  invalidateAvatars();
  res.json({ ok:true });
}));

// Ficha de un jugador (para el despliegue del ranking). Todo sale de la DB, sin Riot API.
const ksOf  = p => (p && p.perks && p.perks.styles && p.perks.styles[0] && p.perks.styles[0].selections && p.perks.styles[0].selections[0] && p.perks.styles[0].selections[0].perk) || null;
const secOf = p => (p && p.perks && p.perks.styles && p.perks.styles[1] && p.perks.styles[1].style) || null;
function buildHistoryRow(m, puuid){
  if (!m || !m.info) return null;
  const P = m.info.participants || [];
  const me = P.find(p => p.puuid === puuid); if (!me) return null;
  const teamKills = P.filter(p => p.teamId === me.teamId).reduce((s,p)=>s+(p.kills||0),0);
  const opp = P.find(p => p.teamId !== me.teamId && (p.teamPosition||'') === (me.teamPosition||'') && me.teamPosition);
  const cs = (me.totalMinionsKilled||0) + (me.neutralMinionsKilled||0);
  const dur = m.info.gameDuration || 0;
  return {
    matchId: m.metadata && m.metadata.matchId, queueId: m.info.queueId,
    win: !!me.win, champion: me.championName, position: me.teamPosition || '',
    k: me.kills||0, d: me.deaths||0, a: me.assists||0,
    kda: ((me.kills||0)+(me.assists||0)) / Math.max(1, me.deaths||0),
    kp: teamKills ? Math.round(((me.kills||0)+(me.assists||0))/teamKills*100) : 0,
    cs, csMin: dur ? +(cs/(dur/60)).toFixed(1) : 0,
    spells: [me.summoner1Id, me.summoner2Id], keystone: ksOf(me), secStyle: secOf(me),
    items: [me.item0,me.item1,me.item2,me.item3,me.item4,me.item5].map(x=>x||0), trinket: me.item6||0,
    duration: dur, end: m.info.gameEndTimestamp || 0,
    oppChampion: opp ? opp.championName : null, oppSpells: opp ? [opp.summoner1Id, opp.summoner2Id] : null,
    oppKeystone: opp ? ksOf(opp) : null, oppSecStyle: opp ? secOf(opp) : null,
    doubleK: me.doubleKills||0, tripleK: me.tripleKills||0, quadraK: me.quadraKills||0, pentaK: me.pentaKills||0,
  };
}
app.get('/api/player/:riotid', wrap(async (req,res) => {
  const riotid = (req.params.riotid || '').trim();   // Express ya decodifica el parámetro
  if (!riotid) return res.status(400).json({ error:'Falta riotid' });
  res.set('Cache-Control', 'public, max-age=90');   // ficha: Cloudflare la sirve del borde ~90s

  // Perfil desde la caché del ranking (players.json) + usuario registrado
  const lp = liveData && Array.isArray(liveData.players) ? liveData.players.find(p => p.rid === riotid) : null;
  const rankPos = lp && liveData ? liveData.players.indexOf(lp) + 1 : null;
  // Normaliza el Riot ID (colapsa espacios pegados al '#') para tolerar cuentas con nombres
  // que traen un espacio raro (ej. "SHR UZI #LAS1" vs "SHR UZI#LAS1" como se registró).
  const NORMR = "replace(replace(lower(riotid),' #','#'),'# ','#')";
  const nr = riotid.toLowerCase().replace(/\s*#\s*/, '#');
  let u = await q1(`SELECT * FROM users WHERE ${NORMR}=$1`, [nr]);
  let accLabel = u ? 'Main' : null;
  if (!u){ // ¿es una cuenta smurf? -> resuelve el dueño (para nick/blueshells)
    const s = await q1(`SELECT user_id FROM smurfs WHERE ${NORMR}=$1`, [nr]);
    if (s){ u = await q1('SELECT * FROM users WHERE id=$1', [s.user_id]); accLabel = 'Smurf'; }
  }

  // puuid: del ranking o de los datos crudos guardados
  let puuid = lp && lp.puuid;
  if (!puuid){ const r = await q1('SELECT puuid FROM match_participants WHERE lower(riotid)=lower($1) AND puuid<>\'\' ORDER BY game_end DESC LIMIT 1', [riotid]); puuid = r && r.puuid; }

  // Historial detallado (últimas 15) desde las partidas completas guardadas
  let history = [];
  if (puuid){
    const parts = await q('SELECT match_id FROM match_participants WHERE puuid=$1 ORDER BY game_end DESC NULLS LAST LIMIT 15', [puuid]);
    const ids = parts.map(p => p.match_id);
    if (ids.length){
      const byId = await matchBlobs(ids);   // blobs inmutables: caché en memoria (no re-baja de Supabase)
      history = ids.map(id => buildHistoryRow(byId[id], puuid)).filter(Boolean);
    }
    // ±LP y aegis por partida (desde lpGames del caché local del runner), casando por 'end'.
    try {
      const s = await playerMatchCache(puuid);
      if (s && Array.isArray(s.lpGames)){
        const byEnd = {}; s.lpGames.forEach(g => { if (g.end) byEnd[g.end] = g; });
        const wd = s.lpGames.filter(g => g.delta > 0).slice(0, 15).map(g => g.delta).sort((a,b)=>a-b);
        const med = wd.length ? wd[Math.floor(wd.length/2)] : 0;
        // Guarda de signo: una victoria SIEMPRE da +LP y una derrota −LP. Si el delta casado por
        // 'end' contradice el resultado (por un desfase del runner al juntarse 2 partidas o un
        // remake), no lo mostramos en vez de mostrar un ±LP incoherente (victoria −23, derrota +17).
        history.forEach(h => {
          const g = byEnd[h.end];
          if (g && ((h.win && g.delta >= 0) || (!h.win && g.delta <= 0))){
            h.lp = g.delta; h.aegis = g.delta > 0 && med > 0 && g.delta >= 1.8*med;
          }
        });
      }
    } catch {}
  }

  // Stats agregadas sobre TODO el historial guardado
  let stats = null;
  if (puuid){
    const s = await q1(`SELECT count(*)::int n, coalesce(sum(kills),0)::int k, coalesce(sum(deaths),0)::int d,
      coalesce(sum(assists),0)::int a, coalesce(sum(cs),0)::bigint cs, coalesce(sum(duration),0)::bigint dur,
      coalesce(sum(damage),0)::bigint dmg, coalesce(avg(vision),0)::float vis, coalesce(sum(penta),0)::int penta,
      count(*) FILTER (WHERE first_blood)::int fb, coalesce(max(kills),0)::int rec,
      coalesce(avg(duration),0)::float avgdur, coalesce(max(duration),0)::int maxdur,
      count(*) FILTER (WHERE win)::int wins FROM match_participants WHERE puuid=$1`, [puuid]);
    if (s && s.n){
      const durMin = Number(s.dur)/60 || 1;
      stats = { registradas:s.n, k:s.k, d:s.d, a:s.a, kda:+(((s.k+s.a)/Math.max(1,s.d)).toFixed(2)),
        csMin:+(Number(s.cs)/durMin).toFixed(1), dmgMin:Math.round(Number(s.dmg)/durMin), vision:+s.vis.toFixed(1),
        penta:s.penta, firstBloods:s.fb, recordKills:s.rec, avgDurMin:Math.round(s.avgdur/60), maxDurMin:Math.round(s.maxdur/60),
        wins:s.wins, losses:s.n - s.wins };
    }
  }

  // Blue Shells (si es un usuario registrado)
  let blueshells = null;
  if (u){
    const inv = await q1('SELECT count(*)::int c FROM shells WHERE owner_id=$1', [u.id]);
    const con = await q1('SELECT count(*)::int c FROM shell_log WHERE user_id=$1', [u.id]);
    const rob = await q1("SELECT count(*)::int c FROM shell_log WHERE user_id=$1 AND motivo ILIKE 'Robada%'", [u.id]);
    const lan = await q1("SELECT count(*)::int c FROM events WHERE user_id=$1 AND kind='sent'", [u.id]);
    const rec = await q1("SELECT count(*)::int c FROM events WHERE user_id=$1 AND kind='received'", [u.id]);
    const listCon = await q('SELECT motivo, created_at FROM shell_log WHERE user_id=$1 ORDER BY id DESC LIMIT 40', [u.id]);
    const listLan = await q("SELECT castigo, other, estado, created_at FROM events WHERE user_id=$1 AND kind='sent' ORDER BY id DESC LIMIT 40", [u.id]);
    const listRec = await q(`SELECT castigo, other AS "from", estado, extra, bounce, created_at FROM events WHERE user_id=$1 AND kind='received' ORDER BY id DESC LIMIT 40`, [u.id]);
    blueshells = { inventory:inv.c, max:MAX_SHELLS, conseguidas:con.c, robadas:rob.c, lanzadas:lan.c, recibidas:rec.c, castigos:rec.c,
      listConseguidas:listCon, listLanzadas:listLan, listRecibidas:listRec };
  }

  const profile = {
    riotid, nickname: (u && u.nickname) || (lp && lp.nm) || riotid.split('#')[0],
    realname: u && u.realname, avatar: u && u.avatar, pos1: u && u.pos1, pos2: u && u.pos2,
    champs: u ? [u.champ1,u.champ2,u.champ3].filter(Boolean) : [], flashSlot: u && u.flash_slot,
    isRegistered: !!u, isAdmin: !!(u && u.is_admin), label: accLabel,
    tier: lp && lp.tier, div: lp && lp.div, lp: lp && lp.lp, rankPos,
    w: lp ? lp.w : (stats?stats.wins:0), l: lp ? lp.l : (stats?stats.losses:0),
    form: (lp && lp.form) || [], up: lp && lp.up, down: lp && lp.down, aegis: lp && lp.aegis,
  };
  res.json({ profile, history, stats, blueshells, ddragonVersion: liveData && liveData.ddragonVersion });
}));

// Scoreboard completo de una partida guardada (para el desglose "tipo live games").
app.get('/api/match/:matchId', wrap(async (req,res) => {
  const id = (req.params.matchId || '').trim();
  const blob = (await matchBlobs([id]))[id];   // caché en memoria (partida inmutable)
  if (!blob || !blob.info) return res.status(404).json({ error:'Partida no guardada' });
  res.set('Cache-Control', 'public, max-age=86400, immutable');   // el JSON no cambia → Cloudflare lo cachea
  const info = blob.info;
  const trackedRids = new Set(((liveData && liveData.players) || []).map(p => (p.rid||'').toLowerCase()));
  const parts = (info.participants || []).map(p => {
    const gn = p.riotIdGameName || p.summonerName || '', tg = p.riotIdTagline || '';
    const rid = gn ? (tg ? `${gn}#${tg}` : gn) : '';
    return {
      name: gn, tag: tg, champion: p.championName, teamId: p.teamId, win: !!p.win, position: p.teamPosition || '',
      spells: [p.summoner1Id, p.summoner2Id], keystone: ksOf(p), secStyle: secOf(p),
      k: p.kills||0, d: p.deaths||0, a: p.assists||0, cs: (p.totalMinionsKilled||0)+(p.neutralMinionsKilled||0),
      items: [p.item0,p.item1,p.item2,p.item3,p.item4,p.item5].map(x=>x||0), trinket: p.item6||0,
      tracked: rid ? trackedRids.has(rid.toLowerCase()) : false,
    };
  });
  res.json({ duration: info.gameDuration||0, queueId: info.queueId,
    blue: parts.filter(p=>p.teamId===100), red: parts.filter(p=>p.teamId===200) });
}));

// ---- Ficha COMPLETA: evolución de elo + Premios (ranking entre jugadores) + récords ----
const TIERV = { IRON:0,BRONZE:1,SILVER:2,GOLD:3,PLATINUM:4,EMERALD:5,DIAMOND:6,MASTER:7,GRANDMASTER:7,CHALLENGER:7 };
const DIVV  = { I:3, II:2, III:1, IV:0, '':0 };
function absLPof(tier, div, lp){
  if (!tier || tier==='UNRANKED') return null;
  if (tier==='MASTER'||tier==='GRANDMASTER'||tier==='CHALLENGER') return 2800 + (lp||0);
  return (TIERV[tier]||0)*400 + (DIVV[div]||0)*100 + (lp||0);
}
// Premios: cada uno mide algo por jugador y se rankea. get(p) null = "sin registro".
const AWARDS = [
  { key:'grindeador',  title:'El Grindeador',            prize:'2.500 €', unit:'',                   get:p=>p.games },
  { key:'onetrick',    title:'One Trick King',           prize:'2.500 €', unit:'',                   get:p=>p.oneTrick||null },
  { key:'main',        title:'Main Character',           prize:'2.500 €', unit:'%',  min:20,         get:p=>p.games>=20?+p.winrate.toFixed(1):null },
  { key:'sinfrenos',   title:'Sin Frenos',               prize:'1.500 €', unit:'',                   get:p=>p.maxDeaths||null },
  { key:'penta',       title:'Pentakill Hunter',         prize:'1.500 €', unit:'',                   get:p=>p.pentas||null },
  { key:'caos',        title:'Agente del Caos',          prize:'1.500 €', unit:' derrotas seguidas', get:p=>p.lossStreak||null },
  { key:'pool',        title:'Maestro del Champion Pool', prize:'1.000 €', unit:'',                   get:p=>p.distinctChamps||null },
  { key:'consistency', title:'Consistency King',         prize:'1.000 €', unit:'',                   get:p=>p.winStreak||null },
  { key:'kda',         title:'KDA Player',               prize:'1.000 €', unit:'',                   get:p=>p.games?+p.bestKda.toFixed(2):null },
  { key:'criminal',    title:'Criminal de Guerra',       prize:'1.000 €', unit:'',                   get:p=>p.maxKills||null },
];
// Récords por partida (mejor marca de una sola partida).
const RECORDS = [
  { key:'kills',   title:'Más kills',             unit:'',    get:p=>p.maxKills },
  { key:'assists', title:'Más asistencias',       unit:'',    get:p=>p.maxAssists },
  { key:'damage',  title:'Más daño a campeones',  unit:'',    get:p=>p.maxDamage,  fmt:v=>v.toLocaleString('es-CL') },
  { key:'vision',  title:'Más visión',            unit:'',    get:p=>p.maxVision },
  { key:'longest', title:'Victoria más larga',    unit:'',    get:p=>p.longestWin, fmt:v=>Math.floor(v/60)+':'+String(Math.floor(v%60)).padStart(2,'0') },
  { key:'kda',     title:'Mejor KDA',             unit:'',    get:p=>+p.bestKda.toFixed(2) },
  { key:'gold',    title:'Más oro',               unit:'',    get:p=>p.maxGold,    fmt:v=>v.toLocaleString('es-CL') },
  { key:'csmin',   title:'Mejor CS/min',          unit:'',    get:p=>+p.bestCsMin.toFixed(1) },
];
// Agregados por jugador del torneo (cache 60s: es global, igual para todos).
let LB_CACHE = { at:0, players:[] };
async function leaderboardPlayers(){
  if (Date.now() - LB_CACHE.at < 90000) return LB_CACHE.players;
  const rows = await q(`SELECT puuid, riotid, name, champion, win, kills, deaths, assists, cs, gold, damage, vision, penta, duration, game_end
    FROM match_participants WHERE is_tournament=true`);
  const byP = {};
  for (const r of rows){
    const p = byP[r.puuid] || (byP[r.puuid] = { puuid:r.puuid, riotid:r.riotid, name:(r.name || (r.riotid||'').split('#')[0] || '—'),
      games:0, wins:0, maxKills:0, maxDeaths:0, maxAssists:0, maxDamage:0, maxVision:0, maxGold:0, pentas:0,
      bestKda:0, bestCsMin:0, longestWin:0, champs:{}, seq:[] });
    p.games++; if (r.win) p.wins++;
    p.maxKills=Math.max(p.maxKills,r.kills||0); p.maxDeaths=Math.max(p.maxDeaths,r.deaths||0); p.maxAssists=Math.max(p.maxAssists,r.assists||0);
    p.maxDamage=Math.max(p.maxDamage,r.damage||0); p.maxVision=Math.max(p.maxVision,r.vision||0); p.maxGold=Math.max(p.maxGold,r.gold||0);
    p.pentas+=r.penta||0;
    const kda=((r.kills||0)+(r.assists||0))/Math.max(1,r.deaths||0); if (kda>p.bestKda) p.bestKda=kda;
    if (r.duration>0){ const cm=(r.cs||0)/(r.duration/60); if (cm>p.bestCsMin) p.bestCsMin=cm; }
    if (r.win) p.longestWin=Math.max(p.longestWin,r.duration||0);
    p.champs[r.champion]=(p.champs[r.champion]||0)+1;
    p.seq.push({ end:r.game_end||0, win:!!r.win });
  }
  const players = Object.values(byP).map(p => {
    const cc=Object.values(p.champs); p.distinctChamps=Object.keys(p.champs).length; p.oneTrick=cc.length?Math.max(...cc):0;
    p.winrate=p.games?p.wins/p.games*100:0;
    p.seq.sort((a,b)=>a.end-b.end);
    let ws=0,ls=0,mw=0,ml=0; for (const g of p.seq){ if (g.win){ ws++; ls=0; mw=Math.max(mw,ws);} else { ls++; ws=0; ml=Math.max(ml,ls);} }
    p.winStreak=mw; p.lossStreak=ml; delete p.seq; delete p.champs; return p;
  });
  LB_CACHE = { at:Date.now(), players };
  return players;
}
// Rankea a los jugadores por una métrica y devuelve el puesto/líder del jugador puuid.
function rankBy(players, getFn, puuid){
  const scored = players.map(p => ({ p, v:getFn(p) })).filter(x => x.v != null && x.v > 0).sort((a,b) => b.v - a.v);
  const total = scored.length;
  const leader = scored[0] ? { name:scored[0].p.name, value:scored[0].v } : null;
  const idx = scored.findIndex(x => x.p.puuid === puuid);
  const mine = idx >= 0 ? scored[idx].v : null;
  return { value:mine, rank: idx>=0 ? idx+1 : null, total, leader };
}
// Cuentas a EXCLUIR de las stats por jugador: de cada jugador REGISTRADO con varias
// cuentas (main + smurfs), se cuenta solo la MÁS ALTA; las demás se excluyen. Las cuentas
// inscritas SIN dueño registrado no se excluyen (cuentan como su propia "cuenta más alta").
async function excludedSmurfRids(){
  const absByRid = {};
  (liveSnapshot().players || []).forEach(p => { absByRid[(p.rid || '').toLowerCase()] = absLPof(p.tier, p.div, p.lp) || 0; });
  const owner = {};
  try {
    for (const u of await q("SELECT id, lower(riotid) rid FROM users WHERE coalesce(riotid,'')<>''"))
      (owner['u' + u.id] = owner['u' + u.id] || []).push(u.rid);
    for (const s of await q("SELECT user_id, lower(riotid) rid FROM smurfs WHERE coalesce(riotid,'')<>''"))
      (owner['u' + s.user_id] = owner['u' + s.user_id] || []).push(s.rid);
  } catch {}
  const exclude = new Set();
  for (const o in owner){
    const rids = [...new Set(owner[o])];
    if (rids.length < 2) continue;
    rids.sort((a, b) => (absByRid[b] || 0) - (absByRid[a] || 0));   // más alta primero
    rids.slice(1).forEach(r => exclude.add(r));                      // todas menos la más alta
  }
  return exclude;
}

app.get('/api/ficha/:riotid', wrap(async (req,res) => {
  const riotid = (req.params.riotid || '').trim();
  res.set('Cache-Control', 'public, max-age=90');   // ficha completa: Cloudflare la sirve del borde ~90s
  const lp = liveData && Array.isArray(liveData.players) ? liveData.players.find(p => p.rid === riotid) : null;
  const rankPos = lp && liveData ? liveData.players.indexOf(lp) + 1 : null;
  const u = await q1('SELECT nickname, realname, avatar, pos1 FROM users WHERE riotid=$1', [riotid]);
  let puuid = lp && lp.puuid;
  if (!puuid){ const r = await q1('SELECT puuid FROM match_participants WHERE lower(riotid)=lower($1) AND puuid<>\'\' ORDER BY game_end DESC LIMIT 1', [riotid]); puuid = r && r.puuid; }

  // Evolución de elo: reconstruida de los ±LP absolutos guardados
  let eloSeries = [];
  const curAbs = lp ? absLPof(lp.tier, lp.div, lp.lp) : null;
  if (puuid && curAbs != null){
    try {
      const s = await playerMatchCache(puuid);
      if (s && Array.isArray(s.lpGames)){
        const lg = s.lpGames.filter(g => g.end);
        let abs = curAbs; const pts = [{ t:Date.now(), lp:abs }];
        for (const g of lg){ abs -= (g.delta||0); pts.push({ t:g.end, lp:abs }); }
        eloSeries = pts.reverse();
      }
    } catch {}
  }

  // Premios + récords (ranking entre todos los jugadores del torneo)
  const players = await leaderboardPlayers();
  const premios = AWARDS.map(a => { const r = rankBy(players, a.get, puuid); return { key:a.key, title:a.title, prize:a.prize, unit:a.unit, ...r }; });
  const records = RECORDS.map(a => {
    const r = rankBy(players, a.get, puuid);
    const f = a.fmt || (v=>v);
    return { key:a.key, title:a.title, value:r.value!=null?f(r.value):null, rank:r.rank, total:r.total };
  });

  // Estadísticas agregadas del jugador — TODO desde match_participants (datos ya extraídos
  // de las partidas), sin gastar ni una llamada a la Riot API.
  let stats = null;
  if (puuid){
    const NS = "upper(coalesce(position,'')) NOT IN ('UTILITY','SUPPORT')";
    const a = await q1(`
      SELECT count(*) games, count(*) FILTER (WHERE win) wins,
             avg(kills) kk, avg(deaths) dd, avg(assists) aa,
             sum(kills) k, sum(deaths) d, sum(assists) asi,
             sum(coalesce(damage,0)) dmg_sum, sum(coalesce(gold,0)) gold_sum, sum(coalesce(vision,0)) vis_sum,
             sum(coalesce(duration,0)) dur_all, avg(cs) cs_all,
             sum(coalesce(penta,0)) pentas, count(*) FILTER (WHERE first_blood) fb,
             sum(cs) FILTER (WHERE ${NS}) cs_ns, sum(duration) FILTER (WHERE ${NS}) dur_ns,
             max(kills) maxk, max(cs) maxcs, max(damage) maxdmg
      FROM match_participants WHERE puuid=$1`, [puuid]);
    const champs = await q(`
      SELECT champion, count(*) games, count(*) FILTER (WHERE win) wins,
             avg(kills) k, avg(deaths) d, avg(assists) a
      FROM match_participants WHERE puuid=$1 AND coalesce(champion,'')<>''
      GROUP BY champion ORDER BY games DESC, wins DESC LIMIT 8`, [puuid]);
    const roles = await q(`
      SELECT coalesce(nullif(position,''),'—') pos, count(*) games, count(*) FILTER (WHERE win) wins
      FROM match_participants WHERE puuid=$1 GROUP BY 1 ORDER BY games DESC`, [puuid]);
    if (a && +a.games > 0){
      const g = +a.games, durAll = +a.dur_all || 0, perMin = s => durAll > 0 ? s / (durAll / 60) : 0;
      stats = {
        games: g, wins: +a.wins, winrate: Math.round(+a.wins / g * 100),
        kills: +a.kk || 0, deaths: +a.dd || 0, assists: +a.aa || 0,
        kda: (+a.k + +a.asi) / Math.max(1, +a.d),
        csmin: +a.dur_ns > 0 ? +a.cs_ns / (+a.dur_ns / 60) : 0, avgCs: +a.cs_all || 0,
        damage: perMin(+a.dmg_sum), gold: perMin(+a.gold_sum), vision: perMin(+a.vis_sum),
        pentas: +a.pentas || 0, firstBloods: +a.fb || 0,
        maxKills: +a.maxk || 0, maxCs: +a.maxcs || 0, maxDamage: +a.maxdmg || 0,
        champions: champs.map(c => ({ champion: c.champion, games: +c.games, wins: +c.wins,
          winrate: Math.round(+c.wins / +c.games * 100), kda: (+c.k + +c.a) / Math.max(1, +c.d) })),
        roles: roles.map(r => ({ pos: r.pos, games: +r.games, wins: +r.wins, winrate: Math.round(+r.wins / +r.games * 100) })),
      };
    }
  }

  // Puesto en CADA estadística respecto a TODOS los jugadores del torneo (por puuid).
  if (stats && puuid){
    const NS = "upper(coalesce(position,'')) NOT IN ('UTILITY','SUPPORT')";
    const exclude = await excludedSmurfRids();   // rankea por jugador (cuenta más alta), no por cuenta
    const all = await q(`
      SELECT puuid, lower((array_agg(riotid ORDER BY game_end DESC NULLS LAST))[1]) rid,
             sum(kills) k, sum(deaths) d, sum(assists) asi, count(*) games,
             avg(kills) kk, avg(deaths) dd, avg(assists) aa,
             sum(coalesce(damage,0)) dmg_sum, sum(coalesce(gold,0)) gold_sum, sum(coalesce(vision,0)) vis_sum, sum(coalesce(duration,0)) dur_all,
             sum(coalesce(penta,0)) pentas, count(*) FILTER (WHERE first_blood) fb,
             sum(cs) FILTER (WHERE ${NS}) cs_ns, sum(duration) FILTER (WHERE ${NS}) dur_ns,
             max(kills) maxk, max(cs) maxcs, max(damage) maxdmg
      FROM match_participants WHERE is_tournament=true AND coalesce(puuid,'')<>'' GROUP BY puuid`);
    // Si abres una cuenta ALTA → te rankea solo entre las cuentas altas (una por jugador).
    // Si abres una cuenta BAJA (smurf excluida) → te rankea entre el TOTAL de cuentas.
    const meExcluded = exclude.has(riotid.toLowerCase());
    const rows2 = all
      .filter(r => meExcluded || !exclude.has(r.rid))
      .map(r => { const dur = +r.dur_all || 0, pm = s => dur > 0 ? s / (dur / 60) : 0; return { puuid: r.puuid,
      kda: (+r.k + +r.asi) / Math.max(1, +r.d), kills: +r.kk || 0, deaths: +r.dd || 0, assists: +r.aa || 0,
      csmin: +r.dur_ns > 0 ? +r.cs_ns / (+r.dur_ns / 60) : null,
      damage: pm(+r.dmg_sum), gold: pm(+r.gold_sum), vision: pm(+r.vis_sum), pentas: +r.pentas || 0, firstBloods: +r.fb || 0,
      maxKills: +r.maxk || 0, maxCs: +r.maxcs || 0, maxDamage: +r.maxdmg || 0 }; });
    const rankOf = key => {
      const vals = rows2.filter(x => x[key] != null).sort((a, b) => b[key] - a[key]);
      const idx = vals.findIndex(x => x.puuid === puuid);
      return idx >= 0 ? { rank: idx + 1, total: vals.length } : null;
    };
    stats.ranks = {};
    ['kda','kills','deaths','assists','csmin','damage','gold','vision','pentas','firstBloods','maxKills','maxCs','maxDamage']
      .forEach(k => { stats.ranks[k] = rankOf(k); });
  }

  const w = lp ? lp.w : 0, l = lp ? lp.l : 0, tot = w+l;
  res.json({
    profile: { riotid, nickname:(u&&u.nickname)||(lp&&lp.nm)||riotid.split('#')[0], realname:u&&u.realname, avatar:u&&u.avatar,
      tier:lp&&lp.tier, div:lp&&lp.div, lp:lp&&lp.lp, rankPos, role:(u&&u.pos1)||(lp&&lp.role),
      elo: lp && ['MASTER','GRANDMASTER','CHALLENGER'].includes(lp.tier) ? 'High Elo' : 'Low Elo',
      w, l, winrate: tot?Math.round(w/tot*100):0 },
    eloSeries, premios, records, stats,
  });
}));

// El overlay (exe) reporta el rango/estado del jugador (obtenido GRATIS del cliente vía LCU)
// para que el runner de la nube NO tenga que gastar llamadas a la Riot API por ese jugador.
app.post('/api/overlay/report', wrap(async (req,res) => {
  const b = req.body || {};
  const riotid = (b.riotid || '').trim();
  if (!/^.+#.+$/.test(riotid)) return res.status(400).json({ error:'riotid inválido' });
  let allowed;
  if (REPORT_SECRET) allowed = b.secret === REPORT_SECRET;
  else allowed = !!(await q1('SELECT 1 FROM users WHERE riotid=$1 UNION SELECT 1 FROM roster WHERE riotid=$1', [riotid]));
  if (!allowed) return res.status(403).json({ error:'no autorizado' });
  const entry = (b.entry && typeof b.entry === 'object') ? b.entry : null;
  await q(`INSERT INTO overlay_reports (riotid,entry,in_game,updated_at) VALUES ($1,$2::jsonb,$3,now())
           ON CONFLICT (riotid) DO UPDATE SET entry=$2::jsonb, in_game=$3, updated_at=now()`,
    [riotid, JSON.stringify(entry), !!b.inGame]);
  res.json({ ok:true });
}));

// Mensajes (texto y/o voz) que el admin manda al overlay de un jugador.
app.post('/api/admin/message', auth, requireAdmin, wrap(async (req,res) => {
  const uid = Number(req.body && req.body.userId);
  if (!uid) return res.status(400).json({ error:'Falta el jugador' });
  const text  = ((req.body && req.body.text) || '').trim() || null;
  const audio = (req.body && typeof req.body.audio === 'string' && req.body.audio.startsWith('data:audio')) ? req.body.audio : null;
  if (!text && !audio) return res.status(400).json({ error:'Escribe un mensaje o graba un audio' });
  if (audio && audio.length > 2000000) return res.status(400).json({ error:'El audio es muy largo (grábalo más corto)' });
  const target = await q1('SELECT id FROM users WHERE id=$1', [uid]);
  if (!target) return res.status(400).json({ error:'Jugador inválido' });
  await q('INSERT INTO admin_messages (user_id,text,audio) VALUES ($1,$2,$3)', [uid, text, audio]);
  ovlInvalidate(uid);   // el overlay del destinatario lo recibe en su próximo poll (sin esperar el TTL)
  res.json({ ok:true });
}));
// El overlay sondea sus mensajes recientes (últimos 5 min) por Riot ID. Sin auth (solo lectura de lo propio).
// Resuelve un Riot ID (cuenta MAIN o SMURF) al id del jugador dueño. Así el overlay recibe
// shells/mensajes del jugador estés logueado en la main o en cualquiera de tus smurfs.
async function ownerIdByRiotid(riotid){
  const u = await q1('SELECT id FROM users WHERE lower(riotid)=lower($1)', [riotid]);
  if (u) return u.id;
  const s = await q1('SELECT user_id AS id FROM smurfs WHERE lower(riotid)=lower($1)', [riotid]);
  return s ? s.id : null;
}
// EGRESS: el overlay sondea shells (12s) y mensajes (8s). Sin caché, CADA poll pega a Supabase.
// Cacheamos por usuario en memoria (Render): el poll se sirve sin tocar la DB. TTL corto +
// invalidación al enviar → la entrega sigue siendo instantánea (el envío borra el caché del destino).
const RID_UID = new Map();     // ridLower -> { at, uid }  (resolución rid→usuario; casi nunca cambia)
const OVL_SHELLS = new Map();  // uid -> { at, data }
const OVL_MSGS   = new Map();  // uid -> { at, data }
const OVL_TTL = 45000;
async function ownerIdCached(riotid){
  const k = riotid.toLowerCase(), c = RID_UID.get(k);
  if (c && Date.now() - c.at < 300000) return c.uid;
  const uid = await ownerIdByRiotid(riotid);
  RID_UID.set(k, { at: Date.now(), uid });
  return uid;
}
function ovlInvalidate(uid){ uid = Number(uid); OVL_SHELLS.delete(uid); OVL_MSGS.delete(uid); }

app.get('/api/overlay/messages', wrap(async (req,res) => {
  const riotid = (req.query.riotid || '').trim();
  if (!riotid) return res.json([]);
  const uid = await ownerIdCached(riotid);
  if (!uid) return res.json([]);
  const c = OVL_MSGS.get(uid);
  if (c && Date.now() - c.at < OVL_TTL) return res.json(c.data);
  const data = await q(`SELECT id, text, audio, created_at FROM admin_messages
    WHERE user_id=$1 AND created_at > now() - interval '5 minutes' ORDER BY id ASC LIMIT 10`, [uid]);
  OVL_MSGS.set(uid, { at: Date.now(), data });
  res.json(data);
}));

// Blue Shells recibidas por un jugador (para el overlay). Sin auth: solo lectura por Riot ID.
app.get('/api/overlay/shells', wrap(async (req,res) => {
  const riotid = (req.query.riotid || '').trim();
  if (!riotid) return res.json([]);
  const uid = await ownerIdCached(riotid);
  if (!uid) return res.json([]);
  const cached = OVL_SHELLS.get(uid);
  if (cached && Date.now() - cached.at < OVL_TTL) return res.json(cached.data);
  // EGRESS: el audio (base64, hasta ~1.5 MB) solo se manda en shells RECIENTES. El overlay solo
  // reproduce las nuevas (created_at > su arranque), así que las viejas no necesitan re-bajar el
  // audio en cada poll (cada 12 s por overlay abierto) — antes ESO era el gran consumo de egress.
  const data = await q(`SELECT id, castigo, other AS "from", estado, extra,
      CASE WHEN created_at > now() - interval '15 minutes' THEN audio ELSE NULL END AS audio,
      created_at FROM events
    WHERE user_id=$1 AND kind='received' ORDER BY id DESC LIMIT 20`, [uid]);
  OVL_SHELLS.set(uid, { at: Date.now(), data });
  res.json(data);
}));

// ================= PARTICIPANTES =================
app.get('/api/participants', auth, wrap(async (req,res) => {
  const rows = await q('SELECT id,nickname,riotid FROM users ORDER BY nickname');
  res.json(rows.map(r => ({ id:r.id, nickname:r.nickname, riotid:r.riotid, pos: ladderPos(r.riotid) })));
}));

// ================= BLUE SHELLS =================
app.get('/api/blueshells', auth, wrap(async (req,res) => {
  const inventory = await q('SELECT id,motivo,created_at FROM shells WHERE owner_id=$1 ORDER BY id', [req.user.id]);
  const received = await q("SELECT * FROM events WHERE user_id=$1 AND kind='received' ORDER BY id DESC", [req.user.id]);
  const sent     = await q("SELECT * FROM events WHERE user_id=$1 AND kind='sent' ORDER BY id DESC", [req.user.id]);
  res.json({ inventory, received, sent, max: MAX_SHELLS });
}));

app.post('/api/blueshells/launch', auth, wrap(async (req,res) => {
  const targetId = Number(req.body && req.body.targetId);
  const target = targetId && await q1('SELECT * FROM users WHERE id=$1', [targetId]);
  if (!target) return res.status(400).json({ error:'Objetivo inválido' });
  if (target.id === req.user.id) return res.status(400).json({ error:'No puedes lanzarte a ti mismo' });
  const shell = await q1('SELECT id FROM shells WHERE owner_id=$1 ORDER BY id LIMIT 1', [req.user.id]);
  if (!shell) return res.status(400).json({ error:'No tienes Blue Shells' });
  // Audio opcional (voz) que sonará en el overlay del objetivo. Máx ~8s.
  const audio = (req.body && typeof req.body.audio === 'string' && req.body.audio.startsWith('data:audio')) ? req.body.audio : null;
  if (audio && audio.length > 1600000) return res.status(400).json({ error:'El audio es muy largo (máx 8s)' });

  await q('DELETE FROM shells WHERE id=$1', [shell.id]);
  let castigo = rollShell(), bounce = false;
  if (castigo === 'Reverse'){ bounce = true; do { castigo = rollShell(); } while (castigo === 'Reverse'); }
  if (Math.random()*100 < reverseChance(ladderPos(target.riotid))) bounce = true;

  // Sorteos del momento (se guardan en events.extra):
  //  - "Campeón aleatorio": un campeón concreto (extra = id DDragon, con icono).
  //  - "Clase de campeón aleatoria":  una clase/tag (extra = tag en inglés; se muestra en español).
  let extra = null, champIcon = null, display = null;
  if (castigo === 'Campeón aleatorio' && CHAMP_IDS.length){
    extra = CHAMP_IDS[Math.floor(Math.random()*CHAMP_IDS.length)];
    champIcon = champIconUrl(extra); display = extra;
  } else if (castigo === 'Clase de campeón aleatoria'){
    extra = CLASSES[Math.floor(Math.random()*CLASSES.length)];
    display = CLASS_ES[extra] || extra;
  }

  if (bounce){
    await q("INSERT INTO events (kind,user_id,other,castigo,extra,bounce,audio) VALUES ('received',$1,$2,$3,$4,true,$5)", [req.user.id, '↩️ rebote (' + target.nickname + ')', castigo, extra, audio]);
    ovlInvalidate(req.user.id);
    return res.json({ bounce:true, castigo, champ: display, champIcon, msg:`¡Rebotó! El castigo te toca a TI: ${castigo}` });
  }
  await q("INSERT INTO events (kind,user_id,other,castigo,extra) VALUES ('sent',$1,$2,$3,$4)", [req.user.id, target.nickname, castigo, extra]);
  await q("INSERT INTO events (kind,user_id,other,castigo,extra,audio) VALUES ('received',$1,$2,$3,$4,$5)", [target.id, req.user.nickname, castigo, extra, audio]);
  ovlInvalidate(target.id);   // el destinatario recibe la shell en su próximo poll
  res.json({ bounce:false, castigo, target: target.nickname, champ: display, champIcon, msg:`Le lanzaste una Blue Shell a ${target.nickname}. Le tocó: ${castigo}` });
}));

app.post('/api/blueshells/:id/cumplido', auth, wrap(async (req,res) => {
  const rows = await q("UPDATE events SET estado='cumplido' WHERE id=$1 AND user_id=$2 AND kind='received' RETURNING id", [Number(req.params.id), req.user.id]);
  if (!rows.length) return res.status(404).json({ error:'No encontrado' });
  ovlInvalidate(req.user.id);
  res.json({ ok:true });
}));

// ================= TICKETS =================
app.post('/api/tickets', auth, wrap(async (req,res) => {
  const { asunto, mensaje } = req.body || {};
  if (!asunto || !mensaje) return res.status(400).json({ error:'Falta asunto o mensaje' });
  await q('INSERT INTO tickets (user_id,asunto,mensaje) VALUES ($1,$2,$3)', [req.user.id, asunto, mensaje]);
  res.json({ ok:true });
}));
app.get('/api/tickets/mine', auth, wrap(async (req,res) => res.json(await q('SELECT * FROM tickets WHERE user_id=$1 ORDER BY id DESC', [req.user.id]))));

// ================= VERIFICACIONES =================
app.post('/api/verifications', auth, wrap(async (req,res) => {
  const { castigo } = req.body || {};
  if (!castigo) return res.status(400).json({ error:'Falta castigo' });
  await q('INSERT INTO verifications (user_id,castigo) VALUES ($1,$2)', [req.user.id, castigo]);
  res.json({ ok:true });
}));

// ================= ADMIN =================
app.get('/api/admin/tickets', auth, requireAdmin, wrap(async (req,res) =>
  res.json(await q(`SELECT t.*, u.nickname AS player FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.estado='abierto' ORDER BY t.id DESC`))));
app.post('/api/admin/tickets/:id/resolve', auth, requireAdmin, wrap(async (req,res) => {
  await q("UPDATE tickets SET estado='resuelto' WHERE id=$1", [Number(req.params.id)]); res.json({ ok:true }); }));

app.get('/api/admin/verifications', auth, requireAdmin, wrap(async (req,res) =>
  res.json(await q(`SELECT v.*, u.nickname AS player FROM verifications v JOIN users u ON u.id=v.user_id WHERE v.estado='pendiente' ORDER BY v.id DESC`))));
app.post('/api/admin/verifications/:id/:action', auth, requireAdmin, wrap(async (req,res) => {
  const estado = req.params.action === 'approve' ? 'aprobado' : 'rechazado';
  const v = await q1('SELECT * FROM verifications WHERE id=$1', [Number(req.params.id)]);
  if (!v) return res.status(404).json({ error:'No encontrado' });
  await q('UPDATE verifications SET estado=$1 WHERE id=$2', [estado, v.id]);
  if (estado === 'aprobado')
    await q("UPDATE events SET estado='cumplido' WHERE user_id=$1 AND castigo=$2 AND kind='received' AND estado='pendiente'", [v.user_id, v.castigo]);
    ovlInvalidate(v.user_id);
  res.json({ ok:true });
}));

app.get('/api/admin/participants', auth, requireAdmin, wrap(async (req,res) =>
  res.json(await q(`SELECT u.id,u.nickname,u.riotid,(SELECT COUNT(*) FROM shells WHERE owner_id=u.id)::int AS shells FROM users u ORDER BY u.nickname`))));
app.post('/api/admin/grant', auth, requireAdmin, wrap(async (req,res) => {
  const { userId, motivo } = req.body || {};
  const target = userId && await q1('SELECT * FROM users WHERE id=$1', [Number(userId)]);
  if (!target) return res.status(400).json({ error:'Usuario inválido' });
  const c = await q1('SELECT COUNT(*)::int AS c FROM shells WHERE owner_id=$1', [target.id]);
  if (c.c >= MAX_SHELLS) return res.status(400).json({ error:`${target.nickname} ya tiene el inventario lleno (${MAX_SHELLS})` });
  await q('INSERT INTO shells (owner_id,motivo) VALUES ($1,$2)', [target.id, motivo || 'Otorgada por la organización']);
  res.json({ ok:true });
}));
app.post('/api/admin/revoke', auth, requireAdmin, wrap(async (req,res) => {
  const target = req.body && req.body.userId && await q1('SELECT * FROM users WHERE id=$1', [Number(req.body.userId)]);
  if (!target) return res.status(400).json({ error:'Usuario inválido' });
  const shell = await q1('SELECT id FROM shells WHERE owner_id=$1 ORDER BY id DESC LIMIT 1', [target.id]);
  if (!shell) return res.status(400).json({ error:`${target.nickname} no tiene Blue Shells` });
  await q('DELETE FROM shells WHERE id=$1', [shell.id]);
  res.json({ ok:true });
}));

// ---- Penalizaciones (castigos): dar directamente y quitar pendientes ----
app.get('/api/admin/penalties', auth, requireAdmin, wrap(async (req,res) =>
  res.json(await q(`SELECT e.id, e.castigo, e.other, e.created_at, u.nickname AS player
    FROM events e JOIN users u ON u.id=e.user_id
    WHERE e.kind='received' AND e.estado='pendiente' ORDER BY e.id DESC`))));
app.post('/api/admin/penalty', auth, requireAdmin, wrap(async (req,res) => {
  const { userId, castigo } = req.body || {};
  const target = userId && await q1('SELECT * FROM users WHERE id=$1', [Number(userId)]);
  if (!target) return res.status(400).json({ error:'Usuario inválido' });
  if (!castigo) return res.status(400).json({ error:'Falta el castigo' });
  await q("INSERT INTO events (kind,user_id,other,castigo) VALUES ('received',$1,'Organización',$2)", [target.id, castigo]);
  ovlInvalidate(target.id);
  res.json({ ok:true });
}));
app.post('/api/admin/penalty/remove', auth, requireAdmin, wrap(async (req,res) => {
  const del = await q("DELETE FROM events WHERE id=$1 AND kind='received' RETURNING user_id", [Number(req.body && req.body.id)]);
  if (del.length) ovlInvalidate(del[0].user_id);
  res.json({ ok:true });
}));

// ---- Confirmación de perfiles (el registro queda "por confirmar" hasta que el admin lo apruebe) ----
app.get('/api/admin/unconfirmed', auth, requireAdmin, wrap(async (req,res) =>
  res.json(await q(`SELECT id, nickname, riotid, pos1, pos2, champ1, champ2, champ3, flash_slot AS "flashSlot", main, discord, created_at
    FROM users WHERE confirmed = false ORDER BY created_at`))));
app.post('/api/admin/confirm', auth, requireAdmin, wrap(async (req,res) => {
  const id = Number(req.body && req.body.userId);
  const u = id && await q1('SELECT id FROM users WHERE id=$1', [id]);
  if (!u) return res.status(400).json({ error:'Usuario inválido' });
  await q('UPDATE users SET confirmed = true WHERE id=$1', [id]);
  res.json({ ok:true });
}));

// ================= INGESTA DEL RANKING =================
// El runner local (con la Riot key) empuja aquí players.json para mantener
// vivo el ranking del sitio online. Protegido por INGEST_SECRET.
let liveData = null;   // último snapshot en memoria (sobrevive a discos efímeros)
// Snapshot del ranking: SIEMPRE de memoria (liveData). Cae al disco solo si aún no hay memoria
// (evita leer un players.json de disco vacío/viejo cuando el runner no lo escribió este arranque).
function liveSnapshot(){
  if (liveData && Array.isArray(liveData.players)) return liveData;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'players.json'), 'utf8')); } catch { return { players: [], encounters: [] }; }
}
app.post('/api/ingest', wrap(async (req,res) => {
  if (!process.env.INGEST_SECRET) return res.status(503).json({ error:'Ingesta deshabilitada (falta INGEST_SECRET)' });
  if ((req.headers['x-ingest-secret'] || '') !== process.env.INGEST_SECRET) return res.status(401).json({ error:'Secreto inválido' });
  const data = req.body;
  if (!data || !Array.isArray(data.players)) return res.status(400).json({ error:'Payload inválido' });
  liveData = data;
  try {
    fs.writeFileSync(path.join(ROOT, 'players.json'), JSON.stringify(data), 'utf8');
    fs.writeFileSync(path.join(ROOT, 'players.js'), 'window.SQC_DATA = ' + JSON.stringify(data) + ';\n', 'utf8');
  } catch { /* disco de solo-memoria: seguimos sirviendo desde liveData */ }
  res.json({ ok:true, players: data.players.length });
}));
// Servir el snapshot en memoria si existe (más fresco que el archivo en disco)
// Datos mínimos para los badges de la navbar (evita bajar players.json entero en cada página).
app.get('/api/nav-counts', (req,res) => {
  const live = (liveData && Array.isArray(liveData.liveGames)) ? liveData.liveGames.length : 0;
  const encEnds = (liveData && Array.isArray(liveData.encounters)) ? liveData.encounters.map(e => e.end || 0) : [];
  res.json({ live, encEnds });
});
// players.json (el que se consulta cada 30s por polling): cacheable ~20s → Cloudflare lo
// sirve del borde y baja la banda. players.js es la carga INICIAL de cada página (script tag):
// SIN caché, así el primer render nunca sale con un snapshot viejo (evita cronómetros de live
// games inflados al abrir). Cargar players.js fresco 1 vez por página es despreciable.
app.get('/players.json', (req,res,next) => { if (!liveData) return next(); res.setHeader('Cache-Control', 'public, max-age=20'); res.json(liveData); });
app.get('/players.js',   (req,res,next) => { if (!liveData) return next(); res.setHeader('Cache-Control', 'no-store'); res.type('application/javascript').send('window.SQC_DATA = ' + JSON.stringify(liveData) + ';\n'); });

// ================= DROP DIARIO =================
// Reto que lanza la organización; el primero que lo cumpla se lleva la Blue Shell.
app.get('/api/drop', wrap(async (req,res) =>
  res.json(await q1("SELECT reto, created_at FROM drops WHERE estado='activo' ORDER BY id DESC LIMIT 1"))));
app.get('/api/admin/drop', auth, requireAdmin, wrap(async (req,res) =>
  res.json(await q1("SELECT * FROM drops WHERE estado='activo' ORDER BY id DESC LIMIT 1"))));
app.post('/api/admin/drop', auth, requireAdmin, wrap(async (req,res) => {
  const reto = ((req.body && req.body.reto) || '').trim();
  if (!reto) return res.status(400).json({ error:'Falta el reto' });
  await q("UPDATE drops SET estado='cerrado' WHERE estado='activo'");
  await q('INSERT INTO drops (reto) VALUES ($1)', [reto]);
  res.json({ ok:true });
}));
app.post('/api/admin/drop/close', auth, requireAdmin, wrap(async (req,res) => {
  await q("UPDATE drops SET estado='cerrado' WHERE estado='activo'");
  res.json({ ok:true });
}));

// ================= STREAMS (transmisiones agregadas a mano por el admin) =================
app.get('/api/streams', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=15');
  res.json(await q('SELECT id, url, label FROM streams ORDER BY id DESC'));
}));
app.post('/api/admin/streams', auth, requireAdmin, wrap(async (req,res) => {
  const url = ((req.body && req.body.url) || '').trim();
  const label = ((req.body && req.body.label) || '').trim() || null;
  if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error:'URL inválida (debe empezar con http)' });
  await q('INSERT INTO streams (url, label) VALUES ($1, $2)', [url, label]);
  res.json({ ok:true });
}));
app.post('/api/admin/streams/remove', auth, requireAdmin, wrap(async (req,res) => {
  await q('DELETE FROM streams WHERE id=$1', [Number(req.body && req.body.id)]);
  res.json({ ok:true });
}));

// ================= ROSTER (cuentas agregadas a mano) =================
app.get('/api/admin/roster', auth, requireAdmin, wrap(async (req,res) =>
  res.json(await q('SELECT riotid, created_at FROM roster ORDER BY created_at DESC'))));
app.post('/api/admin/roster', auth, requireAdmin, wrap(async (req,res) => {
  const riotid = ((req.body && req.body.riotid) || '').trim();
  if (!/^.+#.+$/.test(riotid)) return res.status(400).json({ error:'Riot ID debe ser Nombre#TAG' });
  await q('INSERT INTO roster (riotid) VALUES ($1) ON CONFLICT (riotid) DO NOTHING', [riotid]);
  res.json({ ok:true });
}));
app.post('/api/admin/roster/remove', auth, requireAdmin, wrap(async (req,res) => {
  await q('DELETE FROM roster WHERE riotid=$1', [((req.body && req.body.riotid) || '').trim()]);
  res.json({ ok:true });
}));

// ---- Equipos (solo admin): un jugador puede estar en VARIOS equipos (checkboxes) ----
// Resuelve la cuenta clickeada a su "cuenta canónica": la main del jugador registrado (para que
// los equipos apliquen a todas sus cuentas) o el propio Riot ID si no está registrado.
async function canonicalRid(riotid){
  const asUser = await q1('SELECT riotid FROM users WHERE lower(riotid)=lower($1)', [riotid]);
  if (asUser) return asUser.riotid;
  const asSmurf = await q1('SELECT u.riotid FROM smurfs s JOIN users u ON u.id=s.user_id WHERE lower(s.riotid)=lower($1)', [riotid]);
  if (asSmurf) return asSmurf.riotid;
  return riotid;
}
// Equipos actualmente marcados para una cuenta (+ catálogo de equipos disponibles + rol/titularidad por equipo).
app.get('/api/admin/teams/:riotid', auth, requireAdmin, wrap(async (req,res) => {
  const rid = await canonicalRid((req.params.riotid || '').trim());
  const rows = await q("SELECT team, role, starter FROM team_members WHERE lower(riotid)=lower($1) AND team<>''", [rid]);
  const meta = {}; rows.forEach(r => { meta[r.team] = { role: r.role || null, starter: r.starter !== false }; });
  res.json({ riotid: rid, teams: [...TEAMS], roles: [...ROLES], selected: rows.map(r => r.team), meta });
}));
// Reemplaza el conjunto de equipos de una cuenta (array vacío = sin equipo). meta[team] = { role, starter }.
app.post('/api/admin/teams/:riotid', auth, requireAdmin, wrap(async (req,res) => {
  const rid = await canonicalRid((req.params.riotid || '').trim());
  if (!/^.+#.+$/.test(rid)) return res.status(400).json({ error:'Riot ID debe ser Nombre#TAG' });
  const want = [...new Set((Array.isArray(req.body && req.body.teams) ? req.body.teams : []).filter(t => TEAMS.has(t)))];
  const meta = (req.body && req.body.meta && typeof req.body.meta === 'object') ? req.body.meta : {};
  await q('DELETE FROM team_members WHERE lower(riotid)=lower($1)', [rid]);
  for (const t of want){
    const m = meta[t] || {};
    const role = ROLES.has(m.role) ? m.role : null;
    const starter = m.starter === false ? false : true;
    await q(`INSERT INTO team_members (riotid, team, role, starter) VALUES ($1,$2,$3,$4)
             ON CONFLICT (riotid, team) DO UPDATE SET role=EXCLUDED.role, starter=EXCLUDED.starter`, [rid, t, role, starter]);
  }
  await q('UPDATE users SET team=NULL WHERE lower(riotid)=lower($1)', [rid]);   // el multi-equipo vive en team_members
  res.json({ ok:true, riotid: rid, selected: want });
}));
// Alta o edición de UN jugador en UN equipo (rol + titular/suplente), sin tocar sus otros equipos.
app.post('/api/admin/team-meta/:riotid', auth, requireAdmin, wrap(async (req,res) => {
  const rid = await canonicalRid((req.params.riotid || '').trim());
  if (!/^.+#.+$/.test(rid)) return res.status(400).json({ error:'Riot ID debe ser Nombre#TAG' });
  const team = (req.body && TEAMS.has(req.body.team)) ? req.body.team : null;
  if (!team) return res.status(400).json({ error:'Equipo inválido' });
  const role = ROLES.has(req.body && req.body.role) ? req.body.role : null;
  const starter = (req.body && req.body.starter === false) ? false : true;
  await q(`INSERT INTO team_members (riotid, team, role, starter) VALUES ($1,$2,$3,$4)
           ON CONFLICT (riotid, team) DO UPDATE SET role=EXCLUDED.role, starter=EXCLUDED.starter`, [rid, team, role, starter]);
  res.json({ ok:true, riotid: rid, team });
}));
// Quita a un jugador de UN equipo concreto.
app.post('/api/admin/team-remove/:riotid', auth, requireAdmin, wrap(async (req,res) => {
  const rid = await canonicalRid((req.params.riotid || '').trim());
  const team = (req.body && TEAMS.has(req.body.team)) ? req.body.team : null;
  if (!team) return res.status(400).json({ error:'Equipo inválido' });
  await q('DELETE FROM team_members WHERE lower(riotid)=lower($1) AND team=$2', [rid, team]);
  res.json({ ok:true });
}));
// Vínculos smurf→main de jugadores NO registrados (para agrupar cuentas en los rosters).
app.get('/api/admin/smurf-links', auth, requireAdmin, wrap(async (req,res) =>
  res.json(await q('SELECT smurf_riotid, main_riotid, created_at FROM smurf_links ORDER BY main_riotid, created_at'))));
app.post('/api/admin/smurf-link', auth, requireAdmin, wrap(async (req,res) => {
  const smurf = ((req.body && req.body.smurf) || '').trim();
  const main  = ((req.body && req.body.main)  || '').trim();
  if (!/^.+#.+$/.test(smurf) || !/^.+#.+$/.test(main)) return res.status(400).json({ error:'Riot ID debe ser Nombre#TAG' });
  if (smurf.toLowerCase() === main.toLowerCase()) return res.status(400).json({ error:'La smurf y la main no pueden ser la misma cuenta' });
  await q(`INSERT INTO smurf_links (smurf_riotid, main_riotid) VALUES ($1,$2)
           ON CONFLICT (smurf_riotid) DO UPDATE SET main_riotid=EXCLUDED.main_riotid`, [smurf, main]);
  res.json({ ok:true, smurf, main });
}));
app.post('/api/admin/smurf-unlink', auth, requireAdmin, wrap(async (req,res) => {
  const smurf = ((req.body && req.body.smurf) || '').trim();
  await q('DELETE FROM smurf_links WHERE lower(smurf_riotid)=lower($1)', [smurf]);
  res.json({ ok:true });
}));

// Promover o quitar admin a un jugador registrado (solo admin).
app.post('/api/admin/set-admin', auth, requireAdmin, wrap(async (req,res) => {
  const riotid = ((req.body && req.body.riotid) || '').trim();
  const makeAdmin = !!(req.body && req.body.admin);
  if (!riotid) return res.status(400).json({ error:'Falta riotid' });
  const u = await q1('SELECT id, is_admin FROM users WHERE riotid=$1', [riotid]);
  if (!u) return res.status(400).json({ error:'Ese jugador no tiene cuenta registrada' });
  if (!makeAdmin && u.id === req.user.id) return res.status(400).json({ error:'No puedes quitarte el admin a ti mismo' });
  await q('UPDATE users SET is_admin=$1 WHERE id=$2', [makeAdmin, u.id]);
  res.json({ ok:true, isAdmin: makeAdmin });
}));

// Resetear la contraseña de un jugador a una temporal (solo admin). No usa correo:
// devuelve la contraseña generada para que el admin se la pase al jugador, que luego
// puede cambiarla desde su perfil.
app.post('/api/admin/reset-password', auth, requireAdmin, wrap(async (req,res) => {
  const riotid = ((req.body && req.body.riotid) || '').trim();
  if (!riotid) return res.status(400).json({ error:'Falta riotid' });
  const u = await q1('SELECT id, email FROM users WHERE riotid=$1', [riotid]);
  if (!u) return res.status(400).json({ error:'Ese jugador no tiene cuenta registrada' });
  const temp = Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(temp, 10), u.id]);
  res.json({ ok:true, email: u.email, password: temp });
}));

// Eliminar un jugador del ranking POR COMPLETO: borra su perfil registrado (y datos
// asociados), lo saca del roster manual y lo agrega a roster_hidden para que el runner
// lo excluya aunque esté en la lista fija de RIOT_IDS.
app.post('/api/admin/player/remove', auth, requireAdmin, wrap(async (req,res) => {
  const riotid = ((req.body && req.body.riotid) || '').trim();
  if (!riotid) return res.status(400).json({ error:'Falta riotid' });
  if (ADMIN_RIDS.has(riotid)) return res.status(400).json({ error:'No se puede eliminar a un administrador' });
  const u = await q1('SELECT id FROM users WHERE riotid=$1', [riotid]);
  if (u){
    await q('DELETE FROM events        WHERE user_id=$1', [u.id]);
    await q('DELETE FROM shells        WHERE owner_id=$1', [u.id]);
    await q('DELETE FROM tickets       WHERE user_id=$1', [u.id]);
    await q('DELETE FROM verifications WHERE user_id=$1', [u.id]);
    await q('DELETE FROM users         WHERE id=$1', [u.id]);
  }
  await q('DELETE FROM roster WHERE riotid=$1', [riotid]);
  await q('INSERT INTO roster_hidden (riotid) VALUES ($1) ON CONFLICT (riotid) DO NOTHING', [riotid]);
  res.json({ ok:true });
}));

// ---- Estadísticas globales del torneo (TOPS / ELO / COINCIDENCIAS) ----
// Todo se calcula desde match_participants (datos crudos de cada partida de cada
// jugador del torneo) + los ±LP guardados en fetch_cache. Cache 60s.
const STATS_CACHE = { at: 0, data: null };
app.get('/api/stats', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=90');   // Cloudflare lo sirve del borde (menos hits al origen)
  if (STATS_CACHE.data && Date.now() - STATS_CACHE.at < 90000) return res.json(STATS_CACHE.data);

  // ---- Identidad de CUENTA por PUUID (consolida renombres) + JUGADOR (dueño) ----
  // El puuid no cambia aunque cambie el Riot ID, así una cuenta renombrada cuenta como una sola.
  const snapPlayers = liveSnapshot().players || [];
  // rid (incluye nombres VIEJOS) -> acct(puuid), desde el historial crudo.
  const acctByRid = {};
  try { for (const r of await q("SELECT lower(riotid) rid, (array_agg(puuid ORDER BY game_end DESC NULLS LAST))[1] puuid FROM match_participants WHERE coalesce(puuid,'')<>'' GROUP BY 1")) acctByRid[r.rid] = r.puuid; } catch {}
  const acctOf = rid => acctByRid[rid] || rid;
  const metaByAcct = {};   // acct(puuid|rid) -> { nm, tier, high, pos, abs, rid }
  snapPlayers.forEach((p, i) => {
    const rid = (p.rid || '').toLowerCase(); const acct = acctByRid[rid] || p.puuid || rid;   // mismo acct que las agregaciones
    const high = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(p.tier);
    if (!metaByAcct[acct]) metaByAcct[acct] = { nm: p.nm || rid.split('#')[0], tier: p.tier || 'UNRANKED', high, pos: i + 1, abs: absLPof(p.tier, p.div, p.lp) || 0, rid };
  });
  // Jugador (dueño) por cuenta: main + smurfs registrados → user id; + nick del jugador.
  const puuidOwner = {}, ownerNick = {};
  try {
    for (const u of await q("SELECT id, nickname, lower(riotid) rid FROM users WHERE coalesce(riotid,'')<>''")){ puuidOwner[acctOf(u.rid)] = 'u' + u.id; ownerNick['u' + u.id] = (u.nickname || '').trim(); }
    for (const s of await q("SELECT user_id, lower(riotid) rid FROM smurfs WHERE coalesce(riotid,'')<>''")) puuidOwner[acctOf(s.rid)] = 'u' + s.user_id;
  } catch {}
  const playerOf = acct => puuidOwner[acct] || acct;   // jugador (dueño) del acct
  // Excluir de TOPS las cuentas secundarias de un jugador (solo cuenta la más alta).
  const ownerAccts = {};
  for (const acct in puuidOwner) (ownerAccts[puuidOwner[acct]] = ownerAccts[puuidOwner[acct]] || []).push(acct);
  const excludeAcct = new Set();
  for (const o in ownerAccts){ const accts = [...new Set(ownerAccts[o])]; if (accts.length < 2) continue;
    accts.sort((a, b) => ((metaByAcct[b] && metaByAcct[b].abs) || 0) - ((metaByAcct[a] && metaByAcct[a].abs) || 0));
    accts.slice(1).forEach(a => excludeAcct.add(a)); }

  // ---- TOPS: agregado por CUENTA (consolidada por puuid) ----
  // CS/min excluye el rol support (UTILITY). Kills/muertes/asistencias van PROMEDIADAS por partida.
  const NS = "upper(coalesce(position,'')) NOT IN ('UTILITY','SUPPORT')";  // "no support"
  const ACCT = "COALESCE(NULLIF(puuid,''), lower(riotid))";
  const agg = await q(`
    SELECT ${ACCT} acct,
           (array_agg(lower(riotid) ORDER BY game_end DESC NULLS LAST))[1] rid,
           (array_agg(name       ORDER BY game_end DESC NULLS LAST))[1] nm,
           sum(coalesce(kills,0)) k, sum(coalesce(deaths,0)) d, sum(coalesce(assists,0)) a, count(*) games,
           sum(coalesce(gold,0)) gold_sum, sum(coalesce(duration,0)) dur_all,
           sum(coalesce(cs,0))       FILTER (WHERE ${NS}) cs_ns,
           sum(coalesce(duration,0)) FILTER (WHERE ${NS}) dur_ns,
           count(*)                  FILTER (WHERE ${NS}) games_ns
    FROM match_participants
    WHERE is_tournament=true AND riotid IS NOT NULL
    GROUP BY ${ACCT}`);
  const rowsA = agg.filter(r => !excludeAcct.has(r.acct)).map(r => {
    const m = metaByAcct[r.acct] || {};
    const k = +r.k, d = +r.d, a = +r.a, games = +r.games;
    const csNs = +r.cs_ns || 0, durNs = +r.dur_ns || 0, gamesNs = +r.games_ns || 0, durAll = +r.dur_all || 0;
    return { rid: m.rid || r.rid, nm: m.nm || r.nm, tier: m.tier || 'UNRANKED', high: !!m.high, pos: m.pos || null, games, gamesNs,
      kavg: games ? k / games : 0, davg: games ? d / games : 0, aavg: games ? a / games : 0,
      csmin: durNs > 0 ? csNs / (durNs / 60) : 0, goldmin: durAll > 0 ? (+r.gold_sum) / (durAll / 60) : 0,
      kda: (k + a) / Math.max(1, d) };
  });
  const topN = (key, n = 5, minGames = 0, gf = 'games') => rowsA.filter(x => x[gf] >= minGames)
    .sort((x, y) => y[key] - x[key]).slice(0, n)
    .map(x => ({ rid: x.rid, nm: x.nm, tier: x.tier, high: x.high, pos: x.pos, games: x[gf], value: x[key] }));
  const tops = { kills: topN('kavg', 5, 10), deaths: topN('davg', 5, 10), assists: topN('aavg', 5, 10),
    csmin: topN('csmin', 5, 10, 'gamesNs'), goldmin: topN('goldmin', 5, 10), kda: topN('kda', 5, 10) };

  // ---- COINCIDENCIAS: verdugos + duelos (solo en equipos contrarios) ----
  // Identidad por CUENTA = puuid (consolida renombres) y por JUGADOR = dueño (main+smurfs).
  const encRows = await q(`
    SELECT match_id, ${ACCT} acct,
           (array_agg(lower(riotid) ORDER BY game_end DESC NULLS LAST))[1] rid,
           (array_agg(name       ORDER BY game_end DESC NULLS LAST))[1] nm,
           bool_or(win) win, max(team_id) team
    FROM match_participants
    WHERE is_tournament=true AND riotid IS NOT NULL
      AND match_id IN (SELECT match_id FROM match_participants WHERE is_tournament=true
                       GROUP BY match_id HAVING count(distinct ${ACCT}) >= 2)
    GROUP BY match_id, ${ACCT}`);
  const byMatch = {};
  for (const r of encRows) (byMatch[r.match_id] = byMatch[r.match_id] || []).push(r);
  const repRid = {}, repAcct = {};   // clave de jugador -> rid/acct representativo (para nick/tier/OP.GG)
  const verd = {}, duel = {};
  let coincCount = 0;
  for (const mid in byMatch) {
    const ps = byMatch[mid]; if (ps.length < 2) continue; coincCount++;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const A = ps[i], B = ps[j];
      const pa = playerOf(A.acct), pb = playerOf(B.acct);
      if (pa === pb) continue;   // dos cuentas de la misma persona: no es dúo ni duelo
      if (!repRid[pa]){ repRid[pa] = A.rid; repAcct[pa] = A.acct; }
      if (!repRid[pb]){ repRid[pb] = B.rid; repAcct[pb] = B.acct; }
      const key = [pa, pb].sort(); const kk = key.join('|');
      const dd = duel[kk] || (duel[kk] = { a: key[0], b: key[1], aw: 0, bw: 0, together: 0, tw: 0 });
      if (A.team === B.team) { dd.together++; if (A.win) dd.tw++; continue; }   // aliados (dúo): guarda V/D juntos
      const dec = A.win !== B.win; if (!dec) continue;         // debe haber ganador/perdedor
      const winner = A.win ? A : B; const wKey = playerOf(winner.acct);
      verd[pa] = verd[pa] || { wins: 0, duels: 0 }; verd[pb] = verd[pb] || { wins: 0, duels: 0 };
      verd[pa].duels++; verd[pb].duels++; verd[wKey].wins++;
      if (wKey === dd.a) dd.aw++; else dd.bw++;
    }
  }
  // Meta de un JUGADOR: nick del registrado (o nombre de la cuenta si no está registrada) + tier/high.
  const pmeta = pkey => { const rid = repRid[pkey] || pkey; const m = metaByAcct[repAcct[pkey]] || {};
    return { rid, nm: ownerNick[pkey] || m.nm || rid.split('#')[0], high: !!m.high }; };
  const verdugos = Object.entries(verd).map(([pkey, s]) => ({ ...pmeta(pkey), wins: s.wins, duels: s.duels,
      wr: s.duels ? Math.round(s.wins / s.duels * 100) : 0 }))
    .sort((a, b) => b.wins - a.wins || b.wr - a.wr).slice(0, 12);
  const duelos = Object.values(duel).filter(d => d.aw + d.bw > 0)
    .map(d => ({ a: pmeta(d.a), b: pmeta(d.b), aw: d.aw, bw: d.bw, together: d.together }))
    .sort((x, y) => (y.aw + y.bw) - (x.aw + x.bw)).slice(0, 30);

  // Mejores / peores dúos: parejas que jugaron en el MISMO equipo (mín. 2 partidas).
  // No se ordena por winrate crudo (un 2-0 = 100% no vale más que un 11-4 = 73%), sino por el
  // INTERVALO DE WILSON, que castiga las muestras chicas: los mejores por su cota INFERIOR (desc)
  // y los peores por su cota SUPERIOR (asc). z alto => el nº de partidas pesa más que el % crudo.
  const MINDUO = 2, WZ = 2.5;
  const wilson = (w, n, upper) => {
    if (!n) return upper ? 1 : 0;
    const p = w / n, z2 = WZ * WZ;
    const centre = p + z2 / (2 * n);
    const margin = WZ * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return (centre + (upper ? margin : -margin)) / (1 + z2 / n);
  };
  const duosAll = Object.values(duel).filter(d => d.together >= MINDUO)
    .map(d => ({ a: pmeta(d.a), b: pmeta(d.b), games: d.together, wins: d.tw, wr: Math.round(d.tw / d.together * 100),
      lo: wilson(d.tw, d.together, false), hi: wilson(d.tw, d.together, true) }));
  const duosBest = duosAll.slice().sort((x, y) => y.lo - x.lo || y.games - x.games).slice(0, 8);
  const duosWorst = duosAll.slice().sort((x, y) => x.hi - y.hi || y.games - x.games).slice(0, 8);

  // ---- CONTRINCANTES externos: rivales AJENOS al torneo, por victorias/derrotas nuestras ----
  // Cada partida guardada trae los 10 jugadores; los que NO son del torneo son "contrincantes".
  // Si su equipo perdió, nosotros les ganamos (w++); si ganó, nos ganaron (l++).
  const partRows = await q(`
    SELECT match_id, team_id, puuid, max(name) nm, max(lower(riotid)) rid, bool_or(win) win, bool_or(is_tournament) is_t
    FROM match_participants WHERE coalesce(puuid,'')<>'' GROUP BY match_id, team_id, puuid`);
  const tournPuuids = new Set(), teamHasTourn = {};
  for (const r of partRows) if (r.is_t){ tournPuuids.add(r.puuid); (teamHasTourn[r.match_id] = teamHasTourn[r.match_id] || {})[r.team_id] = true; }
  const opp = {};   // puuid contrincante -> { nm, rid, w, l }
  for (const r of partRows){
    if (tournPuuids.has(r.puuid)) continue;                 // es del torneo, no es contrincante externo
    const tt = teamHasTourn[r.match_id]; if (!tt) continue;
    const oppTeam = r.team_id === 100 ? 200 : 100;
    if (!tt[oppTeam]) continue;                              // no hubo alguien del torneo enfrentándolo
    const o = opp[r.puuid] || (opp[r.puuid] = { nm: r.nm, rid: r.rid, w: 0, l: 0 });
    if (r.nm) o.nm = r.nm; if (r.rid) o.rid = r.rid;
    if (r.win) o.l++; else o.w++;                            // ganó el contrincante => perdimos nosotros
  }
  const oppArr = Object.values(opp).filter(o => (o.w + o.l) >= 2);   // solo rivales enfrentados ≥2 veces
  // Mejores: más victorias; en empate, primero al que MENOS le hemos perdido.
  const rivalesBest  = oppArr.slice().sort((a, b) => b.w - a.w || a.l - b.l).slice(0, 15);
  // Peores: más derrotas; en empate, primero al que MENOS le hemos ganado.
  const rivalesWorst = oppArr.slice().sort((a, b) => b.l - a.l || a.w - b.w).slice(0, 15);

  // Historial de coincidencias: el snapshot en vivo ya trae las últimas 60.
  const historial = liveSnapshot().encounters || [];

  // ---- ELO: subidones/bajones por día + serie de evolución (desde ±LP guardados) ----
  // El caché de ±LP ya está keyeado por puuid (consolidado por cuenta); la meta también.
  let store = (await matchesBlob()) || {};   // disco local del runner o Supabase cacheado 60s (anti-egress)
  // Partidas guardadas por cuenta (win/loss). Riot NO da el LP histórico, así que la curva se
  // reconstruye desde aquí: LP exacto donde el runner lo capturó (lpGames), estimado por V/D si no.
  const gamesByPuuid = {};
  for (const g of await q("SELECT puuid, game_end, win FROM match_participants WHERE is_tournament=true AND coalesce(puuid,'')<>'' AND game_end IS NOT NULL ORDER BY game_end ASC"))
    (gamesByPuuid[g.puuid] = gamesByPuuid[g.puuid] || []).push({ t: Number(g.game_end), win: !!g.win });
  const dayAcc = {}, series = [];
  const dayKey = t => new Date((t || 0) - 4 * 3600 * 1000).toISOString().slice(0, 10);  // día en Chile (UTC-4 aprox)
  for (const puuid in store) {
    if (excludeAcct.has(puuid)) continue;   // solo la cuenta más alta de cada jugador (excluye smurfs)
    const m = metaByAcct[puuid]; if (!m) continue;
    const rid = m.rid || puuid;
    const s = store[puuid]; const lg = (s && Array.isArray(s.lpGames) ? s.lpGames : []).filter(g => g.end);
    const deltaByEnd = {}; lg.forEach(g => { deltaByEnd[g.end] = g.delta || 0; });
    const known = lg.map(g => Math.abs(g.delta || 0)).filter(x => x > 0).sort((a, b) => a - b);
    const STEP = known.length ? known[Math.floor(known.length / 2)] : 20;   // paso estimado (mediana de |Δ| conocidos)
    const gs = gamesByPuuid[puuid] || [];
    // Δ por partida: exacto si lo capturamos, si no estimado por victoria/derrota.
    const perGame = gs.map(g => ({ t: g.t, delta: (g.t in deltaByEnd) ? deltaByEnd[g.t] : (g.win ? STEP : -STEP) }));
    const useGames = perGame.length ? perGame : lg.map(g => ({ t: g.end, delta: g.delta || 0 }));
    // Serie: reconstruye absLP hacia atrás desde el actual.
    if (m.abs != null && useGames.length) {
      let abs = m.abs; const pts = [{ t: Date.now(), lp: abs }];
      for (let k = useGames.length - 1; k >= 0; k--) { abs -= useGames[k].delta; pts.push({ t: useGames[k].t, lp: Math.max(0, abs) }); }
      series.push({ rid, nm: m.nm, high: !!m.high, points: pts.reverse() });
    }
    // Subidones/bajones: neto por día.
    for (const g of useGames) { const dk = dayKey(g.t); const key = rid + '|' + dk;
      (dayAcc[key] = dayAcc[key] || { rid, nm: m.nm, high: !!m.high, day: dk, net: 0 }).net += (g.delta || 0); }
  }
  const days = Object.values(dayAcc);
  const subidones = days.filter(d => d.net > 0).sort((a, b) => b.net - a.net).slice(0, 8);
  const bajones = days.filter(d => d.net < 0).sort((a, b) => a.net - b.net).slice(0, 8);

  // Elo PROMEDIO de todo el ranking en el tiempo: en cada día se toma el elo (absLP) de
  // cada jugador vigente ese día (último punto conocido ≤ día) y se promedian.
  let avgSeries = [];
  if (series.length){
    const sers = series.map(s => s.points.slice().sort((a, b) => a.t - b.t));
    let tMin = Infinity, tMax = -Infinity;
    sers.forEach(pts => pts.forEach(p => { if (p.t < tMin) tMin = p.t; if (p.t > tMax) tMax = p.t; }));
    const DAY = 86400000, start = Math.floor(tMin / DAY) * DAY;
    for (let t = start; t <= tMax + DAY; t += DAY){
      let sum = 0, n = 0;
      for (const pts of sers){ let val = null; for (const p of pts){ if (p.t <= t) val = p.lp; else break; } if (val != null){ sum += val; n++; } }
      if (n) avgSeries.push({ t, lp: Math.round(sum / n), n });
    }
  }

  STATS_CACHE.data = { tops, elo: { subidones, bajones, series, avgSeries }, coincidencias: { count: coincCount, verdugos, duelos, duosBest, duosWorst, historial }, contrincantes: { best: rivalesBest, worst: rivalesWorst } };
  STATS_CACHE.at = Date.now();
  res.json(STATS_CACHE.data);
}));

// ---- Encuentros (aliados Y rivales) desde match_participants ----
// Se reconstruye del historial COMPLETO guardado (no de la ventana de 20 partidas en
// memoria), así se detectan también los cruces como rivales, no solo los dúos. SoloQ.
const ENC_CACHE = { at: 0, data: null };
app.get('/api/encounters', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=90');   // Cloudflare lo sirve del borde
  if (ENC_CACHE.data && Date.now() - ENC_CACHE.at < 90000) return res.json(ENC_CACHE.data);
  // Nickname del torneo por cuenta (para mostrar el nick, no el summoner name).
  const meta = {};
  (liveSnapshot().players || []).forEach(p => { meta[(p.rid || '').toLowerCase()] = p.nm || (p.rid || '').split('#')[0]; });
  const rows = await q(`
    SELECT match_id, lower(riotid) rid, max(name) nm, bool_or(win) win,
           max(team_id) team, max(champion) champ, max(game_end) gend
    FROM match_participants
    WHERE is_tournament=true AND riotid IS NOT NULL
      AND match_id IN (SELECT match_id FROM match_participants WHERE is_tournament=true
                       GROUP BY match_id HAVING count(distinct lower(riotid)) >= 2)
    GROUP BY match_id, lower(riotid)`);
  const byMatch = {};
  for (const r of rows) (byMatch[r.match_id] = byMatch[r.match_id] || []).push(r);
  const encounters = Object.entries(byMatch).map(([id, ps]) => ({
    id, end: Math.max(...ps.map(p => Number(p.gend) || 0)),
    players: ps.map(p => ({ nm: meta[p.rid] || p.nm, rid: p.rid, win: !!p.win, champ: p.champ || null })),
  })).filter(e => e.players.length >= 2)
    .sort((a, b) => (b.end || 0) - (a.end || 0)).slice(0, 400);   // historial completo (antes se cortaba en 100)
  ENC_CACHE.data = { encounters };
  ENC_CACHE.at = Date.now();
  res.json(ENC_CACHE.data);
}));

// ---- RÉCORDS: extremos de una sola partida (+ rachas de V/D) ----
const RECORDS_CACHE = { at: 0, data: null };
app.get('/api/records', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=90');
  if (RECORDS_CACHE.data && Date.now() - RECORDS_CACHE.at < 90000) return res.json(RECORDS_CACHE.data);
  // puuid -> Riot ID actual + nick (para OP.GG correcto aunque la cuenta se haya renombrado).
  const players = liveSnapshot().players || [];
  const ridByPuuid = {}, nickByRid = {};
  players.forEach(p => { if (p.puuid) ridByPuuid[p.puuid] = p.rid; nickByRid[(p.rid || '').toLowerCase()] = p.nm; });
  const N = 5;
  const K='coalesce(kills,0)', D='coalesce(deaths,0)', A='coalesce(assists,0)', CS='coalesce(cs,0)', DUR='coalesce(duration,0)', VIS='coalesce(vision,0)';
  const cols = `name, lower(riotid) rid, puuid, champion, match_id, ${K} k, ${D} d, ${A} a, ${CS} cs, ${DUR} dur, ${VIS} vis`;
  const base = `FROM match_participants WHERE is_tournament=true AND coalesce(puuid,'')<>''`;
  const kda = `(${K}+${A})::float/GREATEST(${D},1)`;
  const topBy = order => q(`SELECT ${cols} ${base} ORDER BY ${order} LIMIT ${N}`);
  const [kdaBest, kdaWorst, cs, dur, kills, deaths, assists, vision] = await Promise.all([
    topBy(`${kda} DESC, ${D} ASC, (${K}+${A}) DESC`),     // KDA+: mayor; empate -> menos muertes
    topBy(`${kda} ASC, ${D} DESC, (${K}+${A}) ASC`),      // KDA-: menor; empate -> más muertes
    topBy(`${CS} DESC`), topBy(`${DUR} DESC`), topBy(`${K} DESC`), topBy(`${D} DESC`), topBy(`${A} DESC`), topBy(`${VIS} DESC`),
  ]);
  const map = r => { const rid = ridByPuuid[r.puuid] || r.rid;
    return { nm: nickByRid[(rid || '').toLowerCase()] || r.name || (r.rid || '').split('#')[0], rid, matchId: r.match_id,
      champ: r.champion, k:+r.k, d:+r.d, a:+r.a, kda:+(((+r.k) + (+r.a)) / Math.max(1, +r.d)).toFixed(2),
      cs:+r.cs, durMin: Math.round((+r.dur) / 60), vis:+r.vis }; };
  // Rachas de victorias/derrotas por cuenta (consecutivas en el tiempo); dedup por jugador (máx).
  const gs = await q(`SELECT puuid, win, game_end ${base} AND game_end IS NOT NULL ORDER BY puuid, game_end ASC`);
  const byP = {}; gs.forEach(r => (byP[r.puuid] = byP[r.puuid] || []).push(!!r.win));
  const wmax = {}, lmax = {};
  for (const puuid in byP){ let cw=0, cl=0, mw=0, ml=0;
    byP[puuid].forEach(w => { if (w){ cw++; cl=0; } else { cl++; cw=0; } if (cw>mw) mw=cw; if (cl>ml) ml=cl; });
    const rid = ridByPuuid[puuid]; const nm = rid ? (nickByRid[(rid||'').toLowerCase()] || rid.split('#')[0]) : null;
    if (!nm) continue;
    if (mw > (wmax[nm]||0)) wmax[nm]=mw; if (ml > (lmax[nm]||0)) lmax[nm]=ml;
  }
  const streaks = obj => Object.entries(obj).filter(([,v]) => v>=2).map(([nm,value]) => ({ nm, value })).sort((a,b) => b.value-a.value).slice(0, N);
  RECORDS_CACHE.data = { kdaBest: kdaBest.map(map), kdaWorst: kdaWorst.map(map), cs: cs.map(map), duration: dur.map(map),
    kills: kills.map(map), deaths: deaths.map(map), assists: assists.map(map), vision: vision.map(map),
    winStreak: streaks(wmax), loseStreak: streaks(lmax) };
  RECORDS_CACHE.at = Date.now();
  res.json(RECORDS_CACHE.data);
}));

// Admin: quién está usando el overlay (desde overlay_reports — cada overlay con LoL abierto
// reporta ~1/min). min_ago pequeño = lo tiene corriendo ahora.
app.get('/api/admin/overlay-usage', auth, requireAdmin, wrap(async (_req, res) => {
  const rows = await q(`SELECT riotid, in_game,
     round(EXTRACT(EPOCH FROM (now()-updated_at))/60)::int AS min_ago
     FROM overlay_reports ORDER BY updated_at DESC`);
  res.json(rows.map(r => ({ riotid: r.riotid, inGame: !!r.in_game, minAgo: Number(r.min_ago) })));
}));

// Health-check ultra liviano (para UptimeRobot / monitoreo): responde "ok" sin tocar la DB.
app.get('/ping', (_req, res) => res.type('text').send('ok'));

// ---- Sitio estático ----
app.use(express.static(ROOT, {
  setHeaders(res, filePath){
    // players.json/js cacheables ~20s: Cloudflare sirve la mayoría de los polls desde el
    // borde (1 fetch al origen cada ~20s en vez de 1 por cliente) → baja mucho la banda.
    // El ranking igual se actualiza cada ~2 min, así que ~20s de "atraso" es imperceptible.
    if (/players\.json$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=20');
    else if (/players\.js$/.test(filePath)) res.setHeader('Cache-Control', 'no-store');   // carga inicial: siempre fresca
  }
}));

// ---- Runner embebido (opcional) ----
// Si RIOT_API_KEY está en el entorno, el propio server actualiza el ranking
// corriendo fetch-data.js cada INTERVAL_SEC (por defecto 120s). Así NO hace
// falta correr el runner en un PC: todo vive en la nube. La key nunca se
// expone al navegador (solo la usa el proceso del server).
function startEmbeddedRunner(){
  if (!process.env.RIOT_API_KEY) return;
  const { spawn } = require('child_process');
  const INTERVAL = (Number(process.env.INTERVAL_SEC) || 120) * 1000;
  const CACHE_DIR = path.join(ROOT, 'cache');
  const CACHE_FILES = { puuids:'puuids.json', ranks:'ranks.json', matches:'matches.json', encounters:'encounters.json', regions:'regions.json', positions:'positions.json', ddragon:'ddragon.json' };
  // Escribe roster-extra.json (cuentas agregadas por el admin) para que fetch-data las incluya.
  const writeRoster = async () => {
    // Cuentas a trackear: mains de jugadores REGISTRADOS + sus smurfs + roster manual (admin).
    try {
      const us   = await q("SELECT riotid FROM users  WHERE coalesce(riotid,'')<>''");
      const rows = await q('SELECT riotid FROM roster ORDER BY created_at');
      const sm   = await q('SELECT riotid FROM smurfs ORDER BY id');
      const all  = [...new Set([...us.map(r=>r.riotid), ...rows.map(r=>r.riotid), ...sm.map(r=>r.riotid)])];
      fs.writeFileSync(path.join(ROOT, 'roster-extra.json'), JSON.stringify(all));
    } catch {}
    try { const hid = await q('SELECT riotid FROM roster_hidden');
      fs.writeFileSync(path.join(ROOT, 'roster-removed.json'), JSON.stringify(hid.map(r=>r.riotid))); } catch {}
    // Reportes frescos del overlay (últimos 10 min): el runner los usa para saltarse llamadas a Riot.
    try {
      const reps = await q("SELECT riotid, entry, in_game, (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS at FROM overlay_reports WHERE updated_at > now() - interval '10 minutes'");
      const obj = {}; reps.forEach(r => { obj[r.riotid] = { entry:r.entry, inGame:r.in_game, at:Number(r.at) }; });
      fs.writeFileSync(path.join(ROOT, 'overlay-reports.json'), JSON.stringify(obj));
    } catch {}
  };

  // El caché (PUUIDs, rangos y sobre todo el historial ±LP/aegis) se guarda en
  // Postgres para que sobreviva los reinicios/redeploys de Render (disco efímero).
  const loadCache = async () => {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive:true });
    for (const [id, file] of Object.entries(CACHE_FILES)){
      try { const row = await q1('SELECT data FROM fetch_cache WHERE id=$1', [id]);
        if (row && row.data) fs.writeFileSync(path.join(CACHE_DIR, file), JSON.stringify(row.data)); } catch {}
    }
    await mergeSeed();
  };
  // Semilla permanente (fetch_seed): el runner NUNCA la sobrescribe. Se fusiona en
  // el caché en cada arranque para restaurar el historial ±LP/aegis inicial. La
  // fusión es idempotente (dedup por 'end'/'id') y los datos viejos caen solos
  // cuando entran 40 partidas nuevas más recientes.
  const mergeSeed = async () => {
    let seed; try { const r = await q1("SELECT data FROM fetch_seed WHERE id='matches'"); seed = r && r.data; } catch { return; }
    if (seed){
      const file = path.join(CACHE_DIR, CACHE_FILES.matches);
      let cur = {}; try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      for (const puuid in seed){
        const s = seed[puuid] || {};
        const c = cur[puuid] || (cur[puuid] = { games:[], lpGames:[], lastAbsLP:null });
        // Une el seed (línea base) con lo YA acumulado, sin perder partidas (dedup por end+delta).
        const seen = new Set(), merged = [];
        for (const g of [...(c.lpGames || []), ...(s.lpGames || [])]){
          if (!g || g.end == null) continue;
          const k = g.end + '|' + (g.delta || 0);
          if (seen.has(k)) continue; seen.add(k); merged.push(g);
        }
        merged.sort((a, b) => (a.end || 0) - (b.end || 0));
        c.lpGames = merged.slice(-80);   // conserva las 80 más recientes
        if (c.lastAbsLP == null && s.lastAbsLP != null) c.lastAbsLP = s.lastAbsLP;
        if ((!c.games || !c.games.length) && s.games) c.games = s.games;
      }
      fs.writeFileSync(file, JSON.stringify(cur));
    }
    try {   // sembrar puuids que falten (evita re-resolver contra Riot)
      const pr = await q1("SELECT data FROM fetch_seed WHERE id='puuids'");
      if (pr && pr.data){
        const pf = path.join(CACHE_DIR, CACHE_FILES.puuids);
        let pcur = {}; try { pcur = JSON.parse(fs.readFileSync(pf,'utf8')); } catch {}
        for (const k in pr.data) if (!pcur[k]) pcur[k] = pr.data[k];
        fs.writeFileSync(pf, JSON.stringify(pcur));
      }
    } catch {}
  };
  const saveCache = async () => {
    for (const [id, file] of Object.entries(CACHE_FILES)){
      try { const raw = fs.readFileSync(path.join(CACHE_DIR, file), 'utf8');
        await q('INSERT INTO fetch_cache (id,data,updated_at) VALUES ($1,$2::jsonb,now()) ON CONFLICT (id) DO UPDATE SET data=$2::jsonb, updated_at=now()', [id, raw]); } catch {}
    }
  };
  const runOnce = () => new Promise(res => {
    const p = spawn(process.execPath, [path.join(ROOT, 'fetch-data.js')], { cwd: ROOT, env: process.env, stdio: 'inherit' });
    p.on('exit', () => res()); p.on('error', () => res());
  });

  console.log(`▶ Runner embebido activo — actualiza el ranking cada ${INTERVAL / 1000}s`);
  (async () => {
    // Muestra de inmediato el ÚLTIMO ranking bueno (guardado en DB), para no servir el
    // players.json viejo del repo durante los ~2-3 min del primer ciclo tras un redeploy.
    try { const row = await q1("SELECT data FROM fetch_cache WHERE id='players'"); if (row && row.data) liveData = row.data; } catch {}
    await loadCache();   // restaura el historial ±LP/aegis persistido
    for (;;){
      const t = Date.now();
      try {
        await writeRoster(); await runOnce(); await saveCache();
        liveData = JSON.parse(fs.readFileSync(path.join(ROOT, 'players.json'), 'utf8'));
        // Persiste el ranking recién construido para el próximo arranque (redeploy sin ranking viejo).
        try { await q("INSERT INTO fetch_cache (id,data,updated_at) VALUES ('players',$1::jsonb,now()) ON CONFLICT (id) DO UPDATE SET data=$1::jsonb, updated_at=now()", [JSON.stringify(liveData)]); } catch {}
      }
      catch (e){ console.error('Runner embebido:', e.message); }
      await new Promise(r => setTimeout(r, Math.max(0, INTERVAL - (Date.now() - t))));
    }
  })();
}

// ---- Auto-detección de cambios de nombre (renames) ----
// El PUUID de una cuenta de Riot NO cambia aunque el jugador cambie su Riot ID. Cada ~30 min
// consultamos el nombre actual de cada cuenta registrada por su puuid y, si cambió, actualizamos
// el Riot ID guardado (jugadores, smurfs, roster y equipos). El historial ya se consolida por puuid.
async function accountByPuuid(puuid, KEY){
  try {
    const r = await fetch(`https://americas.api.riotgames.com/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`, { headers: { 'X-Riot-Token': KEY } });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.gameName) ? (j.gameName + '#' + j.tagLine) : null;
  } catch { return null; }
}
async function applyRename(w, newRid){
  const oldRid = w.rid;
  try {
    if (w.kind === 'user')   await q('UPDATE users  SET riotid=$1 WHERE id=$2', [newRid, w.id]);
    if (w.kind === 'smurf')  await q('UPDATE smurfs SET riotid=$1 WHERE id=$2', [newRid, w.id]);
    if (w.kind === 'roster') await q('UPDATE roster SET riotid=$1 WHERE lower(riotid)=lower($2)', [newRid, oldRid]);
    // Equipos: mueve las filas al nombre nuevo evitando choque de PK (riotid,team).
    await q('DELETE FROM team_members WHERE lower(riotid)=lower($1) AND team IN (SELECT team FROM team_members WHERE lower(riotid)=lower($2))', [newRid, oldRid]);
    await q('UPDATE team_members SET riotid=$1 WHERE lower(riotid)=lower($2)', [newRid, oldRid]);
    console.log(`↻ rename detectado: ${oldRid} → ${newRid} (${w.kind})`);
  } catch (e){ console.error('applyRename:', e.message); }
}
async function detectRenames(){
  const KEY = process.env.RIOT_API_KEY; if (!KEY) return;
  const watch = [];
  for (const u of await q("SELECT id, riotid FROM users  WHERE coalesce(riotid,'')<>''")) watch.push({ kind:'user',   id:u.id, rid:u.riotid });
  for (const s of await q("SELECT id, riotid FROM smurfs WHERE coalesce(riotid,'')<>''")) watch.push({ kind:'smurf',  id:s.id, rid:s.riotid });
  for (const r of await q("SELECT riotid    FROM roster WHERE coalesce(riotid,'')<>''")) watch.push({ kind:'roster',          rid:r.riotid });
  // puuid por rid desde el historial crudo (sin gastar llamadas a Riot para resolver).
  const rid2puuid = {};
  for (const r of await q("SELECT lower(riotid) rid, (array_agg(puuid ORDER BY game_end DESC NULLS LAST))[1] puuid FROM match_participants WHERE coalesce(puuid,'')<>'' GROUP BY 1")) rid2puuid[r.rid] = r.puuid;
  for (const w of watch){
    const puuid = rid2puuid[(w.rid || '').toLowerCase()]; if (!puuid) continue;
    const cur = await accountByPuuid(puuid, KEY);
    await new Promise(r => setTimeout(r, 120));   // suave con el rate limit de Riot
    if (!cur) continue;
    if (cur.toLowerCase() === (w.rid || '').toLowerCase()) continue;   // sin cambios
    await applyRename(w, cur);
  }
}

init()
  .then(() => app.listen(PORT, () => {
    console.log(`✔ Backend + web en http://localhost:${PORT}`);
    loadChampions();
    startEmbeddedRunner();
    // Detección automática de cumplimiento de castigos (cada 3 min) si hay Riot key.
    if (process.env.RIOT_API_KEY){
      const check = () => runCheck({ q, KEY: process.env.RIOT_API_KEY, champTags: CHAMP_TAGS }).catch(e => console.error('checker:', e.message));
      setTimeout(check, 20000);
      setInterval(check, 180000);
      // Otorga Blue Shells automáticamente por logros en SoloQ (cada GRANTER_SEC, 5 min por defecto).
      const grant = () => runGrant({ q, KEY: process.env.RIOT_API_KEY }).catch(e => console.error('granter:', e.message));
      const GRANT_MS = (Number(process.env.GRANTER_SEC) || 300) * 1000;
      setTimeout(grant, 45000);
      setInterval(grant, GRANT_MS);
      // Auto-detección de cambios de nombre (cada 30 min).
      const renames = () => detectRenames().catch(e => console.error('renames:', e.message));
      setTimeout(renames, 90000);
      setInterval(renames, 30 * 60 * 1000);
    }
  }))
  .catch(e => { console.error('❌ No se pudo conectar a la base de datos:', e.message); process.exit(1); });
