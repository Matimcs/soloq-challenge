/* ============================================================
   server.js — Backend del SoloQ Challenge (Express + Postgres)
   Sirve la web estática + API REST. Auth con JWT + bcrypt.
   Requiere:  DATABASE_URL  (Postgres/Supabase)
   Uso:  DATABASE_URL=... node server.js
   ============================================================ */
const path = require('path');
const crypto = require('crypto');
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
// rid (incl. nombres viejos) -> puuid, desde match_participants. Mapa GRANDE (~13k filas) y ESTABLE
// (solo cambia al entrar cuentas nuevas), pero se reconstruía en CADA rebuild de stats/encuentros/
// records y en el detector de renombres → era ~11.6M filas de egress. Cacheado 10 min en memoria.
let _ridPuuid = { at: 0, data: null };
async function ridPuuidMap(){
  if (_ridPuuid.data && Date.now() - _ridPuuid.at < 600000) return _ridPuuid.data;
  const m = {};
  // Solo las cuentas que alguien consulta (torneo, usuarios, smurfs, roster). Antes traía TODOS los rivales
  // que alguna vez aparecieron (~27 mil filas, 2,5 MB por lectura): era la mayor fuente de egress de Supabase.
  try { for (const r of await q(`SELECT lower(riotid) rid, (array_agg(puuid ORDER BY game_end DESC NULLS LAST))[1] puuid FROM match_participants
      WHERE coalesce(puuid,'')<>'' AND (is_tournament=true OR replace(lower(riotid),' ','') IN (
        SELECT replace(lower(riotid),' ','') FROM users  WHERE coalesce(riotid,'')<>'' UNION
        SELECT replace(lower(riotid),' ','') FROM smurfs WHERE coalesce(riotid,'')<>'' UNION
        SELECT replace(lower(riotid),' ','') FROM roster WHERE coalesce(riotid,'')<>''))
      GROUP BY 1`)) m[r.rid] = r.puuid; } catch {}
  _ridPuuid = { at: Date.now(), data: m };
  return m;
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
// gzip en el origen: Render cobra la banda que sale del servidor, y antes salía sin comprimir (Cloudflare
// comprimía recién hacia el visitante). JSON/HTML/JS bajan ~70-85%.
app.use(require('compression')({ threshold: 1024 }));
app.use(express.json({ limit: '8mb' }));
app.use((req,res,next)=>{ res.header('Access-Control-Allow-Origin','*'); res.header('Access-Control-Allow-Headers','Content-Type,Authorization'); res.header('Access-Control-Allow-Methods','GET,POST,OPTIONS'); if(req.method==='OPTIONS') return res.sendStatus(204); next(); });

const wrap = fn => (req,res) => fn(req,res).catch(e => { console.error(e); res.status(500).json({ error:'Error del servidor' }); });
const sign = u => jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: '30d' });
const TEAMS = new Set(['Exilium', 'Tide', 'Zenith', 'Hundred Blossom']);
const ROLES = new Set(['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT']);   // rol dentro del equipo (puede diferir del de SoloQ)
// El nombre real de los jugadores solo lo ven los admins: las rutas públicas lo omiten salvo que pida un admin.
const _admCache = new Map();
async function reqIsAdmin(req){
  const uid = await optionalUid(req); if (!uid) return false;
  const c = _admCache.get(uid); if (c && Date.now() - c.at < 300000) return c.v;
  let v = false; try { const u = await q1('SELECT is_admin FROM users WHERE id=$1', [uid]); v = !!(u && u.is_admin); } catch {}
  _admCache.set(uid, { at: Date.now(), v }); return v;
}
// Organización = jugadores con cuenta en users (todos los registrados hasta hoy + los que se inscriban por
// las vías permitidas). Las cuentas externas (ext_users) y los visitantes sin sesión NO son org: no ven lo sensible.
const _orgCache = new Map();
// ---- Smurfs: solo la org las ve ----
// Para visitantes y externos las cuentas smurf no existen: ni en el ranking, ni en estadísticas/récords, ni su ficha
// (aunque no dijeran de quién son, se podía deducir). SMURF_SET = Riot IDs normalizados (sin espacios, minúsculas).
const nrSmurf = r => String(r || '').toLowerCase().replace(/\s+/g, '');
let SMURF_SET = new Set();
async function loadSmurfSet(){
  const s = new Set();
  try { for (const r of await q("SELECT riotid r FROM smurfs WHERE coalesce(riotid,'')<>''")) s.add(nrSmurf(r.r)); } catch {}
  try { for (const r of await q("SELECT smurf_riotid r FROM smurf_links")) s.add(nrSmurf(r.r)); } catch {}
  if (s.size || !SMURF_SET.size) SMURF_SET = s;
  return SMURF_SET;
}
setTimeout(() => loadSmurfSet().catch(() => {}), 1000); setInterval(() => loadSmurfSet().catch(() => {}), 5 * 60 * 1000);
const isSmurf = rid => SMURF_SET.has(nrSmurf(rid));
// Saca de una respuesta (recursivamente) todo elemento de lista que nombre a una smurf en un campo de texto propio
// (Riot ID o enlace de OP.GG "nombre-tag").
function strHasSmurf(v){
  if (typeof v !== 'string' || v.length > 400 || !SMURF_SET.size) return false;
  let d = v; try { d = decodeURIComponent(v); } catch {}
  const n = nrSmurf(d);
  for (const sm of SMURF_SET) if (n.includes(sm) || n.includes(sm.replace('#', '-'))) return true;
  return false;
}
function stripSmurfs(x){
  if (Array.isArray(x)) return x.map(stripSmurfs).filter(it => !(it && typeof it === 'object' && !Array.isArray(it) && Object.values(it).some(strHasSmurf)));
  if (x && typeof x === 'object'){ const o = {}; for (const [k, v] of Object.entries(x)) o[k] = stripSmurfs(v); return o; }
  return x;
}
async function reqOrg(req){
  const uid = await optionalUid(req); if (!uid) return false;
  const c = _orgCache.get(uid); if (c && Date.now() - c.at < 300000) return c.v;
  let v = false; try { v = !!(await q1('SELECT 1 FROM users WHERE id=$1', [uid])); } catch {}
  _orgCache.set(uid, { at: Date.now(), v }); return v;
}
// Rutas solo para la org (análisis, encuentros, partidas guardadas). Nunca en la caché compartida de Cloudflare.
async function orgOnly(req, res, next){
  if (await reqOrg(req)){ res.set('CDN-Cache-Control', 'no-store'); return next(); }
  res.status(403).json({ error:'Solo para jugadores de la organización', orgOnly: true });
}
const signExt = x => jwt.sign({ xid: x.id }, JWT_SECRET, { expiresIn: '30d' });
const publicExt = x => ({ id: 'x' + x.id, external: true, email: x.email, nickname: x.nickname, riotid: x.riotid, realname: x.realname, university: x.university, avatar: x.avatar });
const publicUser = u => ({ id:u.id, email:u.email, nickname:u.nickname, realname:u.realname, riotid:u.riotid, main:u.main, discord:u.discord, pos1:u.pos1, pos2:u.pos2, avatar:u.avatar, champ1:u.champ1, champ2:u.champ2, champ3:u.champ3, flashSlot:u.flash_slot, team:u.team || null, confirmed: !!u.confirmed, isAdmin: !!u.is_admin });
async function auth(req,res,next){
  const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error:'No autenticado' });
  try { const { uid, xid } = jwt.verify(t, JWT_SECRET);
    if (xid && !uid) return res.status(403).json({ error:'Esto es solo para jugadores de la organización' });
    const u = await q1('SELECT * FROM users WHERE id=$1', [uid]);
    if (!u) return res.status(401).json({ error:'Sesión inválida' }); req.user = u; next(); }
  catch { return res.status(401).json({ error:'Sesión inválida' }); }
}
const requireAdmin = (req,res,next) => req.user.is_admin ? next() : res.status(403).json({ error:'Solo admin' });

// ---- Inscripción a la organización (cerrada) ----
const ORG_420 = 'Los 420', ORG_420_MAX = 6;
// ¿Alguno de estos Riot ID ya estaba inscrito (rosters de equipos, roster manual, smurfs vinculadas o uLeague)?
async function orgInscribed(rids){
  const nr = r => String(r || '').toLowerCase().replace(/\s+/g, '');
  const want = new Set(rids.map(nr).filter(r => /#/.test(r))); if (!want.size) return false;
  const have = new Set();
  try { for (const r of await q('SELECT riotid FROM team_members UNION SELECT riotid FROM roster UNION SELECT smurf_riotid FROM smurf_links UNION SELECT main_riotid FROM smurf_links')) have.add(nr(r.riotid)); } catch {}
  try { const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'uleague-data.json'), 'utf8'));
    for (const t of (d.teams || [])) if (/^UCH /i.test(t.name || '')) for (const p of (t.players || [])) have.add(nr(p.rid || p.riotId)); } catch {}
  return [...want].some(r => have.has(r));
}
// Límite simple de intentos por IP (login / registro), en memoria. Detrás de Cloudflare la IP real viene en CF-Connecting-IP.
const _hits = new Map();
function tooMany(req, kind, max, windowMs){
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const k = kind + '|' + ip, now = Date.now(), arr = (_hits.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); _hits.set(k, arr);
  if (_hits.size > 5000) for (const [kk, v] of _hits) if (!v.length || now - v[v.length - 1] > windowMs) _hits.delete(kk);
  return arr.length > max;
}
// ================= AUTH =================
app.post('/api/register', wrap(async (req,res) => {
  if (tooMany(req, 'register', 8, 60 * 60000)) return res.status(429).json({ error:'Demasiados registros desde tu conexión. Intenta más tarde.' });
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
  if (await q1('SELECT 1 FROM ext_users WHERE email=$1', [b.email])) return res.status(409).json({ error:'Ese email ya está registrado (como externo)' });
  // Inscripción a la organización: ya está cerrada. Solo entran (1) quienes se inscriben en "Los 420" hasta
  // completar 6, o (2) jugadores que ya están inscritos (rosters / roster manual / uLeague) y aún no tienen cuenta.
  const is420 = b.team === ORG_420;
  if (is420){
    const n = await q1('SELECT count(*)::int n FROM users WHERE team=$1', [ORG_420]);
    if (n && n.n >= ORG_420_MAX) return res.status(403).json({ error:`Los 420 ya completó sus ${ORG_420_MAX} cupos. Puedes registrarte como externo.` });
  } else if (!(await orgInscribed([b.riotid]))){   // la cuenta principal debe ser la inscrita (no basta con nombrarla como smurf)
    return res.status(403).json({ error:'Las inscripciones a la organización están cerradas. Si ya estabas inscrito, usa el mismo Riot ID con que te inscribieron; si no, regístrate como externo (más abajo).' });
  }
  const team = TEAMS.has(b.team) ? b.team : (is420 ? ORG_420 : null);
  const riotid = b.riotid;   // la cuenta principal del jugador (la que se trackea)
  const hash = await bcrypt.hash(b.password, 10);
  const u = await q1(`INSERT INTO users (email,password_hash,nickname,realname,riotid,main,discord,pos1,pos2,avatar,champ1,champ2,champ3,flash_slot,team,confirmed,is_admin)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16) RETURNING *`,
    [b.email, hash, b.nickname, b.realname, riotid, b.main||null, b.discord, b.pos1, b.pos2, b.avatar||null, b.champ1, b.champ2, b.champ3, flash, team, ADMIN_RIDS.has(riotid)]);
  // El equipo se guarda en team_members (fuente única, multi-equipo). Si eligió uno al registrarse,
  // lo añade (conserva lo que el admin haya sembrado para esta cuenta).
  if (team && TEAMS.has(team)) await q('INSERT INTO team_members (riotid, team) VALUES ($1,$2) ON CONFLICT (riotid, team) DO NOTHING', [riotid, team]);
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
  if (tooMany(req, 'login', 15, 10 * 60000)) return res.status(429).json({ error:'Demasiados intentos. Espera unos minutos.' });
  const u = email && await q1('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
  if (u && await bcrypt.compare(password||'', u.password_hash)) return res.json({ token: sign(u), user: publicUser(u) });
  const x = !u && email && await q1('SELECT * FROM ext_users WHERE lower(email)=lower($1)', [email]);
  if (x && await bcrypt.compare(password||'', x.password_hash)) return res.json({ token: signExt(x), user: publicExt(x) });
  res.status(401).json({ error:'Email o contraseña incorrectos' });
}));
// Registro de EXTERNOS (fuera de la organización): Riot ID obligatorio; universidad (o "sin universidad"),
// nombre e imagen opcionales. No entran al ranking ni ven lo sensible.
app.post('/api/register-external', wrap(async (req,res) => {
  if (tooMany(req, 'register', 8, 60 * 60000)) return res.status(429).json({ error:'Demasiados registros desde tu conexión. Intenta más tarde.' });
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase(), riotid = String(b.riotid || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error:'Email inválido' });
  if (String(b.password || '').length < 6) return res.status(400).json({ error:'La contraseña debe tener al menos 6 caracteres' });
  if (!/^.+#.+$/.test(riotid)) return res.status(400).json({ error:'Tu nick de LoL debe ser Nombre#TAG' });
  const uni = String(b.university || '').trim().slice(0, 80);
  if (!uni) return res.status(400).json({ error:'Indica tu universidad (o marca que no eres de universidad)' });
  const avatar = b.avatar && String(b.avatar).startsWith('data:image/') && String(b.avatar).length < 400000 ? String(b.avatar) : null;
  if (await q1('SELECT 1 FROM users WHERE lower(email)=$1 UNION SELECT 1 FROM ext_users WHERE lower(email)=$1', [email])) return res.status(409).json({ error:'Ese email ya está registrado' });
  const x = await q1(`INSERT INTO ext_users (email, password_hash, riotid, nickname, realname, university, avatar) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [email, await bcrypt.hash(String(b.password), 10), riotid, riotid.split('#')[0].trim(), String(b.realname || '').trim().slice(0, 80) || null, uni, avatar]);
  res.json({ token: signExt(x), user: publicExt(x) });
}));

app.get('/api/me', wrap(async (req,res) => {
  const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  let p = null; try { p = t && jwt.verify(t, JWT_SECRET); } catch {}
  if (p && p.xid && !p.uid){ const x = await q1('SELECT * FROM ext_users WHERE id=$1', [p.xid]); return x ? res.json({ user: publicExt(x) }) : res.status(401).json({ error:'Sesión inválida' }); }
  const u = p && p.uid && await q1('SELECT * FROM users WHERE id=$1', [p.uid]);
  if (!u) return res.status(401).json({ error: t ? 'Sesión inválida' : 'No autenticado' });
  res.json({ user: publicUser(u) });
}));

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
  if (AVATARS_CACHE.data && Date.now() - AVATARS_CACHE.at < AVATARS_TTL) return res.json(await avatarsFor(req, AVATARS_CACHE.data));
  const users = await q('SELECT id, riotid, nickname, avatar, pos1, pos2, main, champ1, champ2, champ3, flash_slot FROM users');
  const smurfs = await q('SELECT user_id, riotid FROM smurfs ORDER BY id');
  const byUser = {}; smurfs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s.riotid); });
  const out = [];
  users.forEach(u => {
    const base = { nickname:u.nickname, avatar:u.avatar, pos1:u.pos1, pos2:u.pos2, main:u.main, champ1:u.champ1, champ2:u.champ2, champ3:u.champ3, flashSlot:u.flash_slot, owner:u.nickname };
    out.push({ ...base, riotid:u.riotid, label:'Main' });
    const list = byUser[u.id] || [];
    list.forEach((rid, i) => out.push({ ...base, riotid:rid, label: list.length > 1 ? `Smurf ${i+1}` : 'Smurf' }));
  });
  // smurfs vinculadas por el admin (el dueño puede no tener cuenta en la web): para agrupar "1 cuenta" en la org
  try { const known = new Set(out.map(a => String(a.riotid || '').toLowerCase().replace(/\s+/g, '')));
    const nickByRid = {}; users.forEach(u => { nickByRid[String(u.riotid || '').toLowerCase().replace(/\s+/g, '')] = u.nickname; });
    for (const l of await q('SELECT smurf_riotid, main_riotid FROM smurf_links')){ const k = String(l.smurf_riotid || '').toLowerCase().replace(/\s+/g, ''); if (!k || known.has(k)) continue;
      const nick = nickByRid[String(l.main_riotid || '').toLowerCase().replace(/\s+/g, '')] || String(l.main_riotid || '').split('#')[0];
      out.push({ nickname: nick, owner: nick, avatar: null, riotid: l.smurf_riotid, label: 'Smurf' }); known.add(k); } } catch {}
  AVATARS_CACHE = { at: Date.now(), data: out };
  res.json(await avatarsFor(req, out));
}));
// Los de afuera no reciben las filas de smurfs (qué cuenta es de quién); la org recibe todo, sin caché compartida.
async function avatarsFor(req, all){
  if (await reqOrg(req)){ req.res.set('Cache-Control', 'private, no-store'); return all; }
  return all.filter(a => a.label === 'Main').map(({ champ1, champ2, champ3, flashSlot, ...a }) => a);
}

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
  const org = await reqOrg(req); if (org) res.set('Cache-Control', 'private, no-store');
  if (org) users.forEach(u => { const m = map[u.riotid.toLowerCase()];   // propaga los equipos de la main a sus smurfs (solo org)
    if (m && m.teams.size) (byUser[u.id] || []).forEach(rid => m.teams.forEach(t => add(rid, t))); });
  res.json(Object.values(map).filter(x => org || !isSmurf(x.riotid)).map(x => ({ riotid:x.riotid, teams:[...x.teams] })));
}));

// Rosters por equipo: UNA fila por jugador (su cuenta main de team_members), mostrando el
// elo de su CUENTA MÁS ALTA (main + smurfs), su rol en el equipo y si es titular o suplente.
// El elo se toma del ranking ya trackeado (liveSnapshot), sin llamar a la Riot API. Público.
app.get('/api/rosters', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=20');
  const R = await buildRosters();
  if (await reqOrg(req)){ res.set('Cache-Control', 'private, no-store'); return res.json(R); }
  // los de afuera no ven cuál es la cuenta más alta de cada uno (suele ser una smurf)
  const out = {}; for (const [t, list] of Object.entries(R)) out[t] = list.map(p => ({ ...p, bestRiotid: p.riotid })); res.json(out);
}));
// Rosters de los equipos internos con rol de torneo y la mejor cuenta de cada jugador (también lo usa la Subasta).
async function buildRosters(){
  const players = liveSnapshot().players || [];
  const byRid = {}; players.forEach(p => { byRid[(p.rid || '').toLowerCase()] = p; });

  const tm     = await q("SELECT riotid, team, role, starter FROM team_members WHERE team IS NOT NULL AND team<>''");
  const users  = await q("SELECT id, riotid, nickname FROM users");
  const smurfs = await q('SELECT user_id, riotid FROM smurfs');
  const links  = await q('SELECT smurf_riotid, main_riotid FROM smurf_links');
  const nrk = r => String(r || '').toLowerCase().replace(/\s+/g, '');   // "k1sseshugs #xoxo" == "k1sseshugs#xoxo"
  const userByRid  = {}; users.forEach(u => { userByRid[nrk(u.riotid)] = u; });
  const userById   = {}; users.forEach(u => { userById[u.id] = u; });
  const smurfsByUser = {}; smurfs.forEach(s => { (smurfsByUser[s.user_id] = smurfsByUser[s.user_id] || []).push(s.riotid); });
  // Mapa smurf→main. Primero las smurfs REGISTRADAS (tabla smurfs, colgadas de un usuario),
  // luego los vínculos manuales de jugadores no registrados (smurf_links).
  const mainOf = {}, linkSmurfs = {};
  smurfs.forEach(s => { const m = userById[s.user_id]; if (m) mainOf[nrk(s.riotid)] = m.riotid; });
  links.forEach(l => { mainOf[nrk(l.smurf_riotid)] = l.main_riotid;
    (linkSmurfs[l.main_riotid.toLowerCase()] = linkSmurfs[l.main_riotid.toLowerCase()] || []).push(l.smurf_riotid); });
  const canon = rid => { const m = mainOf[nrk(rid)]; if (m) return m; const u = userByRid[nrk(rid)]; return u ? u.riotid : rid; };   // smurf → main; variante con espacios → la del usuario

  // Todas las cuentas de un jugador (main + smurfs registradas + smurfs vinculadas a mano).
  const accountsOf = mainRid => {
    const set = new Map(); const add = r => { if (r) set.set(r.toLowerCase(), r); };
    add(mainRid);
    const u = userByRid[nrk(mainRid)]; if (u) (smurfsByUser[u.id] || []).forEach(add);
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
    const key = nrk(mainRid);
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
  return result;
}

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

// Resultados de la FASE SUIZA de uLeague (puestos por el admin desde el fixture). Público (los lee uleague.html).
const ulMatchId = (round, a, b) => 'r' + (round|0) + ':' + [String(a||'').trim(), String(b||'').trim()].sort().join('__');
app.get('/api/uleague-results', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=10');
  const rows = await q('SELECT round, team_a, team_b, winner, loser_maps FROM uleague_results');
  res.json(rows.map(r => ({ round: r.round, a: r.team_a, b: r.team_b, winner: r.winner, loserMaps: r.loser_maps|0 })));
}));
// El admin fija (o borra) el resultado de un partido del suizo. winner vacío/null = borra el resultado.
// loserMaps = mapas que ganó el perdedor (BO3: 0 -> 2-0, 1 -> 2-1).
app.post('/api/admin/uleague-result', auth, requireAdmin, wrap(async (req,res) => {
  const b = req.body || {};
  const round = parseInt(b.round, 10);
  const teamA = String(b.a || '').trim(), teamB = String(b.b || '').trim();
  const winner = String(b.winner || '').trim();
  const loserMaps = Math.max(0, Math.min(2, parseInt(b.loserMaps, 10) || 0));
  if (!round || !teamA || !teamB) return res.status(400).json({ error:'Faltan datos (round, a, b)' });
  const matchId = ulMatchId(round, teamA, teamB);
  if (!winner) { await q('DELETE FROM uleague_results WHERE match_id=$1', [matchId]); return res.json({ ok:true, cleared:true }); }
  if (winner !== teamA && winner !== teamB) return res.status(400).json({ error:'El ganador debe ser uno de los dos equipos' });
  await q(`INSERT INTO uleague_results (match_id, round, team_a, team_b, winner, loser_maps, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT (match_id) DO UPDATE SET winner=EXCLUDED.winner, loser_maps=EXCLUDED.loser_maps, round=EXCLUDED.round, team_a=EXCLUDED.team_a, team_b=EXCLUDED.team_b, updated_at=now()`,
          [matchId, round, teamA, teamB, winner, loserMaps]);
  res.json({ ok:true, round, a:teamA, b:teamB, winner, loserMaps });
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
  // 1) uLeague PRINCIPAL: rosters del torneo en curso (uleague-data.json).
  try {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'uleague-data.json'), 'utf8'));
    (d.teams || []).forEach(t => (t.players || []).forEach(p => {
      const rid = normRid(typeof p === 'string' ? p : p.rid); if (rid) map[rid] = { tag: t.name || '', team: t.name || '' };
    }));
  } catch {}
  // 2) UDPORROS de RESPALDO: solo cuentas/equipos que NO estén ya en uLeague (uLeague manda).
  try {
    const m = fs.readFileSync(path.join(ROOT, 'torneo-data.js'), 'utf8').match(/window\.TDATA\s*=\s*([\s\S]*);\s*$/);
    const data = m ? JSON.parse(m[1]) : { teams: [] };
    (data.teams || []).forEach(t => (t.players || []).forEach(p => {
      const rid = normRid(p.rid); if (rid && !map[rid]) map[rid] = { tag: t.tag || '', team: t.team || '' };
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
// Etiquetas de jugador (PRO / Streamer / Competitivo / GOD). Público (ranking + live games).
const PLAYER_TAGS = new Set(['PRO', 'STREAMER', 'COMPETITIVO', 'GOD']);
// Etiquetas por defecto (jugadores fijados en código). El admin puede sobreescribirlas desde el panel.
const DEFAULT_TAGS = { 'el financiero#las': 'GOD' };
let _tagsCache = { at: 0, data: null };
function invalidateTags(){ _tagsCache = { at: 0, data: null }; }
app.get('/api/player-tags', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=120');
  if (_tagsCache.data && Date.now() - _tagsCache.at < 120000) return res.json(_tagsCache.data);
  const rows = await q('SELECT riotid, tag FROM player_tags');
  const out = { ...DEFAULT_TAGS }; rows.forEach(r => { out[r.riotid.toLowerCase()] = r.tag; });   // la DB pisa el default
  _tagsCache = { at: Date.now(), data: out };
  res.json(out);
}));
// Canales de los streamers etiquetados (Riot ID en minúsculas → URL): el tag "Streamer" lleva a su stream.
app.get('/api/streamer-links', wrap(async (req,res) => {
  res.set('Cache-Control', 'public, max-age=120');
  const out = {}; try { for (const r of await q("SELECT riotid, stream_url FROM player_tags WHERE tag='STREAMER' AND coalesce(stream_url,'')<>''")) out[r.riotid.toLowerCase()] = r.stream_url; } catch {}
  res.json(out);
}));
app.post('/api/admin/player-tag', auth, requireAdmin, wrap(async (req,res) => {
  const riotid = ((req.body && req.body.riotid) || '').trim();
  if (!/^.+#.+$/.test(riotid)) return res.status(400).json({ error:'Riot ID debe ser Nombre#TAG' });
  const tag = ((req.body && req.body.tag) || '').trim().toUpperCase();
  if (!tag){ await q('DELETE FROM player_tags WHERE lower(riotid)=lower($1)', [riotid]); invalidateTags(); return res.json({ ok:true, cleared:true }); }
  if (!PLAYER_TAGS.has(tag)) return res.status(400).json({ error:'Etiqueta inválida' });
  // canal de stream (opcional): sin el campo se conserva; vacío lo borra
  const stream = req.body && req.body.stream !== undefined ? String(req.body.stream || '').trim() : undefined;
  if (stream && !/^https?:\/\/(www\.)?(twitch\.tv|kick\.com)\/[A-Za-z0-9_]+\/?$/i.test(stream)) return res.status(400).json({ error:'Canal inválido: usa https://twitch.tv/canal o https://kick.com/canal' });
  await q(`INSERT INTO player_tags (riotid, tag, stream_url, updated_at) VALUES ($1,$2,$3,now())
           ON CONFLICT (riotid) DO UPDATE SET tag=EXCLUDED.tag, stream_url=CASE WHEN $4 THEN EXCLUDED.stream_url ELSE player_tags.stream_url END, updated_at=now()`,
    [riotid, tag, stream || null, stream !== undefined]);
  invalidateTags(); STREAM_LIVE.at = 0;
  res.json({ ok:true, riotid, tag });
}));
app.get('/api/admin/player-tags', auth, requireAdmin, wrap(async (req,res) =>
  res.json(await q('SELECT riotid, tag, stream_url, updated_at FROM player_tags ORDER BY updated_at DESC'))));
// Streamers etiquetados que están EN VIVO ahora (Twitch vía decapi.me, Kick vía su API pública). Cache 2 min.
// El inicio rota entre ellos cuando el admin no puso ningún stream.
const STREAM_LIVE = { at: 0, data: [] };
const PRIORITY_STREAM = { nick: 'Caedrel', url: 'https://www.twitch.tv/caedrel' };
async function streamIsLive(url){
  const m = String(url).match(/(twitch\.tv|kick\.com)\/([A-Za-z0-9_]+)/i); if (!m) return null;
  const host = m[1].toLowerCase(), ch = m[2];
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
  try {
    if (host === 'twitch.tv'){
      const txt = (await (await fetch('https://decapi.me/twitch/uptime/' + encodeURIComponent(ch), { signal: ctl.signal })).text()).trim();
      if (/offline|error|not found|no user/i.test(txt) || !txt) return null;
      return { platform: 'twitch', channel: ch, uptime: txt };
    }
    const r = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(ch), { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!r.ok) return null; const j = await r.json(); if (!j || !j.livestream) return null;
    return { platform: 'kick', channel: ch, viewers: j.livestream.viewer_count || null, title: j.livestream.session_title || null };
  } catch { return null; } finally { clearTimeout(t); }
}
app.get('/api/streams/live', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  if (Date.now() - STREAM_LIVE.at > 120000){
    STREAM_LIVE.at = Date.now();
    let rows = []; try { rows = await q("SELECT riotid, stream_url FROM player_tags WHERE tag='STREAMER' AND coalesce(stream_url,'')<>''"); } catch {}
    const out = [];
    await Promise.all(rows.map(async r => { const live = await streamIsLive(r.stream_url); if (live) out.push({ riotid: r.riotid, nick: r.riotid.split('#')[0].replace(/^(kick|twitch)\s+/i, ''), url: r.stream_url, ...live }); }));
    STREAM_LIVE.data = out.sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
    // Caedrel: si está transmitiendo, va primero y el inicio lo muestra antes que cualquier otro stream.
    const cae = await streamIsLive(PRIORITY_STREAM.url);
    if (cae) STREAM_LIVE.data.unshift({ riotid: null, nick: PRIORITY_STREAM.nick, url: PRIORITY_STREAM.url, priority: true, ...cae });
  }
  res.json(STREAM_LIVE.data);
}));

// ---- APUESTA: ¿quién llega antes a Challenger, Krok o Petu? (vota cualquier jugador logueado) ----
const BET_ID = 'dia_krok_petu';   // carrera a Diamante (id nuevo => votos reiniciados)
const BET_CHOICES = new Set(['krok', 'petu']);
// Lee el uid del token si viene (sin obligar a estar logueado), para devolver el voto propio.
async function optionalUid(req){
  const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return null;
  try { return jwt.verify(t, JWT_SECRET).uid; } catch { return null; }
}
async function betTally(uid){
  const rows = await q('SELECT choice, count(*)::int c FROM bet_votes WHERE bet_id=$1 GROUP BY choice', [BET_ID]);
  const out = { krok:0, petu:0, mine:null };
  rows.forEach(r => { if (r.choice === 'krok' || r.choice === 'petu') out[r.choice] = r.c; });
  if (uid){ const m = await q1('SELECT choice FROM bet_votes WHERE bet_id=$1 AND user_id=$2', [BET_ID, uid]); out.mine = m ? m.choice : null; }
  return out;
}
app.get('/api/bet-votes', wrap(async (req,res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await betTally(await optionalUid(req)));
}));
app.post('/api/bet-vote', auth, wrap(async (req,res) => {
  const choice = ((req.body && req.body.choice) || '').trim().toLowerCase();
  if (!BET_CHOICES.has(choice)) return res.status(400).json({ error:'Voto inválido' });
  await q(`INSERT INTO bet_votes (bet_id, user_id, choice, updated_at) VALUES ($1,$2,$3,now())
           ON CONFLICT (bet_id, user_id) DO UPDATE SET choice=EXCLUDED.choice, updated_at=now()`, [BET_ID, req.user.id, choice]);
  res.json(await betTally(req.user.id));
}));

// Palmaditas de apoyo (contador compartido). El cooldown de 10 min es por navegador (cliente);
// acá solo un throttle ligero por IP anti-spam.
const PAT_ID = 'apoyin_hb';   // contador propio de cada campaña (quedan guardados 'acaricia_tide' y 'acaricia_matotomato')
const _patLastIp = new Map();
app.get('/api/palmadita', wrap(async (req,res) => {
  res.set('Cache-Control', 'no-store');
  const r = await q1('SELECT n FROM counters WHERE name=$1', [PAT_ID]);
  res.json({ count: r ? Number(r.n) : 0 });
}));
app.post('/api/palmadita', wrap(async (req,res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const now = Date.now();
  if (ip && (now - (_patLastIp.get(ip) || 0)) < 3000){   // 1 cada 3s por IP
    const r = await q1('SELECT n FROM counters WHERE name=$1', [PAT_ID]);
    return res.json({ count: r ? Number(r.n) : 0 });
  }
  if (ip) _patLastIp.set(ip, now);
  const r = await q1(`INSERT INTO counters (name, n, updated_at) VALUES ($1, 1, now())
                      ON CONFLICT (name) DO UPDATE SET n = counters.n + 1, updated_at = now() RETURNING n`, [PAT_ID]);
  res.json({ count: r ? Number(r.n) : 1 });
}));

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
  loadSmurfSet().catch(() => {}); res.json({ ok:true });
}));
app.post('/api/me/smurfs/remove', auth, wrap(async (req,res) => {
  await q('DELETE FROM smurfs WHERE id=$1 AND user_id=$2', [Number(req.body && req.body.id), req.user.id]);
  invalidateAvatars();
  loadSmurfSet().catch(() => {}); res.json({ ok:true });
}));

// Ficha de un jugador (para el despliegue del ranking). Todo sale de la DB, sin Riot API.
const ksOf  = p => (p && p.perks && p.perks.styles && p.perks.styles[0] && p.perks.styles[0].selections && p.perks.styles[0].selections[0] && p.perks.styles[0].selections[0].perk) || null;
const secOf = p => (p && p.perks && p.perks.styles && p.perks.styles[1] && p.perks.styles[1].style) || null;
// Derrota SIN pérdida de LP: partida terminada por comportamiento disruptivo de un compañero
// ("IGNB surrender"). El equipo que rinde no pierde LP, salvo el causante.
const noLpLoss = p => !p.win && !!p.teamIGNBSurrendered && !p.causedGameEndFromIGNBSurrender;
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
    win: !!me.win, noLp: noLpLoss(me), voided: !!me.gameEndedInIGNBSurrender, champion: me.championName, position: me.teamPosition || '',
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
  if (isSmurf(riotid) && !(await reqOrg(req))) return res.status(404).json({ error:'Jugador no encontrado' });
  const admin = await reqIsAdmin(req);
  res.set('Cache-Control', admin ? 'private, no-store' : 'public, max-age=300');   // ficha: Cloudflare la sirve del borde ~90s (la de admin trae el nombre real: no se cachea)

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
          if (h.noLp){ h.lp = 0; return; }   // derrota sin LP: 0 exacto, lo dice Riot
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
      count(*) FILTER (WHERE win)::int wins FROM mp_stats WHERE puuid=$1`, [puuid]);
    if (s && s.n){
      const durMin = Number(s.dur)/60 || 1;
      stats = { registradas:s.n, k:s.k, d:s.d, a:s.a, kda:+(((s.k+s.a)/Math.max(1,s.d)).toFixed(2)),
        csMin:+(Number(s.cs)/durMin).toFixed(1), dmgMin:Math.round(Number(s.dmg)/durMin), vision:+s.vis.toFixed(1),
        penta:s.penta, firstBloods:s.fb, recordKills:s.rec, avgDurMin:Math.round(s.avgdur/60), maxDurMin:Math.round(s.maxdur/60),
        wins:s.wins, losses:s.n - s.wins };
    }
  }

  // Duelos: V/D del jugador contra OTROS participantes del torneo (en el equipo contrario).
  let duels = null;
  if (puuid){
    const dr = await q(`SELECT mp1.win, count(*)::int n
      FROM mp_stats mp1
      JOIN mp_stats mp2 ON mp2.match_id = mp1.match_id AND mp2.is_tournament = true
        AND mp2.puuid <> mp1.puuid AND mp2.team_id <> mp1.team_id AND coalesce(mp2.puuid,'') <> ''
      WHERE mp1.puuid = $1 AND mp1.is_tournament = true AND coalesce(mp1.duration,0) >= 300
      GROUP BY mp1.win`, [puuid]);
    let w = 0, l = 0; dr.forEach(r => { if (r.win) w = r.n; else l = r.n; });
    if (w + l > 0) duels = { w, l };
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
    realname: admin && u ? u.realname : undefined, avatar: u && u.avatar, pos1: u && u.pos1, pos2: u && u.pos2,
    champs: u ? [u.champ1,u.champ2,u.champ3].filter(Boolean) : [], flashSlot: u && u.flash_slot,
    isRegistered: !!u, isAdmin: !!(u && u.is_admin), label: accLabel,
    tier: lp && lp.tier, div: lp && lp.div, lp: lp && lp.lp, rankPos,
    w: lp ? lp.w : (stats?stats.wins:0), l: lp ? lp.l : (stats?stats.losses:0),
    form: (lp && lp.form) || [], up: lp && lp.up, down: lp && lp.down, aegis: lp && lp.aegis,
  };
  if (!(await reqOrg(req))){ if (profile.label && /smurf/i.test(profile.label)) profile.label = null; profile.champs = []; profile.flashSlot = null;
    return res.json({ profile, history: [], stats: null, duels: null, blueshells: null, orgOnly: true, ddragonVersion: liveData && liveData.ddragonVersion }); }
  res.set('Cache-Control', 'private, no-store');
  res.json({ profile, history, stats, duels, blueshells, ddragonVersion: liveData && liveData.ddragonVersion });
}));

// Scoreboard completo de una partida guardada (para el desglose "tipo live games").
app.get('/api/match/:matchId', orgOnly, wrap(async (req,res) => {
  const id = (req.params.matchId || '').trim();
  const blob = (await matchBlobs([id]))[id];   // caché en memoria (partida inmutable)
  if (!blob || !blob.info) return res.status(404).json({ error:'Partida no guardada' });
  res.set('Cache-Control', 'public, max-age=120');   // el JSON es inmutable pero las asignaciones no
  const info = blob.info;
  const trackedRids = new Set(((liveData && liveData.players) || []).map(p => (p.rid||'').toLowerCase()));
  const parts = (info.participants || []).map(p => {
    const gn = p.riotIdGameName || p.summonerName || '', tg = p.riotIdTagline || '';
    const rid = gn ? (tg ? `${gn}#${tg}` : gn) : '';
    return {
      name: gn, tag: tg, puuid: p.puuid || '', champion: p.championName, teamId: p.teamId, win: !!p.win, position: p.teamPosition || '',
      spells: [p.summoner1Id, p.summoner2Id], keystone: ksOf(p), secStyle: secOf(p),
      k: p.kills||0, d: p.deaths||0, a: p.assists||0, cs: (p.totalMinionsKilled||0)+(p.neutralMinionsKilled||0),
      items: [p.item0,p.item1,p.item2,p.item3,p.item4,p.item5].map(x=>x||0), trinket: p.item6||0,
      tracked: rid ? trackedRids.has(rid.toLowerCase()) : false,
    };
  });
  // Asignaciones manuales de esta partida (account sharing): puuid -> nick del jugador asignado.
  const assigned = {};
  try {
    const rows = await q('SELECT puuid, user_id FROM game_assignments WHERE match_id=$1', [id]);
    if (rows.length){ const us = await q('SELECT id, nickname FROM users WHERE id = ANY($1)', [rows.map(r=>r.user_id)]);
      const nick = {}; us.forEach(u => nick[u.id] = u.nickname);
      rows.forEach(r => { assigned[r.puuid] = nick[r.user_id] || null; }); }
  } catch {}
  res.json({ duration: info.gameDuration||0, queueId: info.queueId, assigned,
    blue: parts.filter(p=>p.teamId===100), red: parts.filter(p=>p.teamId===200) });
}));

// El admin asigna una partida a un jugador (account sharing): en esta partida, la cuenta (puuid o
// riotid) la jugaba `userId`. userId vacío = quita la asignación. Afecta stats/dúos/encuentros.
app.post('/api/admin/game-assign', auth, requireAdmin, wrap(async (req,res) => {
  const matchId = ((req.body && req.body.matchId) || '').trim();
  let puuid = ((req.body && req.body.puuid) || '').trim();
  const riotid = ((req.body && req.body.riotid) || '').trim();
  const userId = (req.body && req.body.userId) ? Number(req.body.userId) : 0;
  if (!matchId) return res.status(400).json({ error:'Falta matchId' });
  if (!puuid && riotid){ const r = await q1("SELECT puuid FROM match_participants WHERE match_id=$1 AND lower(riotid)=lower($2) AND coalesce(puuid,'')<>'' LIMIT 1", [matchId, riotid]); puuid = r && r.puuid; }
  if (!puuid) return res.status(400).json({ error:'No pude identificar la cuenta en esa partida' });
  if (!userId){ await q('DELETE FROM game_assignments WHERE match_id=$1 AND puuid=$2', [matchId, puuid]); }
  else {
    const u = await q1('SELECT id, nickname FROM users WHERE id=$1', [userId]); if (!u) return res.status(400).json({ error:'Jugador inválido' });
    await q(`INSERT INTO game_assignments (match_id, puuid, user_id, updated_at) VALUES ($1,$2,$3,now())
             ON CONFLICT (match_id, puuid) DO UPDATE SET user_id=EXCLUDED.user_id, updated_at=now()`, [matchId, puuid, userId]);
  }
  STATS_CACHE.at = 0; ENC_CACHE.at = 0;   // que el cambio se vea sin esperar el cache
  res.json({ ok:true });
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
  if (Date.now() - LB_CACHE.at < 300000) return LB_CACHE.players;
  const rows = await q(`SELECT puuid, riotid, name, champion, win, kills, deaths, assists, cs, gold, damage, vision, penta, duration, game_end
    FROM mp_stats WHERE is_tournament=true`);
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
  if (isSmurf(riotid) && !(await reqOrg(req))) return res.status(404).json({ error:'Jugador no encontrado' });
  const admin = await reqIsAdmin(req);
  res.set('Cache-Control', admin ? 'private, no-store' : 'public, max-age=300');   // ficha completa: Cloudflare la sirve del borde ~90s
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
        // lpGames viene en orden ASCENDENTE (más viejo primero). Para reconstruir el elo hacia
        // atrás desde el LP actual hay que recorrerlo del más NUEVO al más viejo; si no, los
        // tiempos quedan desordenados y la línea zigzaguea/se cruza. Cada punto = LP tras ese game.
        const lg = s.lpGames.filter(g => g.end).sort((a,b) => (b.end||0) - (a.end||0));
        let abs = curAbs; const pts = [{ t:Date.now(), lp:abs }];
        for (const g of lg){ pts.push({ t:g.end, lp:abs }); abs -= (g.delta||0); }
        eloSeries = pts.sort((a,b) => a.t - b.t);
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
      FROM mp_stats WHERE puuid=$1`, [puuid]);
    const champs = await q(`
      SELECT champion, count(*) games, count(*) FILTER (WHERE win) wins,
             avg(kills) k, avg(deaths) d, avg(assists) a
      FROM mp_stats WHERE puuid=$1 AND coalesce(champion,'')<>''
      GROUP BY champion ORDER BY games DESC, wins DESC LIMIT 8`, [puuid]);
    const roles = await q(`
      SELECT coalesce(nullif(position,''),'—') pos, count(*) games, count(*) FILTER (WHERE win) wins
      FROM mp_stats WHERE puuid=$1 GROUP BY 1 ORDER BY games DESC`, [puuid]);
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
      FROM mp_stats WHERE is_tournament=true AND coalesce(puuid,'')<>'' GROUP BY puuid`);
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
    profile: { riotid, nickname:(u&&u.nickname)||(lp&&lp.nm)||riotid.split('#')[0], realname:admin&&u?u.realname:undefined, avatar:u&&u.avatar,
      tier:lp&&lp.tier, div:lp&&lp.div, lp:lp&&lp.lp, rankPos, role:(u&&u.pos1)||(lp&&lp.role),
      elo: lp && ['MASTER','GRANDMASTER','CHALLENGER'].includes(lp.tier) ? 'High Elo' : 'Low Elo',
      w, l, winrate: tot?Math.round(w/tot*100):0 },
    eloSeries, premios, records, stats: (await reqOrg(req)) ? stats : null, orgOnly: !(await reqOrg(req)),
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

// ---- Resultado de Ranked enviado por el overlay ----
// Al terminar una partida PERSONALIZADA, el overlay lee del cliente del LoL (historial local) el ganador y las
// estadísticas de los 10, y las manda aquí. Si quien reporta está en una sala de Ranked en juego y los jugadores de
// la partida coinciden con los de la sala, el resultado se aplica al tiro (se cancela la votación) y quedan
// guardadas las estadísticas. La API de Riot no entrega partidas personalizadas, por eso se hace desde el overlay.
let RK_CHAMP_KEYS = { at: 0, map: null };
async function rkChampKeys(){   // id numérico de campeón → id de Data Dragon ("103" → "Ahri")
  if (RK_CHAMP_KEYS.map && Date.now() - RK_CHAMP_KEYS.at < 12 * 3600 * 1000) return RK_CHAMP_KEYS.map;
  try { const ver = (liveSnapshot().ddragonVersion) || '16.15.1';
    const r = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/champion.json`);
    if (r.ok){ const j = await r.json(), map = {}; Object.values(j.data).forEach(c => { map[String(c.key)] = c.id; }); RK_CHAMP_KEYS = { at: Date.now(), map }; } } catch {}
  return RK_CHAMP_KEYS.map || {};
}
const ovNrk = r => String(r || '').toLowerCase().replace(/\s+/g, '');
app.post('/api/overlay/ranked-result', wrap(async (req, res) => {
  const b = req.body || {}, g = b.game || {}, riotid = String(b.riotid || '').trim();
  if (!/^.+#.+$/.test(riotid) || !Array.isArray(g.players) || !g.players.length || g.players.length > 12) return res.status(400).json({ error: 'datos inválidos' });
  if (REPORT_SECRET && b.secret !== REPORT_SECRET) return res.status(403).json({ error: 'no autorizado' });
  await rkInit();
  const gameId = String(g.gameId || '').replace(/\D/g, '').slice(0, 20);
  if (!gameId) return res.status(400).json({ error: 'falta gameId' });
  const num = v => Number.isFinite(+v) ? Math.round(+v) : null;
  // partida ya usada: si otro overlay manda un ganador distinto, queda marcada para que la revise un admin
  const won = side => g.players.filter(p => p.win === true && p.teamId === side).length > 0 || (g.teams || []).some(t => t.teamId === side && t.win === true);
  const u0 = await q1("SELECT id, nickname FROM users WHERE lower(regexp_replace(riotid, '[[:space:]]', '', 'g')) = $1", [ovNrk(riotid)]);
  try { const used = await q1("SELECT id, data FROM ranked_matches WHERE data->'game'->>'gameId' = $1", [gameId]);
    if (used){ const d = used.data, mine = (d.game.players || []).find(p => ovNrk(p.rid) === ovNrk(riotid));
      if (mine && won(mine.teamId) !== (d.winner === mine.side) && !d.conflict){
        d.conflict = { by: (u0 && u0.nickname) || riotid, at: Date.now(), claims: won(mine.teamId) ? mine.side : (mine.side === 'blue' ? 'red' : 'blue') };
        await q('UPDATE ranked_matches SET data=$2::jsonb WHERE id=$1', [used.id, JSON.stringify(d)]); }
      return res.json({ ok: true, ignored: 'ya registrada', matchId: used.id }); } } catch {}
  const u = await q1("SELECT id, nickname FROM users WHERE lower(regexp_replace(riotid, '[[:space:]]', '', 'g')) = $1", [ovNrk(riotid)]);
  const mid = u ? RK.byUser.get(u.id) : null, m = mid != null ? RK.matches.get(mid) : null;
  if (!m || (m.status !== 'playing' && m.status !== 'dispute')){ const t = await tgIngest(g, riotid).catch(e => { console.error('tgIngest:', e.message); return null; });
    return res.json({ ok: true, ignored: 'sin sala de Ranked en juego', teamInbox: t }); }
  if ((num(g.duration) || 0) < 180) return res.json({ ok: true, ignored: 'partida demasiado corta' });
  if (g.creation && +g.creation < (m.playingAt || m.createdAt) - 5 * 60000) return res.json({ ok: true, ignored: 'la partida es anterior a la sala' });
  // cruzar los jugadores de la partida con los de la sala
  const slotByRid = {}; m.teams.forEach(t => t.players.forEach(p => { slotByRid[ovNrk(p.rid)] = { uid: p.uid, side: t.side, nick: p.nick }; }));
  const rep = g.players.map(p => ({ p, s: slotByRid[ovNrk(p.rid)] })).filter(x => x.s);
  const sideTeam = {};
  for (const side of ['blue', 'red']){
    const ids = rep.filter(x => x.s.side === side).map(x => x.p.teamId), cnt = {}; ids.forEach(t => { cnt[t] = (cnt[t] || 0) + 1; });
    const best = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    sideTeam[side] = best ? Number(best[0]) : null;
    if (!m.sim && (!best || best[1] < 4)) return res.status(400).json({ error: 'los jugadores de la partida no coinciden con los de la sala' });
  }
  if (m.sim){ const me = rep.find(x => ovNrk(x.p.rid) === ovNrk(riotid)); if (!me) return res.status(400).json({ error: 'no estás en la partida reportada' });
    sideTeam[me.s.side] = me.p.teamId; sideTeam[me.s.side === 'blue' ? 'red' : 'blue'] = me.p.teamId === 100 ? 200 : 100; }
  if (sideTeam.blue === sideTeam.red) return res.status(400).json({ error: 'los equipos de la partida no coinciden con los de la sala' });
  const bw = won(sideTeam.blue), rw = won(sideTeam.red);
  if (bw === rw) return res.status(400).json({ error: 'no se pudo saber quién ganó' });
  const winner = bw ? 'blue' : 'red', keys = await rkChampKeys(), picks = m.draft.picks || {};
  const players = rep.map(({ p, s: sl }) => { const champ = keys[String(p.championId)] || (p.championName ? String(p.championName).replace(/[^A-Za-z]/g, '') : null);
    return { uid: sl.uid, nick: sl.nick, rid: p.rid, side: sl.side, teamId: p.teamId, champ, picked: picks[sl.uid] || null,
      k: num(p.kills), d: num(p.deaths), a: num(p.assists), cs: num(p.cs), gold: num(p.gold), dmg: num(p.damage), vision: num(p.vision), level: num(p.level),
      items: Array.isArray(p.items) ? p.items.map(num).filter(x => x).slice(0, 7) : [] }; });
  m.game = { gameId, duration: num(g.duration), creation: num(g.creation), src: String(g.src || '').slice(0, 20), reportedBy: (u && u.nickname) || riotid, players,
    offPick: players.filter(x => x.picked && x.champ && x.picked !== x.champ).map(x => x.nick) };   // jugaron otro campeón que el del draft
  await rkResolve(m, winner, 'overlay');
  res.json({ ok: true, applied: true, winner, matchId: m.id });
}));

// ================= HISTORIAL PRIVADO DE EQUIPOS (scrims / torneos) =================
// 1) El overlay manda un resumen de cada personalizada (mismo envío que Ranked). Si 3+ jugadores de un equipo de la org
//    estaban en el mismo lado, cae en la BANDEJA de ese equipo ('pending'). Las pendientes se borran a las 3 semanas.
// 2) El capitán (o un admin) la cataloga: scrim/torneo (cuál), rival y comentario → 'requested'.
// 3) El overlay de cualquier jugador de esa partida ve el pedido, saca del cliente la partida completa + línea de tiempo y
//    la sube → 'filed' (historial del equipo con tablero, resumen, estadísticas, gráficos y runas).
const TG_TOURNAMENTS = ['uLeague Clausura 2026'];   // torneos activos para catalogar (más "Otro")
let TG_MEM = { at: 0, map: null };
async function tgMembership(){   // Riot ID normalizado -> Set(equipos), extendido a todas las cuentas del mismo usuario
  if (TG_MEM.map && Date.now() - TG_MEM.at < 300000) return TG_MEM.map;
  const map = new Map(), add = (rid, t) => { const k = nrSmurf(rid); if (!k) return; if (!map.has(k)) map.set(k, new Set()); map.get(k).add(t); };
  for (const r of await q("SELECT riotid, team FROM team_members WHERE team IS NOT NULL AND team<>''")) if (TEAMS.has(r.team)) add(r.riotid, r.team);
  const users = await q('SELECT id, riotid, team FROM users'), smurfs = await q('SELECT user_id, riotid FROM smurfs');
  const accs = {}; users.forEach(u => { accs[u.id] = [u.riotid]; }); smurfs.forEach(s => { (accs[s.user_id] = accs[s.user_id] || []).push(s.riotid); });
  for (const u of users){ const ts = new Set(); if (u.team && TEAMS.has(u.team)) ts.add(u.team);
    (accs[u.id] || []).forEach(r => (map.get(nrSmurf(r)) || []).forEach(t => ts.add(t)));
    (accs[u.id] || []).forEach(r => ts.forEach(t => add(r, t))); }
  TG_MEM = { at: Date.now(), map }; return map;
}
async function tgUserTeams(uid){   // equipos de un usuario (por cualquiera de sus cuentas)
  const mem = await tgMembership(), ts = new Set();
  const u = await q1('SELECT riotid FROM users WHERE id=$1', [uid]); if (!u) return ts;
  const rids = [u.riotid, ...(await q('SELECT riotid FROM smurfs WHERE user_id=$1', [uid])).map(r => r.riotid)];
  rids.forEach(r => (mem.get(nrSmurf(r)) || []).forEach(t => ts.add(t))); return ts;
}
async function tgIsCaptain(uid, team){ return !!(await q1('SELECT 1 FROM team_captains WHERE team=$1 AND user_id=$2', [team, uid])); }
async function tgIngest(g, reporter){
  const players = (g.players || []).filter(p => p && p.rid).slice(0, 10);
  if (players.length < 6 || (Number(g.duration) || 0) < 180) return null;
  const gameId = String(g.gameId || '').replace(/\D/g, '').slice(0, 20); if (!gameId) return null;
  if (await q1("SELECT 1 FROM ranked_matches WHERE data->'game'->>'gameId' = $1", [gameId])) return null;   // era de Ranked
  const mem = await tgMembership(), num = v => Number.isFinite(+v) ? Math.round(+v) : null, keys = await rkChampKeys();
  const won = side => players.some(p => p.teamId === side && p.win === true) || (g.teams || []).some(t => t.teamId === side && t.win === true);
  const summary = { players: players.map(p => ({ rid: String(p.rid).slice(0, 40), teamId: p.teamId, champ: keys[String(p.championId)] || null, k: num(p.kills), d: num(p.deaths), a: num(p.assists), cs: num(p.cs), gold: num(p.gold) })) };
  const out = [];
  for (const team of TEAMS){
    for (const side of [100, 200]){
      const n = players.filter(p => p.teamId === side && (mem.get(nrSmurf(p.rid)) || new Set()).has(team)).length;
      if (n < 3) continue;
      await q(`INSERT INTO team_games (team, game_id, side, won, duration, game_at, summary, reported_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
               ON CONFLICT (team, game_id) DO NOTHING`, [team, gameId, side, won(side), num(g.duration), g.creation ? new Date(+g.creation) : new Date(), JSON.stringify(summary), String(reporter || '').slice(0, 60)]);
      out.push(team);
    }
  }
  return out;
}
// Normaliza la partida del cliente (historial del LCU) a un formato compacto para el detalle.
function tgNormGame(h){
  const ids = {}; (h.participantIdentities || []).forEach(pi => { ids[pi.participantId] = pi.player || {}; });
  const KEEP = ['kills','deaths','assists','champLevel','totalMinionsKilled','neutralMinionsKilled','neutralMinionsKilledTeamJungle','neutralMinionsKilledEnemyJungle','goldEarned','goldSpent',
    'totalDamageDealt','totalDamageDealtToChampions','physicalDamageDealtToChampions','magicDamageDealtToChampions','trueDamageDealtToChampions','totalDamageTaken','damageSelfMitigated',
    'totalHeal','damageDealtToObjectives','damageDealtToTurrets','visionScore','wardsPlaced','wardsKilled','visionWardsBoughtInGame','timeCCingOthers','totalTimeCrowdControlDealt',
    'turretKills','inhibitorKills','largestKillingSpree','largestMultiKill','doubleKills','tripleKills','quadraKills','pentaKills','firstBloodKill','firstTowerKill','killingSprees','win',
    'perk0','perk1','perk2','perk3','perk4','perk5','perkPrimaryStyle','perkSubStyle','statPerk0','statPerk1','statPerk2','item0','item1','item2','item3','item4','item5','item6'];
  return { gameId: String(h.gameId), creation: h.gameCreation, duration: h.gameDuration, mode: h.gameMode, version: h.gameVersion,
    teams: (h.teams || []).map(t => ({ teamId: t.teamId, win: t.win === 'Win' || t.win === true, towers: t.towerKills, inhibs: t.inhibitorKills, dragons: t.dragonKills, barons: t.baronKills, heralds: t.riftHeraldKills, bans: (t.bans || []).map(b => b.championId) })),
    players: (h.participants || []).map(p => { const pl = ids[p.participantId] || {}, st = {}; KEEP.forEach(k => { if (p.stats && p.stats[k] !== undefined) st[k] = p.stats[k]; });
      return { pid: p.participantId, teamId: p.teamId, rid: pl.gameName ? pl.gameName + '#' + pl.tagLine : (pl.summonerName || ''), championId: p.championId, spells: [p.spell1Id, p.spell2Id], st }; }) };
}
// Overlay: partidas pedidas por un capitán en las que este jugador estuvo (para que suba la partida completa).
app.get('/api/overlay/team-requests', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const k = nrSmurf(req.query.riotid || ''); if (!k.includes('#')) return res.json([]);
  const rows = await q("SELECT DISTINCT game_id, summary FROM team_games WHERE status='requested' AND created_at > now() - interval '60 days'");
  res.json(rows.filter(r => ((r.summary && r.summary.players) || []).some(p => nrSmurf(p.rid) === k)).map(r => r.game_id).slice(0, 5));
}));
app.post('/api/overlay/team-game', wrap(async (req, res) => {
  const b = req.body || {}, k = nrSmurf(b.riotid || ''), gameId = String(b.gameId || '').replace(/\D/g, '').slice(0, 20);
  if (!k.includes('#') || !gameId || !b.game || typeof b.game !== 'object') return res.status(400).json({ error: 'datos inválidos' });
  const rows = await q("SELECT id, summary FROM team_games WHERE game_id=$1 AND status='requested'", [gameId]);
  if (!rows.length) return res.json({ ok: true, ignored: 'no pedida' });
  const norm = tgNormGame(b.game);
  if (norm.gameId !== gameId || norm.players.length < 6) return res.status(400).json({ error: 'la partida no coincide' });
  const want = new Set(((rows[0].summary && rows[0].summary.players) || []).map(p => nrSmurf(p.rid)));
  if (!want.has(k) || norm.players.filter(p => want.has(nrSmurf(p.rid))).length < Math.min(want.size, 6)) return res.status(400).json({ error: 'los jugadores no coinciden' });
  const tl = b.timeline && typeof b.timeline === 'object' && Array.isArray(b.timeline.frames) ? b.timeline : null;
  const tlStr = tl ? JSON.stringify(tl) : null; if (tlStr && tlStr.length > 600000) return res.status(400).json({ error: 'línea de tiempo demasiado grande' });
  await q("UPDATE team_games SET data=$2::jsonb, timeline=$3::jsonb, status='filed', filed_at=coalesce(filed_at, now()) WHERE game_id=$1 AND status='requested'", [gameId, JSON.stringify(norm), tlStr]);
  res.json({ ok: true, filed: rows.length });
}));
// Equipos donde el usuario es integrante: solo por el roster (team_members) con su cuenta principal.
// (No cuenta el equipo elegido al registrarse ni las smurfs que uno mismo declara.)
async function tgRosterTeams(uid){
  const rows = await q(`SELECT DISTINCT tm.team FROM team_members tm JOIN users u ON lower(replace(u.riotid,' ','')) = lower(replace(tm.riotid,' ',''))
                        WHERE u.id=$1 AND tm.team IS NOT NULL`, [uid]);
  return new Set(rows.map(r => r.team).filter(t => TEAMS.has(t)));
}
// Web: el historial lo ven los integrantes del equipo; catalogar/editar solo su capitán y los admins.
async function tgAccess(req, team){
  const uid = await optionalUid(req); if (!uid) return null;
  const admin = await reqIsAdmin(req);
  if (team){ if (!TEAMS.has(team)) return null;
    const captain = admin || await tgIsCaptain(uid, team);
    if (!captain && !(await tgRosterTeams(uid)).has(team)) return null;
    return { uid, admin, captain }; }
  return { uid, admin };
}
app.get('/api/team/me', wrap(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const a = await tgAccess(req); if (!a) return res.status(401).json({ error: 'Inicia sesión' });
  const caps = new Set((await q('SELECT team FROM team_captains WHERE user_id=$1', [a.uid])).map(r => r.team)), roster = await tgRosterTeams(a.uid);
  const mine = a.admin ? [...TEAMS] : [...TEAMS].filter(t => caps.has(t) || roster.has(t));
  if (!mine.length) return res.status(403).json({ error: 'Solo para integrantes de un equipo' });
  res.json({ admin: a.admin, tournaments: TG_TOURNAMENTS, teams: mine.map(t => ({ team: t, captain: a.admin || caps.has(t) })) });
}));
app.get('/api/team/:team/games', wrap(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const team = req.params.team, a = await tgAccess(req, team); if (!a) return res.status(403).json({ error: 'No tienes acceso a este equipo' });
  await q("DELETE FROM team_games WHERE status='pending' AND created_at < now() - interval '21 days'").catch(() => {});
  const box = req.query.box === 'inbox' ? 'inbox' : 'history';
  if (box === 'inbox' && !a.captain) return res.status(403).json({ error: 'Solo el capitán y los admins' });
  const rows = await q(`SELECT id, game_id, status, kind, tournament, rival, comment, game_no, side, won, duration, game_at, summary, filed_at FROM team_games WHERE team=$1 AND ${box === 'inbox' ? "status='pending'" : "status IN ('requested','filed')"} ORDER BY game_at DESC LIMIT 100`, [team]);
  res.json({ captain: a.captain, games: rows });
}));
app.get('/api/team/:team/game/:id', wrap(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const team = req.params.team, a = await tgAccess(req, team); if (!a) return res.status(403).json({ error: 'No tienes acceso a este equipo' });
  const r = await q1('SELECT * FROM team_games WHERE team=$1 AND id=$2', [team, Number(req.params.id)]);
  if (!r || (r.status === 'pending' && !a.captain)) return res.status(404).json({ error: 'Partida no encontrada' });
  // rol de cada jugador en el roster de este equipo (para deducir roles en el análisis); se extiende a todas sus cuentas
  const ROLE_MAP = { TOP: 'TOP', JUNGLE: 'JUNGLE', JUNGLA: 'JUNGLE', MID: 'MIDDLE', MIDDLE: 'MIDDLE', ADC: 'BOTTOM', BOTTOM: 'BOTTOM', SUPPORT: 'UTILITY', SUP: 'UTILITY', UTILITY: 'UTILITY' };
  const rosterRoles = {};
  try { const tm = await q("SELECT riotid, role, starter FROM team_members WHERE team=$1 AND role IS NOT NULL AND role<>''", [team]);
    const users = await q('SELECT id, riotid FROM users'), smurfs = await q('SELECT user_id, riotid FROM smurfs');
    const accs = {}; users.forEach(u => { accs[u.id] = [u.riotid]; }); smurfs.forEach(s => { (accs[s.user_id] = accs[s.user_id] || []).push(s.riotid); });
    const owner = {}; Object.entries(accs).forEach(([id, list]) => list.forEach(rid => { owner[nrSmurf(rid)] = id; }));
    tm.sort((x, y) => (y.starter ? 1 : 0) - (x.starter ? 1 : 0)).forEach(m => { const role = ROLE_MAP[String(m.role).toUpperCase()]; if (!role) return;
      const k = nrSmurf(m.riotid), uid = owner[k], rids = uid ? accs[uid] : [m.riotid];
      rids.forEach(rid => { const kk = nrSmurf(rid); if (!rosterRoles[kk]) rosterRoles[kk] = role; }); }); } catch {}
  res.json({ ...r, rosterRoles });
}));
app.post('/api/team/:team/game/:id', auth, wrap(async (req, res) => {
  const team = req.params.team, a = await tgAccess(req, team); if (!a || !a.captain) return res.status(403).json({ error: 'Solo el capitán del equipo y los admins' });
  const r = await q1('SELECT id, status, (data IS NOT NULL) AS has_data FROM team_games WHERE team=$1 AND id=$2', [team, Number(req.params.id)]); if (!r) return res.status(404).json({ error: 'Partida no encontrada' });
  const b = req.body || {}, clip = (v, n) => String(v || '').trim().slice(0, n) || null;
  if (b.action === 'discard'){ await q('DELETE FROM team_games WHERE id=$1', [r.id]); return res.json({ ok: true }); }
  if (b.action === 'roles'){   // el capitán fija los roles a mano {pid: ROL}
    const OK = new Set(['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']), roles = {};
    for (const [pid, role] of Object.entries(b.roles || {})) if (/^\d{1,2}$/.test(pid) && OK.has(role)) roles[pid] = role;
    await q('UPDATE team_games SET roles=$2::jsonb WHERE id=$1', [r.id, Object.keys(roles).length ? JSON.stringify(roles) : null]);
    return res.json({ ok: true }); }
  const kind = b.kind === 'torneo' ? 'torneo' : b.kind === 'scrim' ? 'scrim' : null;
  if (!kind) return res.status(400).json({ error: 'Elige si fue scrim o torneo' });
  const tournament = kind === 'torneo' ? clip(b.tournament, 80) : null;
  if (kind === 'torneo' && !tournament) return res.status(400).json({ error: 'Elige el torneo' });
  // catalogar desde la bandeja → se pide la partida completa al overlay; editar una ya guardada solo cambia los datos
  // (si ya tiene los datos completos —p.ej. corregidos a mano— se guarda directo, sin pedirla de nuevo)
  const status = r.status === 'pending' ? (r.has_data ? 'filed' : 'requested') : r.status;
  const gameNo = /^[1-5]$/.test(String(b.gameNo)) ? +b.gameNo : null;
  await q(`UPDATE team_games SET kind=$2, tournament=$3, rival=$4, comment=$5, status=$6, filed_by=$7, filed_at=CASE WHEN $6='filed' THEN coalesce(filed_at, now()) ELSE filed_at END, game_no=$8 WHERE id=$1`, [r.id, kind, tournament, clip(b.rival, 60), clip(b.comment, 1000), status, a.uid, gameNo]);
  res.json({ ok: true, status });
}));
// ================= HERRAMIENTAS · LINKS (generales y por campeón) =================
// Los ve y los agrega la org; cada link lo borra quien lo agregó o un admin.
app.get('/api/links', wrap(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (!(await reqOrg(req))) return res.status(403).json({ error: 'Solo para jugadores de la organización' });
  const uid = await optionalUid(req), admin = await reqIsAdmin(req);
  const rows = await q('SELECT l.id, l.kind, l.champ, l.title, l.url, l.note, l.user_id, l.created_at, u.nickname FROM links l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC LIMIT 1000');
  res.json(rows.map(r => ({ ...r, canDelete: admin || (uid && r.user_id === uid) })));
}));
app.post('/api/links', auth, wrap(async (req, res) => {
  const b = req.body || {}, clip = (v, n) => String(v || '').trim().slice(0, n);
  const kind = b.kind === 'champ' ? 'champ' : 'general', title = clip(b.title, 120), url = clip(b.url, 600), note = clip(b.note, 400) || null;
  const champ = kind === 'champ' ? clip(b.champ, 40).replace(/[^A-Za-z]/g, '') : null;
  if (!title) return res.status(400).json({ error: 'Ponle un título' });
  if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(url)) return res.status(400).json({ error: 'El link debe empezar con http:// o https://' });
  if (kind === 'champ' && !(await rkChamps()).some(c => c.id === champ)) return res.status(400).json({ error: 'Elige un campeón de la lista' });
  if (await tooManyLinks(req.user.id)) return res.status(429).json({ error: 'Agregaste muchos links seguidos, espera un poco' });
  const r = await q1('INSERT INTO links (kind, champ, title, url, note, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [kind, champ, title, url, note, req.user.id]);
  res.json({ ok: true, id: r.id });
}));
const _linkHits = new Map();
async function tooManyLinks(uid){ const now = Date.now(), a = (_linkHits.get(uid) || []).filter(t => now - t < 600000); a.push(now); _linkHits.set(uid, a); return a.length > 20; }
app.post('/api/links/:id/delete', auth, wrap(async (req, res) => {
  const r = await q1('SELECT id, user_id FROM links WHERE id=$1', [Number(req.params.id)]); if (!r) return res.status(404).json({ error: 'Link no encontrado' });
  if (r.user_id !== req.user.id && !(await reqIsAdmin(req))) return res.status(403).json({ error: 'Solo quien lo agregó o un admin puede borrarlo' });
  await q('DELETE FROM links WHERE id=$1', [r.id]); res.json({ ok: true });
}));

// Admin: capitanes de cada equipo.
app.get('/api/admin/team-captains', auth, requireAdmin, wrap(async (req, res) => {
  res.json({ teams: [...TEAMS], captains: await q('SELECT c.team, c.user_id, u.nickname, u.riotid FROM team_captains c JOIN users u ON u.id = c.user_id ORDER BY c.team') });
}));
app.post('/api/admin/team-captains', auth, requireAdmin, wrap(async (req, res) => {
  const team = String((req.body && req.body.team) || ''), uid = Number(req.body && req.body.userId), on = !(req.body && req.body.on === false);
  if (!TEAMS.has(team) || !uid) return res.status(400).json({ error: 'Datos inválidos' });
  if (on) await q('INSERT INTO team_captains (team, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [team, uid]);
  else await q('DELETE FROM team_captains WHERE team=$1 AND user_id=$2', [team, uid]);
  res.json({ ok: true });
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
// Puesto real del jugador en el ranking (contando todas las cuentas, como lo ve la org). El overlay no tiene sesión y
// el ranking público viene sin smurfs, así que sin esto mostraba un puesto de menos. Solo cuentas de jugadores registrados.
app.get('/api/overlay/standing', wrap(async (req,res) => {
  res.set('Cache-Control', 'no-store');
  const rid = String(req.query.riotid || '').trim(), k = nrSmurf(rid);
  if (!/^.+#.+$/.test(rid)) return res.status(400).json({ error:'riotid inválido' });
  const known = await q1("SELECT 1 FROM users WHERE lower(regexp_replace(riotid, '[[:space:]]', '', 'g')) = $1 UNION SELECT 1 FROM smurfs WHERE lower(regexp_replace(riotid, '[[:space:]]', '', 'g')) = $1", [k]);
  if (!known) return res.status(404).json({ error:'Cuenta no registrada' });
  const all = liveSnapshot().players || [], i = all.findIndex(p => nrSmurf(p.rid) === k);
  // objetivo = la cuenta justo arriba (aunque sea una smurf), con el nick de su dueño como lo ve la org en el ranking
  const TV = { IRON:0, BRONZE:1, SILVER:2, GOLD:3, PLATINUM:4, EMERALD:5, DIAMOND:6 }, DV = { IV:0, III:1, II:2, I:3 };
  const abs = p => !p || !p.tier || p.tier === 'UNRANKED' ? 0 : ['MASTER','GRANDMASTER','CHALLENGER'].includes(p.tier) ? 2800 + (p.lp || 0) : (TV[p.tier] || 0) * 400 + (DV[p.div] || 0) * 100 + (p.lp || 0);
  let target = null;
  if (i > 0){ const up = all[i - 1], k2 = nrSmurf(up.rid);
    const o = await q1("SELECT u.nickname FROM users u WHERE lower(regexp_replace(u.riotid, '[[:space:]]', '', 'g')) = $1 UNION ALL SELECT u.nickname FROM smurfs s JOIN users u ON u.id = s.user_id WHERE lower(regexp_replace(s.riotid, '[[:space:]]', '', 'g')) = $1 LIMIT 1", [k2]);
    target = { name: (o && o.nickname) || up.nm || String(up.rid).split('#')[0], lp: Math.max(0, abs(up) - abs(all[i])) }; }
  res.json({ pos: i >= 0 ? i + 1 : null, total: all.length, target });
}));
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
app.get('/api/nav-counts', wrap(async (req,res) => {
  const org = await reqOrg(req);
  const live = (org && liveData && Array.isArray(liveData.liveGames)) ? liveData.liveGames.length : 0;
  const encEnds = (org && liveData && Array.isArray(liveData.encounters)) ? liveData.encounters.map(e => e.end || 0) : [];
  res.json({ live, encEnds, recSig: _recSig, recEnd: _recEnd });   // recSig: firma de récords (para el badge de Estadísticas)
}));
// players.json (el que se consulta cada 30s por polling): cacheable ~20s → Cloudflare lo
// sirve del borde y baja la banda. players.js es la carga INICIAL de cada página (script tag):
// SIN caché, así el primer render nunca sale con un snapshot viejo (evita cronómetros de live
// games inflados al abrir). Cargar players.js fresco 1 vez por página es despreciable.
// Snapshot público SIN live games ni encuentros (dicen quién juega ahora, con qué y con quién): eso va en /api/live, solo org.
const publicSnap = () => {
  let d = liveData; if (!d){ try { d = JSON.parse(fs.readFileSync(path.join(ROOT, 'players.json'), 'utf8')); } catch { d = { players: [] }; } }
  return { ...d, liveGames: [], encounters: [], orgOnly: true,
    players: (d.players || []).filter(p => !isSmurf(p.rid)).map(p => ({ ...p, inGame: false, game: null })) };
};
app.get('/players.json', (req,res) => { res.setHeader('Cache-Control', 'public, max-age=20'); res.json(publicSnap()); });
app.get('/api/live', wrap(async (req,res) => {
  res.set('Cache-Control', 'private, no-store');
  if (!(await reqOrg(req))) return res.status(403).json({ error:'Solo para jugadores de la organización' });
  // Si el snapshot tiene más de 10 min (el tracker se atrasó), sus partidas "en vivo" probablemente ya terminaron:
  // no se muestran, para no dejar tarjetas fantasma con cronómetros de 80+ minutos.
  const age = liveData && liveData.updatedAt ? Date.now() - new Date(liveData.updatedAt).getTime() : Infinity, stale = age > 10 * 60 * 1000;
  res.json({ liveGames: stale ? [] : ((liveData && liveData.liveGames) || []), encounters: (liveData && liveData.encounters) || [], updatedAt: liveData && liveData.updatedAt, stale,
    inGame: stale ? [] : ((liveData && liveData.players) || []).filter(p => p.inGame).map(p => ({ rid: p.rid, game: p.game || null })),
    smurfs: (liveSnapshot().players || []).filter(p => isSmurf(p.rid)).map(p => ({ ...p, inGame: stale ? false : !!p.inGame, game: stale ? null : (p.game || null) })),
    order: (liveSnapshot().players || []).map(p => p.rid) });
}));
app.get('/players.js',   (req,res) => { res.setHeader('Cache-Control', 'no-store'); res.type('application/javascript').send('window.SQC_DATA = ' + JSON.stringify(publicSnap()) + ';\n'); });

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
  loadSmurfSet().catch(() => {}); res.json({ ok:true, smurf, main });
}));
app.post('/api/admin/smurf-unlink', auth, requireAdmin, wrap(async (req,res) => {
  const smurf = ((req.body && req.body.smurf) || '').trim();
  await q('DELETE FROM smurf_links WHERE lower(smurf_riotid)=lower($1)', [smurf]);
  loadSmurfSet().catch(() => {}); res.json({ ok:true });
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
  // sin importar mayúsculas ni espacios ("Henry Miller #379" == "henrymiller#379")
  const u = await q1("SELECT id, email, nickname FROM users WHERE lower(regexp_replace(riotid, '[[:space:]]', '', 'g')) = lower(regexp_replace($1, '[[:space:]]', '', 'g'))", [riotid]);
  if (!u) return res.status(400).json({ error:'Ese jugador no tiene cuenta registrada' });
  const temp = Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(temp, 10), u.id]);
  for (const k of [..._hits.keys()]) if (k.startsWith('login|')) _hits.delete(k);   // y que pueda entrar al tiro
  res.json({ ok:true, email: u.email, nickname: u.nickname, password: temp });
}));
// Liberar los bloqueos por intentos fallidos de inicio de sesión (son por conexión/IP, no por cuenta).
app.post('/api/admin/login-unlock', auth, requireAdmin, wrap(async (req,res) => {
  let n = 0; for (const k of [..._hits.keys()]) if (k.startsWith('login|')){ _hits.delete(k); n++; }
  res.json({ ok:true, cleared: n });
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
async function statsFor(req, data){
  if (await reqOrg(req)){ req.res.set('Cache-Control', 'private, no-store'); return data; }
  return stripSmurfs({ ...data, coincidencias: null, contrincantes: null, orgOnly: true });
}
app.get('/api/stats', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');   // Cloudflare lo sirve del borde (menos hits al origen)
  if (STATS_CACHE.data && Date.now() - STATS_CACHE.at < 300000) return res.json(await statsFor(req, STATS_CACHE.data));

  // ---- Identidad de CUENTA por PUUID (consolida renombres) + JUGADOR (dueño) ----
  // El puuid no cambia aunque cambie el Riot ID, así una cuenta renombrada cuenta como una sola.
  const snapPlayers = liveSnapshot().players || [];
  // rid (incluye nombres VIEJOS) -> acct(puuid), desde el historial crudo.
  // Resolución rid -> puuid robusta (snapshot + historial, normalizando espacios del '#'),
  // para que la cuenta de un jugador calce con sus agregaciones (keyeadas por puuid) y se
  // consolide bien aunque el rid del smurf tenga espacios raros ("shr uzi #las1").
  const acctByRid = await ridPuuidMap();   // historial: lower(rid) -> puuid
  const nrid = r => (r || '').toLowerCase().replace(/\s*#\s*/, '#').trim();
  const rid2puuid = {};
  snapPlayers.forEach(p => { if (p.rid && p.puuid) rid2puuid[nrid(p.rid)] = p.puuid; });
  for (const [r, pu] of Object.entries(acctByRid)){ const k = nrid(r); if (!rid2puuid[k]) rid2puuid[k] = pu; }
  const acctOf = rid => rid2puuid[nrid(rid)] || nrid(rid);
  const metaByAcct = {};   // acct(puuid) -> { nm, tier, high, pos, abs, rid }
  snapPlayers.forEach((p, i) => {
    const rid = (p.rid || '').toLowerCase(); const acct = p.puuid || acctOf(rid);   // mismo acct (puuid) que las agregaciones
    const high = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(p.tier);
    if (!metaByAcct[acct]) metaByAcct[acct] = { nm: p.nm || rid.split('#')[0], tier: p.tier || 'UNRANKED', high, pos: i + 1, abs: absLPof(p.tier, p.div, p.lp) || 0, rid };
  });
  // Jugador (dueño) por cuenta: main + smurfs registrados → user id; + nick del jugador.
  const puuidOwner = {}, ownerNick = {}, mainAcct = {};
  try {
    for (const u of await q("SELECT id, nickname, riotid FROM users WHERE coalesce(riotid,'')<>''")){ puuidOwner[acctOf(u.riotid)] = 'u' + u.id; ownerNick['u' + u.id] = (u.nickname || '').trim(); mainAcct['u' + u.id] = acctOf(u.riotid); }
    for (const s of await q("SELECT user_id, riotid FROM smurfs WHERE coalesce(riotid,'')<>''")) puuidOwner[acctOf(s.riotid)] = 'u' + s.user_id;
  } catch {}
  const playerOf = acct => puuidOwner[acct] || acct;   // jugador (dueño) del acct
  // Excluir de TOPS las cuentas secundarias de un jugador (solo cuenta la más alta).
  const ownerAccts = {};
  for (const acct in puuidOwner) (ownerAccts[puuidOwner[acct]] = ownerAccts[puuidOwner[acct]] || []).push(acct);
  const excludeAcct = new Set();
  for (const o in ownerAccts){ const accts = [...new Set(ownerAccts[o])]; if (accts.length < 2) continue;
    accts.sort((a, b) => ((metaByAcct[b] && metaByAcct[b].abs) || 0) - ((metaByAcct[a] && metaByAcct[a].abs) || 0));
    accts.slice(1).forEach(a => excludeAcct.add(a)); }
  // Mejor cuenta de cada dueño (mayor LP absoluto presente en el ranking): para mostrar SU elo real
  // (Master/GM/Chall) y no el de un smurf de menor elo que casualmente apareció primero en una coincidencia.
  const ownerBest = {};
  for (const o in ownerAccts){
    const best = [...new Set(ownerAccts[o])].filter(a => metaByAcct[a])
      .sort((a, b) => (metaByAcct[b].abs || 0) - (metaByAcct[a].abs || 0))[0];
    if (best) ownerBest[o] = best;
  }

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
    FROM mp_stats
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
  // Winrate de la SEASON (del ranking, no de las partidas trackeadas): 1 cuenta por jugador
  // (la mejor, misma exclusión que los demás tops), mín. 30 partidas rankeadas.
  const winrate = snapPlayers
    .map((p, i) => ({ p, pos: i + 1, acct: acctByRid[(p.rid || '').toLowerCase()] || p.puuid || (p.rid || '').toLowerCase() }))
    .filter(x => !excludeAcct.has(x.acct) && ((x.p.w || 0) + (x.p.l || 0)) >= 30)
    .map(x => { const p = x.p, g = (p.w || 0) + (p.l || 0);
      return { rid: p.rid, nm: p.nm, tier: p.tier || 'UNRANKED', high: ['MASTER','GRANDMASTER','CHALLENGER'].includes(p.tier),
               pos: x.pos, games: g, wins: p.w || 0, value: g ? (p.w || 0) / g * 100 : 0 }; })
    .sort((a, b) => b.value - a.value || b.games - a.games)
    .slice(0, 5);
  const tops = { kills: topN('kavg', 5, 10), deaths: topN('davg', 5, 10), assists: topN('aavg', 5, 10),
    csmin: topN('csmin', 5, 10, 'gamesNs'), goldmin: topN('goldmin', 5, 10), kda: topN('kda', 5, 10), winrate };

  // ---- COINCIDENCIAS: verdugos + duelos (solo en equipos contrarios) ----
  // Identidad por CUENTA = puuid (consolida renombres) y por JUGADOR = dueño (main+smurfs).
  const encRows = await q(`
    SELECT match_id, ${ACCT} acct,
           (array_agg(lower(riotid) ORDER BY game_end DESC NULLS LAST))[1] rid,
           (array_agg(name       ORDER BY game_end DESC NULLS LAST))[1] nm,
           bool_or(win) win, max(team_id) team
    FROM mp_stats
    WHERE is_tournament=true AND riotid IS NOT NULL AND coalesce(duration,0) >= 300   -- excluye remakes (<5min)
      AND match_id IN (SELECT match_id FROM mp_stats WHERE is_tournament=true AND coalesce(duration,0) >= 300
                       GROUP BY match_id HAVING count(distinct ${ACCT}) >= 2)
    GROUP BY match_id, ${ACCT}`);
  const byMatch = {};
  for (const r of encRows) (byMatch[r.match_id] = byMatch[r.match_id] || []).push(r);
  const repRid = {}, repAcct = {};   // clave de jugador -> rid/acct representativo (para nick/tier/OP.GG)
  const verd = {}, duel = {};
  let coincCount = 0;
  // CUENTAS PRESTADAS: en las partidas donde coincide `partnerRid`, la participación del dueño de
  // `ownerRid` la jugaba en realidad `realRid` → se reasigna esa participación (solo esas partidas).
  const LENTS = [
    { ownerRid:'voidpages#111', partnerRid:'matotomatoxd#las', realRid:'sionantisionista#sas' },   // Sion jugó la cuenta de Kriideastoraa con matotomatoxd
  ].map(o => ({ owner: playerOf(acctOf(o.ownerRid.toLowerCase())), partner: playerOf(acctOf(o.partnerRid.toLowerCase())),
                real: playerOf(acctOf(o.realRid.toLowerCase())), realRid: o.realRid, realAcct: acctOf(o.realRid.toLowerCase()) }))
   .filter(o => o.owner && o.partner && o.real && o.owner !== o.real);
  LENTS.forEach(o => { if (!repRid[o.real]){ repRid[o.real] = o.realRid; repAcct[o.real] = o.realAcct; } });   // nick/OP.GG correctos para el dueño real
  // Asignaciones manuales por partida (account sharing, las pone el admin): match_id|puuid -> 'u'+user_id.
  const gameAssign = {};
  try { for (const r of await q('SELECT match_id, puuid, user_id FROM game_assignments')) gameAssign[r.match_id + '|' + r.puuid] = 'u' + r.user_id; } catch {}
  for (const mid in byMatch) {
    const ps = byMatch[mid]; if (ps.length < 2) continue; coincCount++;
    // Dueño EFECTIVO por partida: 1) asignación manual del admin, 2) cuenta prestada (partner presente).
    const ownersHere = new Set(ps.map(p => playerOf(p.acct)));
    const effOwner = acct => {
      const a = gameAssign[mid + '|' + acct]; if (a) return a;
      const base = playerOf(acct);
      for (const o of LENTS){ if (base === o.owner && ownersHere.has(o.partner)) return o.real; }
      return base;
    };
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const A = ps[i], B = ps[j];
      const pa = effOwner(A.acct), pb = effOwner(B.acct);
      if (pa === pb) continue;   // dos cuentas de la misma persona: no es dúo ni duelo
      if (!repRid[pa]){ repRid[pa] = A.rid; repAcct[pa] = A.acct; }
      if (!repRid[pb]){ repRid[pb] = B.rid; repAcct[pb] = B.acct; }
      const key = [pa, pb].sort(); const kk = key.join('|');
      const dd = duel[kk] || (duel[kk] = { a: key[0], b: key[1], aw: 0, bw: 0, together: 0, tw: 0 });
      if (A.team === B.team) { dd.together++; if (A.win) dd.tw++; continue; }   // aliados (dúo): guarda V/D juntos
      const dec = A.win !== B.win; if (!dec) continue;         // debe haber ganador/perdedor
      const winner = A.win ? A : B; const wKey = effOwner(winner.acct);
      verd[pa] = verd[pa] || { wins: 0, duels: 0 }; verd[pb] = verd[pb] || { wins: 0, duels: 0 };
      verd[pa].duels++; verd[pb].duels++; verd[wKey].wins++;
      if (wKey === dd.a) dd.aw++; else dd.bw++;
    }
  }
  // Meta de un JUGADOR: nick del registrado (o nombre de la cuenta si no está registrada) + tier/high.
  const pmeta = pkey => { const rid = repRid[pkey] || pkey;
    const m = metaByAcct[ownerBest[pkey]] || metaByAcct[repAcct[pkey]] || {};   // elo del MAIN del jugador, no del smurf
    return { rid, nm: ownerNick[pkey] || m.nm || rid.split('#')[0], high: !!m.high }; };
  const verdugos = Object.entries(verd).map(([pkey, s]) => ({ ...pmeta(pkey), wins: s.wins, duels: s.duels,
      wr: s.duels ? Math.round(s.wins / s.duels * 100) : 0 }))
    .sort((a, b) => b.wins - a.wins || b.wr - a.wr).slice(0, 12);
  // Antónimo de VERDUGOS: más DERROTAS contra otros participantes (wins=derrotas aquí, wr=% de derrota).
  const victimas = Object.entries(verd).map(([pkey, s]) => ({ ...pmeta(pkey), wins: s.duels - s.wins, duels: s.duels,
      wr: s.duels ? Math.round((s.duels - s.wins) / s.duels * 100) : 0 }))
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
  // Un dúo con winrate POSITIVo (>50%) no puede figurar entre los "peores".
  const duosWorst = duosAll.filter(d => d.wr <= 50).sort((x, y) => x.hi - y.hi || y.games - x.games).slice(0, 8);

  // ---- CONTRINCANTES externos: rivales AJENOS al torneo, por victorias/derrotas nuestras ----
  // Cada partida guardada trae los 10 jugadores; los que NO son del torneo son "contrincantes".
  // Si su equipo perdió, nosotros les ganamos (w++); si ganó, nos ganaron (l++).
  // El conteo se hace en la base y vuelven solo los 15 mejores y 15 peores rivales enfrentados ≥2 veces (antes se traían las ~78 mil
  // filas de participantes, ~10 MB por lectura, para contarlas aquí: la segunda mayor fuente de egress).
  const oppArr = await q(`
    WITH g AS (SELECT match_id, team_id, puuid, max(name) nm, max(lower(riotid)) rid, bool_or(win) win, bool_or(is_tournament) is_t
               FROM mp_stats WHERE coalesce(puuid,'')<>'' GROUP BY match_id, team_id, puuid),
         tp AS (SELECT DISTINCT puuid FROM g WHERE is_t),
         tt AS (SELECT DISTINCT match_id, team_id FROM g WHERE is_t),
         o AS (SELECT max(g.nm) nm, max(g.rid) rid, (count(*) FILTER (WHERE NOT g.win))::int w, (count(*) FILTER (WHERE g.win))::int l
               FROM g JOIN tt ON tt.match_id = g.match_id AND tt.team_id = CASE WHEN g.team_id = 100 THEN 200 ELSE 100 END
               WHERE NOT EXISTS (SELECT 1 FROM tp WHERE tp.puuid = g.puuid)
               GROUP BY g.puuid HAVING count(*) >= 2)   -- w = le ganamos (su equipo perdió) · l = nos ganó
    SELECT nm, rid, w, l FROM (SELECT o.*, row_number() OVER (ORDER BY w DESC, l ASC) rb, row_number() OVER (ORDER BY l DESC, w ASC) rw FROM o) x
    WHERE rb <= 15 OR rw <= 15`);              // solo hacen falta los 15 mejores y los 15 peores
  // Mejores: más victorias; en empate, primero al que MENOS le hemos perdido.
  const rivalesBest  = oppArr.slice().sort((a, b) => b.w - a.w || a.l - b.l).slice(0, 15);
  // Peores: más derrotas; en empate, primero al que MENOS le hemos ganado.
  const rivalesWorst = oppArr.slice().sort((a, b) => b.l - a.l || a.w - b.w).slice(0, 15);

  // Historial de coincidencias: el snapshot en vivo ya trae las últimas 60. Mostramos el nick del
  // JUGADOR REGISTRADO por participante (no el nombre del smurf).
  // Si en la MISMA partida hay 2+ cuentas del mismo dueño (main + smurf a la vez = account sharing),
  // la main lleva el nick del dueño y las demás su propio nombre de cuenta.
  const historial = (liveSnapshot().encounters || []).map(e => {
    const cnt = {}; (e.players || []).forEach(pl => { const o = playerOf(acctByRid[(pl.rid || '').toLowerCase()] || (pl.rid || '').toLowerCase()); cnt[o] = (cnt[o] || 0) + 1; });
    return { ...e, players: (e.players || []).map(pl => {
      const acct = acctByRid[(pl.rid || '').toLowerCase()] || (pl.rid || '').toLowerCase();
      const o = playerOf(acct);
      let nm = pl.nm;
      if (ownerNick[o]) nm = ((cnt[o] || 0) <= 1 || (mainAcct[o] && acct === mainAcct[o])) ? ownerNick[o] : pl.nm;
      return { ...pl, nm };
    }) };
  });

  // ---- ELO: subidones/bajones por día + serie de evolución (desde ±LP guardados) ----
  // El caché de ±LP ya está keyeado por puuid (consolidado por cuenta); la meta también.
  let store = (await matchesBlob()) || {};   // disco local del runner o Supabase cacheado 60s (anti-egress)
  // Partidas guardadas por cuenta (win/loss). Riot NO da el LP histórico, así que la curva se
  // reconstruye desde aquí: LP exacto donde el runner lo capturó (lpGames), estimado por V/D si no.
  const gamesByPuuid = {};
  for (const g of await q("SELECT puuid, game_end, win, coalesce(no_lp,false) no_lp FROM match_participants WHERE is_tournament=true AND coalesce(puuid,'')<>'' AND game_end IS NOT NULL ORDER BY game_end ASC"))
    (gamesByPuuid[g.puuid] = gamesByPuuid[g.puuid] || []).push({ t: Number(g.game_end), win: !!g.win, noLp: !!g.no_lp });
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
    const perGame = gs.map(g => ({ t: g.t, delta: g.noLp ? 0 : (g.t in deltaByEnd) ? deltaByEnd[g.t] : (g.win ? STEP : -STEP) }));
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

  STATS_CACHE.data = { tops, elo: { subidones, bajones, series, avgSeries }, coincidencias: { count: coincCount, verdugos, victimas, duelos, duosBest, duosWorst, historial }, contrincantes: { best: rivalesBest, worst: rivalesWorst } };
  STATS_CACHE.at = Date.now();
  res.json(await statsFor(req, STATS_CACHE.data));
}));

// ---- Encuentros (aliados Y rivales) desde match_participants ----
// Se reconstruye del historial COMPLETO guardado (no de la ventana de 20 partidas en
// memoria), así se detectan también los cruces como rivales, no solo los dúos. SoloQ.
const ENC_CACHE = { at: 0, data: null };
app.get('/api/encounters', orgOnly, wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');   // Cloudflare lo sirve del borde
  if (ENC_CACHE.data && Date.now() - ENC_CACHE.at < 300000) return res.json(ENC_CACHE.data);
  // Nickname del torneo por cuenta (para mostrar el nick, no el summoner name).
  const meta = {};
  (liveSnapshot().players || []).forEach(p => { meta[(p.rid || '').toLowerCase()] = p.nm || (p.rid || '').split('#')[0]; });
  // Nick del JUGADOR REGISTRADO por puuid: si la cuenta (main o smurf) es de un usuario, mostramos SU
  // nick, no el de la cuenta (p.ej. un smurf aparece con el nombre del dueño).
  const rid2puuid = await ridPuuidMap();
  const uNick = {}, puuidOwner = {}, mainPuuid = {};
  try {
    for (const u of await q("SELECT id, nickname, lower(riotid) rid FROM users")){ uNick['u'+u.id] = (u.nickname||'').trim();
      const pu = u.rid && rid2puuid[u.rid]; if (pu){ puuidOwner[pu] = 'u'+u.id; mainPuuid['u'+u.id] = pu; } }
    for (const s of await q("SELECT user_id, lower(riotid) rid FROM smurfs WHERE coalesce(riotid,'')<>''")){
      const pu = rid2puuid[s.rid]; if (pu) puuidOwner[pu] = 'u'+s.user_id; }
  } catch {}
  const ownerOf = rid => puuidOwner[rid2puuid[rid]] || rid;   // id del dueño ('u'+id) o el rid si no está registrado
  // Nombre a mostrar por participante DENTRO de una partida: normalmente el nick del dueño; pero si en
  // la MISMA partida hay 2+ cuentas del mismo dueño (main + smurf a la vez), no puede ser una sola
  // persona (account sharing) → la MAIN lleva el nick del dueño y las demás su propio nombre de cuenta.
  const dispName = (rid, ownerCountInMatch) => {
    const acct = meta[rid] || null;
    const o = ownerOf(rid), pu = rid2puuid[rid];
    if (!uNick[o]) return acct;                                   // cuenta no registrada
    if ((ownerCountInMatch[o] || 0) <= 1) return uNick[o];        // única cuenta del dueño en la partida
    return (mainPuuid[o] && pu === mainPuuid[o]) ? uNick[o] : acct;  // main -> dueño; smurf -> cuenta
  };
  const rows = await q(`
    SELECT match_id, lower(riotid) rid, max(name) nm, bool_or(win) win, bool_or(coalesce(no_lp,false)) nolp, bool_or(coalesce(voided,false)) voided,
           max(team_id) team, max(champion) champ, max(game_end) gend
    FROM match_participants
    WHERE is_tournament=true AND riotid IS NOT NULL AND coalesce(duration,0) >= 300   -- excluye remakes (<5min)
      AND match_id IN (SELECT match_id FROM match_participants WHERE is_tournament=true AND coalesce(duration,0) >= 300
                       GROUP BY match_id HAVING count(distinct lower(riotid)) >= 2)
    GROUP BY match_id, lower(riotid)`);
  const byMatch = {};
  for (const r of rows) (byMatch[r.match_id] = byMatch[r.match_id] || []).push(r);
  const encounters = Object.entries(byMatch).map(([id, ps]) => {
    const ownerCount = {}; ps.forEach(p => { const o = ownerOf(p.rid); ownerCount[o] = (ownerCount[o] || 0) + 1; });
    return { id, end: Math.max(...ps.map(p => Number(p.gend) || 0)), voided: ps.some(p => p.voided),
      players: ps.map(p => ({ nm: dispName(p.rid, ownerCount) || p.nm, rid: p.rid, win: !!p.win, noLp: !!p.nolp, champ: p.champ || null })) };
  }).filter(e => e.players.length >= 2)
    .sort((a, b) => (b.end || 0) - (a.end || 0)).slice(0, 400);   // historial completo (antes se cortaba en 100)
  ENC_CACHE.data = { encounters };
  ENC_CACHE.at = Date.now();
  res.json(ENC_CACHE.data);
}));

// ---- EQUIPOS: métricas de sinergia (jugando JUNTOS), no promedios que ya se ven en el leaderboard ----
const TEAMSTATS_CACHE = { at: 0, data: null };
async function teamStatsFor(req, data){
  if (await reqOrg(req)){ req.res.set('Cache-Control', 'private, no-store'); return data; }
  return { ...data, teams: (data.teams || []).map(t => ({ ...t, bestDuo: null })) };
}
app.get('/api/team-stats', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  if (TEAMSTATS_CACHE.data && Date.now() - TEAMSTATS_CACHE.at < 300000) return res.json(await teamStatsFor(req, TEAMSTATS_CACHE.data));
  const rid2puuid = await ridPuuidMap();
  const acctOf = rid => rid2puuid[rid] || rid;
  // Dueño por cuenta (main + smurfs) + nick.
  const uNick = {}, puuidOwner = {};
  for (const u of await q("SELECT id, nickname, lower(riotid) rid FROM users WHERE coalesce(riotid,'')<>''")){ uNick['u'+u.id] = (u.nickname||'').trim(); puuidOwner[acctOf(u.rid)] = 'u'+u.id; }
  for (const s of await q("SELECT user_id, lower(riotid) rid FROM smurfs WHERE coalesce(riotid,'')<>''")) puuidOwner[acctOf(s.rid)] = 'u'+s.user_id;
  const ownerOf = rid => puuidOwner[acctOf((rid||'').toLowerCase())] || (rid||'').toLowerCase();
  const nmByOwner = {};   // nombre legible para cuentas NO registradas (desde el ranking)
  (liveSnapshot().players || []).forEach(p => { const o = ownerOf((p.rid||'').toLowerCase()); if (!nmByOwner[o]) nmByOwner[o] = p.nm; });
  const nickOf = owner => uNick[owner] || nmByOwner[owner] || (String(owner).includes('#') ? String(owner).split('#')[0] : owner);
  // Membresía de equipo: por DUEÑO (consolida main+smurfs).
  const teamOfOwner = {}, teamOwners = {};
  for (const r of await q("SELECT lower(riotid) rid, team FROM team_members WHERE coalesce(team,'')<>''")){
    const o = ownerOf(r.rid); teamOfOwner[o] = r.team; (teamOwners[r.team] = teamOwners[r.team] || new Set()).add(o);
  }
  // Winrate individual (season): mejor cuenta por dueño (más partidas) desde el ranking.
  const bestWR = {};
  (liveSnapshot().players || []).forEach(p => { const o = ownerOf((p.rid||'').toLowerCase()); if (!teamOfOwner[o]) return;
    const g = (p.w||0)+(p.l||0); const cur = bestWR[o]; if (g && (!cur || g > cur.g)) bestWR[o] = { g, w:p.w||0 }; });
  // Partidas JUNTOS (2+ del mismo equipo aliados) + parejas internas.
  const rows = await q(`SELECT match_id, lower(riotid) rid, max(team_id) side, bool_or(win) win
    FROM mp_stats WHERE is_tournament=true AND riotid IS NOT NULL AND coalesce(duration,0) >= 300 GROUP BY match_id, lower(riotid)`);
  const byMatch = {}; for (const r of rows) (byMatch[r.match_id] = byMatch[r.match_id] || []).push(r);
  const teamAgg = {}, pairAgg = {};
  for (const mid in byMatch){
    const bySideTeam = {};   // team -> side -> Map(owner->win)
    for (const p of byMatch[mid]){ const o = ownerOf(p.rid), t = teamOfOwner[o]; if (!t) continue;
      (((bySideTeam[t] = bySideTeam[t]||{})[p.side]) = bySideTeam[t][p.side] || new Map()).set(o, !!p.win); }
    for (const t in bySideTeam) for (const side in bySideTeam[t]){
      const arr = [...bySideTeam[t][side].entries()]; if (arr.length < 2) continue;   // 2+ aliados del equipo
      const won = arr[0][1];
      const ta = teamAgg[t] = teamAgg[t] || { games:0, wins:0 }; ta.games++; if (won) ta.wins++;
      const os = arr.map(x=>x[0]).sort();
      for (let i=0;i<os.length;i++) for (let j=i+1;j<os.length;j++){ const k = t+'|'+os[i]+'|'+os[j];
        const pa = pairAgg[k] = pairAgg[k] || { a:os[i], b:os[j], w:0, l:0 }; if (won) pa.w++; else pa.l++; }
    }
  }
  const teams = Object.keys(teamOwners).map(t => {
    const owners = [...teamOwners[t]];
    const wrs = owners.map(o => bestWR[o]).filter(Boolean);
    const indAvg = wrs.length ? wrs.reduce((s,x)=>s + x.w/x.g, 0)/wrs.length*100 : 0;
    const ta = teamAgg[t] || { games:0, wins:0 };
    const juntosWR = ta.games ? ta.wins/ta.games*100 : 0;
    let best = null;
    for (const k in pairAgg){ const pa = pairAgg[k]; if (!k.startsWith(t+'|')) continue; const g = pa.w+pa.l; if (g < 2) continue;
      const wr = pa.w/g*100; if (!best || wr > best.wr || (wr===best.wr && g > best.games))
        best = { a: nickOf(pa.a), b: nickOf(pa.b), w:pa.w, l:pa.l, games:g, wr: Math.round(wr) }; }
    return { team:t, members: owners.length,
      juntosWR: Math.round(juntosWR), juntosGames: ta.games, juntosW: ta.wins, juntosL: ta.games - ta.wins,
      indAvg: Math.round(indAvg), sinergia: Math.round(juntosWR - indAvg), bestDuo: best };
  }).sort((a,b) => (b.juntosGames?b.juntosWR:-1) - (a.juntosGames?a.juntosWR:-1) || b.juntosGames - a.juntosGames);
  TEAMSTATS_CACHE.data = { teams };
  TEAMSTATS_CACHE.at = Date.now();
  res.json(await teamStatsFor(req, TEAMSTATS_CACHE.data));
}));

// ---- MENCIONES: premios graciosos (roasts + vicio + pool + dúos) ----
const MENC_CACHE = { at: 0, data: null };
async function mencFor(req, data){
  if (await reqOrg(req)){ req.res.set('Cache-Control', 'private, no-store'); return data; }
  return { ...data, menciones: (data.menciones || []).filter(m => !/d[uú]o|pareja/i.test(m.title || '')) };   // premios de dúos: solo org
}
const CL_FMT = new Intl.DateTimeFormat('en-CA', { timeZone:'America/Santiago', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hour12:false });
function chileHD(ts){ const o = {}; for (const x of CL_FMT.formatToParts(new Date(Number(ts)||0))) o[x.type] = x.value; return { d: `${o.year}-${o.month}-${o.day}`, h: (+o.hour) % 24 }; }
app.get('/api/menciones', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  if (MENC_CACHE.data && Date.now() - MENC_CACHE.at < 300000) return res.json(await mencFor(req, MENC_CACHE.data));
  const rid2puuid = await ridPuuidMap();
  const acctOf = rid => rid2puuid[rid] || rid;
  const uNick = {}, puuidOwner = {};
  for (const u of await q("SELECT id, nickname, lower(riotid) rid FROM users WHERE coalesce(riotid,'')<>''")){ uNick['u'+u.id] = (u.nickname||'').trim(); puuidOwner[acctOf(u.rid)] = 'u'+u.id; }
  for (const s of await q("SELECT user_id, lower(riotid) rid FROM smurfs WHERE coalesce(riotid,'')<>''")) puuidOwner[acctOf(s.rid)] = 'u'+s.user_id;
  const ownerOf = rid => puuidOwner[acctOf((rid||'').toLowerCase())] || (rid||'').toLowerCase();
  const peakByRid = {}; try { for (const r of await q('SELECT lower(rid) rid, peak_abs FROM peak_lp')) peakByRid[r.rid] = +r.peak_abs; } catch {}
  const nmByOwner = {}, aegisByOwner = {}, bestWR = {}, dropByOwner = {};
  const bestAcctAbs = {};   // dueño -> { acct, abs } de su cuenta MÁS ALTA (mayor elo) — para el Sommelier
  (liveSnapshot().players || []).forEach(p => { const o = ownerOf((p.rid||'').toLowerCase());
    if (!nmByOwner[o]) nmByOwner[o] = uNick[o] || p.nm;
    aegisByOwner[o] = (aegisByOwner[o]||0) + (p.aegis||0);
    const g = (p.w||0)+(p.l||0); const c = bestWR[o]; if (g && (!c || g > c.g)) bestWR[o] = { g, w:p.w||0 };
    const abs = absLPof(p.tier, p.div, p.lp);
    if (abs != null){ const ba = bestAcctAbs[o]; if (!ba || abs > ba.abs) bestAcctAbs[o] = { acct: acctOf((p.rid||'').toLowerCase()), abs };
      const pk = peakByRid[(p.rid||'').toLowerCase()];   // caída desde el pico (El Antiprime)
      if (pk != null){ const drop = pk - abs; const cd = dropByOwner[o]; if (drop > 0 && (!cd || drop > cd.drop)) dropByOwner[o] = { drop, peak:pk, cur:abs }; } } });
  const nick = o => uNick[o] || nmByOwner[o] || (String(o).includes('#') ? String(o).split('#')[0] : o);
  const absLabel = abs => { if (abs >= 2800) return (abs-2800)+' LP'; const TN=['Hierro','Bronce','Plata','Oro','Platino','Esmeralda','Diamante'], DN=['IV','III','II','I']; const ti=Math.min(6,Math.floor(abs/400)), rem=abs-ti*400, di=Math.min(3,Math.floor(rem/100)), lp=rem-di*100; return `${TN[ti]} ${DN[di]} ${lp}LP`; };
  // Scan del historial: agregados por dueño + extremos de una partida.
  const agg = {}; const distinctByAcct = {}, gamesByAcct = {}, carreadoBy = {}, griefeadoBy = {};
  const NS = pos => !['UTILITY','SUPPORT'].includes((pos||'').toUpperCase());
  for (const r of await q(`SELECT match_id, lower(riotid) rid, champion champ, coalesce(kills,0) k, coalesce(deaths,0) d, coalesce(assists,0) a, coalesce(cs,0) cs, coalesce(duration,0) dur, win, position pos, game_end gend FROM mp_stats WHERE is_tournament=true AND riotid IS NOT NULL`)){
    const o = ownerOf(r.rid), acct = acctOf(r.rid);
    const A = agg[o] || (agg[o] = { games:0, deaths:0, csNs:0, durNs:0, gamesNs:0, durAll:0, champs:{}, days:{}, night:0, morning:0 });
    A.games++; A.deaths += +r.d; A.durAll += +r.dur;
    gamesByAcct[acct] = (gamesByAcct[acct]||0) + 1;
    if (NS(r.pos)){ A.csNs += +r.cs; A.durNs += +r.dur; A.gamesNs++; }
    if (r.champ){ A.champs[r.champ] = (A.champs[r.champ]||0)+1; (distinctByAcct[acct] = distinctByAcct[acct] || new Set()).add(r.champ); }
    if (r.gend){ const t = chileHD(r.gend); A.days[t.d] = (A.days[t.d]||0)+1; if (t.h>=2 && t.h<6) A.night++; if (t.h>=6 && t.h<11) A.morning++; }
    if (+r.dur >= 900){   // solo partidas reales (≥15 min); descarta remakes/rendiciones tempranas
      const kda = (+r.k + +r.a)/Math.max(1,+r.d);
      if (r.win){ const c = carreadoBy[o]; if (!c || kda < c.kda) carreadoBy[o] = { champ:r.champ, k:+r.k, d:+r.d, a:+r.a, kda, mid:r.match_id }; }
      else { const c = griefeadoBy[o]; if (!c || kda > c.kda) griefeadoBy[o] = { champ:r.champ, k:+r.k, d:+r.d, a:+r.a, kda, mid:r.match_id }; }
    }
  }
  // Dúos (aliados) para "Dúo Tóxico" y "Pareja Inseparable".
  const byMatch = {};
  for (const r of await q(`SELECT match_id, lower(riotid) rid, max(team_id) side, bool_or(win) win FROM mp_stats WHERE is_tournament=true AND riotid IS NOT NULL AND coalesce(duration,0) >= 300 GROUP BY match_id, lower(riotid)`)) (byMatch[r.match_id] = byMatch[r.match_id] || []).push(r);
  const pairAgg = {}, duoByOwner = {};   // duoByOwner: W/L de cada jugador cuando juega EN DÚO (aliado con otro del torneo)
  for (const mid in byMatch){ const sides = {};
    for (const p of byMatch[mid]){ const o = ownerOf(p.rid); (sides[p.side] = sides[p.side] || new Map()).set(o, !!p.win); }
    for (const side in sides){ const arr = [...sides[side].entries()]; if (arr.length < 2) continue; const won = arr[0][1]; const os = arr.map(x=>x[0]).sort();
      os.forEach(o => { const d = duoByOwner[o] = duoByOwner[o] || { w:0, l:0 }; if (won) d.w++; else d.l++; });
      for (let i=0;i<os.length;i++) for (let j=i+1;j<os.length;j++){ if (os[i]===os[j]) continue; const k = os[i]+'|'+os[j];
        const pa = pairAgg[k] = pairAgg[k] || { a:os[i], b:os[j], w:0, l:0 }; if (won) pa.w++; else pa.l++; } }
  }
  const owners = Object.keys(agg);
  const r1 = n => Math.round(n*10)/10;
  const M = [];
  // rank: ordena la lista y devuelve el top-N ya formateado. dir<0 = menor gana; dir>0 = mayor gana.
  const rank = (list, keyfn, fmt, dir, n=8) => list.slice().sort((a,b)=> dir < 0 ? keyfn(a)-keyfn(b) : keyfn(b)-keyfn(a)).slice(0, n).map(fmt);
  const push = (emoji, title, sub, top) => { if (top && top.length) M.push({ emoji, title, sub, top }); };
  const pairs = Object.values(pairAgg);
  const sommDistinct = o => { const ba = bestAcctAbs[o]; return (ba && distinctByAcct[ba.acct]) ? distinctByAcct[ba.acct].size : 0; };
  // Roasts
  push('📦','El Paquete','Peor winrate de la season (mín. 30)',
    rank(owners.filter(o=>bestWR[o] && bestWR[o].g>=30), o=>bestWR[o].w/bestWR[o].g,
      o=>({ nm:nick(o), value:Math.round(bestWR[o].w/bestWR[o].g*100)+'%', detail:`${bestWR[o].w}V·${bestWR[o].g-bestWR[o].w}D` }), -1));
  push('📉','El Antiprime','Más LP caídos desde su pico',
    rank(Object.keys(dropByOwner).filter(o=>dropByOwner[o].drop>=50), o=>dropByOwner[o].drop,
      o=>{ const d=dropByOwner[o]; return { nm:nick(o), value:`−${d.drop} LP`, detail:`de ${absLabel(d.peak)} a ${absLabel(d.cur)}` }; }, 1));
  push('🍼','Carreado','Peor KDA en una partida GANADA',
    rank(Object.keys(carreadoBy), o=>carreadoBy[o].kda,
      o=>{ const c=carreadoBy[o]; return { nm:nick(o), value:`${c.k}/${c.d}/${c.a}`, detail:`KDA ${c.kda.toFixed(2)} · ${c.champ} · W`, matchId:c.mid }; }, -1));
  push('😭','Griefeado','Mejor KDA en una partida PERDIDA',
    rank(Object.keys(griefeadoBy), o=>griefeadoBy[o].kda,
      o=>{ const c=griefeadoBy[o]; return { nm:nick(o), value:`${c.k}/${c.d}/${c.a}`, detail:`KDA ${c.kda.toFixed(2)} · ${c.champ} · L`, matchId:c.mid }; }, 1));
  push('⚰️','El Inter','Más muertes por partida (mín. 20)',
    rank(owners.filter(o=>agg[o].games>=20), o=>agg[o].deaths/agg[o].games,
      o=>({ nm:nick(o), value:r1(agg[o].deaths/agg[o].games)+' muertes', detail:`en ${agg[o].games} partidas` }), 1));
  push('🪨','Manos de Piedra','Peor CS/min (mín. 20 partidas fuera de support)',
    rank(owners.filter(o=>agg[o].gamesNs>=20 && agg[o].durNs>0), o=>agg[o].csNs/(agg[o].durNs/60),
      o=>({ nm:nick(o), value:r1(agg[o].csNs/(agg[o].durNs/60))+' cs/min', detail:`en ${agg[o].gamesNs} partidas de carril/jungla` }), -1));
  // Vicio
  push('🦇','Noctámbulo','Más partidas entre 2 y 6 AM',
    rank(owners.filter(o=>agg[o].night>0), o=>agg[o].night, o=>({ nm:nick(o), value:agg[o].night+' partidas', detail:'de madrugada' }), 1));
  push('🐓','Madrugador','Más partidas entre 6 y 11 AM',
    rank(owners.filter(o=>agg[o].morning>0), o=>agg[o].morning, o=>({ nm:nick(o), value:agg[o].morning+' partidas', detail:'temprano' }), 1));
  push('⏳','Horas en la Grieta','Más tiempo total jugado',
    rank(owners, o=>agg[o].durAll, o=>({ nm:nick(o), value:Math.round(agg[o].durAll/3600)+' h', detail:`≈ ${(agg[o].durAll/86400).toFixed(1)} días` }), 1));
  push('🏃','Maratón','Más partidas en un solo día',
    rank(owners.map(o=>{ let mx=0,day=''; for (const d in agg[o].days) if (agg[o].days[d]>mx){ mx=agg[o].days[d]; day=d; } return { o, mx, day }; }).filter(x=>x.mx), x=>x.mx,
      x=>({ nm:nick(x.o), value:x.mx+' partidas', detail:`el ${x.day}` }), 1));
  // Pool
  push('🐴','One-Trick','% con un solo campeón (mín. 20)',
    rank(owners.filter(o=>agg[o].games>=20).map(o=>{ let mc=null,mn=0; for (const c in agg[o].champs) if (agg[o].champs[c]>mn){ mn=agg[o].champs[c]; mc=c; } return { o, pct:mn/agg[o].games, champ:mc }; }), x=>x.pct,
      x=>({ nm:nick(x.o), value:Math.round(x.pct*100)+'%', detail:`con ${x.champ}` }), 1));
  push('🍷','Sommelier','Más campeones distintos en su cuenta principal (mín. 20)',
    rank(owners.filter(o=>{ const ba=bestAcctAbs[o]; return ba && (gamesByAcct[ba.acct]||0)>=20; }), sommDistinct,
      o=>({ nm:nick(o), value:sommDistinct(o)+' campeones', detail:'' }), 1));
  // Dúos
  push('☢️','Dúo Tóxico','Peor winrate jugando juntos (mín. 4)',
    rank(pairs.filter(p=>p.w+p.l>=4), p=>p.w/(p.w+p.l),
      p=>({ nm:`${nick(p.a)} + ${nick(p.b)}`, value:Math.round(p.w/(p.w+p.l)*100)+'%', detail:`${p.w}V·${p.l}D juntos` }), -1));
  push('💞','Pareja Inseparable','Los que más juegan juntos',
    rank(pairs, p=>p.w+p.l, p=>({ nm:`${nick(p.a)} + ${nick(p.b)}`, value:(p.w+p.l)+' partidas', detail:`${p.w}V·${p.l}D` }), 1));
  push('🃏','El Troll del Dúo','Peor winrate jugando en dúo (mín. 5)',
    rank(Object.keys(duoByOwner).filter(o=>(duoByOwner[o].w+duoByOwner[o].l)>=5), o=>duoByOwner[o].w/(duoByOwner[o].w+duoByOwner[o].l),
      o=>{ const d=duoByOwner[o]; return { nm:nick(o), value:Math.round(d.w/(d.w+d.l)*100)+'%', detail:`${d.w}V·${d.l}D en dúo` }; }, -1));
  push('🛡️','Aegis King','Más victorias de doble LP',
    rank(owners.filter(o=>(aegisByOwner[o]||0)>0), o=>aegisByOwner[o]||0, o=>({ nm:nick(o), value:(aegisByOwner[o])+' aegis', detail:'' }), 1));
  MENC_CACHE.data = { menciones: M };
  MENC_CACHE.at = Date.now();
  res.json(await mencFor(req, MENC_CACHE.data));
}));

// ---- SOLOQDLE: adivina el jugador del torneo por sus últimas partidas (diario, compartible) ----
const DLE_CACHE = { date: null, data: null };
const DLE_MAX = 8;   // intentos máximos por día (debe coincidir con MAX del frontend)
const DLE_EPOCH = Date.UTC(2026, 8, 29);   // 2026-09-29 => SoloQdle #1
const DLE_POS = { TOP:'TOP', JUNGLE:'JNG', MIDDLE:'MID', BOTTOM:'ADC', UTILITY:'SUP' };   // normaliza posiciones a 5 roles
// Ambos modos consideran SOLO la cuenta más alta (mejor elo) de cada jugador y sus partidas en esa cuenta.
async function buildDle(today){
  // Todo se agrupa por PUUID (columna directa en historial y snapshot): así renames y espacios
  // raros en el Riot ID ("shr uzi #las1" vs "shr uzi#las1") no separan la misma cuenta.
  const rid2puuidHist = await ridPuuidMap();
  const nrid = r => (r||'').toLowerCase().replace(/\s*#\s*/, '#').trim();   // normaliza espacios alrededor del #
  const rid2puuid = {};   // rid normalizado -> puuid (snapshot primero, luego historial)
  (liveSnapshot().players || []).forEach(p => { if (p.rid && p.puuid) rid2puuid[nrid(p.rid)] = p.puuid; });
  for (const [r, pu] of Object.entries(rid2puuidHist)){ const k = nrid(r); if (!rid2puuid[k]) rid2puuid[k] = pu; }
  const puuidOf = rid => rid2puuid[nrid(rid)] || null;

  const uNick = {}, puuidOwner = {}, avByOwner = {};
  for (const u of await q("SELECT id, nickname, avatar, riotid FROM users WHERE coalesce(riotid,'')<>''")){ uNick['u'+u.id] = (u.nickname||'').trim(); avByOwner['u'+u.id] = u.avatar || null; const pu = puuidOf(u.riotid); if (pu) puuidOwner[pu] = 'u'+u.id; }
  for (const s of await q("SELECT user_id, riotid FROM smurfs WHERE coalesce(riotid,'')<>''")){ const pu = puuidOf(s.riotid); if (pu) puuidOwner[pu] = 'u'+s.user_id; }
  const ownerOf = puuid => puuidOwner[puuid] || puuid;
  const teamOf = {};
  try { for (const r of await q("SELECT riotid, team FROM team_members WHERE coalesce(team,'')<>''")){ const pu = puuidOf(r.riotid); if (pu) teamOf[ownerOf(pu)] = r.team; } } catch {}
  // elo actual y winrate ranked POR CUENTA (puuid) desde el snapshot en vivo
  const absByAcct = {}, nmByAcct = {}, wlByAcct = {};
  (liveSnapshot().players || []).forEach(p => { const acct = p.puuid; if (!acct) return;
    if (!nmByAcct[acct]) nmByAcct[acct] = p.nm;
    const abs = absLPof(p.tier, p.div, p.lp); if (abs != null && abs > (absByAcct[acct] ?? -1)) absByAcct[acct] = abs;
    if (p.w != null && p.l != null && !wlByAcct[acct]) wlByAcct[acct] = { w: +p.w, l: +p.l }; });   // W/L ranked oficial (igual que el resto del sitio)
  // peak POR CUENTA
  const peakByAcct = {};
  try { for (const r of await q('SELECT rid, peak_abs FROM peak_lp')){ const acct = puuidOf(r.rid); if (acct && +r.peak_abs > (peakByAcct[acct]||0)) peakByAcct[acct] = +r.peak_abs; } } catch {}
  // partidas, roles, winrate y KDA POR CUENTA (puuid)
  const gamesByAcct = {}, posByAcct = {}, winByAcct = {}, kdaByAcct = {};
  for (const r of await q("SELECT puuid acct, coalesce(kills,0) k, coalesce(deaths,0) d, coalesce(assists,0) a, win, position pos, coalesce(duration,0) dur FROM mp_stats WHERE is_tournament=true AND coalesce(puuid,'')<>'' AND coalesce(duration,0) >= 300 ORDER BY game_end DESC NULLS LAST")){
    const acct = r.acct; (gamesByAcct[acct] = gamesByAcct[acct] || []).push(r);
    const pos = DLE_POS[(r.pos||'').toUpperCase()]; if (pos){ (posByAcct[acct] = posByAcct[acct] || {})[pos] = (posByAcct[acct][pos]||0) + 1; }
    const w = winByAcct[acct] = winByAcct[acct] || { w:0, n:0 }; w.n++; if (r.win) w.w++;
    const kd = kdaByAcct[acct] = kdaByAcct[acct] || { k:0, d:0, a:0 }; kd.k += +r.k; kd.d += +r.d; kd.a += +r.a;
  }
  // Cuentas por JUGADOR (dueño) desde el snapshot (registradas o no), como el filtro "1 CUENTA" del ranking.
  const accsByOwner = {};   // owner -> [{ acct, abs, nm }]
  (liveSnapshot().players || []).forEach(p => { const acct = p.puuid; if (!acct) return;
    const owner = ownerOf(acct), abs = absLPof(p.tier, p.div, p.lp);
    (accsByOwner[owner] = accsByOwner[owner] || []).push({ acct, abs: abs ?? null, nm: uNick[owner] || p.nm }); });
  // Mejor cuenta = la de mayor elo ENTRE las que tienen suficientes partidas trackeadas (para armar el puzzle).
  // Así un smurf altísimo pero sin historial no deja al jugador fuera (p.ej. Gonza: su GM tiene 0 games, se usa su main).
  const MIN_GAMES = 15;
  const bestOf = o => (accsByOwner[o] || []).filter(x => (gamesByAcct[x.acct]||[]).length >= MIN_GAMES)
    .sort((a,b) => (b.abs ?? -1) - (a.abs ?? -1))[0];
  const roleMost  = c => c ? Object.keys(c).sort((a,b)=> c[b]-c[a] || a.localeCompare(b))[0] : null;
  const roleLeast = c => c ? Object.keys(c).sort((a,b)=> c[a]-c[b] || a.localeCompare(b))[0] : null;

  const players = [];
  for (const o of Object.keys(accsByOwner)){
    if (!teamOf[o]) continue;   // los sin equipo quedan fuera del pool (p.ej. nemesis, omidal)
    const best = bestOf(o); if (!best) continue;
    const a = best.acct;
    const gs = gamesByAcct[a] || [];
    const w = winByAcct[a], kd = kdaByAcct[a];
    const alt = [...new Set((accsByOwner[o]||[]).map(x => nmByAcct[x.acct]).filter(Boolean))];   // nombres de TODAS sus cuentas (para el autocompletar)
    players.push({ key:o, nm: uNick[o] || best.nm || nmByAcct[a], alt, avatar: avByOwner[o] || null, team: teamOf[o] || null,
      eloAbs: absByAcct[a] ?? null, peakAbs: peakByAcct[a] ?? null, games: gs.length,
      roleMost: roleMost(posByAcct[a]), roleLeast: roleLeast(posByAcct[a]),
      wr: (wlByAcct[a] && (wlByAcct[a].w + wlByAcct[a].l)) ? Math.round(wlByAcct[a].w * 100 / (wlByAcct[a].w + wlByAcct[a].l))
          : ((w && w.n) ? Math.round(w.w*100/w.n) : null),   // winrate ranked oficial; fallback al historial capturado
      kda: kd ? Math.round(((kd.k + kd.a) / Math.max(1, kd.d)) * 100) / 100 : null,
      _games: gs.map(g => ({ k:+g.k, d:+g.d, a:+g.a, win: !!g.win, durMin: Math.round(+g.dur/60) })) });
  }
  players.sort((a,b) => a.nm.localeCompare(b.nm));
  const hash = salt => [...(today+salt)].reduce((h,c) => (h*31 + c.charCodeAt(0)) >>> 0, 7);
  const answer  = players[hash('') % players.length];        // modo "por partidas"
  const answer2 = players[hash('|classic') % players.length]; // modo "clásico" (otro jugador el mismo día)
  // 5 partidas CONSECUTIVAS con inicio aleatorio (determinista por día): no siempre las últimas, para dificultar hacer trampa.
  const all = (answer && answer._games) || [];
  const off = all.length > 5 ? (hash('|clue') % (all.length - 5 + 1)) : 0;
  const clueGames = all.slice(off, off + 5);
  const number = Math.floor((Date.parse(today+'T12:00:00Z') - DLE_EPOCH) / 86400000) + 1;
  const attrs = {}; players.forEach(p => { const { _games, ...rest } = p; attrs[p.key] = rest; });
  return { date: today, number, clueGames, players: players.map(p => ({ key:p.key, nm:p.nm, alt:p.alt })),
           answerKey: answer.key, answer2Key: answer2.key, attrs };
}
async function getDle(){ const today = chileHD(Date.now()).d; if (DLE_CACHE.date === today && DLE_CACHE.data) return DLE_CACHE.data; const d = await buildDle(today); DLE_CACHE.date = today; DLE_CACHE.data = d; return d; }
app.get('/api/soloqdle', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  const d = await getDle();
  res.json({ date: d.date, number: d.number, clueGames: d.clueGames, players: d.players });
}));
app.post('/api/soloqdle/guess', auth, wrap(async (req, res) => {
  const key = ((req.body && req.body.key) || '').toString();
  const d = await getDle();
  const g = d.attrs[key]; if (!g) return res.status(400).json({ error: 'jugador inválido' });
  const ans = d.attrs[d.answerKey], correct = key === d.answerKey;
  const dir = (a, b) => (a == null || b == null) ? 'na' : a > b ? 'up' : a < b ? 'down' : 'eq';   // ¿el CORRECTO tiene más que el guess?
  res.json({ correct,
    guess: { nm: g.nm, team: g.team, eloAbs: g.eloAbs, peakAbs: g.peakAbs, games: g.games },
    cmp: { team: (g.team && ans.team) ? (g.team === ans.team ? 'match' : 'no') : 'na', elo: dir(ans.eloAbs, g.eloAbs), peak: dir(ans.peakAbs, g.peakAbs), games: dir(ans.games, g.games) },
    answer: correct ? { nm: ans.nm } : undefined });
}));
app.get('/api/soloqdle/reveal', auth, wrap(async (req, res) => { const d = await getDle(); res.json({ nm: d.attrs[d.answerKey].nm }); }));

// ---- SOLOQDLE modo "clásico": adivina el jugador por sus atributos (grilla estilo LoLdle) ----
app.get('/api/soloqdle2', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  const d = await getDle();
  res.json({ date: d.date, number: d.number, players: d.players });
}));
function dleGuess2(g, ans){
  const dir = (a, b) => (a == null || b == null) ? 'na' : a > b ? 'up' : a < b ? 'down' : 'eq';   // ¿el CORRECTO tiene más que el guess?
  const same = (a, b) => (a == null || b == null) ? 'na' : (a === b ? 'match' : 'no');
  return {
    guess: { nm: g.nm, avatar: g.avatar, team: g.team, roleMost: g.roleMost, roleLeast: g.roleLeast, eloAbs: g.eloAbs, peakAbs: g.peakAbs, wr: g.wr, kda: g.kda, games: g.games },
    cmp: { team: same(g.team, ans.team), roleMost: same(g.roleMost, ans.roleMost), roleLeast: same(g.roleLeast, ans.roleLeast),
           elo: dir(ans.eloAbs, g.eloAbs), peak: dir(ans.peakAbs, g.peakAbs), wr: dir(ans.wr, g.wr), kda: dir(ans.kda, g.kda), games: dir(ans.games, g.games) },
  };
}
app.post('/api/soloqdle2/guess', auth, wrap(async (req, res) => {
  const key = ((req.body && req.body.key) || '').toString();
  const d = await getDle();
  const g = d.attrs[key]; if (!g) return res.status(400).json({ error: 'jugador inválido' });
  const ans = d.attrs[d.answer2Key], correct = key === d.answer2Key;
  res.json({ correct, ...dleGuess2(g, ans), answer: correct ? { nm: ans.nm } : undefined });
}));
app.get('/api/soloqdle2/reveal', auth, wrap(async (req, res) => { const d = await getDle(); res.json({ nm: d.attrs[d.answer2Key].nm }); }));

// Registra el resultado del día por modo (idempotente: no pisa un día ya resuelto con uno peor). Alimenta el scoreboard.
app.post('/api/soloqdle/result', auth, wrap(async (req, res) => {
  const d = await getDle();
  const b = req.body || {};
  const mode = b.mode === 'classic' ? 'classic' : 'games';
  const solved = !!b.solved, gaveUp = !!b.gaveUp;
  const guesses = Math.max(1, Math.min(DLE_MAX, Number(b.guesses) || DLE_MAX));
  await q(`INSERT INTO soloqdle_results (user_id, day, mode, solved, guesses, gave_up, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (user_id, day, mode) DO UPDATE SET
             solved   = soloqdle_results.solved OR EXCLUDED.solved,
             guesses  = CASE WHEN EXCLUDED.solved AND (NOT soloqdle_results.solved OR EXCLUDED.guesses < soloqdle_results.guesses)
                             THEN EXCLUDED.guesses ELSE soloqdle_results.guesses END,
             gave_up  = soloqdle_results.gave_up OR EXCLUDED.gave_up,
             updated_at = now()`,
    [req.user.id, d.date, mode, solved, guesses, gaveUp]);
  res.json({ ok: true });
}));
// Scoreboard: mejores jugadores del SoloQdle (racha actual, mejor racha, total resueltos, promedio de intentos).
app.get('/api/soloqdle/leaderboard', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  const today = chileHD(Date.now()).d;
  const yday = chileHD(Date.now() - 86400000).d;
  const rows = await q(`SELECT r.user_id, r.day, r.solved, r.guesses, u.nickname, u.avatar
                        FROM soloqdle_results r JOIN users u ON u.id = r.user_id
                        ORDER BY r.user_id, r.day`);
  const byUser = {};
  for (const r of rows){ (byUser[r.user_id] = byUser[r.user_id] || { nm: (r.nickname||'').trim(), avatar: r.avatar || null, days: [] }).days.push(r); }
  const dayBefore = ds => { const t = Date.parse(ds + 'T12:00:00Z') - 86400000; return chileHD(t).d; };
  const board = Object.values(byUser).map(u => {
    const solvedDays = u.days.filter(d => d.solved).map(d => d.day);
    const set = new Set(solvedDays);
    const total = solvedDays.length;
    const sumG = u.days.filter(d => d.solved).reduce((s,d) => s + (+d.guesses||0), 0);
    const avg = total ? sumG / total : 0;
    // Mejor racha (días consecutivos resueltos, en cualquier momento)
    let best = 0; for (const day of set){ if (!set.has(dayBefore(day))){ let n = 0, cur = day; while (set.has(cur)){ n++; cur = /*día siguiente*/ chileHD(Date.parse(cur+'T12:00:00Z') + 86400000).d; } best = Math.max(best, n); } }
    // Racha actual (consecutiva terminando hoy o ayer)
    let curStreak = 0; let anchor = set.has(today) ? today : (set.has(yday) ? yday : null);
    while (anchor && set.has(anchor)){ curStreak++; anchor = dayBefore(anchor); }
    return { nm: u.nm, avatar: u.avatar, total, streak: curStreak, best, avg: Math.round(avg*100)/100 };
  }).filter(u => u.total > 0)
    .sort((a,b) => b.streak - a.streak || b.total - a.total || a.avg - b.avg || a.nm.localeCompare(b.nm))
    .slice(0, 50);
  res.json({ board });
}));

// ---- ANÁLISIS: promedios por jugador sobre sus últimas N partidas (polígono comparativo) ----
// Todo sale de la DB (sin llamadas a Riot). Las filas de los jugadores del challenge se cargan una vez
// y se cachean 5 min; de ahí se arma cualquier ventana (N) y modo de cuentas:
//   top   = solo la cuenta más alta de cada jugador      all = todas las cuentas (smurfs aparte)
//   merge = main + smurfs combinadas en un solo jugador
// Las partidas anuladas y los remakes no entran en los promedios (las anuladas sí se listan, marcadas).
let AN_ROWS = { at: 0, byPuuid: null };
async function analysisRows(){
  if (AN_ROWS.byPuuid && Date.now() - AN_ROWS.at < 300000) return AN_ROWS.byPuuid;
  const rows = await q(`
    SELECT m.puuid, m.match_id id, m.champion champ, m.position pos, m.win, coalesce(m.kills,0) k, coalesce(m.deaths,0) d, coalesce(m.assists,0) a,
           coalesce(m.cs,0) cs, coalesce(m.gold,0) gold, coalesce(m.damage,0) dmg, coalesce(m.vision,0) vis, coalesce(m.champ_level,0) lvl,
           coalesce(m.duration,0) dur, m.game_end, coalesce(m.voided,false) voided, coalesce(m.no_lp,false) no_lp,
           m.cs10, m.cs_adv, m.lvl_lead, m.solo_kills, tk.tk
    FROM match_participants m
    JOIN (SELECT match_id, team_id, sum(coalesce(kills,0))::int tk FROM match_participants GROUP BY 1,2) tk
      ON tk.match_id = m.match_id AND tk.team_id = m.team_id
    WHERE m.is_tournament=true AND coalesce(m.puuid,'')<>'' AND coalesce(m.duration,0) >= 300
    ORDER BY m.game_end DESC NULLS LAST`);
  const by = {};
  for (const r of rows){
    (by[r.puuid] = by[r.puuid] || []).push({ id: r.id, champ: r.champ || '', pos: (r.pos || '').toUpperCase(), win: !!r.win, k: +r.k, d: +r.d, a: +r.a,
      cs: +r.cs, gold: +r.gold, dmg: +r.dmg, vis: +r.vis, lvl: +r.lvl, dur: +r.dur, end: Number(r.game_end) || 0, voided: !!r.voided, noLp: !!r.no_lp,
      cs10: r.cs10 == null ? null : +r.cs10, csadv: r.cs_adv == null ? null : +r.cs_adv, lvllead: r.lvl_lead == null ? null : +r.lvl_lead,
      solok: r.solo_kills == null ? null : +r.solo_kills, tk: +r.tk || 0 });
  }
  AN_ROWS = { at: Date.now(), byPuuid: by };
  return by;
}
// Jugadores (dueños) y sus cuentas presentes en el ranking, según el modo pedido.
async function analysisEntities(mode){
  const snap = (liveSnapshot().players || []).filter(p => p.puuid);
  const rid2puuid = await ridPuuidMap();
  const owner = {}, nick = {};
  try {
    for (const u of await q("SELECT id, nickname, lower(riotid) rid FROM users WHERE coalesce(riotid,'')<>''")){
      nick['u' + u.id] = (u.nickname || '').trim(); const pu = rid2puuid[u.rid]; if (pu) owner[pu] = 'u' + u.id; }
    for (const s of await q("SELECT user_id, lower(riotid) rid FROM smurfs WHERE coalesce(riotid,'')<>''")){ const pu = rid2puuid[s.rid]; if (pu) owner[pu] = 'u' + s.user_id; }
  } catch {}
  const linkMain = {};
  try { for (const l of await q('SELECT smurf_riotid, main_riotid FROM smurf_links')) linkMain[normRid(l.smurf_riotid)] = normRid(l.main_riotid); } catch {}
  const ownerOf = p => owner[p.puuid] || ('r:' + (linkMain[normRid(p.rid)] || normRid(p.rid)));
  const groups = {};
  snap.forEach((p, i) => { const o = ownerOf(p); (groups[o] = groups[o] || []).push({ p, pos: i + 1, abs: absLPof(p.tier, p.div, p.lp) || 0 }); });
  const out = [];
  for (const o in groups){
    const accts = groups[o].slice().sort((a, b) => b.abs - a.abs || a.pos - b.pos), best = accts[0];
    const name = nick[o] || best.p.nm || (best.p.rid || '').split('#')[0];
    const ent = (a, puuids, key, smurf) => ({ key, nm: name, rid: a.p.rid, accts: accts.map(x => x.p.rid), smurf, pos: a.pos,
      tier: a.p.tier || 'UNRANKED', div: a.p.div || '', lp: a.p.lp || 0, abs: a.abs || null, puuids });
    if (mode === 'all') accts.forEach((a, i) => out.push(ent(a, [a.p.puuid], normRid(a.p.rid), i > 0)));
    else if (mode === 'merge') out.push(ent(best, accts.map(a => a.p.puuid), 'o:' + o, false));
    else out.push(ent(best, [best.p.puuid], normRid(best.p.rid), false));
  }
  return out.sort((a, b) => a.pos - b.pos);
}
const anMode = v => (v === 'all' || v === 'merge') ? v : 'top';
// Rol principal (el más jugado) y partidas que CUENTAN para las estadísticas: a quien no es support
// no se le cuentan las partidas que jugó de support (suelen ser autofill y distorsionan CS, daño, etc.).
function anCounted(valid){
  const roles = {}; valid.forEach(g => { if (g.pos) roles[g.pos] = (roles[g.pos] || 0) + 1; });
  const role = Object.keys(roles).sort((a, b) => roles[b] - roles[a])[0] || null;
  const skipSup = !!role && role !== 'UTILITY';
  return { role, skipSup, counted: skipSup ? valid.filter(g => g.pos !== 'UTILITY') : valid };
}
const anGamesOf = (by, puuids) => puuids.length === 1 ? (by[puuids[0]] || [])
  : [].concat(...puuids.map(pu => by[pu] || [])).sort((a, b) => b.end - a.end);
const AN_CACHE = {};
app.get('/api/analysis', orgOnly, wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  const raw = String(req.query.n || 'all').toLowerCase(), mode = anMode(req.query.mode);
  const n = raw === 'all' ? 0 : Math.max(5, Math.min(200, parseInt(raw, 10) || 10));
  const ck = mode + '|' + n, hit = AN_CACHE[ck];
  if (hit && Date.now() - hit.at < 300000) return res.json(hit.data);
  const by = await analysisRows(), ents = await analysisEntities(mode);
  const avg = (arr, f) => { const v = arr.map(f).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const players = [];
  for (const e of ents){
    const { role, counted: all } = anCounted(anGamesOf(by, e.puuids).filter(g => !g.voided)); if (!all.length) continue;
    const gs = n ? all.slice(0, n) : all, G = gs.length, sum = f => gs.reduce((s, g) => s + f(g), 0);
    const min = sum(g => g.dur) / 60 || 1, K = sum(g => g.k), D = sum(g => g.d), A = sum(g => g.a), TK = sum(g => g.tk);
    const r1 = v => v == null ? null : Math.round(v * 10) / 10;
    players.push({ key: e.key, nm: e.nm, rid: e.rid, accts: e.accts, smurf: e.smurf, pos: e.pos, tier: e.tier, div: e.div, lp: e.lp, abs: e.abs, role,
      games: G, wr: Math.round(sum(g => g.win ? 1 : 0) / G * 1000) / 10, k: r1(K / G), d: r1(D / G), a: r1(A / G),
      kda: +((K + A) / Math.max(1, D)).toFixed(2), csmin: +(sum(g => g.cs) / min).toFixed(2), goldmin: Math.round(sum(g => g.gold) / min),
      dmgmin: Math.round(sum(g => g.dmg) / min), vismin: +(sum(g => g.vis) / min).toFixed(2), lvlmin: +(sum(g => g.lvl) / min).toFixed(3),
      kp: TK ? Math.round((K + A) / TK * 1000) / 10 : null,
      cs10: r1(avg(gs, g => g.cs10)), csadv: r1(avg(gs, g => g.csadv)), lvllead: (v => v == null ? null : +v.toFixed(2))(avg(gs, g => g.lvllead)),
      solok: (v => v == null ? null : +v.toFixed(2))(avg(gs, g => g.solok)) });
  }
  const data = { n: n || 'all', mode, players };
  AN_CACHE[ck] = { at: Date.now(), data };
  res.json(data);
}));
// Detalle de un jugador: últimas 60 partidas (con ±PL y participación) y su pool de campeones completo.
app.get('/api/analysis/detail', orgOnly, wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  const mode = anMode(req.query.mode), key = String(req.query.key || '');
  const e = (await analysisEntities(mode)).find(x => x.key === key);
  if (!e) return res.json({ games: [], champs: [] });
  const by = await analysisRows(), all = anGamesOf(by, e.puuids);
  const { skipSup, counted } = anCounted(all.filter(g => !g.voided));
  const lpByEnd = {};
  try { const blob = await matchesBlob(); e.puuids.forEach(pu => ((blob && blob[pu] && blob[pu].lpGames) || []).forEach(g => { if (g.end && !g.pending) lpByEnd[g.end] = g.delta; })); } catch {}
  const games = all.slice(0, 60).map(g => {
    const dl = lpByEnd[g.end]; let lp = null;
    if (g.noLp) lp = 0; else if (dl != null && ((g.win && dl >= 0) || (!g.win && dl <= 0))) lp = dl;
    return { id: g.id, champ: g.champ, pos: g.pos, win: g.win, k: g.k, d: g.d, a: g.a, cs: g.cs, gold: g.gold, dmg: g.dmg, vis: g.vis, lvl: g.lvl,
      dur: g.dur, end: g.end, voided: g.voided, off: skipSup && g.pos === 'UTILITY' && !g.voided, lp, kp: g.tk ? Math.round((g.k + g.a) / g.tk * 100) : null };
  });
  const cm = {};
  counted.filter(g => g.champ).forEach(g => { const c = cm[g.champ] || (cm[g.champ] = { champ: g.champ, games: 0, wins: 0, k: 0, d: 0, a: 0 });
    c.games++; if (g.win) c.wins++; c.k += g.k; c.d += g.d; c.a += g.a; });
  const champs = Object.values(cm).sort((a, b) => b.games - a.games || b.wins - a.wins).slice(0, 25)
    .map(c => ({ champ: c.champ, games: c.games, wr: Math.round(c.wins / c.games * 100), kda: +((c.k + c.a) / Math.max(1, c.d)).toFixed(2) }));
  res.json({ games, champs, total: counted.length });
}));

// ================= HERRAMIENTAS · ORGANIZADOR DE 5v5 =================
// Salas: quien crea una recibe un enlace para invitar; los jugadores se unen y el anfitrión (el
// creador, o un admin) sortea dos equipos de elo parecido, con roles al azar o todos fuera de su rol,
// y opcionalmente un campeón al azar jugable en ese rol. Cada jugador puede cambiar su campeón un
// número limitado de veces. Las salas EXPIRAN tras 3 h sin actividad.
// El estado vive en memoria (una sola instancia) y se respalda en la DB para sobrevivir reinicios.
const FV_ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const FV_SIZE = 10;
const FV_TTL = 3 * 3600 * 1000;      // una sala vive 3 h desde su última actividad
const FV_MAX_ROOMS = 40;
const fvRand = n => crypto.randomInt(n);
const fvShuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--){ const j = fvRand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fvCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 6; i++) s += A[fvRand(A.length)]; return s; };   // sin 0/O/1/I
let FV_ROOMS = null;   // code -> sala
async function fvRooms(){
  if (!FV_ROOMS){
    FV_ROOMS = {};
    try { for (const r of await q("SELECT data FROM tool_state WHERE id LIKE '5v5:%'")) if (r.data && r.data.code) FV_ROOMS[r.data.code] = r.data; } catch {}
  }
  // limpia las expiradas (memoria y DB)
  const now = Date.now();
  for (const c of Object.keys(FV_ROOMS)) if ((FV_ROOMS[c].expiresAt || 0) <= now){ delete FV_ROOMS[c]; q("DELETE FROM tool_state WHERE id=$1", ['5v5:' + c]).catch(() => {}); }
  return FV_ROOMS;
}
// Guarda la sala y RENUEVA su vencimiento (cada acción cuenta como actividad).
async function fvSave(st){
  st.v = (st.v || 0) + 1; st.expiresAt = Date.now() + FV_TTL;
  try { await q("INSERT INTO tool_state (id, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data=$2::jsonb, updated_at=now()", ['5v5:' + st.code, JSON.stringify(st)]); } catch {}
}
// Sala pedida en la solicitud (?room= o body.room). Responde 404 si no existe o ya expiró.
async function fvRoom(req, res){
  const code = String((req.query && req.query.room) || (req.body && req.body.room) || '').trim().toUpperCase();
  const st = code ? (await fvRooms())[code] : null;
  if (!st){ res.status(404).json({ error: 'La sala no existe o ya expiró' }); return null; }
  return st;
}
// Campeones jugables por rol, sacados de las partidas guardadas: cuenta todo campeón con al menos 25
// partidas en esa posición (así entran picks poco comunes pero jugables, como Tahm Kench top). Cache 6 h.
const FV_EXTRA = { TOP: ['Janna'] };   // id de Data Dragon del campeón, por rol
let FV_POOL = { at: 0, data: null };
async function fvChampPool(){
  if (FV_POOL.data && Date.now() - FV_POOL.at < 6 * 3600 * 1000) return FV_POOL.data;
  const pool = {}; FV_ROLES.forEach(r => { pool[r] = []; });
  for (const r of await q(`SELECT upper(position) pos, champion, count(*)::int n FROM match_participants
      WHERE coalesce(position,'')<>'' AND coalesce(champion,'')<>'' AND coalesce(duration,0) >= 300 GROUP BY 1,2 HAVING count(*) >= 25`))
    if (pool[r.pos]) pool[r.pos].push(r.champion);
  // picks agregados a mano: jugables en ese rol aunque casi nadie los juegue en las partidas guardadas
  for (const role in FV_EXTRA) FV_EXTRA[role].forEach(c => { if (pool[role] && !pool[role].includes(c)) pool[role].push(c); });
  FV_POOL = { at: Date.now(), data: pool };
  return pool;
}
// Datos de un jugador a partir de su entidad del ranking (cuenta más alta + rol habitual).
async function fvFromEntity(e, uid){
  const by = await analysisRows(), valid = anGamesOf(by, e.puuids).filter(g => !g.voided && g.pos);
  const cnt = {}; valid.forEach(g => { cnt[g.pos] = (cnt[g.pos] || 0) + 1; });
  const main = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || null;
  const roles = {}; Object.keys(cnt).forEach(r => { roles[r] = Math.round(cnt[r] / valid.length * 100) / 100; });
  return { id: e.key, uid: uid || null, nick: e.nm, rid: e.rid, tier: e.tier, div: e.div, lp: e.lp, abs: e.abs, main, roles };
}
async function fvPlayerForUser(u){
  const rids = new Set([normRid(u.riotid)]);
  for (const s of await q('SELECT riotid FROM smurfs WHERE user_id=$1', [u.id])) rids.add(normRid(s.riotid));
  const e = (await analysisEntities('top')).find(x => x.accts.some(a => rids.has(normRid(a))));
  if (e){ const p = await fvFromEntity(e, u.id); p.nick = (u.nickname || '').trim() || p.nick; return p; }
  return { id: 'u' + u.id, uid: u.id, nick: (u.nickname || '').trim() || (u.riotid || '').split('#')[0], rid: u.riotid || '', tier: 'UNRANKED', div: '', lp: 0, abs: null, main: null };
}
const fvIsHost = (st, u) => !!u && (u.is_admin || (st.host != null && st.host === u.id));
// ¿es admin? Se consulta cada 5 min por usuario: la sala se refresca cada pocos segundos y no vale
// una consulta a la DB por cada refresco.
const FV_ADMIN = {};
async function fvAdmin(uid){
  const c = FV_ADMIN[uid]; if (c && Date.now() - c.at < 300000) return c.v;
  let v = false; try { const u = await q1('SELECT is_admin FROM users WHERE id=$1', [uid]); v = !!(u && u.is_admin); } catch {}
  FV_ADMIN[uid] = { at: Date.now(), v }; return v;
}
async function fvView(st, uid){
  let me = null;
  if (uid){ const p = st.players.find(x => x.uid === uid);
    me = { uid, id: p ? p.id : null, host: fvIsHost(st, { id: uid, is_admin: await fvAdmin(uid) }) }; }
  // Selección oculta: los campeones del otro equipo NO se envían al navegador (no basta con no
  // dibujarlos). Quien no está en ningún equipo —espectador, o un admin mirando— no ve ninguno.
  let draw = st.draw;
  if (draw && draw.champs && draw.hidden){
    const myTeam = me && me.id ? draw.teams.findIndex(t => t.players.some(p => p.id === me.id)) : -1;
    draw = { ...draw, teams: draw.teams.map((t, i) => i === myTeam ? t : { ...t, players: t.players.map(p => ({ ...p, champ: null, used: [], secret: true })) }) };
  }
  return { ...st, draw, size: FV_SIZE, remakeVotes: FV_REMAKE_VOTES, me };
}
// Crear sala: el creador queda como anfitrión y dentro de ella. Si ya tiene una sala viva, se le devuelve esa.
app.post('/api/5v5/create', auth, wrap(async (req, res) => {
  const rooms = await fvRooms();
  let st = Object.values(rooms).find(r => r.owner === req.user.id);
  if (!st){
    if (Object.keys(rooms).length >= FV_MAX_ROOMS) return res.status(400).json({ error: 'Hay demasiadas salas abiertas; intenta más tarde' });
    let code; do { code = fvCode(); } while (rooms[code]);
    st = { code, v: 0, owner: req.user.id, host: req.user.id, createdAt: Date.now(), players: [], settings: { teamMode: 'elo', roleMode: 'random', champs: false, rerolls: 1, hidden: false }, draw: null };
    st.players.push(await fvPlayerForUser(req.user));
    rooms[code] = st;
  }
  await fvSave(st); res.json(await fvView(st, req.user.id));
}));
app.get('/api/5v5', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const st = await fvRoom(req, res); if (!st) return;
  res.json(await fvView(st, await optionalUid(req)));
}));
app.post('/api/5v5/join', auth, wrap(async (req, res) => {
  const st = await fvRoom(req, res); if (!st) return;
  const p = await fvPlayerForUser(req.user);
  const ex = st.players.find(x => x.id === p.id || x.uid === req.user.id);
  if (st.queue && !ex) return res.status(403).json({ error: 'Esta sala salió de la cola: solo entran los 10 que aceptaron' });
  if (ex){ ex.uid = req.user.id; }
  else { if (st.players.length >= FV_SIZE) return res.status(400).json({ error: 'La sala está llena' }); st.players.push(p); }
  // el anfitrión pasa a quien entra solo si no hay ninguno presente (y no es el creador de la sala)
  if (!st.queue && (st.host == null || (st.host !== st.owner && !st.players.some(x => x.uid === st.host)))) st.host = req.user.id;
  await fvSave(st); res.json(await fvView(st, req.user.id));
}));
// Sacar a un jugador (uno mismo, o cualquiera si eres anfitrión). Al cambiar la sala se anula el sorteo.
app.post('/api/5v5/leave', auth, wrap(async (req, res) => {
  const st = await fvRoom(req, res); if (!st) return;
  const id = String((req.body && req.body.id) || '');
  const target = id ? st.players.find(x => x.id === id) : st.players.find(x => x.uid === req.user.id);
  if (!target) return res.json(await fvView(st, req.user.id));
  if (target.uid !== req.user.id && !fvIsHost(st, req.user)) return res.status(403).json({ error: 'Solo el anfitrión puede sacar a otros' });
  st.players = st.players.filter(x => x !== target); if (!st.queue) st.draw = null;
  if (!st.queue && st.host === target.uid){ const nx = st.players.find(x => x.uid); st.host = nx ? nx.uid : null; }
  await fvSave(st); res.json(await fvView(st, req.user.id));
}));
// El anfitrión agrega a mano a alguien del ranking (para quienes no han iniciado sesión).
app.post('/api/5v5/add', auth, wrap(async (req, res) => {
  const st = await fvRoom(req, res); if (!st) return;
  if (!fvIsHost(st, req.user) && (st.host != null || st.queue)) return res.status(403).json({ error: 'Solo el anfitrión puede agregar jugadores' });
  if (st.players.length >= FV_SIZE) return res.status(400).json({ error: 'La sala está llena' });
  const key = String((req.body && req.body.key) || '');
  const e = (await analysisEntities('top')).find(x => x.key === key);
  if (!e) return res.status(400).json({ error: 'Jugador no encontrado' });
  if (st.players.some(x => x.id === e.key)) return res.status(400).json({ error: 'Ese jugador ya está en la sala' });
  st.players.push(await fvFromEntity(e, null)); st.draw = null;
  if (st.host == null) st.host = req.user.id;
  await fvSave(st); res.json(await fvView(st, req.user.id));
}));
app.post('/api/5v5/settings', auth, wrap(async (req, res) => {
  const st = await fvRoom(req, res); if (!st) return;
  const b = req.body || {};
  if (!fvIsHost(st, req.user)) return res.status(403).json({ error: 'Solo el anfitrión cambia las opciones' });
  if (b.teamMode === 'elo' || b.teamMode === 'random') st.settings.teamMode = b.teamMode;
  if (b.roleMode === 'random' || b.roleMode === 'off' || b.roleMode === 'main') st.settings.roleMode = b.roleMode;
  if (typeof b.champs === 'boolean') st.settings.champs = b.champs;
  if (typeof b.hidden === 'boolean') st.settings.hidden = b.hidden;
  if (b.rerolls != null) st.settings.rerolls = Math.max(0, Math.min(20, parseInt(b.rerolls, 10) || 0));
  await fvSave(st); res.json(await fvView(st, req.user.id));
}));
// Vaciar: saca a todos y borra el sorteo, pero la sala (y su enlace) sigue viva.
app.post('/api/5v5/reset', auth, wrap(async (req, res) => {
  const st = await fvRoom(req, res); if (!st) return;
  if (!fvIsHost(st, req.user)) return res.status(403).json({ error: 'Solo el anfitrión puede vaciar la sala' });
  st.players = []; st.draw = null; st.host = st.owner;
  await fvSave(st); res.json(await fvView(st, req.user.id));
}));
// Cerrar: elimina la sala; el enlace deja de funcionar.
app.post('/api/5v5/close', auth, wrap(async (req, res) => {
  const st = await fvRoom(req, res); if (!st) return;
  if (!fvIsHost(st, req.user)) return res.status(403).json({ error: 'Solo el anfitrión puede cerrar la sala' });
  delete (await fvRooms())[st.code];
  try { await q("DELETE FROM tool_state WHERE id=$1", ['5v5:' + st.code]); } catch {}
  res.json({ ok: true, closed: true });
}));
// Sorteo: equipos de elo parecido + roles + (opcional) campeones.
// Devuelve un mensaje de error, o null si sorteó (deja el resultado en st.draw).
async function fvDoDraw(st){
  const P = st.players;
  if (P.length !== FV_SIZE) return `Se necesitan ${FV_SIZE} jugadores (hay ${P.length})`;
  // A quien no tiene elo conocido se le asigna la mediana del resto, para no desbalancear el reparto.
  const known = P.map(p => p.abs).filter(v => v != null).sort((a, b) => a - b);
  const med = known.length ? known[Math.floor(known.length / 2)] : 0;
  const elo = P.map(p => p.abs != null ? p.abs : med);
  // Las 126 formas de repartir 10 jugadores en 5 y 5; se sortea entre las más parejas.
  const splits = [];
  (function rec(start, pick){
    if (pick.length === 5){ const B = [...Array(10).keys()].filter(i => !pick.includes(i));
      const sa = pick.reduce((s, i) => s + elo[i], 0), sb = B.reduce((s, i) => s + elo[i], 0);
      splits.push({ A: pick, B, sa, sb, diff: Math.abs(sa - sb) }); return; }
    for (let i = start; i < 10; i++) rec(i + 1, pick.concat(i));
  })(1, [0]);
  splits.sort((a, b) => a.diff - b.diff);
  // 'elo' = se sortea entre los repartos más parejos; 'random' = cualquier reparto, sin mirar el elo.
  const anyTeams = st.settings.teamMode === 'random';
  // Parejos: entre los repartos a no más de 100 PL totales (20 por jugador) del mejor posible, y nunca
  // menos de 8 opciones, para que el sorteo no dé siempre los mismos equipos.
  let balanced = splits.filter(s => s.diff <= splits[0].diff + 100); if (balanced.length < 8) balanced = splits.slice(0, 8);
  // Las 120 formas de repartir los 5 roles en un equipo, y qué tan bien calza cada jugador con su rol.
  const perms = []; (function pm(a, r){ if (!r.length){ perms.push(a); return; } r.forEach((x, i) => pm(a.concat(x), r.filter((_, j) => j !== i))); })([], FV_ROLES);
  const fit = (team, pr) => team.reduce((sc, i, k) => sc + (P[i].roles ? (P[i].roles[pr[k]] || 0) : (P[i].main === pr[k] ? 1 : 0)), 0);
  const bestFit = team => Math.max(...perms.map(pr => fit(team, pr)));
  // Priorizando roles: entre los repartos parejos se prefieren los que dejan a más gente en lo suyo
  // (p.ej. que no caigan tres ADC en el mismo equipo). No aplica al modo totalmente al azar.
  if (!anyTeams && st.settings.roleMode === 'main'){
    const scored = balanced.map(sp => ({ sp, f: bestFit(sp.A) + bestFit(sp.B) })), top = Math.max(...scored.map(x => x.f));
    balanced = scored.filter(x => x.f >= top - 0.25).map(x => x.sp);
  }
  const cand = anyTeams ? splits : balanced;
  const S = cand[fvRand(cand.length)];
  const teamsIdx = fvRand(2) ? [S.A, S.B] : [S.B, S.A];
  const rolesFor = team => {
    if (st.settings.roleMode === 'main'){
      // Priorizar roles: el reparto en que el equipo juega lo más posible en lo que suele jugar. Vale más
      // el rol principal; si dos lo comparten, el otro va a su siguiente rol más jugado. Empates al azar.
      const top = bestFit(team), ok = perms.filter(pr => fit(team, pr) >= top - 1e-9);
      return ok[fvRand(ok.length)];
    }
    if (st.settings.roleMode !== 'off') return fvShuffle(FV_ROLES);
    const hits = pr => team.reduce((s, i, k) => s + (P[i].main && P[i].main === pr[k] ? 1 : 0), 0);
    const best = Math.min(...perms.map(hits)), ok = perms.filter(pr => hits(pr) === best);
    return ok[fvRand(ok.length)];
  };
  const pool = st.settings.champs ? await fvChampPool() : null;
  const taken = new Set();   // un campeón no puede repetirse en toda la partida (ni en el equipo rival)
  const teams = teamsIdx.map(team => {
    const pr = rolesFor(team);
    const players = team.map((i, k) => {
      let champ = null;
      if (pool){ const opts = (pool[pr[k]] || []).filter(c => !taken.has(c)); champ = opts.length ? opts[fvRand(opts.length)] : null; if (champ) taken.add(champ); }
      return { id: P[i].id, role: pr[k], champ, used: champ ? [champ] : [], left: st.settings.rerolls };
    }).sort((a, b) => FV_ROLES.indexOf(a.role) - FV_ROLES.indexOf(b.role));
    const sum = team.reduce((s, i) => s + elo[i], 0);
    return { avg: Math.round(sum / team.length), players };
  });
  st.draw = { at: Date.now(), diff: S.diff, teamMode: anyTeams ? 'random' : 'elo', roleMode: st.settings.roleMode, champs: !!pool, hidden: !!pool && !!st.settings.hidden, teams, votes: [] };
  return null;
}
app.post('/api/5v5/draw', auth, wrap(async (req, res) => {
  const st = await fvRoom(req, res); if (!st) return;
  if (!fvIsHost(st, req.user)) return res.status(403).json({ error: 'Solo el anfitrión puede sortear' });
  const err = await fvDoDraw(st); if (err) return res.status(400).json({ error: err });
  await fvSave(st); res.json(await fvView(st, req.user.id));
}));
// Votación de remake: cada jugador de la sala puede votar (o quitar su voto). Con MÁS de 5 votos
// —o sea, 6 de los 10— el sorteo se rehace solo con las mismas opciones, y los votos vuelven a cero.
const FV_REMAKE_VOTES = 6;
app.post('/api/5v5/remake', auth, wrap(async (req, res) => {
  const st = await fvRoom(req, res); if (!st) return;
  if (!st.draw) return res.status(400).json({ error: 'Aún no hay sorteo' });
  const me = st.players.find(p => p.uid === req.user.id);
  if (!me) return res.status(403).json({ error: 'Solo los jugadores de la sala pueden votar' });
  const votes = Array.isArray(st.draw.votes) ? st.draw.votes : (st.draw.votes = []);
  const i = votes.indexOf(me.id); if (i >= 0) votes.splice(i, 1); else votes.push(me.id);
  let remade = false;
  if (votes.length >= FV_REMAKE_VOTES){ const err = await fvDoDraw(st); if (err) return res.status(400).json({ error: err }); remade = true; }
  await fvSave(st); res.json({ ...(await fvView(st, req.user.id)), remade });
}));
app.post('/api/5v5/reveal', auth, wrap(async (req, res) => {
  const st = await fvRoom(req, res); if (!st) return;
  if (!fvIsHost(st, req.user)) return res.status(403).json({ error: 'Solo el anfitrión puede revelar los campeones' });
  if (st.draw) st.draw.hidden = false;
  await fvSave(st); res.json(await fvView(st, req.user.id));
}));
// Cambiar el campeón propio: sale otro del mismo rol que no le haya salido antes ni tenga otro
// jugador de la partida (de cualquiera de los dos equipos).
app.post('/api/5v5/reroll', auth, wrap(async (req, res) => {
  const st = await fvRoom(req, res); if (!st) return;
  const id = String((req.body && req.body.id) || '');
  if (!st.draw || !st.draw.champs) return res.status(400).json({ error: 'No hay campeones sorteados' });
  const team = st.draw.teams.find(t => t.players.some(p => p.id === id)), slot = team && team.players.find(p => p.id === id);
  const pl = st.players.find(p => p.id === id);
  if (!slot || !pl) return res.status(400).json({ error: 'Jugador no encontrado en el sorteo' });
  if (pl.uid !== req.user.id && !fvIsHost(st, req.user)) return res.status(403).json({ error: 'Solo puedes cambiar tu propio campeón' });
  if (st.draw.hidden && pl.uid !== req.user.id){
    const mine = st.players.find(p => p.uid === req.user.id);
    if (!mine || !team.players.some(p => p.id === mine.id)) return res.status(403).json({ error: 'Con selección oculta solo puedes cambiar campeones de tu equipo' });
  }
  if (slot.left <= 0) return res.status(400).json({ error: 'No te quedan cambios' });
  const inGame = new Set(st.draw.teams.flatMap(t => t.players).filter(p => p !== slot).map(p => p.champ).filter(Boolean));
  const opts = ((await fvChampPool())[slot.role] || []).filter(c => !slot.used.includes(c) && !inGame.has(c));
  if (!opts.length) return res.status(400).json({ error: 'No quedan campeones disponibles para ese rol' });
  slot.champ = opts[fvRand(opts.length)]; slot.used.push(slot.champ); slot.left--;
  await fvSave(st); res.json(await fvView(st, req.user.id));
}));

// ---- Cola pública del 5v5: cada uno busca partida; con 10 en cola salta "partida encontrada" (20 s para
// aceptar). Si aceptan todos se arma una sala sin anfitrión, ya sorteada (parejos en elo, roles y campeones
// al azar, 1 cambio). Quien no acepta sale de la cola; los que aceptaron vuelven a la cola con su lugar.
// Quien cierra la página sale de la cola a los 45 s. El estado se respalda en tool_state ('5v5q').
const FVQ_ACCEPT_MS = 20000, FVQ_IDLE_MS = 45000, FVQ_KEY = process.env.RK_LOCAL ? null : '5v5q';
let FVQ = null, FVQ_LOCK = Promise.resolve();
const fvqSerial = fn => { const run = FVQ_LOCK.then(fn); FVQ_LOCK = run.catch(() => {}); return run; };
async function fvqState(){
  if (!FVQ){ FVQ = { queue: [], pending: null, last: {} };
    if (FVQ_KEY) try { const r = await q1('SELECT data FROM tool_state WHERE id=$1', [FVQ_KEY]); if (r && r.data) FVQ = { ...FVQ, ...r.data, last: r.data.last || {} }; } catch {}
    const now = Date.now(); FVQ.queue.forEach(e => { e.seen = now; }); }   // tras un reinicio, nadie se cae de la cola por inactivo
  return FVQ;
}
async function fvqSave(){ if (!FVQ_KEY) return;
  try { await q("INSERT INTO tool_state (id, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data=$2::jsonb, updated_at=now()", [FVQ_KEY, JSON.stringify(FVQ)]); } catch {} }
async function fvqCreateRoom(uids){
  const rooms = await fvRooms(); let code; do { code = fvCode(); } while (rooms[code]);
  const st = { code, v: 0, owner: null, host: null, queue: true, createdAt: Date.now(), players: [], settings: { teamMode: 'elo', roleMode: 'random', champs: true, rerolls: 1, hidden: false }, draw: null };
  for (const uid of uids){ const u = await q1('SELECT id, riotid, nickname FROM users WHERE id=$1', [uid]); if (u) st.players.push(await fvPlayerForUser(u)); }
  rooms[code] = st;
  if (st.players.length === FV_SIZE) await fvDoDraw(st);
  await fvSave(st); return code;
}
function fvqTick(){ return fvqSerial(async () => {
  const s = await fvqState(), now = Date.now(); let ch = false;
  const inPend = new Set(s.pending ? s.pending.uids : []);
  const n0 = s.queue.length; s.queue = s.queue.filter(e => inPend.has(e.uid) || now - (e.seen || 0) < FVQ_IDLE_MS); if (s.queue.length !== n0) ch = true;
  if (s.pending){ const p = s.pending;
    if (p.accepted.length >= p.uids.length){
      const code = await fvqCreateRoom(p.uids), set = new Set(p.uids);
      s.queue = s.queue.filter(e => !set.has(e.uid)); p.uids.forEach(u => { s.last[u] = { code, at: now }; }); s.pending = null; ch = true;
    } else if (p.declined.length || now > p.deadline){
      const out = new Set(p.declined.length ? p.declined : p.uids.filter(u => !p.accepted.includes(u)));
      s.queue = s.queue.filter(e => !out.has(e.uid)); s.pending = null; ch = true;
    }
  }
  if (!s.pending && s.queue.length >= FV_SIZE){
    const uids = s.queue.slice().sort((a, b) => a.since - b.since).slice(0, FV_SIZE).map(e => e.uid);
    s.pending = { id: fvCode(), uids, accepted: [], declined: [], deadline: now + FVQ_ACCEPT_MS }; ch = true;
  }
  for (const u of Object.keys(s.last)) if (now - s.last[u].at > FV_TTL){ delete s.last[u]; ch = true; }
  if (ch) await fvqSave();
  return s;
}); }
function fvqView(s, uid){
  const out = { now: Date.now(), size: FV_SIZE, count: s.queue.length, inQueue: false, since: null, pending: null, room: null };
  if (!uid) return out;
  const e = s.queue.find(x => x.uid === uid); if (e){ out.inQueue = true; out.since = e.since; }
  const p = s.pending; if (p && p.uids.includes(uid)) out.pending = { id: p.id, deadline: p.deadline, accepted: p.accepted.length, total: p.uids.length, iAccepted: p.accepted.includes(uid) };
  if (s.last[uid]) out.room = s.last[uid].code;
  return out;
}
app.get('/api/5v5/queue', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const uid = await optionalUid(req), s = await fvqState();
  const e = uid && s.queue.find(x => x.uid === uid); if (e) e.seen = Date.now();
  res.json(fvqView(await fvqTick(), uid));
}));
app.post('/api/5v5/queue/join', auth, wrap(async (req, res) => {
  const uid = req.user.id;
  await fvqSerial(async () => { const s = await fvqState(), now = Date.now();
    if (!s.queue.some(x => x.uid === uid)) s.queue.push({ uid, since: now, seen: now });
    delete s.last[uid]; await fvqSave(); });
  res.json(fvqView(await fvqTick(), uid));
}));
app.post('/api/5v5/queue/leave', auth, wrap(async (req, res) => {
  const uid = req.user.id;
  await fvqSerial(async () => { const s = await fvqState();
    if (s.pending && s.pending.uids.includes(uid) && !s.pending.declined.includes(uid)) s.pending.declined.push(uid);
    s.queue = s.queue.filter(x => x.uid !== uid); await fvqSave(); });
  res.json(fvqView(await fvqTick(), uid));
}));
app.post('/api/5v5/queue/accept', auth, wrap(async (req, res) => {
  const uid = req.user.id, yes = !(req.body && req.body.accept === false);
  const err = await fvqSerial(async () => { const s = await fvqState(), p = s.pending;
    if (!p || !p.uids.includes(uid)) return 'No hay partida por aceptar';
    if (yes){ if (!p.accepted.includes(uid)) p.accepted.push(uid); } else if (!p.declined.includes(uid)) p.declined.push(uid);
    await fvqSave(); return null; });
  if (err) return res.status(400).json({ error: err });
  res.json(fvqView(await fvqTick(), uid));
}));
// la cola avanza aunque nadie esté mirando (vencimiento de la aceptación, inactivos)
setInterval(() => { if (FVQ) fvqTick().catch(() => {}); }, 2000).unref();

// ================= HERRAMIENTAS · RANKED (cola interna con ranking propio) =================
// Los jugadores eligen rol principal/secundario y entran a una cola. Al juntarse 10 hay que aceptar
// (como en el LoL); después se arma la sala con equipos parejos por MMR, se hace el pick/ban igual
// por turnos como en torneo (cada jugador banea uno; bans y picks en dos fases) y al terminar los jugadores votan quién ganó.
// Ranking como el del LoL: Hierro→Diamante con 4 divisiones de 100 PL, y Maestro+ con PL abiertos.
// Todos parten en Maestro con 0 PL. El estado vive en memoria y se respalda en la DB.
const RK_ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const RK_START = 2800;                         // Maestro, 0 PL (en puntos absolutos de liga)
const RK_SIZE = 10;
const RK_READY_MS = 30000, RK_BAN_MS = 30000, RK_PICK_MS = 30000;
// Gracia: el reloj que se ve llega a 0, pero el turno se cierra unos segundos despues (como en el LoL),
// para que quien aprieta "fijar" en el ultimo segundo no termine con un campeon al azar.
const RK_GRACE_MS = 3000;
// Cambio de campeón: se puede pedir hasta 30 s después de fijarlo (lo acepta el rival). Por eso, tras el último pick
// hay una fase final de 30 s antes de cerrar el draft.
const RK_PICKCHG_MS = 30000, RK_FINAL_MS = 30000;
// Preparación: 1 min al inicio para ponerse de acuerdo. Solo en esa fase se pueden cambiar los roles.
const RK_PREP_MS = 60000;
const RK = { ready: false, players: new Map(), queue: new Map(), pending: new Map(), matches: new Map(), byUser: new Map(), last: new Map(), pseq: 1 };
const RK_TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'], RK_DIVS = ['IV', 'III', 'II', 'I'];
// Rango visible a partir de los puntos absolutos: 400 por liga (4 divisiones de 100) hasta Diamante I;
// desde 2800 es Maestro (Gran Maestro con 300 PL, Retador con 500 PL).
// La ladder SUBE en general (no es suma cero): se gana más de lo que se pierde (base +23 / -17, o sea +3 PL por partida
// para alguien con 50% de victorias) y el MMR sube lo mismo por partida jugada, para que el ajuste PL↔MMR no lo anule.
// Con 60% de victorias son ~+7 PL por partida: de Diamante IV a Maestro en ~57 partidas y a Retador en ~130.
const RK_WIN_BASE = 23, RK_LOSS_BASE = 17, RK_DRIFT = 3;
function rkRank(abs){
  abs = Math.max(0, Math.round(abs));
  if (abs >= 2800){ const lp = abs - 2800; return { tier: lp >= 500 ? 'CHALLENGER' : lp >= 300 ? 'GRANDMASTER' : 'MASTER', div: '', lp, abs }; }
  const ti = Math.floor(abs / 400), rem = abs - ti * 400, di = Math.floor(rem / 100);
  return { tier: RK_TIERS[ti], div: RK_DIVS[di], lp: rem - di * 100, abs };
}
// Peso del voto: quien vota mal seguido pesa menos y, si insiste, pierde el voto.
const rkVoteWeight = strikes => strikes >= 4 ? 0 : strikes >= 2 ? 0.5 : 1;
// Carga inicial (una sola vez; quien llegue mientras carga espera la misma promesa, así nadie ve la cola vacía al arrancar).
function rkInit(){ if (!RK.initP) RK.initP = rkInitLoad(); return RK.initP; }
async function rkInitLoad(){
  RK.ready = true;
  try { for (const r of await q('SELECT * FROM ranked_players')) RK.players.set(r.user_id, { uid: r.user_id, role1: r.role1, role2: r.role2, mmr: +r.mmr, lp: +r.lp, wins: r.wins | 0, losses: r.losses | 0, strikes: r.strikes | 0,
    gMain: r.g_main | 0, gSec: r.g_sec | 0, gOff: r.g_off | 0, gFill: r.g_fill | 0, lastOff: !!r.last_off }); } catch {}
  if (RK_LOCAL){ console.log('Ranked en modo local (RK_LOCAL=1): no se cargan salas reales ni la cola'); return; }
  // Migración (una sola vez): antes se partía en Diamante IV (2400); ahora en Maestro (2800). A quienes ya jugaron se
  // les suman los 400 PL (y 400 de MMR), así conservan lo que ganaron o perdieron; también el rango guardado en cada partida.
  try { if (!(await q1("SELECT 1 FROM tool_state WHERE id='rk:mig:master'"))){
    await q("INSERT INTO tool_state (id, data, updated_at) VALUES ('rk:mig:master', '{}'::jsonb, now()) ON CONFLICT (id) DO NOTHING");
    for (const p of RK.players.values()){ if (p.uid < 0) continue; p.lp += 400; p.mmr += 400; await rkSavePlayer(p); }
    for (const r of await q('SELECT id, data FROM ranked_matches')){ const d = r.data; let ch = false;
      for (const c of Object.values(d.lpChanges || {})) if (c && c.lp != null){ c.lp += 400; ch = true; }
      for (const t of d.teams || []){ if (t.avgMmr != null){ t.avgMmr += 400; ch = true; } for (const p of t.players || []){ if (p.lp != null) p.lp += 400; if (p.mmr != null) p.mmr += 400; } }
      if (ch) await q('UPDATE ranked_matches SET data=$2::jsonb WHERE id=$1', [r.id, JSON.stringify(d)]); }
    console.log('Ranked: migración a Maestro aplicada (+400 PL a ' + [...RK.players.values()].filter(p => p.uid > 0).length + ' jugadores)'); } } catch (e) { console.error('migración Maestro:', e.message); }
  try { for (const r of await q("SELECT id, data FROM ranked_matches WHERE status IN ('draft','playing','dispute')")){ const m = r.data; m.id = r.id; RK.matches.set(m.id, m); rkUids(m).forEach(u => RK.byUser.set(u, m.id)); } } catch {}
  try { const r = await q1("SELECT data FROM tool_state WHERE id='rk:queue' AND updated_at > now() - interval '3 hours'");
    for (const e of (r && Array.isArray(r.data) ? r.data : [])) if (e && Number.isFinite(e.uid) && !RK.byUser.has(e.uid)) RK.queue.set(e.uid, { uid: e.uid, since: e.since || Date.now() });
    _rkQueueSig = [...RK.queue.values()].map(e => e.uid + ':' + e.since).sort().join(','); } catch {}
  try { await q("DELETE FROM tool_state WHERE id LIKE 'rksim:%' AND updated_at < now() - interval '3 hours'");
    for (const r of await q("SELECT data FROM tool_state WHERE id LIKE 'rksim:%'")){ const m = r.data; if (!m || m.id == null || rkUids(m).some(u => RK.byUser.has(u))) continue;
      RK.matches.set(m.id, m); rkUids(m).forEach(u => RK.byUser.set(u, m.id)); } } catch {}
  for (const u of [...RK.queue.keys()]) if (RK.byUser.has(u)) RK.queue.delete(u);   // quien ya está en una sala no sigue en cola
}
const rkUids = m => m.teams.flatMap(t => t.players.map(p => p.uid));
// La cola se respalda en tool_state cada vez que cambia y se recupera al arrancar: así un deploy/reinicio del
// servidor no saca a nadie de la cola (antes había que volver a buscar partida después de cada commit).
let _rkQueueSig = null;
function rkSaveQueue(){
  if (RK_LOCAL) return;
  const list = [...RK.queue.values()].map(e => ({ uid: e.uid, since: e.since })), sig = list.map(e => e.uid + ':' + e.since).sort().join(',');
  if (sig === _rkQueueSig) return; _rkQueueSig = sig;
  q("INSERT INTO tool_state (id, data, updated_at) VALUES ('rk:queue', $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data=$1::jsonb, updated_at=now()", [JSON.stringify(list)]).catch(() => {});
}
function rkPlayer(uid){
  let p = RK.players.get(uid);
  if (!p){ p = { uid, role1: null, role2: null, mmr: RK_START, lp: RK_START, wins: 0, losses: 0, strikes: 0, gMain: 0, gSec: 0, gOff: 0, gFill: 0, lastOff: false }; RK.players.set(uid, p); }
  return p;
}
async function rkSavePlayer(p){
  if (p.uid < 0) return;                       // jugadores ficticios del modo prueba: solo en memoria
  if (RK_LOCAL) return;                        // pruebas locales: no tocar los perfiles reales
  try { await q(`INSERT INTO ranked_players (user_id, role1, role2, mmr, lp, wins, losses, strikes, g_main, g_sec, g_off, g_fill, last_off, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
    ON CONFLICT (user_id) DO UPDATE SET role1=$2, role2=$3, mmr=$4, lp=$5, wins=$6, losses=$7, strikes=$8, g_main=$9, g_sec=$10, g_off=$11, g_fill=$12, last_off=$13, updated_at=now()`,
    [p.uid, p.role1, p.role2, p.mmr, Math.round(p.lp), p.wins, p.losses, p.strikes, p.gMain | 0, p.gSec | 0, p.gOff | 0, p.gFill | 0, !!p.lastOff]); } catch {}
}
async function rkSaveMatch(m){
  // Sala de prueba: no va a ranked_matches (ni a la tabla), pero se respalda en tool_state para que un reinicio del
  // servidor (un deploy) no la borre a mitad del draft. Se borra al terminar o anularse.
  if (m.sim && RK_LOCAL){ if (m.id == null) m.id = -Date.now(); return; }
  if (!m.sim && RK_LOCAL){ if (m.id == null) m.id = -Date.now(); return; }   // modo local: nada a la base
  if (m.sim){ if (m.id == null) m.id = -Date.now();
    try { if (m.status === 'done' || m.status === 'cancelled') await q('DELETE FROM tool_state WHERE id=$1', ['rksim:' + m.id]);
          else await q("INSERT INTO tool_state (id, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data=$2::jsonb, updated_at=now()", ['rksim:' + m.id, JSON.stringify(m)]); } catch {}
    return; }
  try {
    if (m.id == null){ const r = await q1('INSERT INTO ranked_matches (status, data) VALUES ($1, $2::jsonb) RETURNING id', [m.status, JSON.stringify(m)]); m.id = r ? r.id : -Date.now(); }
    await q('UPDATE ranked_matches SET status=$2, data=$3::jsonb, ended_at=$4 WHERE id=$1', [m.id, m.status, JSON.stringify(m), m.endedAt ? new Date(m.endedAt) : null]);
  } catch { if (m.id == null) m.id = -Date.now(); }
}
// Nick y Riot ID de cada usuario (cache 5 min).
let RK_USERS = { at: 0, map: new Map() };
async function rkUsers(){
  if (Date.now() - RK_USERS.at < 300000) return RK_USERS.map;
  const map = new Map();
  try { for (const u of await q('SELECT id, nickname, riotid, is_admin FROM users')) map.set(u.id, { nick: (u.nickname || '').trim() || (u.riotid || '').split('#')[0], rid: u.riotid || '', admin: !!u.is_admin }); } catch {}
  RK_BOTS.forEach(b => map.set(b, rkBotUser(b)));
  RK_USERS = { at: Date.now(), map }; return map;
}
// Campeones válidos para el draft (id y nombre desde Data Dragon; si falla, los de las partidas guardadas).
let RK_CHAMPS = { at: 0, list: null };
async function rkChamps(){
  if (RK_CHAMPS.list && Date.now() - RK_CHAMPS.at < 12 * 3600 * 1000) return RK_CHAMPS.list;
  let list = null;
  try { const ver = (liveSnapshot().ddragonVersion) || '16.15.1';
    const r = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/es_MX/champion.json`); if (r.ok){ const j = await r.json(); list = Object.values(j.data).filter(c => /^[A-Za-z]+$/.test(c.id)).map(c => ({ id: c.id, name: c.name })); } } catch {}   // fuera variantes de modos ("Jade_Ahri"): salían repetidos
  if (!list || !list.length){ try { list = (await q("SELECT DISTINCT champion c FROM match_participants WHERE coalesce(champion,'')<>''")).map(r => ({ id: r.c, name: r.c })); } catch { list = RK_CHAMPS.list || []; } }
  list.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  RK_CHAMPS = { at: Date.now(), list }; return list;
}
// Preferencia de un jugador por un rol: 1 = principal, 0.6 = secundario, 0.5 = "relleno", 0 = fuera de lo que pidió.
const rkPref = (p, role) => p.role1 === role ? 1 : p.role2 === role ? 0.6 : (p.role1 === 'FILL' || p.role2 === 'FILL') ? 0.5 : 0;
const rkPrefName = v => v >= 1 ? 'main' : v >= 0.6 ? 'sec' : v >= 0.5 ? 'fill' : 'auto';
// Reparto justo de roles: cada jugador tiene memoria de qué le tocó (principal / secundario / fuera de rol).
// Quien ha quedado seguido en su secundario o fuera de rol pesa más al repartir, así que el sistema prefiere
// darle su rol a él y mandar a otro (que suele tener suerte) al secundario o a rellenar. Quien quedó fuera de rol
// en su última partida tiene protección extra (como el "autofill protection" del LoL).
// Las tasas se suavizan (se suman 3 partidas "neutras") para que una sola partida no cambie todo.
function rkFillStats(p){
  const n = (p.gMain | 0) + (p.gSec | 0) + (p.gOff | 0) + (p.gFill | 0), d = n + 3;
  return { n, main: n ? (p.gMain | 0) / n : 0, sec: n ? (p.gSec | 0) / n : 0, off: n ? (p.gOff | 0) / n : 0, fill: n ? (p.gFill | 0) / n : 0,
    weight: 1 + 2.5 * ((p.gOff | 0) / d) + 1 * ((p.gSec | 0) / d) + (p.lastOff ? 1.5 : 0) };
}
// Arma la sala: entre las 126 formas de repartir 10 jugadores y todas las asignaciones de roles, elige la
// que mejor combina "cada uno en lo que pidió" (ponderado por su prioridad de arriba) con equipos de MMR parejo
// (un rol bien asignado vale 60 MMR).
async function rkCreateMatch(uids){
  const users = await rkUsers();
  const P = uids.map(uid => { const p = rkPlayer(uid), u = users.get(uid) || { nick: 'Jugador ' + uid, rid: '' }; return { uid, nick: u.nick, rid: u.rid, mmr: p.mmr, lp: p.lp, role1: p.role1, role2: p.role2, w: rkFillStats(p).weight }; });
  const perms = []; (function pm(a, r){ if (!r.length){ perms.push(a); return; } r.forEach((x, i) => pm(a.concat(x), r.filter((_, j) => j !== i))); })([], RK_ROLES);
  const bestPerm = team => { let bs = -Infinity, opts = []; for (const pr of perms){ const sc = team.reduce((s, i, k) => s - (1 - rkPref(P[i], pr[k])) * P[i].w, 0); if (sc > bs + 1e-9){ bs = sc; opts = [pr]; } else if (Math.abs(sc - bs) < 1e-9) opts.push(pr); } return { sc: bs, pr: opts[fvRand(opts.length)] }; };
  let best = null, bestScore = -Infinity;
  (function rec(start, pick){
    if (pick.length === 5){ const B = [...Array(10).keys()].filter(i => !pick.includes(i));
      const a = bestPerm(pick), b = bestPerm(B), diff = Math.abs(pick.reduce((s, i) => s + P[i].mmr, 0) - B.reduce((s, i) => s + P[i].mmr, 0)) / 5;
      const score = (a.sc + b.sc) * 60 - diff + Math.random() * 0.01;
      if (score > bestScore){ bestScore = score; best = { A: pick, B, pa: a.pr, pb: b.pr }; } return; }
    for (let i = start; i < 10; i++) rec(i + 1, pick.concat(i));
  })(1, [0]);
  const mk = (idx, pr, side) => ({ side, avgMmr: Math.round(idx.reduce((s, i) => s + P[i].mmr, 0) / 5),
    players: idx.map((i, k) => ({ uid: P[i].uid, nick: P[i].nick, rid: P[i].rid, role: pr[k], pref: rkPrefName(rkPref(P[i], pr[k])), mmr: P[i].mmr, lp: P[i].lp }))
      .sort((x, y) => RK_ROLES.indexOf(x.role) - RK_ROLES.indexOf(y.role)) });
  // El equipo con menos elo (rango promedio; si empatan, MMR) va al lado rojo. Empate total: al azar.
  const avg = (idx, k) => idx.reduce((s, i) => s + P[i][k], 0) / idx.length;
  const dLp = avg(best.A, 'lp') - avg(best.B, 'lp'), dMmr = avg(best.A, 'mmr') - avg(best.B, 'mmr');
  const flip = dLp !== 0 ? dLp < 0 : dMmr !== 0 ? dMmr < 0 : fvRand(2) === 1;   // flip = A va a rojo
  const blue = mk(flip ? best.B : best.A, flip ? best.pb : best.pa, 'blue'), red = mk(flip ? best.A : best.B, flip ? best.pa : best.pb, 'red');
  // Draft por turnos, como en torneo (azul = equipo de la izquierda). El orden dentro de cada equipo es al azar
  // y vale para banear y para elegir; dos compañeros pueden intercambiar sus turnos (ver /api/ranked/swap).
  //   bans  A R A R A R  →  picks A · RR · AA · R  →  bans A R A R  →  picks R · AA · R
  // Cada pick es su propio turno con su propio tiempo (en un doble pick, primero uno y después el otro).
  const bo = fvShuffle(blue.players.map(p => p.uid)), ro = fvShuffle(red.players.map(p => p.uid));
  const bb = bo, rb = ro;
  const B = u => ({ t: 'ban', u: [u] }), K = (...u) => ({ t: 'pick', u });
  const seq = [B(bb[0]), B(rb[0]), B(bb[1]), B(rb[1]), B(bb[2]), B(rb[2]), K(bo[0]), K(ro[0]), K(ro[1]), K(bo[1]), K(bo[2]), K(ro[2]),
               B(bb[3]), B(rb[3]), B(bb[4]), B(rb[4]), K(ro[3]), K(bo[3]), K(bo[4]), K(ro[4])];
  const assigned = {}; [blue, red].forEach(t => t.players.forEach(p => { assigned[p.uid] = p.pref; }));
  const m = { id: null, sim: uids.some(u => u < 0), status: 'draft', createdAt: Date.now(), teams: [blue, red], assigned,
    draft: { phase: 'prep', deadline: Date.now() + RK_PREP_MS, bans: {}, locked: {}, step: 0, picks: {}, seq, swaps: {}, hover: {}, banHover: {}, roleSwaps: {}, banReq: {}, banChanged: {} }, kicks: {},
    lobby: null, votes: {}, winner: null, resolvedBy: null, lpChanges: {} };
  await rkSaveMatch(m);
  RK.matches.set(m.id, m); uids.forEach(u => { RK.byUser.set(u, m.id); RK.queue.delete(u); });
  return m;
}
// Cambio de lado: en la preparación, el equipo rojo (el de menos elo) puede votar para jugar en azul; con 4 de 5
// votos los equipos intercambian lados. Cada jugador toma el turno equivalente del otro lado (el 1° en banear del
// rojo pasa a ser el 1° del azul, etc.).
const RK_SIDE_NEED = 4;
function rkSwapSides(m){
  const d = m.draft, [blue, red] = m.teams, side = u => blue.players.some(p => p.uid === u) ? 'blue' : 'red';
  const order = s => d.seq.filter(x => x.t === 'ban').flatMap(x => x.u).filter(u => side(u) === s);
  const bo = order('blue'), ro = order('red'), mate = {};
  bo.forEach((u, i) => { mate[u] = ro[i]; mate[ro[i]] = u; });
  d.seq.forEach(x => { x.u = x.u.map(u => mate[u] != null ? mate[u] : u); });
  red.side = 'blue'; blue.side = 'red'; m.teams = [red, blue];
  d.sideSwapped = true; d.sideVotes = [];
}
// Borra las selecciones (sin fijar) de campeones que ya fueron baneados o elegidos.
function rkPurgeHovers(d){
  const taken = new Set([...Object.values(d.bans || {}).filter(Boolean), ...Object.values(d.picks || {})]);
  for (const k of ['hover', 'banHover']) for (const u of Object.keys(d[k] || {})) if (taken.has(d[k][u])) delete d[k][u];
}
const rkTeamOf = (m, uid) => m.teams.find(t => t.players.some(p => p.uid === uid));
const rkSlot = (m, uid) => { for (const t of m.teams){ const p = t.players.find(x => x.uid === uid); if (p) return p; } return null; };
// Avanza el draft cuando el turno terminó o se acabó el tiempo. Quien no banea a tiempo pierde su ban; a quien
// no elige se le asigna un campeón al azar jugable en su rol (para no cancelar la sala por un despistado).
// Las revisiones de una misma sala van en fila (una termina antes de que empiece la otra). Antes corrían en paralelo
// (la del latido de cada segundo y la de quien acababa de fijar campeón) y, como el paso de picks espera la lista de
// campeones, las dos avanzaban un turno: se saltaba el siguiente entero (p.ej. los 2 picks del rojo).
const RK_ADV = new Map();
function rkAdvance(m){
  const prev = RK_ADV.get(m.id) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => rkAdvanceOnce(m));
  RK_ADV.set(m.id, run);
  run.finally(() => { if (RK_ADV.get(m.id) === run) RK_ADV.delete(m.id); }).catch(() => {});
  return run;
}
async function rkAdvanceOnce(m){
  const d = m.draft; let changed = false;
  if (m.status !== 'draft') return false;
  if (!d.seq){ await rkCancel(m, 'formato antiguo'); return true; }
  while (m.status === 'draft'){
    if (d.phase === 'prep'){
      if (Date.now() < d.deadline) break;
      d.phase = d.seq[d.step].t; d.deadline = Date.now() + (d.phase === 'ban' ? RK_BAN_MS : RK_PICK_MS); d.roleSwaps = {};
      changed = true; continue;
    }
    if (d.phase === 'final'){
      if (Date.now() < d.deadline) break;
      d.phase = 'done'; d.deadline = null; m.status = 'playing'; m.playingAt = Date.now(); d.banReq = {}; d.roleSwaps = {}; d.swaps = {}; d.pickReq = {}; d.trades = {};
      m.lobby = { name: 'SQC-' + String(Math.abs(m.id)).slice(-3).padStart(3, '0'), pass: String(1000 + fvRand(9000)) };
      changed = true; break;
    }
    const st = d.seq[d.step], done = u => st.t === 'ban' ? d.locked[u] : d.picks[u];
    if (!(st.u.every(done) || Date.now() >= d.deadline + RK_GRACE_MS)) break;
    // se acabo el tiempo: se fija lo que tenia seleccionado (si sigue libre); si no, ban vacio / campeon al azar
    const takenNow = () => new Set([...Object.values(d.bans).filter(Boolean), ...Object.values(d.picks)]);
    if (st.t === 'ban') st.u.forEach(u => { if (!d.locked[u]){ const h = (d.banHover || {})[u]; d.locked[u] = true; d.bans[u] = h && !takenNow().has(h) ? h : null; } });
    else if (st.u.some(u => !d.picks[u])){   // solo si falta alguien (si ya eligieron todos, no hay nada que esperar)
      const at = d.step, pool = await fvChampPool(), valid = (await rkChamps()).map(c => c.id), byRole = await rkChampRoles();
      if (d.step !== at || m.status !== 'draft') continue;   // por si algo cambió mientras se esperaba
      for (const u of st.u){ if (d.picks[u]) continue;
        const taken = takenNow(), h = (d.hover || {})[u];
        d.pickAt = d.pickAt || {}; d.pickAt[u] = Date.now();
        if (h && !taken.has(h)){ d.picks[u] = h; continue; }
        const role = rkSlot(m, u).role;
        let opts = byRole.filter(c => c.roles.includes(role) && !taken.has(c.id)).map(c => c.id);
        if (!opts.length) opts = (pool[role] || []).filter(c => !taken.has(c)); if (!opts.length) opts = valid.filter(c => !taken.has(c));
        d.picks[u] = opts[fvRand(opts.length)]; rkSlot(m, u).auto = true; }
    }
    d.step++; changed = true; rkPurgeHovers(d);
    if (d.step >= d.seq.length){ d.phase = 'final'; d.deadline = Date.now() + RK_FINAL_MS; }
    else { d.phase = d.seq[d.step].t; d.deadline = Date.now() + (d.phase === 'ban' ? RK_BAN_MS : RK_PICK_MS); }
  }
  if (changed) await rkSaveMatch(m);
  return changed;
}
// Cierra la partida: reparte MMR y PL, y anota quién votó bien o mal.
async function rkResolve(m, winner, by){
  const [blue, red] = m.teams, eBlue = 1 / (1 + Math.pow(10, (red.avgMmr - blue.avgMmr) / 400));
  m.winner = winner; m.resolvedBy = by; m.status = 'done'; m.endedAt = Date.now();
  if (m.sim){   // sala de prueba: se muestra el resultado, pero no se mueven PL, MMR ni faltas de nadie
    for (const t of m.teams) for (const s of t.players){ const won = t.side === winner, lp = rkPlayer(s.uid).lp;
      RK.last.set(s.uid, { matchId: m.id, won, delta: won ? RK_WIN_BASE : -RK_LOSS_BASE, before: lp, after: lp, at: m.endedAt, by, sim: true }); }
    try { await q('DELETE FROM tool_state WHERE id=$1', ['rksim:' + m.id]); } catch {}
    RK.matches.delete(m.id); rkUids(m).forEach(u => RK.byUser.delete(u)); return;
  }
  for (const t of m.teams){
    const won = t.side === winner, e = t.side === 'blue' ? eBlue : 1 - eBlue;
    for (const s of t.players){ const p = rkPlayer(s.uid);
      const pf = m.assigned && m.assigned[s.uid], lastOffBefore = !!p.lastOff;   // memoria de roles (lo que asignó el emparejamiento)
      if (pf){ if (pf === 'main') p.gMain = (p.gMain | 0) + 1; else if (pf === 'sec') p.gSec = (p.gSec | 0) + 1; else if (pf === 'fill') p.gFill = (p.gFill | 0) + 1; else p.gOff = (p.gOff | 0) + 1; p.lastOff = pf === 'auto'; }
      const gap = (p.mmr - p.lp) / 25;          // quien tiene más MMR que rango sube más rápido (y al revés)
      const delta = won ? Math.max(12, Math.min(35, Math.round(RK_WIN_BASE + gap + (0.5 - e) * 10)))
                        : -Math.max(8, Math.min(30, Math.round(RK_LOSS_BASE - gap + (e - 0.5) * 10)));
      const before = p.lp, mmrDelta = 40 * ((won ? 1 : 0) - e) + RK_DRIFT, strikesBefore = p.strikes; p.lp = Math.max(0, p.lp + delta); p.mmr = p.mmr + mmrDelta;
      if (won) p.wins++; else p.losses++;
      const v = m.votes[s.uid]; if (v){ if (v === winner) p.strikes = Math.max(0, p.strikes - 1); else p.strikes++; }
      m.lpChanges[s.uid] = { delta: p.lp - before, lp: p.lp, voted: v || null, ok: v ? v === winner : null, mmr: mmrDelta, won, strikes: strikesBefore, pf: pf || null, lastOff: lastOffBefore };
      await rkSavePlayer(p);
      RK.last.set(s.uid, { matchId: m.id, won, delta: p.lp - before, before, after: p.lp, at: m.endedAt, by });
    }
  }
  await rkSaveMatch(m); RK.matches.delete(m.id); rkUids(m).forEach(u => RK.byUser.delete(u)); RK_HIST.at = 0;
}
async function rkCancel(m, by, kicked){
  m.status = 'cancelled'; m.resolvedBy = by; m.endedAt = Date.now(); if (kicked != null) m.kicked = kicked;
  const kn = kicked != null ? (rkSlot(m, kicked) || {}).nick : null;
  rkUids(m).forEach(u => RK.last.set(u, { matchId: m.id, cancelled: true, kicked: kn, wasMe: u === kicked, at: m.endedAt, by }));
  await rkSaveMatch(m); RK.matches.delete(m.id); rkUids(m).forEach(u => RK.byUser.delete(u));
}
// Cambio de turno entre dos compañeros: solo se intercambian los turnos (de ban y/o de pick) que AMBOS tienen
// todavía por delante; un turno en curso o ya jugado no se toca (así nadie banea dos veces ni se queda sin elegir).
function rkSwapTypes(m, a, b){
  const d = m.draft; if (m.status !== 'draft' || !d.seq) return [];
  const from = d.phase === 'prep' ? d.step : d.step + 1;
  const pend = (u, t) => d.seq.some((x, i) => i >= from && x.t === t && x.u.includes(u));
  return ['ban', 'pick'].filter(t => pend(a, t) && pend(b, t));
}
function rkDoSwap(m, a, b){
  const d = m.draft, types = rkSwapTypes(m, a, b);
  const from = d.phase === 'prep' ? d.step : d.step + 1;
  d.seq.forEach((x, i) => { if (i >= from && types.includes(x.t)) x.u = x.u.map(u => u === a ? b : u === b ? a : u); });
  rkSyncBans(m);
  return types;
}
// El orden de bans sigue al orden de picks: tras un cambio de turno, los bans que faltan (los que aún no empiezan) se
// reparten entre quienes todavía no banean, en el orden en que eligen. Así el ban no queda pegado al orden inicial.
function rkSyncBans(m){
  const d = m.draft; if (!d.seq) return;
  const from = d.phase === 'prep' ? d.step : d.step + 1, cur = d.phase === 'prep' ? null : d.seq[d.step];
  for (const t of m.teams){
    const mine = new Set(t.players.map(p => p.uid));
    const pickOrder = d.seq.filter(x => x.t === 'pick').flatMap(x => x.u).filter(u => mine.has(u));
    const busy = new Set(cur && cur.t === 'ban' ? cur.u : []);   // quien está baneando ahora conserva su turno
    const free = pickOrder.filter(u => !d.locked[u] && !busy.has(u));
    const slots = d.seq.map((x, i) => i).filter(i => i >= from && d.seq[i].t === 'ban' && mine.has(d.seq[i].u[0]));
    slots.forEach((i, k) => { if (free[k] != null) d.seq[i].u = [free[k]]; });
  }
}
// Expulsión por votación: si 9 de los 10 marcan al mismo jugador (troleo, o jugar algo distinto a lo elegido),
// la partida se cancela sin cambios de PL.
const RK_KICK_NEED = 9;
async function rkKickVote(m, voter, target, on){
  m.kicks = m.kicks || {}; const v = new Set(m.kicks[target] || []); if (on === false) v.delete(voter); else v.add(voter); m.kicks[target] = [...v];
  if (v.size >= RK_KICK_NEED){ await rkCancel(m, 'expulsion', target); return true; }
  await rkSaveMatch(m); return false;
}
// Recuento ponderado. Gana quien supera la mitad del peso total; si ya votaron todos los que pueden y
// nadie la supera (p.ej. 5 contra 5), queda "en disputa" y lo resuelve un admin.
async function rkCheckVotes(m){
  const uids = rkUids(m), w = u => rkVoteWeight(rkPlayer(u).strikes), total = uids.reduce((s, u) => s + w(u), 0);
  const sum = side => uids.reduce((s, u) => s + (m.votes[u] === side ? w(u) : 0), 0), b = sum('blue'), r = sum('red');
  if (b > total / 2) return rkResolve(m, 'blue', 'votos');
  if (r > total / 2) return rkResolve(m, 'red', 'votos');
  if (uids.filter(u => w(u) > 0).every(u => m.votes[u])){ m.status = 'dispute'; await rkSaveMatch(m); }
  else await rkSaveMatch(m);
}
// Latido: aceptar partida, emparejar y avanzar drafts.
let _rkTicking = false;
async function rkTick(){
  if (RK.stopped) return;
  if (_rkTicking){ await rkInit(); return; } _rkTicking = true;
  try {
    await rkInit(); const now = Date.now();
    for (const pd of [...RK.pending.values()]){
      const all = pd.players.every(u => pd.accepted.has(u));
      if (all){ RK.pending.delete(pd.id); await rkCreateMatch(pd.players); }
      else if (pd.declined.size){
        // alguien rechazó: sale de la cola solo quien rechazó; el resto sigue buscando con su espera intacta
        RK.pending.delete(pd.id); pd.declined.forEach(u => RK.queue.delete(u));
      }
      else if (now >= pd.deadline){
        // se acabó el tiempo: sale de la cola quien no aceptó
        RK.pending.delete(pd.id); pd.players.forEach(u => { if (!pd.accepted.has(u)) RK.queue.delete(u); });
      }
    }
    const busy = new Set([...RK.pending.values()].flatMap(pd => pd.players));
    const free = [...RK.queue.values()].filter(e => !busy.has(e.uid) && !RK.byUser.has(e.uid)).sort((a, b) => a.since - b.since);
    if (free.length >= RK_SIZE){ const id = RK.pseq++; RK.pending.set(id, { id, players: free.slice(0, RK_SIZE).map(e => e.uid), accepted: new Set(), declined: new Set(), deadline: now + RK_READY_MS }); }
    for (const m of [...RK.matches.values()]) await rkAdvance(m);
    rkSaveQueue();
  } catch (e) { console.error('rkTick:', e.message); }
  finally { _rkTicking = false; }
}
// Un solo proceso a cargo de las salas. Si dos servidores avanzan el mismo draft a la vez (en un deploy Render tiene
// un rato el viejo y el nuevo funcionando; o una prueba local apuntando a esta base), cada uno lleva su copia y pasan
// cosas como turnos saltados. Por eso:
//  · RK_LOCAL=1 (pruebas locales): no carga ni guarda las salas reales ni la cola, solo salas de prueba en memoria.
//  · El servidor recién arrancado no toca las salas hasta recibir la primera consulta de Ranked (o sea, cuando ya le
//    llega el tráfico) y recién ahí las carga de la base, con lo último que dejó el anterior.
//  · Al recibir SIGTERM (el deploy lo reemplaza), deja de avanzar salas.
const RK_LOCAL = process.env.RK_LOCAL === '1';
app.use('/api/ranked', (req, res, next) => { RK.armed = true; next(); });
process.on('SIGTERM', () => { RK.stopped = true; });
setInterval(() => { if (RK.armed && !RK.stopped) rkTick(); }, 1000);
// ---- Modo prueba (solo el superadmin): 9 jugadores ficticios (ids negativos) que el superadmin maneja como
// si fuera cada uno, para probar cola, aceptar, draft y votación sin juntar a 10 personas. Una sala con
// algún ficticio queda marcada como `sim`: no se guarda en la base ni cambia PL, MMR o faltas.
const RK_SUPER = 'sionantisionista#sas', RK_BOTS = [-1, -2, -3, -4, -5, -6, -7, -8, -9];
const rkIsSuper = rid => String(rid || '').trim().toLowerCase() === RK_SUPER;
const rkBotUser = uid => ({ nick: 'Bot ' + (-uid), rid: 'Bot ' + (-uid) + '#TEST', admin: false });
// Tras `auth`: si el superadmin manda `as` con un ficticio, la acción se ejecuta como ese jugador.
function rkImp(req, res, next){
  const as = Number(req.body && req.body.as);
  if (RK_BOTS.includes(as) && rkIsSuper(req.user.riotid)) req.user = { id: as, riotid: rkBotUser(as).rid, is_admin: false };
  next();
}
app.post('/api/ranked/admin/sim', auth, wrap(async (req, res) => {
  if (!rkIsSuper(req.user.riotid)) return res.status(403).json({ error: 'Solo superadmin' });
  await rkInit(); const act = req.body && req.body.action, now = Date.now();
  if (act === 'fill'){
    RK_BOTS.forEach((b, i) => { const p = rkPlayer(b);
      if (!p.role1){ p.role1 = RK_ROLES[i % 5]; p.role2 = RK_ROLES[(i + 1 + fvRand(4)) % 5]; }
      if (!RK.byUser.has(b) && !RK.queue.has(b)) RK.queue.set(b, { uid: b, since: now }); });
  } else if (act === 'accept'){
    for (const pd of RK.pending.values()) pd.players.forEach(u => { if (u < 0) pd.accepted.add(u); });
  } else if (act === 'draft'){
    const valid = (await rkChamps()).map(c => c.id), pool = await fvChampPool();
    for (const m of [...RK.matches.values()]){ if (!m.sim || m.status !== 'draft') continue; const d = m.draft;
      // actúan solo los bots a los que les toca en el turno actual
      if (!d.seq[d.step]) continue;
      if (d.phase === 'prep'){ d.deadline = Date.now(); await rkAdvance(m); continue; }
      for (const u of d.seq[d.step].u){ if (u >= 0) continue; const taken = new Set([...Object.values(d.bans).filter(Boolean), ...Object.values(d.picks)]);
        if (d.phase === 'ban'){ if (!d.locked[u]){ const o = valid.filter(c => !taken.has(c)); d.bans[u] = o[fvRand(o.length)] || null; d.locked[u] = true; } }
        else if (!d.picks[u]){ let o = (pool[rkSlot(m, u).role] || []).filter(c => !taken.has(c)); if (!o.length) o = valid.filter(c => !taken.has(c)); d.picks[u] = o[fvRand(o.length)]; } }
      await rkAdvance(m); }
  } else if (act === 'side'){
    for (const m of [...RK.matches.values()]){ if (!m.sim || m.status !== 'draft' || m.draft.phase !== 'prep' || m.draft.sideSwapped) continue; const d = m.draft;
      const v = new Set(d.sideVotes || []), lim = m.teams[1].players.some(p => p.uid > 0 && !v.has(p.uid)) ? RK_SIDE_NEED - 1 : RK_SIDE_NEED;   // si hay un humano en rojo, el último voto es suyo
      m.teams[1].players.forEach(p => { if (p.uid < 0 && v.size < lim) v.add(p.uid); }); d.sideVotes = [...v];
      if (v.size >= RK_SIDE_NEED) rkSwapSides(m); await rkSaveMatch(m); }
  } else if (act === 'remake'){
    for (const m of [...RK.matches.values()]){ if (!m.sim || (m.status !== 'playing' && m.status !== 'dispute')) continue;
      const lim = rkUids(m).some(u => u > 0 && !(m.remake || []).includes(u)) ? RK_REMAKE_NEED - 1 : RK_REMAKE_NEED;   // el último voto es del humano
      for (const u of rkUids(m)) if (u < 0 && (m.remake || []).length < lim && RK.matches.has(m.id)) await rkRemakeVote(m, u, true); }
  } else if (act === 'vote'){
    const side = req.body.team; if (side !== 'blue' && side !== 'red') return res.status(400).json({ error: 'Voto inválido' });
    for (const m of [...RK.matches.values()]){ if (!m.sim || m.status !== 'playing') continue;
      rkUids(m).forEach(u => { if (u < 0 && !m.votes[u]) m.votes[u] = side; }); await rkCheckVotes(m); }
  } else if (act === 'kick'){
    // los bots se suman a toda expulsión que ya tenga algún voto
    for (const m of [...RK.matches.values()]){ if (!m.sim) continue;
      for (const [t, v] of Object.entries(m.kicks || {})){ if (!v.length || !RK.matches.has(m.id)) continue;
        for (const b of rkUids(m)) if (b < 0 && b !== Number(t) && RK.matches.has(m.id)) await rkKickVote(m, b, Number(t), true); } }
  } else if (act === 'clear'){
    RK_BOTS.forEach(b => RK.queue.delete(b));
    for (const pd of [...RK.pending.values()]) if (pd.players.some(u => u < 0)) RK.pending.delete(pd.id);
    for (const m of [...RK.matches.values()]) if (m.sim) await rkCancel(m, 'prueba');
    RK_BOTS.forEach(b => { RK.players.delete(b); RK.last.delete(b); });
  } else return res.status(400).json({ error: 'Acción inválida' });
  await rkTick(); res.json({ ok: true });
}));
// Lo que ve cada jugador de su sala.
async function rkMatchView(m, uid){
  const d = m.draft, my = rkTeamOf(m, uid), cur = m.status === 'draft' && d.seq && d.phase !== 'prep' ? d.seq[d.step] : null, sw = d.swaps || {};
  // posición de cada jugador en el orden de bans / de picks (para mostrarlos en ese orden)
  const flat = { ban: [], pick: [] }; (d.seq || []).forEach(x => flat[x.t].push(...x.u));
  const ord = (t, u) => { const i = flat[t].indexOf(u); return i < 0 ? 99 : i; };
  const w = u => rkVoteWeight(rkPlayer(u).strikes);
  return { id: m.id, status: m.status, createdAt: m.createdAt, lobby: m.lobby, winner: m.winner, resolvedBy: m.resolvedBy,
    kickNeed: RK_KICK_NEED,
    teams: m.teams.map(t => ({ side: t.side, mine: t === my, avgRank: rkRank(t.players.reduce((s, p) => s + p.lp, 0) / 5),
      players: t.players.slice().sort((x, y) => ord('pick', x.uid) - ord('pick', y.uid)).map(p => ({ uid: p.uid, nick: p.nick, rid: p.rid, role: p.role, pref: p.pref, rank: rkRank(p.lp), me: p.uid === uid,
        champ: d.picks[p.uid] || null, auto: !!p.auto, banned: !!d.locked[p.uid],
        kick: ((m.kicks || {})[p.uid] || []).length, myKick: ((m.kicks || {})[p.uid] || []).includes(uid),
        canSwap: t === my && p.uid !== uid && rkSwapTypes(m, uid, p.uid).length > 0,
        hover: !d.picks[p.uid] && (t === my || (cur && cur.t === 'pick' && cur.u.includes(p.uid))) ? ((d.hover || {})[p.uid] || null) : null,
        canRole: m.status === 'draft' && d.phase === 'prep' && t === my && p.uid !== uid,
        canTrade: m.status === 'draft' && t === my && p.uid !== uid && !!d.picks[uid] && !!d.picks[p.uid] })),
      bans: t.players.slice().sort((x, y) => ord('ban', x.uid) - ord('ban', y.uid)).map(p => ({ uid: p.uid, nick: p.nick, champ: d.bans[p.uid] || null, done: !!d.locked[p.uid] })) })),
    draft: { phase: d.phase, deadline: d.deadline, step: d.step, turn: cur ? cur.u : [], order: d.seq || [],
      myBanLocked: !!d.locked[uid], myBan: d.bans[uid] || null, bansHidden: false, graceMs: RK_GRACE_MS, myHover: (d.hover || {})[uid] || null, myBanHover: (d.banHover || {})[uid] || null,
      roleOut: m.status === 'draft' && (d.roleSwaps || {})[uid] != null ? d.roleSwaps[uid] : null, roleIn: m.status === 'draft' ? Object.keys(d.roleSwaps || {}).map(Number).filter(a => d.roleSwaps[a] === uid) : [],
      myBanChanged: !!(d.banChanged || {})[uid], pickChgMs: RK_PICKCHG_MS,
      tradeOut: m.status === 'draft' && (d.trades || {})[uid] != null ? d.trades[uid] : null, tradeIn: m.status === 'draft' ? Object.keys(d.trades || {}).map(Number).filter(a => d.trades[a] === uid) : [],
      side: { votes: (d.sideVotes || []).length, need: RK_SIDE_NEED, mine: (d.sideVotes || []).includes(uid), swapped: !!d.sideSwapped,
        open: m.status === 'draft' && d.phase === 'prep' && !d.sideSwapped, canVote: m.status === 'draft' && d.phase === 'prep' && !d.sideSwapped && m.teams[1].players.some(p => p.uid === uid) },
      myPickAt: (d.pickAt || {})[uid] || null, myPickChanged: !!(d.pickChanged || {})[uid],
      pickReqs: m.status === 'draft' ? Object.entries(d.pickReq || {}).map(([a, to]) => { a = Number(a); const t = rkTeamOf(m, a);
        return { uid: a, nick: (rkSlot(m, a) || {}).nick, side: t.side, from: d.picks[a] || null, to, mine: a === uid, rival: !!my && t !== my }; }) : [],
      banReqs: m.status === 'draft' ? Object.entries(d.banReq || {}).map(([a, to]) => { a = Number(a); const t = rkTeamOf(m, a);
        return { uid: a, nick: (rkSlot(m, a) || {}).nick, side: t.side, from: d.bans[a] || null, to, mine: a === uid, rival: !!my && t !== my }; }) : [],
      swapOut: m.status === 'draft' && sw[uid] != null ? sw[uid] : null, swapIn: m.status === 'draft' ? Object.keys(sw).map(Number).filter(a => sw[a] === uid) : [] },
    votes: { blue: Object.values(m.votes).filter(v => v === 'blue').length, red: Object.values(m.votes).filter(v => v === 'red').length, mine: m.votes[uid] || null,
      weight: w(uid), need: rkUids(m).reduce((s, u) => s + w(u), 0) / 2 },
    remake: { votes: (m.remake || []).length, need: RK_REMAKE_NEED, mine: (m.remake || []).includes(uid) },
    lpChange: m.lpChanges[uid] || null };
}
app.get('/api/ranked/state', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store'); await rkTick();
  const real = await optionalUid(req); let uid = real, sup = false;
  if (real){ const ru = (await rkUsers()).get(real), as = Number(req.query.as); sup = !!ru && rkIsSuper(ru.rid); if (sup && RK_BOTS.includes(as)) uid = as; }
  const out = { now: Date.now(), size: RK_SIZE, queue: { count: RK.queue.size }, me: null, pending: null, match: null, last: null };
  if (uid){
    const users = await rkUsers(), u = users.get(uid) || { nick: '', rid: '', admin: false }, p = rkPlayer(uid);
    out.me = { uid, nick: u.nick, rid: u.rid, admin: u.admin, role1: p.role1, role2: p.role2, rank: rkRank(p.lp), wins: p.wins, losses: p.losses, strikes: p.strikes, voteWeight: rkVoteWeight(p.strikes), roles: rkFillStats(p), lastOff: !!p.lastOff };
    const e = RK.queue.get(uid); out.queue.inQueue = !!e; out.queue.since = e ? e.since : null;
    const pd = [...RK.pending.values()].find(x => x.players.includes(uid));
    if (pd) out.pending = { id: pd.id, deadline: pd.deadline, accepted: pd.accepted.size, total: RK_SIZE, iAccepted: pd.accepted.has(uid) };
    const mid = RK.byUser.get(uid), m = mid != null ? RK.matches.get(mid) : null;
    if (m) out.match = await rkMatchView(m, uid);
    out.last = RK.last.get(uid) || null;
    if (u.admin){ try { out.conflicts = (await q("SELECT id, data FROM ranked_matches WHERE status='done' AND data->'conflict' IS NOT NULL AND data->'conflict'->>'reviewed' IS NULL ORDER BY id DESC LIMIT 10"))
      .map(r => ({ id: r.id, winner: r.data.winner, reportedBy: r.data.game && r.data.game.reportedBy, by: r.data.conflict.by, claims: r.data.conflict.claims, endedAt: r.data.endedAt,
        blue: r.data.teams[0].players.map(p => p.nick), red: r.data.teams[1].players.map(p => p.nick) })); } catch { out.conflicts = []; } }
    if (sup) out.sim = { as: uid < 0 ? uid : null, bots: RK_BOTS.map(b => ({ uid: b, nick: rkBotUser(b).nick, inQueue: RK.queue.has(b), inMatch: RK.byUser.has(b) })) };
  }
  res.json(out);
}));
// Posiciones habituales por campeón (fuente abierta de Meraki Analytics; caché de 12 h). Si falla, queda solo lo de las partidas guardadas.
const RK_POS = { at: 0, map: null };
async function rkPositions(){
  if (RK_POS.map && Date.now() - RK_POS.at < 12 * 3600 * 1000) return RK_POS.map;
  try { const r = await fetch('https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json');
    if (r.ok){ const j = await r.json(), map = {};
      for (const k of Object.keys(j)) map[k.toLowerCase()] = (j[k].positions || []).map(x => x === 'SUPPORT' ? 'UTILITY' : x);
      if (Object.keys(map).length){ RK_POS.map = map; RK_POS.at = Date.now(); } } } catch {}
  return RK_POS.map || {};
}
// Campeones recomendados por línea (lista del admin).
const RK_ROLE_LIST = {
  TOP: 'Aatrox Akali Ambessa Camille Chogath Darius DrMundo Fiora Gangplank Garen Gnar Gragas Gwen Heimerdinger Illaoi Irelia Jax Jayce KSante Kayle Kennen Kled Malphite Mordekaiser Nasus Olaf Ornn Pantheon Renekton Riven Rumble Sett Shen Singed Sion TahmKench Teemo Trundle Tryndamere Urgot Vayne Volibear Yasuo Yone Yorick Zaahen',
  JUNGLE: 'Amumu Belveth Briar Diana Ekko Elise Evelynn Fiddlesticks Graves Hecarim Ivern JarvanIV Jax Karthus Kayn Khazix Kindred LeeSin Lillia Locke MasterYi Naafiri Nasus Nidalee Nocturne Nunu Pantheon Qiyana Quinn Rammus RekSai Rengar Sejuani Shaco Shyvana Skarner Sylas Talon Udyr Vi Viego Warwick MonkeyKing XinZhao Zac Zed',
  MIDDLE: 'Ahri Akali Akshan Anivia Annie AurelionSol Aurora Azir Cassiopeia Diana Ekko Fizz Galio Hwei Irelia Kassadin Katarina Leblanc Lissandra Locke Lux Malzahar Mel Naafiri Orianna Qiyana Ryze Sylas Syndra Taliyah Talon TwistedFate Veigar Vex Viktor Vladimir Xerath Yasuo Yone Zed Zoe',
  BOTTOM: 'Aphelios Ashe Caitlyn Corki Draven Ezreal Jhin Jinx Kaisa Kalista KogMaw Lucian Mel MissFortune Nilah Samira Senna Seraphine Sivir Smolder Syndra Tristana Twitch Varus Vayne Veigar Viktor Xayah Xerath Yasuo Yunara Zeri Ziggs',
  UTILITY: 'Alistar Bard Blitzcrank Brand Braum Camille Janna Karma Leona Lulu Lux Maokai Mel Milio Morgana Nami Nautilus Neeko Pantheon Poppy Pyke Rakan Rell Renata Senna Seraphine Sona Soraka Swain TahmKench Taric Thresh Velkoz Xerath Yuumi Zilean Zyra',
};
const RK_ROLE_SET = Object.fromEntries(Object.entries(RK_ROLE_LIST).map(([r, l]) => [r, new Set(l.split(' '))]));
async function rkChampRoles(){
  return (await rkChamps()).map(c => ({ ...c, roles: RK_ROLES.filter(r => RK_ROLE_SET[r].has(c.id)) }));
}
app.get('/api/ranked/champs', wrap(async (req, res) => { res.set('Cache-Control', 'public, max-age=600'); res.json(await rkChampRoles()); }));
app.post('/api/ranked/roles', auth, rkImp, wrap(async (req, res) => {
  await rkInit(); const ok = v => RK_ROLES.includes(v) || v === 'FILL', r1 = String((req.body && req.body.role1) || ''), r2 = String((req.body && req.body.role2) || '');
  if (!ok(r1) || !ok(r2)) return res.status(400).json({ error: 'Elige rol principal y secundario' });
  if (r1 === r2 && r1 !== 'FILL') return res.status(400).json({ error: 'El rol secundario debe ser distinto del principal' });
  if (RK.queue.has(req.user.id)) return res.status(400).json({ error: 'Sal de la cola para cambiar de rol' });
  const p = rkPlayer(req.user.id); p.role1 = r1; p.role2 = r2; await rkSavePlayer(p);
  res.json({ ok: true });
}));
app.post('/api/ranked/queue', auth, rkImp, wrap(async (req, res) => {
  await rkInit(); const p = rkPlayer(req.user.id);
  if (!req.user.riotid) return res.status(400).json({ error: 'Tu cuenta no tiene Riot ID' });
  if (!p.role1 || !p.role2) return res.status(400).json({ error: 'Elige primero tu rol principal y secundario' });
  if (RK.byUser.has(req.user.id)) return res.status(400).json({ error: 'Ya estás en una partida' });
  if (!RK.queue.has(req.user.id)) RK.queue.set(req.user.id, { uid: req.user.id, since: Date.now() });
  await rkTick(); res.json({ ok: true });
}));
app.post('/api/ranked/dequeue', auth, rkImp, wrap(async (req, res) => {
  await rkInit();
  const pd = [...RK.pending.values()].find(x => x.players.includes(req.user.id)); if (pd) pd.declined.add(req.user.id);
  RK.queue.delete(req.user.id); await rkTick(); res.json({ ok: true });
}));
app.post('/api/ranked/accept', auth, rkImp, wrap(async (req, res) => {
  await rkInit(); const pd = [...RK.pending.values()].find(x => x.players.includes(req.user.id));
  if (!pd) return res.status(400).json({ error: 'No hay partida por aceptar' });
  if (req.body && req.body.accept === false){ pd.declined.add(req.user.id); pd.accepted.delete(req.user.id); } else pd.accepted.add(req.user.id);
  await rkTick(); res.json({ ok: true });
}));
// Partida activa del usuario (o 400).
async function rkMine(req, res){
  await rkTick(); const mid = RK.byUser.get(req.user.id), m = mid != null ? RK.matches.get(mid) : null;
  if (!m){ res.status(400).json({ error: 'No estás en una partida' }); return null; } return m;
}
app.post('/api/ranked/ban', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return; const d = m.draft, uid = req.user.id;
  if (m.status !== 'draft' || d.phase !== 'ban') return res.status(400).json({ error: 'No es la fase de bans' });
  if (d.locked[uid]) return res.status(400).json({ error: 'Ya baneaste' });
  if (!d.seq[d.step].u.includes(uid)) return res.status(400).json({ error: 'No es tu turno de ban' });
  const champ = (req.body && req.body.champ) || null;
  if (champ && !(await rkChamps()).some(c => c.id === champ)) return res.status(400).json({ error: 'Campeón inválido' });
  if (champ && (Object.values(d.bans).includes(champ) || Object.values(d.picks).includes(champ))) return res.status(400).json({ error: 'Ese campeón ya fue baneado o elegido' });
  d.bans[uid] = champ; d.locked[uid] = true; rkPurgeHovers(d); await rkSaveMatch(m); await rkAdvance(m); res.json({ ok: true });
}));
app.post('/api/ranked/pick', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return; const d = m.draft, uid = req.user.id;
  if (m.status !== 'draft' || d.phase !== 'pick') return res.status(400).json({ error: 'No es la fase de picks' });
  if (!d.seq[d.step].u.includes(uid)) return res.status(400).json({ error: 'No es tu turno' });
  if (d.picks[uid]) return res.status(400).json({ error: 'Ya elegiste' });
  const champ = String((req.body && req.body.champ) || '');
  if (!(await rkChamps()).some(c => c.id === champ)) return res.status(400).json({ error: 'Campeón inválido' });
  if (Object.values(d.bans).includes(champ)) return res.status(400).json({ error: 'Ese campeón está baneado' });
  if (Object.values(d.picks).includes(champ)) return res.status(400).json({ error: 'Ese campeón ya fue elegido' });
  d.picks[uid] = champ; d.pickAt = d.pickAt || {}; d.pickAt[uid] = Date.now(); rkPurgeHovers(d); await rkSaveMatch(m); await rkAdvance(m); res.json({ ok: true });
}));
// Campeón seleccionado (sin fijar). Si se acaba el tiempo, se fija ese. En tu turno de ban es el ban; si no, tu pick
// (se puede dejar elegido antes de que llegue tu turno, como en el LoL). Solo lo ve tu equipo.
app.post('/api/ranked/hover', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return; const d = m.draft, uid = req.user.id;
  if (m.status !== 'draft') return res.status(400).json({ error: 'El draft ya terminó' });
  const champ = (req.body && req.body.champ) || null;
  if (champ && !(await rkChamps()).some(c => c.id === champ)) return res.status(400).json({ error: 'Campeón inválido' });
  if (champ && (Object.values(d.bans).includes(champ) || Object.values(d.picks).includes(champ))) return res.status(400).json({ error: 'Ese campeón ya fue baneado o elegido' });
  d.hover = d.hover || {}; d.banHover = d.banHover || {};
  const cur = d.seq[d.step];
  if (!cur) return res.json({ ok: true });
  if (d.phase !== 'prep' && cur.t === 'ban' && cur.u.includes(uid) && !d.locked[uid]) d.banHover[uid] = champ;
  else if (!d.picks[uid]) d.hover[uid] = champ;
  res.json({ ok: true });
}));
app.post('/api/ranked/side', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return; const d = m.draft, uid = req.user.id;
  if (m.status !== 'draft' || d.phase !== 'prep') return res.status(400).json({ error: 'El cambio de lado solo se vota en la preparación' });
  if (d.sideSwapped) return res.status(400).json({ error: 'Los equipos ya cambiaron de lado' });
  if (!m.teams[1].players.some(p => p.uid === uid)) return res.status(400).json({ error: 'Solo vota el equipo rojo (el de menos elo)' });
  const v = new Set(d.sideVotes || []); if (req.body && req.body.on === false) v.delete(uid); else v.add(uid); d.sideVotes = [...v];
  if (v.size >= RK_SIDE_NEED) rkSwapSides(m);
  await rkSaveMatch(m); res.json({ ok: true, swapped: !!d.sideSwapped });
}));
// Intercambio de CAMPEONES con un compañero (como en el LoL): cuando los dos ya eligieron, uno lo pide y el otro
// acepta. Se puede apenas ambos tienen campeón y durante la fase final de 30 s.
app.post('/api/ranked/trade', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return; const d = m.draft, uid = req.user.id, other = Number(req.body && req.body.with), act = req.body && req.body.action;
  if (m.status !== 'draft') return res.status(400).json({ error: 'El draft ya terminó' });
  d.trades = d.trades || {};
  if (act === 'cancel') delete d.trades[uid];
  else if (act === 'decline'){ if (d.trades[other] === uid) delete d.trades[other]; }
  else {
    const t = rkTeamOf(m, uid);
    if (other === uid || !t.players.some(p => p.uid === other)) return res.status(400).json({ error: 'Solo puedes cambiar campeón con alguien de tu equipo' });
    if (!d.picks[uid] || !d.picks[other]) return res.status(400).json({ error: 'Los dos tienen que haber elegido campeón' });
    if (act === 'accept'){
      if (d.trades[other] !== uid) return res.status(400).json({ error: 'Esa solicitud ya no existe' });
      [d.picks[uid], d.picks[other]] = [d.picks[other], d.picks[uid]];
      [uid, other].forEach(u => { const sl = rkSlot(m, u); if (sl) sl.auto = false; if (d.pickReq) delete d.pickReq[u]; });
      for (const k of Object.keys(d.trades)) if ([uid, other].includes(Number(k)) || [uid, other].includes(d.trades[k])) delete d.trades[k];
    } else d.trades[uid] = other;
  }
  await rkSaveMatch(m); res.json({ ok: true });
}));
// Cambio de ROL con un compañero (se pide y el otro tiene que aceptar).
app.post('/api/ranked/roleswap', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return; const d = m.draft, uid = req.user.id, other = Number(req.body && req.body.with), act = req.body && req.body.action;
  if (m.status !== 'draft') return res.status(400).json({ error: 'El draft ya terminó' });
  d.roleSwaps = d.roleSwaps || {};
  if (act === 'cancel') delete d.roleSwaps[uid];
  else if (act === 'decline'){ if (d.roleSwaps[other] === uid) delete d.roleSwaps[other]; }
  else {
    const t = rkTeamOf(m, uid);
    if (other === uid || !t.players.some(p => p.uid === other)) return res.status(400).json({ error: 'Solo puedes cambiar de rol con alguien de tu equipo' });
    if (d.phase !== 'prep') return res.status(400).json({ error: 'Los roles solo se pueden cambiar en la fase de preparación' });
    if (act === 'accept'){
      if (d.roleSwaps[other] !== uid) return res.status(400).json({ error: 'Esa solicitud ya no existe' });
      const a = rkSlot(m, uid), b = rkSlot(m, other); [a.role, b.role] = [b.role, a.role];
      a.pref = rkPrefName(rkPref(rkPlayer(a.uid), a.role)); b.pref = rkPrefName(rkPref(rkPlayer(b.uid), b.role));
      for (const k of Object.keys(d.roleSwaps)) if ([uid, other].includes(Number(k)) || [uid, other].includes(d.roleSwaps[k])) delete d.roleSwaps[k];
    } else d.roleSwaps[uid] = other;
  }
  await rkSaveMatch(m); res.json({ ok: true });
}));
// Cambio de BAN: quien ya baneó (o se quedó sin ban) pide cambiarlo durante el turno del otro equipo; se aplica
// solo si alguien del equipo rival acepta. Una vez por jugador.
app.post('/api/ranked/banchange', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return; const d = m.draft, uid = req.user.id, act = req.body && req.body.action;
  if (m.status !== 'draft') return res.status(400).json({ error: 'El draft ya terminó' });
  d.banReq = d.banReq || {}; d.banChanged = d.banChanged || {};
  const my = rkTeamOf(m, uid);
  if (act === 'cancel'){ delete d.banReq[uid]; }
  else if (act === 'accept' || act === 'decline'){
    const who = Number(req.body && req.body.who), wt = rkTeamOf(m, who);
    if (!(who in d.banReq) || !wt || wt === my) return res.status(400).json({ error: 'Esa solicitud ya no existe' });
    if (act === 'accept'){
      const to = d.banReq[who];
      if (to && (Object.values(d.bans).includes(to) || Object.values(d.picks).includes(to))){ delete d.banReq[who]; await rkSaveMatch(m); return res.status(400).json({ error: 'Ese campeón ya fue baneado o elegido: la solicitud se anuló' }); }
      d.bans[who] = to; d.locked[who] = true; d.banChanged[who] = true; rkPurgeHovers(d);
    }
    delete d.banReq[who];
  } else {
    const champ = (req.body && req.body.champ) || null;
    if (!d.locked[uid]) return res.status(400).json({ error: 'Todavía no has baneado' });
    if (d.banChanged[uid]) return res.status(400).json({ error: 'Ya cambiaste tu ban una vez' });
    const cur = d.seq[d.step];
    if (cur && rkTeamOf(m, cur.u[0]) === my) return res.status(400).json({ error: 'El cambio de ban se pide durante el turno del otro equipo' });
    if (!champ || !(await rkChamps()).some(c => c.id === champ)) return res.status(400).json({ error: 'Elige el campeón nuevo' });
    if (champ === d.bans[uid]) return res.status(400).json({ error: 'Ese ya es tu ban' });
    if (Object.values(d.bans).includes(champ) || Object.values(d.picks).includes(champ)) return res.status(400).json({ error: 'Ese campeón ya fue baneado o elegido' });
    d.banReq[uid] = champ;
  }
  await rkSaveMatch(m); res.json({ ok: true });
}));
// Cambio de CAMPEÓN: hasta 30 s después de fijarlo se puede pedir otro; se aplica solo si alguien del equipo rival
// acepta. Una vez por jugador.
app.post('/api/ranked/pickchange', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return; const d = m.draft, uid = req.user.id, act = req.body && req.body.action;
  if (m.status !== 'draft') return res.status(400).json({ error: 'El draft ya terminó' });
  d.pickReq = d.pickReq || {}; d.pickChanged = d.pickChanged || {}; d.pickAt = d.pickAt || {};
  const my = rkTeamOf(m, uid);
  if (act === 'cancel'){ delete d.pickReq[uid]; }
  else if (act === 'accept' || act === 'decline'){
    const who = Number(req.body && req.body.who), wt = rkTeamOf(m, who);
    if (!(who in d.pickReq) || !wt || wt === my) return res.status(400).json({ error: 'Esa solicitud ya no existe' });
    if (act === 'accept'){
      const to = d.pickReq[who];
      if (Object.values(d.bans).includes(to) || Object.values(d.picks).includes(to)){ delete d.pickReq[who]; await rkSaveMatch(m); return res.status(400).json({ error: 'Ese campeón ya fue baneado o elegido: la solicitud se anuló' }); }
      d.picks[who] = to; d.pickChanged[who] = true; const sl = rkSlot(m, who); if (sl) sl.auto = false; rkPurgeHovers(d);
    }
    delete d.pickReq[who];
  } else {
    const champ = String((req.body && req.body.champ) || '');
    if (!d.picks[uid]) return res.status(400).json({ error: 'Todavía no eliges campeón' });
    if (d.pickChanged[uid]) return res.status(400).json({ error: 'Ya cambiaste tu campeón una vez' });
    if (!d.pickAt[uid] || Date.now() - d.pickAt[uid] > RK_PICKCHG_MS) return res.status(400).json({ error: 'Pasaron más de 30 s desde que fijaste tu campeón' });
    if (!(await rkChamps()).some(c => c.id === champ)) return res.status(400).json({ error: 'Elige el campeón nuevo' });
    if (Object.values(d.bans).includes(champ) || Object.values(d.picks).includes(champ)) return res.status(400).json({ error: 'Ese campeón ya fue baneado o elegido' });
    d.pickReq[uid] = champ;
  }
  await rkSaveMatch(m); res.json({ ok: true });
}));
// Pedir / aceptar / rechazar / cancelar un cambio de turno con un compañero de equipo.
app.post('/api/ranked/swap', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return; const d = m.draft, uid = req.user.id, other = Number(req.body && req.body.with), act = req.body && req.body.action;
  if (m.status !== 'draft') return res.status(400).json({ error: 'El draft ya terminó' });
  d.swaps = d.swaps || {};
  if (act === 'cancel') delete d.swaps[uid];
  else if (act === 'decline'){ if (d.swaps[other] === uid) delete d.swaps[other]; }
  else {
    const t = rkTeamOf(m, uid);
    if (other === uid || !t.players.some(p => p.uid === other)) return res.status(400).json({ error: 'Solo puedes cambiar de turno con alguien de tu equipo' });
    if (!rkSwapTypes(m, uid, other).length) return res.status(400).json({ error: 'Ya no se puede cambiar: esos turnos ya pasaron o están en curso' });
    if (act === 'accept'){
      if (d.swaps[other] !== uid) return res.status(400).json({ error: 'Esa solicitud ya no existe' });
      rkDoSwap(m, uid, other);
      for (const k of Object.keys(d.swaps)) if ([uid, other].includes(Number(k)) || [uid, other].includes(d.swaps[k])) delete d.swaps[k];
    } else d.swaps[uid] = other;
  }
  await rkSaveMatch(m); res.json({ ok: true });
}));
app.post('/api/ranked/kick', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return; const uid = req.user.id, target = Number(req.body && req.body.target);
  if (target === uid || !rkUids(m).includes(target)) return res.status(400).json({ error: 'Jugador inválido' });
  res.json({ ok: true, cancelled: await rkKickVote(m, uid, target, req.body.on) });
}));
// Remake: si la partida no se va a jugar, con 9 de 10 votos se anula (nadie gana ni pierde PL).
const RK_REMAKE_NEED = 9;
async function rkRemakeVote(m, uid, on){
  const v = new Set(m.remake || []); if (on === false) v.delete(uid); else v.add(uid); m.remake = [...v];
  if (v.size >= RK_REMAKE_NEED){ await rkCancel(m, 'remake'); return true; }
  await rkSaveMatch(m); return false;
}
app.post('/api/ranked/remake', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return;
  if (m.status !== 'playing' && m.status !== 'dispute') return res.status(400).json({ error: 'El remake se vota cuando la partida ya está armada' });
  res.json({ ok: true, cancelled: await rkRemakeVote(m, req.user.id, req.body && req.body.on) });
}));
app.post('/api/ranked/vote', auth, rkImp, wrap(async (req, res) => {
  const m = await rkMine(req, res); if (!m) return; const side = req.body && req.body.team;
  if (m.status !== 'playing') return res.status(400).json({ error: m.status === 'dispute' ? 'La votación quedó empatada: decide un admin' : 'Aún no se puede votar' });
  if (side !== 'blue' && side !== 'red') return res.status(400).json({ error: 'Voto inválido' });
  if (rkVoteWeight(rkPlayer(req.user.id).strikes) <= 0) return res.status(403).json({ error: 'Perdiste el derecho a voto por votar mal repetidas veces' });
  m.votes[req.user.id] = side; await rkCheckVotes(m); res.json({ ok: true });
}));
// Admin: conflicto entre dos overlays. "keep" mantiene el resultado; "flip" deshace PL/MMR/V-D/faltas/roles y lo
// vuelve a calcular con el otro ganador; "void" lo deshace y anula la partida.
app.post('/api/ranked/admin/conflict', auth, requireAdmin, wrap(async (req, res) => {
  await rkInit(); const id = Number(req.body && req.body.matchId), act = req.body && req.body.action;
  const row = await q1('SELECT id, data FROM ranked_matches WHERE id=$1', [id]);
  if (!row || row.data.status !== 'done' || !row.data.conflict) return res.status(400).json({ error: 'Partida no encontrada o sin conflicto' });
  const m = row.data; m.id = row.id;
  RK_HIST.at = 0;
  if (act === 'keep'){ m.conflict.reviewed = 'keep'; await rkSaveMatch(m); return res.json({ ok: true }); }
  if (act !== 'flip' && act !== 'void') return res.status(400).json({ error: 'Acción inválida' });
  for (const [uid, c] of Object.entries(m.lpChanges || {})){ const p = rkPlayer(Number(uid)); if (!c || c.won == null) continue;
    p.lp = Math.max(0, p.lp - c.delta); p.mmr -= (c.mmr || 0); if (c.won) p.wins = Math.max(0, p.wins - 1); else p.losses = Math.max(0, p.losses - 1);
    if (c.strikes != null) p.strikes = c.strikes;
    if (c.pf){ const k = c.pf === 'main' ? 'gMain' : c.pf === 'sec' ? 'gSec' : c.pf === 'fill' ? 'gFill' : 'gOff'; p[k] = Math.max(0, (p[k] | 0) - 1); p.lastOff = !!c.lastOff; }
    await rkSavePlayer(p); }
  m.lpChanges = {}; m.conflict.reviewed = act;
  if (act === 'void'){ m.status = 'cancelled'; m.resolvedBy = 'admin'; await rkSaveMatch(m); return res.json({ ok: true }); }
  await rkResolve(m, m.winner === 'blue' ? 'red' : 'blue', 'admin'); res.json({ ok: true });
}));
// Admin: resolver una partida abierta o en disputa, o anularla (sin cambios de PL).
app.post('/api/ranked/admin/resolve', auth, requireAdmin, wrap(async (req, res) => {
  await rkInit(); const m = RK.matches.get(Number(req.body && req.body.matchId)), w = req.body && req.body.winner;
  if (!m) return res.status(400).json({ error: 'Partida no encontrada o ya cerrada' });
  if (w === 'cancel'){ await rkCancel(m, 'admin'); return res.json({ ok: true, cancelled: true }); }
  if (w !== 'blue' && w !== 'red') return res.status(400).json({ error: 'Ganador inválido' });
  if (m.status === 'draft') return res.status(400).json({ error: 'La partida aún está en el draft' });
  await rkResolve(m, w, 'admin'); res.json({ ok: true });
}));
function rkRecentP(d, p){
  const st = d.game && (d.game.players || []).find(x => x.uid === p.uid);
  return { nick: p.nick, champ: (st && st.champ) || (d.draft.picks || {})[p.uid] || null, ...(st ? { k: st.k, d: st.d, a: st.a, cs: st.cs, gold: st.gold, dmg: st.dmg, vision: st.vision } : {}) };
}
// Tabla de posiciones + salas abiertas (para admins) + últimas partidas.
// ---- Historial de partidas (cache 20 s; se invalida al cerrar una) ----
const RK_HIST = { at: 0, rows: [] };
async function rkHistRows(){
  if (Date.now() - RK_HIST.at < 20000) return RK_HIST.rows;
  try { RK_HIST.rows = (await q("SELECT id, data FROM ranked_matches WHERE status='done' ORDER BY id DESC LIMIT 500")).map(r => { r.data.id = r.id; return r.data; }); RK_HIST.at = Date.now(); } catch {}
  return RK_HIST.rows;
}
const rkGameP = (d, uid) => d.game && (d.game.players || []).find(x => x.uid === uid);
const rkSideOf = (d, uid) => { const t = d.teams.find(t => t.players.some(p => p.uid === uid)); return t ? t.side : null; };
function rkSummary(d, uid){
  const pl = p => { const st = rkGameP(d, p.uid); return { uid: p.uid, nick: p.nick, role: p.role, champ: (st && st.champ) || (d.draft.picks || {})[p.uid] || null, ...(st ? { k: st.k, d: st.d, a: st.a } : {}) }; };
  const side = uid ? rkSideOf(d, uid) : null, c = side ? (d.lpChanges || {})[uid] || {} : null, mine = side ? pl(d.teams.find(t => t.side === side).players.find(p => p.uid === uid)) : null;
  return { id: d.id, endedAt: d.endedAt, duration: d.game ? d.game.duration : null, winner: d.winner, by: d.resolvedBy, reportedBy: d.game ? d.game.reportedBy : null, stats: !!d.game,
    conflict: !!(d.conflict && !d.conflict.reviewed), blue: d.teams[0].players.map(pl), red: d.teams[1].players.map(pl),
    me: side ? { side, won: side === d.winner, delta: c.delta != null ? c.delta : null, lp: c.lp != null ? c.lp : null, ...mine } : null };
}
app.get('/api/ranked/history', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store'); await rkInit();
  const page = Math.max(0, Number(req.query.page) || 0), size = 15, mine = req.query.mine === '1';
  let uid = null; if (mine){ uid = await optionalUid(req); if (!uid) return res.status(401).json({ error: 'Inicia sesión para ver tus partidas' }); }
  let rows = await rkHistRows(); if (mine) rows = rows.filter(d => rkSideOf(d, uid));
  const viewer = mine ? uid : await optionalUid(req);
  res.json({ items: rows.slice(page * size, page * size + size).map(d => rkSummary(d, viewer)), more: rows.length > (page + 1) * size, total: rows.length });
}));
app.get('/api/ranked/match/:id', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store'); await rkInit();
  const r = await q1("SELECT id, data FROM ranked_matches WHERE id=$1 AND status='done'", [Number(req.params.id)]);
  if (!r) return res.status(404).json({ error: 'Partida no encontrada' });
  const d = r.data, picks = d.draft.picks || {}, bans = d.draft.bans || {};
  const votes = Object.values(d.votes || {});
  res.json({ id: r.id, createdAt: d.createdAt, endedAt: d.endedAt, duration: d.game ? d.game.duration : null, winner: d.winner, by: d.resolvedBy,
    reportedBy: d.game ? d.game.reportedBy : null, stats: !!d.game, conflict: d.conflict || null, offPick: d.game ? d.game.offPick || [] : [],
    votes: { blue: votes.filter(v => v === 'blue').length, red: votes.filter(v => v === 'red').length },
    teams: d.teams.map(t => ({ side: t.side, won: t.side === d.winner,
      bans: t.players.map(p => ({ nick: p.nick, champ: bans[p.uid] || null })),
      players: t.players.map(p => { const st = rkGameP(d, p.uid) || {}, c = (d.lpChanges || {})[p.uid] || {};
        return { uid: p.uid, nick: p.nick, rid: p.rid, role: p.role, pref: p.pref, champ: st.champ || picks[p.uid] || null, picked: picks[p.uid] || null,
          k: st.k, d: st.d, a: st.a, cs: st.cs, gold: st.gold, dmg: st.dmg, vision: st.vision, level: st.level, items: st.items || [],
          delta: c.delta != null ? c.delta : null, rank: c.lp != null ? rkRank(c.lp) : null, voted: c.voted || null }; }) })) });
}));
app.get('/api/ranked/leaderboard', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store'); await rkInit(); const users = await rkUsers();
  // racha (últimas 10) y campeones más jugados de cada uno, desde el historial
  const form = {}, champs = {};
  for (const d of await rkHistRows()) for (const t of d.teams) for (const p of t.players){
    (form[p.uid] = form[p.uid] || []); if (form[p.uid].length < 10) form[p.uid].push(t.side === d.winner ? 1 : 0);
    const st = rkGameP(d, p.uid), c = (st && st.champ) || (d.draft.picks || {})[p.uid]; if (c){ const m = champs[p.uid] = champs[p.uid] || {}; m[c] = (m[c] || 0) + 1; } }
  const board = [...RK.players.values()].filter(p => p.uid > 0 && p.wins + p.losses > 0).sort((a, b) => b.lp - a.lp || b.wins - a.wins)
    .map((p, i) => { const u = users.get(p.uid) || { nick: '?', rid: '' }; const f = rkFillStats(p);
      return { pos: i + 1, uid: p.uid, nick: u.nick, rid: u.rid, rank: rkRank(p.lp), wins: p.wins, losses: p.losses, role1: p.role1, role2: p.role2, roles: { n: f.n, main: f.main, sec: f.sec, off: f.off, fill: f.fill },
        form: form[p.uid] || [], champs: Object.entries(champs[p.uid] || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => ({ c, n })) }; });
  const open = [...RK.matches.values()].map(m => ({ id: m.id, sim: !!m.sim, status: m.status, createdAt: m.createdAt, blue: m.teams[0].players.map(p => p.nick), red: m.teams[1].players.map(p => p.nick),
    votes: { blue: Object.values(m.votes).filter(v => v === 'blue').length, red: Object.values(m.votes).filter(v => v === 'red').length } }));
  let recent = [];
  try { recent = (await q("SELECT id, data FROM ranked_matches WHERE status='done' ORDER BY ended_at DESC NULLS LAST LIMIT 10")).map(r => ({ id: r.id, winner: r.data.winner, endedAt: r.data.endedAt, by: r.data.resolvedBy,
    reportedBy: r.data.game ? r.data.game.reportedBy : null, duration: r.data.game ? r.data.game.duration : null, conflict: !!r.data.conflict,
    blue: r.data.teams[0].players.map(p => rkRecentP(r.data, p)), red: r.data.teams[1].players.map(p => rkRecentP(r.data, p)) })); } catch {}
  res.json({ board, open, recent, queue: RK.queue.size });
}));

// ================= HERRAMIENTAS · SUBASTA (capitanes arman su equipo pujando) =================
// Abierta a cualquier usuario con sesión. Quien crea la sala es el anfitrión y DIRIGE la subasta (empieza,
// saca cada jugador y puede adjudicarlo antes de que corra el tiempo); se unen hasta 5 capitanes en total
// (6 si los capitanes también salen a subasta; el anfitrión incluido) con 1.000 dólares cada uno, y cada uno compra 6 jugadores: 5 titulares + 1
// suplente comodín (menos si no alcanzan los jugadores para tantos capitanes).
// Salen jugadores AL AZAR, sin importar su rol (se muestra su rol de torneo, o el de SoloQ si no juega
// torneo), y cada uno se descubre recién cuando sale. La puja es abierta: cualquier capitán al que le falten
// jugadores puede subir en cualquier momento; cada puja reinicia una cuenta regresiva corta y, cuando
// termina sin nuevas pujas, se lo lleva el mejor postor. Si nadie puja, se recicla: vuelve a salir al final de
// la fila (si da una vuelta completa sin que se venda nadie, los que siguen sin pujas van gratis al que más
// jugadores necesita, para que la subasta no se trabe). Al terminar, cada capitán reparte a los suyos en
// top/jungla/mid/ADC/support + suplente y confirma; después cada uno ordena a los OTROS equipos de mejor a
// peor y la tabla final sale de esas votaciones (Borda: en una votación de n equipos, el 1º suma n-1 puntos).
// Salen todos los jugadores (coaches incluidos). Por defecto los capitanes no salen; el anfitrión puede activar
// que también salgan (así un capitán puede terminar jugando en el equipo de otro, o comprarse a sí mismo). Salas con enlace:
// viven 3 h sin actividad (memoria + tool_state).
const SB_ROLES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'], SB_SLOTS = [...SB_ROLES, 'SUB'];
const SB_BUDGET = 1000, SB_STEP = 10, SB_MAX_CAPS = 5, SB_MAX_CAPS_IN = 6, SB_TEAM = 6;   // hasta 6 capitanes si ellos también salen a subasta
const sbMaxCaps = st => st.settings && st.settings.capsInPool ? SB_MAX_CAPS_IN : SB_MAX_CAPS;
// SB_BID_MS: una puja no alarga el tiempo, salvo que queden menos de 5 s (ahí vuelve a 5). SB_FINAL_MS: inicio de la puja final.
const SB_OPEN_MS = 20000, SB_BID_MS = 5000, SB_FINAL_MS = 10000, SB_TTL = 3 * 3600 * 1000;
// Margen tras la cuenta regresiva: una puja enviada justo al final que llega tarde por la conexión igual vale.
const SB_GRACE_MS = 1500;
// Modo pistas: cuánto dura cada pista por defecto (el anfitrión lo ajusta y puede adelantarla) y recargo (%) por defecto
// para la 1ª puja de cada fase.
const SB_CLUE_MS = 15000, SB_CLUE_PCT = 25, SB_REVEAL_MS = 3000, SB_CLUE_MIN_MS = 5000;   // modo pistas: el nombre se muestra 3 s al cerrar y sigue solo
const sbClueMs = st => (st.settings && st.settings.clueSecs ? st.settings.clueSecs * 1000 : SB_CLUE_MS);
let SB_ROOMS = null;
async function sbRooms(){
  if (!SB_ROOMS){ SB_ROOMS = {};
    try { for (const r of await q("SELECT data FROM tool_state WHERE id LIKE 'sub:%'")) if (r.data && r.data.code) { r.data.caps = (r.data.caps || []).filter(Boolean); r.data.starting = false; SB_ROOMS[r.data.code] = r.data; } } catch {}
    // salas que venían de antes del historial: se importan sus ventas (no duplica gracias al UNIQUE)
    const imp = []; for (const st of Object.values(SB_ROOMS)) for (const i of Object.keys(st.sold || {})) imp.push(sbRecord(st, Number(i)));
    await Promise.all(imp); }
  const now = Date.now();
  for (const c of Object.keys(SB_ROOMS)) if ((SB_ROOMS[c].expiresAt || 0) <= now){ delete SB_ROOMS[c]; q('DELETE FROM tool_state WHERE id=$1', ['sub:' + c]).catch(() => {}); }
  return SB_ROOMS;
}
async function sbSave(st){
  st.v = (st.v || 0) + 1; st.expiresAt = Date.now() + SB_TTL;
  try { await q("INSERT INTO tool_state (id, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data=$2::jsonb, updated_at=now()", ['sub:' + st.code, JSON.stringify(st)]); } catch {}
}
async function sbRoom(req, res){
  const code = String((req.query && req.query.room) || (req.body && req.body.room) || '').trim().toUpperCase();
  const st = code ? (await sbRooms())[code] : null;
  if (!st){ res.status(404).json({ error: 'La subasta no existe o ya expiró' }); return null; }
  return st;
}
// Candidatos: los jugadores de los rosters (con su rol de torneo) + las cuentas principales del ranking
// (con su rol de SoloQ). Sin smurfs y sin los capitanes de esta subasta. Uno por jugador.
const nrSb = r => String(r || '').toLowerCase().replace(/\s+/g, '');   // Riot no distingue espacios ni mayúsculas
const SB_SOLO_ROLE = { Top: 'TOP', Jungla: 'JUNGLE', Medio: 'MID', ADC: 'ADC', Support: 'SUPPORT' };
async function sbCandidates(exclude){
  const seen = new Set(), out = [];
  const smurf = new Set();
  try { for (const r of await q('SELECT riotid r FROM smurfs')) smurf.add(nrSb(r.r)); } catch {}
  try { for (const r of await q('SELECT smurf_riotid r FROM smurf_links')) smurf.add(nrSb(r.r)); } catch {}
  const skip = k => !k || seen.has(k) || exclude.has(k) || smurf.has(k);
  const R = await buildRosters();
  for (const [team, list] of Object.entries(R)) for (const p of list){
    const k = nrSb(p.riotid), b = nrSb(p.bestRiotid);
    if (!p.role || skip(k) || exclude.has(b)) continue; seen.add(k); if (b) seen.add(b);
    out.push({ rid: p.riotid, nick: p.nickname || p.riotid.split('#')[0], role: p.role, roleSrc: 'torneo', team, tier: p.tier, div: p.div, lp: p.lp, opgg: p.bestRiotid || p.riotid });
  }
  // jugadores del ranking que no juegan torneo: su cuenta más alta entre la principal y sus smurfs
  const snap = liveSnapshot().players || [], byRid = {}; snap.forEach(p => { byRid[(p.rid || '').toLowerCase()] = p; });
  const smurfsOf = {};
  try { for (const r of await q('SELECT lower(u.riotid) main, s.riotid smurf FROM smurfs s JOIN users u ON u.id = s.user_id')) (smurfsOf[r.main] = smurfsOf[r.main] || []).push(r.smurf); } catch {}
  try { for (const r of await q('SELECT lower(main_riotid) main, smurf_riotid smurf FROM smurf_links')) (smurfsOf[r.main] = smurfsOf[r.main] || []).push(r.smurf); } catch {}
  for (const p of snap){
    const k = nrSb(p.rid), role = SB_SOLO_ROLE[p.role];
    if (!role || skip(k)) continue; seen.add(k);
    let best = p; for (const r of (smurfsOf[k] || [])){ const x = byRid[r.toLowerCase()]; if (x && (absLPof(x.tier, x.div, x.lp) || -1) > (absLPof(best.tier, best.div, best.lp) || -1)) best = x; }
    out.push({ rid: p.rid, nick: p.nm || p.rid.split('#')[0], role, roleSrc: 'soloq', team: '', tier: best.tier, div: best.div, lp: best.lp, opgg: best.rid });
  }
  return out;
}
const sbCapsIdx = st => st.caps.map((_, k) => k);
const sbBought = (st, c) => st.pool.map((_, i) => i).filter(i => st.sold[i] && st.sold[i].cap === c);
const sbNeed = (st, c) => st.teamSize - sbBought(st, c).length;
const sbNeeders = st => sbCapsIdx(st).filter(c => sbNeed(st, c) > 0);
// Reparto inicial sugerido: cada uno a su rol si está libre; el resto a los huecos; el que sobra → suplente.
function sbAutoAssign(st, c){
  const mine = sbBought(st, c).slice(), a = {};
  for (const r of SB_ROLES){ const k = mine.findIndex(i => st.pool[i].role === r); if (k >= 0) a[r] = mine.splice(k, 1)[0]; }
  for (const s of SB_SLOTS) if (a[s] == null && mine.length) a[s] = mine.shift();
  return a;
}
function sbToAssign(st){ st.lot = null; st.status = 'assign'; st.assign = sbCapsIdx(st).map(c => sbAutoAssign(st, c)); st.confirmed = st.caps.map(() => false); }
// Historial de ventas pagadas (para el ranking de los más caros). No frena la subasta si falla.
function sbRecord(st, i){
  const s = st.sold && st.sold[i], p = st.pool && st.pool[i]; if (!s || !p || !(s.price > 0)) return Promise.resolve();
  const buyer = st.caps[s.cap] ? st.caps[s.cap].nick : null;
  return q(`INSERT INTO auction_sales (room, started_at, riotid, nick, price, buyer) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (room, started_at, riotid) DO UPDATE SET price=EXCLUDED.price, buyer=EXCLUDED.buyer`,
    [st.code, st.startedAt || st.createdAt || 0, p.rid, p.nick, s.price, buyer]).catch(() => {});
}
// Ranking histórico: el precio más alto que se pagó por cada jugador, cuántas veces lo compraron y el promedio.
app.get('/api/subasta/ranking', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  await sbRooms();   // la primera vez importa al historial las ventas de las salas guardadas
  let rows = [];
  try { rows = await q(`SELECT lower(riotid) k, (array_agg(riotid ORDER BY sold_at DESC))[1] rid, (array_agg(nick ORDER BY sold_at DESC))[1] nick,
      max(price)::int top, round(avg(price))::int avg, count(*)::int n, (array_agg(buyer ORDER BY price DESC, sold_at DESC))[1] buyer
    FROM auction_sales GROUP BY 1 ORDER BY top DESC, avg DESC LIMIT 1000`); } catch {}   // todos los jugadores que se han vendido
  res.json(rows.map(({ k, ...r }) => r));
}));
// Saca el siguiente jugador de la fila (lo decide el anfitrión).
function sbNext(st){
  if (!sbNeeders(st).length || !st.queue.length) return sbToAssign(st);
  const i = st.queue.shift(); st.seen[i] = true;
  // vuelta completa sin ventas → los que nadie quiere van gratis (si no, la subasta no terminaría nunca)
  const free = (st.noSale || 0) > st.queue.length;
  const clues = !!(st.settings && st.settings.clues) && !st.recycled[i];   // un reciclado ya se conoce: sale con nombre
  st.lot = { i, price: 0, leader: null, bids: [], deadline: clues ? null : Date.now() + SB_OPEN_MS, free, again: !!st.recycled[i],
    stage: clues ? 1 : null, stageEnd: clues ? Date.now() + sbClueMs(st) : null };
  st.last = null; st.reveal = null; st.autoNextAt = null;
}
// Cierra el jugador en juego: al mejor postor; sin pujas, se recicla al final de la fila (o va gratis al que más necesita).
function sbClose(st, how){
  const L = st.lot; if (!L) return;
  let winner = L.leader, price = L.price;
  if (winner == null && L.free){
    const need = sbNeeders(st).sort((a, b) => sbNeed(st, b) - sbNeed(st, a) || st.caps[a].spent - st.caps[b].spent);
    if (need.length){ winner = need[0]; price = 0; how = 'asignado gratis'; }
  }
  if (winner == null){ st.queue.push(L.i); st.recycled[L.i] = (st.recycled[L.i] || 0) + 1; st.noSale = (st.noSale || 0) + 1; how = 'sin pujas · vuelve al final'; }
  else { st.sold[L.i] = { cap: winner, price, how }; st.caps[winner].spent += price; delete st.recycled[L.i]; if (L.leader != null) st.noSale = 0; sbRecord(st, L.i); }
  st.log.unshift({ i: L.i, cap: winner, price: winner == null ? null : price, how, at: Date.now() }); st.log = st.log.slice(0, 40);
  st.last = st.log[0]; st.lot = null;
  if (L.stage){ st.reveal = { i: L.i, until: Date.now() + SB_REVEAL_MS }; st.autoNextAt = Date.now() + SB_REVEAL_MS; }
  if (!sbNeeders(st).length) sbToAssign(st);
}
// Puja mínima. Modo pistas: la puja que quedó ganando al cerrar una fase "se arrastra" a la siguiente, y la
// PRIMERA puja de la nueva fase (pista 2, pista 3 o ya revelado) debe superarla en un % (premia al que se la
// jugó con menos información). Las siguientes de esa misma fase suben de a $10 como siempre.
function sbMinBid(st){
  const L = st.lot; if (!L) return null;
  if (L.leader == null) return SB_STEP;
  if (L.carry != null && L.firstOfStage){ const pct = (st.settings && st.settings.cluePct) || SB_CLUE_PCT;
    return Math.max(L.price + SB_STEP, Math.ceil(L.carry * (1 + pct / 100) / SB_STEP) * SB_STEP); }
  return L.price + SB_STEP;
}
function sbBid(st, c, amount){
  const L = st.lot; if (st.status !== 'auction' || !L) return 'No hay ningún jugador en subasta';
  if (sbNeed(st, c) <= 0) return 'Ya completaste tu equipo';
  if (L.leader === c) return 'Ya vas ganando esta puja';
  if ((L.out || []).includes(c)) return 'Te retiraste de este jugador';
  const left = SB_BUDGET - st.caps[c].spent, amt = Math.floor(Number(amount));
  const min = sbMinBid(st);
  if (!Number.isFinite(amt) || amt < min) return `La puja mínima es $${min}`;
  if (amt > left) return `Solo te quedan $${left}`;
  L.price = amt; L.leader = c; L.bids.unshift({ c, amt, stage: L.stage || null }); L.bids = L.bids.slice(0, 12); L.firstOfStage = false;
  if (!L.stage || L.stage >= 4) L.deadline = Math.max(L.deadline, Date.now() + SB_BID_MS);
  else if (L.stageEnd - Date.now() < SB_CLUE_MIN_MS) L.stageEnd = Date.now() + SB_CLUE_MIN_MS;   // puja en los últimos segundos de una pista: la pista vuelve a 5 s
  return null;
}
// Se acabó la cuenta regresiva del jugador en juego → se cierra solo.
// Modo pistas: pasa a la siguiente pista; tras la 3ª se revela el nombre y empieza la cuenta regresiva normal.
function sbClueNext(st){
  const L = st.lot; if (!L || !L.stage || L.stage >= 4) return false;
  L.stage++; const now = Date.now();
  L.carry = L.leader != null ? L.price : null; L.firstOfStage = L.carry != null;
  // puja final (modo pistas): parte con 10 s; si no, la siguiente pista dura lo configurado
  if (L.stage >= 4){ L.stageEnd = null; L.deadline = now + SB_FINAL_MS; } else L.stageEnd = now + sbClueMs(st);
  return true;
}
function sbTick(st){
  if (st.status === 'auction' && !st.lot && st.autoNextAt && Date.now() >= st.autoNextAt){ st.autoNextAt = null; sbNext(st); return true; }
  if (st.status !== 'auction' || !st.lot) return false;
  if (st.lot.stage && st.lot.stage < 4){ if (Date.now() >= st.lot.stageEnd){ sbClueNext(st); return true; } return false; }
  if (Date.now() < st.lot.deadline + SB_GRACE_MS) return false;
  sbClose(st, 'puja'); return true;
}
function sbView(st, uid){
  const me = st.caps.findIndex(c => c && c.uid === uid);
  const L = st.lot, now = Date.now(), mystery = !!(L && L.stage), cluing = !!(L && L.stage && L.stage < 4);
  const reveal = i => st.status !== 'auction' || st.sold[i] || (st.seen && st.seen[i] && !(mystery && L.i === i));
  const pl = i => { const { clue, ...p } = st.pool[i]; return { ...p, i, price: st.sold[i] ? st.sold[i].price : null }; };
  // Modo censura (solo mientras dura la subasta): los jugadores comprados por OTROS capitanes van ocultos en
  // sus equipos, en el tablero y en el historial; hay que acordarse de quién se llevó a quién.
  const censor = !!(st.settings && st.settings.censor) && st.status === 'auction', mine = i => st.sold[i] && st.sold[i].cap === me;
  const C = L && st.pool[L.i].clue, P = L && st.pool[L.i];
  return { code: st.code, status: st.status, v: st.v, now, expiresAt: st.expiresAt, budget: SB_BUDGET, step: SB_STEP, maxCaps: sbMaxCaps(st),
    teamSize: st.teamSize || SB_TEAM, poolSize: st.pool.length, roles: SB_ROLES, slots: SB_SLOTS, queueLeft: (st.queue || []).length,
    me, isHost: uid != null && uid === st.host, hostNick: (st.caps[0] || {}).nick, starting: !!st.starting, capsInPool: !!(st.settings && st.settings.capsInPool), clues: !!(st.settings && st.settings.clues), censor: !!(st.settings && st.settings.censor), clueSecs: sbClueMs(st) / 1000, cluePct: (st.settings && st.settings.cluePct != null) ? st.settings.cluePct : SB_CLUE_PCT,
    caps: st.caps.map((c, k) => ({ nick: c.nick, rid: c.rid, host: c.uid === st.host, left: SB_BUDGET - c.spent, spent: c.spent,
      bought: sbBought(st, k).map(i => censor && k !== me ? { hidden: true } : pl(i)), need: st.status === 'lobby' ? null : sbNeed(st, k),
      lineup: st.assign ? SB_SLOTS.map(s => st.assign[k][s] != null ? pl(st.assign[k][s]) : null) : null,
      confirmed: !!(st.confirmed && st.confirmed[k]) })),
    // Los que aún no salen van ocultos (sin nombre ni rol): se descubren al salir, para darle suspenso.
    pool: st.pool.map((_, i) => i).sort((a, b) => st.order.indexOf(a) - st.order.indexOf(b))
      .map(i => censor && st.sold[i] && !mine(i) ? { hidden: true, censored: true } : reveal(i) ? { ...pl(i), sold: st.sold[i] || null, recycled: (st.recycled || {})[i] || 0 } : { hidden: true }),
    lot: L && { i: mystery ? null : L.i, price: L.price, leader: L.leader, bids: L.bids.slice(0, 8), left: L.deadline ? Math.max(0, L.deadline - now) : null, free: !!L.free, again: !!L.again,
      stage: L.stage || null, stageLeft: cluing ? Math.max(0, L.stageEnd - now) : null, minBid: sbMinBid(st), carry: L.firstOfStage ? L.carry : null, out: L.out || [],
      // si nadie sube antes de que cambie la fase: mínimo para la 1ª puja de la fase siguiente
      nextMin: cluing && L.leader != null ? Math.max(L.price + SB_STEP, Math.ceil(L.price * (1 + (((st.settings && st.settings.cluePct) != null ? st.settings.cluePct : SB_CLUE_PCT)) / 100) / SB_STEP) * SB_STEP) : null,
      // pistas que ya salieron, en orden: 1) una partida suya, 2) su rol, 3) un campeón que jugó.
      // Cuál de los 5 era él (y el nombre) recién se sabe al cerrar su puja.
      clues: L.stage ? { role: L.stage >= 2 ? P.role : null, game: C ? C.game : null, champ: L.stage >= 3 && C ? C.champ : null,
        none: !C || (!C.game && !C.champ), idx: null } : null },
    // revelación tras cerrar (modo pistas): quién era, a quién fue y cuánto falta para el siguiente
    reveal: st.reveal && !L && st.pool[st.reveal.i] ? (() => { const R = st.pool[st.reveal.i], RC = R.clue, s = st.sold[st.reveal.i];
      return { p: pl(st.reveal.i), cap: s ? s.cap : null, price: s ? s.price : null, left: st.autoNextAt ? Math.max(0, st.autoNextAt - now) : 0,
        clues: { role: R.role, game: RC ? RC.game : null, champ: RC ? RC.champ : null, none: !RC || (!RC.game && !RC.champ), idx: RC ? RC.idx : null,
          // la partida de la pista 1 en League of Graphs (LA2_123456 → /match/las/123456)
          lg: RC && RC.matchId ? 'https://www.leagueofgraphs.com/match/las/' + String(RC.matchId).replace(/^[A-Z0-9]+_/, '') : null } }; })() : null,
    player: L && !mystery ? pl(L.i) : null,
    last: st.last ? { ...st.last, p: pl(st.last.i) } : null,
    log: st.log.slice(0, 15).map(l => { const c = st.pool[l.i].clue; if (censor && l.cap != null && l.cap !== me) return { ...l, i: null, p: { hidden: true }, lg: null }; return { ...l, p: pl(l.i), lg: c && c.matchId ? 'https://www.leagueofgraphs.com/match/las/' + String(c.matchId).replace(/^[A-Z0-9]+_/, '') : null }; }),
    // votación final: quién ya votó (lo que votó cada uno se ve recién al terminar) y mi propio voto
    voted: st.votes ? st.caps.map((_, k) => !!st.votes[k]) : null, myVote: st.votes && me >= 0 ? st.votes[me] || null : null,
    final: st.final || null, votes: st.status === 'done' ? st.votes || null : null };
}
app.get('/api/subasta/access', auth, wrap(async (req, res) => res.json({ ok: true })));
app.get('/api/subasta', auth, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store'); const st = await sbRoom(req, res); if (!st) return;
  if (sbTick(st)) await sbSave(st);
  res.json(sbView(st, req.user.id));
}));
async function sbCapOf(uid){ const u = await q1('SELECT id, nickname, riotid FROM users WHERE id=$1', [uid]); return { uid, nick: (u && (u.nickname || '').trim()) || (u && u.riotid ? u.riotid.split('#')[0] : 'Capitán'), rid: (u && u.riotid) || '', spent: 0 }; }
const sbFresh = st => Object.assign(st, { status: 'lobby', pool: [], order: [], queue: [], sold: {}, seen: {}, recycled: {}, noSale: 0, lot: null, last: null, reveal: null, autoNextAt: null, log: [], assign: null, confirmed: null, votes: null, final: null });
app.post('/api/subasta/create', auth, wrap(async (req, res) => {
  const rooms = await sbRooms(); let code; do code = fvCode(); while (rooms[code]);
  const st = sbFresh({ code, host: req.user.id, createdAt: Date.now(), caps: [await sbCapOf(req.user.id)], teamSize: SB_TEAM });
  rooms[code] = st; await sbSave(st); res.json(sbView(st, req.user.id));
}));
app.post('/api/subasta/join', auth, wrap(async (req, res) => {
  const st = await sbRoom(req, res); if (!st) return;
  const cap = await sbCapOf(req.user.id);   // primero la consulta; después revisar y agregar sin esperas de por medio
  if (st.caps.some(c => c.uid === req.user.id)) return res.json(sbView(st, req.user.id));
  if (st.status !== 'lobby' || st.starting) return res.status(400).json({ error: 'La subasta ya empezó' });
  if (st.caps.length >= sbMaxCaps(st)) return res.status(400).json({ error: `La sala ya tiene ${sbMaxCaps(st)} capitanes` });
  st.caps.push(cap); await sbSave(st); res.json(sbView(st, req.user.id));
}));
app.post('/api/subasta/leave', auth, wrap(async (req, res) => {
  const st = await sbRoom(req, res); if (!st) return;
  if (st.status !== 'lobby' || st.starting) return res.status(400).json({ error: 'La subasta ya empezó' });
  const k = req.body && req.body.k != null ? Number(req.body.k) : -1, target = st.caps[k] ? st.caps[k].uid : req.user.id;
  if (target !== req.user.id && req.user.id !== st.host) return res.status(403).json({ error: 'Solo el anfitrión puede sacar a otro' });
  if (target === st.host) return res.status(400).json({ error: 'El anfitrión no puede salir: cierra la subasta' });
  st.caps = st.caps.filter(c => c.uid !== target); await sbSave(st); res.json(sbView(st, req.user.id));
}));
// Acciones del anfitrión: empezar, sacar el siguiente jugador y adjudicar ya.
app.post('/api/subasta/host', auth, wrap(async (req, res) => {
  const st = await sbRoom(req, res); if (!st) return; sbTick(st);
  if (req.user.id !== st.host) return res.status(403).json({ error: 'Solo el anfitrión dirige la subasta' });
  const act = req.body && req.body.action;
  if (act === 'start'){
    if (st.status !== 'lobby' || st.starting) return res.status(400).json({ error: 'La subasta ya empezó' });
    if (st.caps.length < 2) return res.status(400).json({ error: 'Se necesitan al menos 2 capitanes' });
    // Mientras se arma (puede tardar unos segundos con el modo pistas) nadie puede unirse ni salir: antes un capitán
    // que entraba en ese momento quedaba en una subasta calculada para un capitán menos (equipos de 6 que no daban).
    st.starting = true;
    try {
    const capsInPool = !!(st.settings && st.settings.capsInPool);
    const cands = await sbCandidates(capsInPool ? new Set() : new Set(st.caps.map(c => (c.rid || '').toLowerCase()).filter(Boolean)));
    const team = Math.min(st.caps.length >= SB_MAX_CAPS_IN ? 5 : SB_TEAM, Math.floor(cands.length / st.caps.length));   // con 6 capitanes: sin suplente
    if (team < 5){ st.starting = false; return res.status(400).json({ error: `No alcanzan los jugadores: hay ${cands.length} para ${st.caps.length} capitanes (se necesitan ${st.caps.length * 5})` }); }
    sbFresh(st); st.teamSize = team;
    st.pool = fvShuffle(cands).slice(0, Math.min(cands.length, team * st.caps.length + 3)); st.order = st.pool.map((_, i) => i); st.queue = st.order.slice();
    if (st.settings && st.settings.clues){ const res = await clueResolver();
      // las pistas salen SOLO de la cuenta más alta del jugador (opgg = su mejor cuenta según el ranking)
      for (const p of st.pool){ try { p.clue = await clueGame(res.one(p.opgg || p.rid)); } catch { p.clue = null; } } }
    st.caps.forEach(c => { c.spent = 0; }); st.status = 'auction'; st.startedAt = Date.now(); sbNext(st);
    } finally { st.starting = false; }
  } else if (act === 'settings'){
    if (st.status !== 'lobby' || st.starting) return res.status(400).json({ error: 'Las opciones se cambian antes de empezar' });
    st.settings = st.settings || {};
    if (req.body && req.body.capsInPool !== undefined){ const on = !!req.body.capsInPool;
      if (!on && st.caps.length > SB_MAX_CAPS) return res.status(400).json({ error: `Hay ${st.caps.length} capitanes: sin esta opción el máximo es ${SB_MAX_CAPS}` });
      st.settings.capsInPool = on; }
    if (req.body && req.body.clues !== undefined) st.settings.clues = !!req.body.clues;
    if (req.body && req.body.censor !== undefined) st.settings.censor = !!req.body.censor;
    if (req.body && req.body.clueSecs !== undefined){ const v = Number(req.body.clueSecs); if ([10, 15, 20, 30, 45, 60].includes(v)) st.settings.clueSecs = v; }
    if (req.body && req.body.cluePct !== undefined){ const v = Number(req.body.cluePct); if ([0, 10, 15, 20, 25, 30, 40, 50].includes(v)) st.settings.cluePct = v; }
  } else if (act === 'next'){
    if (st.status !== 'auction') return res.status(400).json({ error: 'La subasta no está en curso' });
    if (st.lot) return res.status(400).json({ error: 'Todavía hay un jugador en subasta' });
    sbNext(st);
  } else if (act === 'clue'){
    if (!st.lot || !st.lot.stage || st.lot.stage >= 4) return res.status(400).json({ error: 'No hay pistas por mostrar' });
    sbClueNext(st);
  } else if (act === 'hammer'){
    if (!st.lot) return res.status(400).json({ error: 'No hay ningún jugador en subasta' });
    if (st.lot.stage && st.lot.stage < 4) return res.status(400).json({ error: 'Primero revela al jugador' });
    sbClose(st, 'adjudicado');
  } else return res.status(400).json({ error: 'Acción inválida' });
  await sbSave(st); res.json(sbView(st, req.user.id));
}));
// Retirarse del jugador en juego (no vuelve a pujar por él). Si ya no queda nadie que pueda superar al que va
// ganando, se cierra al tiro (o, sin pujas, se recicla), para agilizar.
app.post('/api/subasta/withdraw', auth, wrap(async (req, res) => {
  const st = await sbRoom(req, res); if (!st) return; sbTick(st);
  const L = st.lot, c = st.caps.findIndex(x => x.uid === req.user.id);
  if (c < 0) return res.status(403).json({ error: 'Solo los capitanes' });
  if (!L || st.status !== 'auction') return res.status(400).json({ error: 'No hay ningún jugador en subasta' });
  if (L.leader === c) return res.status(400).json({ error: 'Vas ganando: no puedes retirarte' });
  L.out = L.out || []; if (!L.out.includes(c)) L.out.push(c);
  const rivals = sbNeeders(st).filter(k => k !== L.leader && !L.out.includes(k));
  if (!rivals.length) sbClose(st, L.leader == null ? 'todos se retiraron' : 'los demás se retiraron');
  await sbSave(st); res.json(sbView(st, req.user.id));
}));
app.post('/api/subasta/bid', auth, wrap(async (req, res) => {
  const st = await sbRoom(req, res); if (!st) return;
  if (sbTick(st)){ await sbSave(st); return res.status(400).json({ error: 'Se acabó el tiempo de ese jugador' }); }
  const c = st.caps.findIndex(x => x.uid === req.user.id);
  if (c < 0) return res.status(403).json({ error: 'Solo los capitanes pujan' });
  const err = sbBid(st, c, req.body && req.body.amount);
  if (err) return res.status(400).json({ error: err });
  await sbSave(st); res.json(sbView(st, req.user.id));
}));
// Reparto de los comprados en los 5 roles + suplente (cada uno el suyo). Cambiarlo quita la confirmación.
app.post('/api/subasta/assign', auth, wrap(async (req, res) => {
  const st = await sbRoom(req, res); if (!st) return;
  const c = st.caps.findIndex(x => x.uid === req.user.id);
  if (c < 0) return res.status(403).json({ error: 'Solo los capitanes arman su equipo' });
  if (st.status !== 'assign') return res.status(400).json({ error: 'Ahora no se puede cambiar el equipo' });
  const mine = sbBought(st, c), body = (req.body && req.body.slots) || {}, a = {};
  for (const s of SB_SLOTS){ const v = body[s]; if (v == null || v === '') continue; const n = Number(v);
    if (!mine.includes(n)) return res.status(400).json({ error: 'Ese jugador no es tuyo' }); a[s] = n; }
  if (new Set(Object.values(a)).size !== Object.values(a).length) return res.status(400).json({ error: 'Un jugador no puede ir en dos puestos' });
  st.assign[c] = a; st.confirmed[c] = false; await sbSave(st); res.json(sbView(st, req.user.id));
}));
app.post('/api/subasta/confirm', auth, wrap(async (req, res) => {
  const st = await sbRoom(req, res); if (!st) return;
  const c = st.caps.findIndex(x => x.uid === req.user.id);
  if (c < 0 || st.status !== 'assign') return res.status(400).json({ error: 'No hay equipo que confirmar' });
  if (req.body && req.body.on === false) st.confirmed[c] = false;
  else { if (!SB_ROLES.every(r => st.assign[c][r] != null)) return res.status(400).json({ error: 'Te falta poner a alguien en algún rol' }); st.confirmed[c] = true; }
  if (st.confirmed.every(Boolean)){ st.status = 'vote'; st.votes = {}; }
  await sbSave(st); res.json(sbView(st, req.user.id));
}));
// Votación final: cada capitán ordena a los OTROS equipos de mejor a peor. Con todos los votos, la tabla
// final se arma por puntos (Borda); a igualdad de puntos, más primeros lugares y después menos gastado.
function sbFinal(st){
  const n = st.caps.length, pts = st.caps.map(() => 0), firsts = st.caps.map(() => 0);
  for (const order of Object.values(st.votes)) order.forEach((c, p) => { pts[c] += (n - 1) - p; if (p === 0) firsts[c]++; });
  const rows = st.caps.map((cap, c) => ({ cap: c, pts: pts[c], firsts: firsts[c], spent: cap.spent }))
    .sort((a, b) => b.pts - a.pts || b.firsts - a.firsts || a.spent - b.spent);
  rows.forEach((r, k) => { r.pos = k > 0 && rows[k - 1].pts === r.pts && rows[k - 1].firsts === r.firsts ? rows[k - 1].pos : k + 1; });
  return rows;
}
app.post('/api/subasta/vote', auth, wrap(async (req, res) => {
  const st = await sbRoom(req, res); if (!st) return;
  const c = st.caps.findIndex(x => x.uid === req.user.id);
  if (c < 0) return res.status(403).json({ error: 'Solo los capitanes votan' });
  if (st.status !== 'vote') return res.status(400).json({ error: 'Ahora no hay votación' });
  const order = ((req.body && req.body.order) || []).map(Number), others = st.caps.map((_, k) => k).filter(k => k !== c);
  if (order.length !== others.length || new Set(order).size !== order.length || !order.every(k => others.includes(k)))
    return res.status(400).json({ error: 'Ordena a todos los demás equipos (sin el tuyo)' });
  st.votes[c] = order;
  if (st.caps.every((_, k) => st.votes[k])){ st.final = sbFinal(st); st.status = 'done'; }
  await sbSave(st); res.json(sbView(st, req.user.id));
}));
// Cerrar la subasta: se borra la sala (el enlace deja de funcionar).
app.post('/api/subasta/close', auth, wrap(async (req, res) => {
  const st = await sbRoom(req, res); if (!st) return;
  if (req.user.id !== st.host && !req.user.is_admin) return res.status(403).json({ error: 'Solo el anfitrión puede cerrarla' });
  delete (await sbRooms())[st.code]; try { await q('DELETE FROM tool_state WHERE id=$1', ['sub:' + st.code]); } catch {}
  res.json({ ok: true, closed: true });
}));
// Volver a la sala de espera (misma sala y capitanes) para repetir la subasta (en cualquier momento).
app.post('/api/subasta/reset', auth, wrap(async (req, res) => {
  const st = await sbRoom(req, res); if (!st) return;
  if (req.user.id !== st.host && !req.user.is_admin) return res.status(403).json({ error: 'Solo el anfitrión' });
  sbFresh(st); st.caps.forEach(c => { c.spent = 0; });
  await sbSave(st); res.json(sbView(st, req.user.id));
}));

// ================= SUBASTA · MODO PISTAS: ayudantes =================
// En el modo pistas el jugador sale "misterioso" y se descubre en 3 pistas antes del nombre:
//   1) su rol de torneo (o el de SoloQ si no juega torneo); 2) una partida suya al azar: los 5 de su equipo
//   con campeón, KDA y farm, sin decir cuál era él; 3) un campeón al azar de todas sus partidas.
// Resuelve los puuid de un jugador: su cuenta + la mejor cuenta del roster + smurfs registradas + vinculadas.
async function clueResolver(){
  const smurfs = await q('SELECT u.riotid main, s.riotid smurf FROM smurfs s JOIN users u ON u.id = s.user_id');
  const links = await q('SELECT main_riotid main, smurf_riotid smurf FROM smurf_links');
  const rid2pu = await ridPuuidMap(), nr = r => (r || '').trim().toLowerCase().replace(/\s*#\s*/g, '#');
  const puOf = {}; for (const [r, pu] of Object.entries(rid2pu)) puOf[nr(r)] = pu;
  for (const p of (liveSnapshot().players || [])) if (p.rid && p.puuid) puOf[nr(p.rid)] = p.puuid;
  const all = (rid, extra) => {
    const rids = [rid, ...(extra || []), ...smurfs.filter(s => nr(s.main) === nr(rid)).map(s => s.smurf), ...links.filter(l => nr(l.main) === nr(rid)).map(l => l.smurf)];
    return [...new Set(rids.map(r => puOf[nr(r)]).filter(Boolean))];
  };
  all.one = rid => puOf[nr(rid)] ? [puOf[nr(rid)]] : [];   // solo esa cuenta
  return all;
}
// Pistas 2 y 3 a partir de sus puuid (null si no tiene partidas guardadas).
async function clueGame(pus){
  if (!pus.length) return null;
  const g = await q1(`SELECT match_id, team_id, puuid FROM match_participants WHERE puuid = ANY($1) AND coalesce(duration,0) >= 600 ORDER BY random() LIMIT 1`, [pus]);
  const ch = await q1(`SELECT champion FROM match_participants WHERE puuid = ANY($1) AND coalesce(champion,'')<>'' ORDER BY random() LIMIT 1`, [pus]);
  let game = null, idx = -1;
  if (g){
    const team = await q(`SELECT puuid, champion, coalesce(kills,0) k, coalesce(deaths,0) d, coalesce(assists,0) a, coalesce(cs,0) cs, win, coalesce(duration,0) dur, game_end
      FROM match_participants WHERE match_id=$1 AND team_id=$2`, [g.match_id, g.team_id]);
    if (team.length >= 5){ const five = fvShuffle(team.slice(0, 5)); idx = five.findIndex(t => t.puuid === g.puuid);
      game = { win: !!team[0].win, durMin: Math.round((+team[0].dur) / 60), end: Number(team[0].game_end) || 0, players: five.map(t => ({ champ: t.champion, k: +t.k, d: +t.d, a: +t.a, cs: +t.cs })) }; }
  }
  return { game, idx, champ: ch ? ch.champion : null, matchId: g ? g.match_id : null };
}

// ---- RÉCORDS: extremos de una sola partida (+ rachas de V/D) ----
const RECORDS_CACHE = { at: 0, data: null };
let _recSig = {};   // firma por categoría (nm|valor de cada uno del top-5) para detectar entradas nuevas
const REC_SIG_V = { kdaBest:r=>r.kda, kdaWorst:r=>r.kda, kills:r=>r.k, deaths:r=>r.d, assists:r=>r.a,
              cs:r=>r.cs, vision:r=>r.vis, duration:r=>r.durMin, winStreak:r=>r.value, loseStreak:r=>r.value };
function recordsSig(R){
  const s = {};
  // Firma el TOP-5 completo de cada categoría: así cualquier ENTRADA nueva al top-5 (no solo el #1)
  // cambia la firma y dispara la notificación de "récord nuevo".
  for (const k in REC_SIG_V){ s[k] = (R[k] || []).slice(0, 5).map(t => (t.nm || '') + '|' + REC_SIG_V[k](t)).join(';'); }
  return s;
}
// Fecha de la partida MÁS RECIENTE dentro del top-5 de cada categoría. Un récord solo es "nuevo" si se
// jugó después de la última vez que el usuario los vio: así un recálculo (deploy, cambio de reglas,
// renombres, cuentas vinculadas) que reordena partidas ANTIGUAS no dispara avisos falsos.
let _recEnd = {};
function recordsEnd(R){
  const e = {};
  for (const k in REC_SIG_V) e[k] = Math.max(0, ...(R[k] || []).slice(0, 5).map(t => t.end || 0));
  return e;
}
app.get('/api/records', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  const recFor = async d => { if (await reqOrg(req)){ res.set('Cache-Control', 'private, no-store'); return d; } return stripSmurfs(d); };
  if (RECORDS_CACHE.data && Date.now() - RECORDS_CACHE.at < 300000) return res.json(await recFor(RECORDS_CACHE.data));
  // puuid -> Riot ID actual + nick (para OP.GG correcto aunque la cuenta se haya renombrado).
  const players = liveSnapshot().players || [];
  const ridByPuuid = {}, nickByRid = {};
  players.forEach(p => { if (p.puuid) ridByPuuid[p.puuid] = p.rid; nickByRid[(p.rid || '').toLowerCase()] = p.nm; });
  // Nickname del JUGADOR REGISTRADO por puuid: si la cuenta (main o smurf) es de un usuario, en Records
  // mostramos SU nick, no el nombre de la cuenta (p.ej. Maio#AZIR -> "Kriideastoraa").
  const rid2puuid = await ridPuuidMap();
  const userNick = {}, ownerNickByPuuid = {};
  try {
    for (const u of await q("SELECT id, nickname, lower(riotid) rid FROM users")){
      userNick['u' + u.id] = (u.nickname || '').trim();
      const pu = u.rid && rid2puuid[u.rid];
      if (pu && userNick['u' + u.id]) ownerNickByPuuid[pu] = userNick['u' + u.id];
    }
    for (const s of await q("SELECT user_id, lower(riotid) rid FROM smurfs WHERE coalesce(riotid,'')<>''")){
      const pu = rid2puuid[s.rid];
      if (pu && userNick['u' + s.user_id]) ownerNickByPuuid[pu] = userNick['u' + s.user_id];
    }
  } catch {}
  const N = 5;
  const K='coalesce(kills,0)', D='coalesce(deaths,0)', A='coalesce(assists,0)', CS='coalesce(cs,0)', DUR='coalesce(duration,0)', VIS='coalesce(vision,0)';
  const cols = `name, lower(riotid) rid, puuid, champion, match_id, game_end, ${K} k, ${D} d, ${A} a, ${CS} cs, ${DUR} dur, ${VIS} vis`;
  const base = `FROM mp_stats WHERE is_tournament=true AND coalesce(puuid,'')<>''`;
  const kda = `(${K}+${A})::float/GREATEST(${D},1)`;
  const topBy = order => q(`SELECT ${cols} ${base} ORDER BY ${order} LIMIT ${N}`);
  const [kdaBest, kdaWorst, cs, dur, kills, deaths, assists, vision] = await Promise.all([
    topBy(`${kda} DESC, ${D} ASC, (${K}+${A}) DESC`),     // KDA+: mayor; empate -> menos muertes
    topBy(`${kda} ASC, ${D} DESC, (${K}+${A}) ASC`),      // KDA-: menor; empate -> más muertes
    topBy(`${CS} DESC`), topBy(`${DUR} DESC`), topBy(`${K} DESC`), topBy(`${D} DESC`), topBy(`${A} DESC`), topBy(`${VIS} DESC`),
  ]);
  const map = r => { const rid = ridByPuuid[r.puuid] || r.rid;
    return { nm: ownerNickByPuuid[r.puuid] || nickByRid[(rid || '').toLowerCase()] || r.name || (r.rid || '').split('#')[0], rid, matchId: r.match_id,
      champ: r.champion, k:+r.k, d:+r.d, a:+r.a, kda:+(((+r.k) + (+r.a)) / Math.max(1, +r.d)).toFixed(2),
      cs:+r.cs, durMin: Math.round((+r.dur) / 60), vis:+r.vis, end: Number(r.game_end) || 0 }; };
  // Rachas de victorias/derrotas por cuenta (consecutivas en el tiempo); dedup por jugador (máx).
  // 'end' = fecha de la partida con que la racha alcanzó su máximo (para saber si es reciente).
  const gs = await q(`SELECT puuid, win, game_end ${base} AND game_end IS NOT NULL ORDER BY puuid, game_end ASC`);
  const byP = {}; gs.forEach(r => (byP[r.puuid] = byP[r.puuid] || []).push({ w: !!r.win, t: Number(r.game_end) || 0 }));
  const wmax = {}, lmax = {};
  for (const puuid in byP){ let cw=0, cl=0, mw=0, ml=0, mwT=0, mlT=0;
    byP[puuid].forEach(g => { if (g.w){ cw++; cl=0; } else { cl++; cw=0; } if (cw>mw){ mw=cw; mwT=g.t; } if (cl>ml){ ml=cl; mlT=g.t; } });
    const rid = ridByPuuid[puuid]; const nm = ownerNickByPuuid[puuid] || (rid ? (nickByRid[(rid||'').toLowerCase()] || rid.split('#')[0]) : null);
    if (!nm) continue;
    if (mw > ((wmax[nm]||{}).v||0)) wmax[nm]={ v:mw, t:mwT }; if (ml > ((lmax[nm]||{}).v||0)) lmax[nm]={ v:ml, t:mlT };
  }
  const streaks = obj => Object.entries(obj).filter(([,x]) => x.v>=2).map(([nm,x]) => ({ nm, value:x.v, end:x.t })).sort((a,b) => b.value-a.value).slice(0, N);
  // RÉCORD DE LP: peak absoluto por cuenta (base sembrada + runner lo sube). Consolidado por jugador, top 5.
  let peakLp = [];
  try {
    const peakRows = await q('SELECT lower(rid) rid, peak_abs FROM peak_lp');
    const byKey = {};
    for (const r of peakRows){
      const pu = rid2puuid[r.rid];
      const key = (pu && ownerNickByPuuid[pu]) || r.rid;   // agrupa por dueño registrado; si no, por cuenta
      const cur = byKey[key];
      if (!cur || +r.peak_abs > cur.abs) byKey[key] = { abs: +r.peak_abs, rid: r.rid, puuid: pu };
    }
    peakLp = Object.values(byKey).map(v => {
      const rid = ridByPuuid[v.puuid] || v.rid;
      const nm = (v.puuid && ownerNickByPuuid[v.puuid]) || nickByRid[(rid || '').toLowerCase()] || v.rid.split('#')[0];
      return { rid, nm, high: v.abs >= 2800, value: v.abs };
    }).sort((a, b) => b.value - a.value).slice(0, 5);
  } catch {}
  RECORDS_CACHE.data = { peakLp, kdaBest: kdaBest.map(map), kdaWorst: kdaWorst.map(map), cs: cs.map(map), duration: dur.map(map),
    kills: kills.map(map), deaths: deaths.map(map), assists: assists.map(map), vision: vision.map(map),
    winStreak: streaks(wmax), loseStreak: streaks(lmax) };
  _recSig = recordsSig(RECORDS_CACHE.data);
  RECORDS_CACHE.data._sig = _recSig;   // firma incluida en la respuesta (para resaltar lo nuevo)
  _recEnd = recordsEnd(RECORDS_CACHE.data);
  RECORDS_CACHE.at = Date.now();
  res.json(await recFor(RECORDS_CACHE.data));
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
// Pestaña "Ranked": la misma página de Herramientas, que al abrirse como ranked.html muestra solo Ranked.
app.get('/ranked.html', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(ROOT, 'herramientas.html')); });
const PUBLIC_FILES = new Set(['api.js', 'auth-fetch.js', 'sfx.js', 'nav.css', 'roulette.js', 'torneo-data.js', 'uleague-data.json']);
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let p = req.path; try { p = decodeURIComponent(p); } catch { return res.status(400).end(); }
  if (p.startsWith('/api/') || p === '/ping' || p === '/' || p === '/players.json' || p === '/players.js') return next();
  if (/^\/[^/]+\.(html|webp|png|jpe?g|gif|svg|ico|pdf)$/i.test(p) || PUBLIC_FILES.has(p.slice(1))) return next();
  if (/^\/overlay\/assets\/[^]+\.(webp|png|jpe?g|gif|svg|ico|mp3|ogg|wav|webm|mp4|woff2?|ttf)$/i.test(p) && !p.includes('..')) return next();
  res.status(404).send('No encontrado');
});
app.use(express.static(ROOT, {
  setHeaders(res, filePath){
    // players.json/js cacheables ~20s: Cloudflare sirve la mayoría de los polls desde el
    // borde (1 fetch al origen cada ~20s en vez de 1 por cliente) → baja mucho la banda.
    // El ranking igual se actualiza cada ~2 min, así que ~20s de "atraso" es imperceptible.
    if (/players\.json$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=20');
    // imágenes y fuentes: casi nunca cambian → una semana en el navegador y en Cloudflare (no vuelven a salir de Render)
    else if (/\.(webp|png|jpe?g|gif|svg|ico|woff2?|ttf|mp3|ogg|webm|mp4)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
    else if (/players\.js$/.test(filePath)) res.setHeader('Cache-Control', 'no-store');   // carga inicial: siempre fresca
  }
}));

// ---- Runner embebido (opcional) ----
// Si RIOT_API_KEY está en el entorno, el propio server actualiza el ranking
// corriendo fetch-data.js cada INTERVAL_SEC (por defecto 90s). Así NO hace
// falta correr el runner en un PC: todo vive en la nube. La key nunca se
// expone al navegador (solo la usa el proceso del server).
function startEmbeddedRunner(){
  if (process.env.NO_RUNNER) return;   // para desarrollo/preview: arranca el server sin el runner de Riot
  if (!process.env.RIOT_API_KEY) return;
  const { spawn } = require('child_process');
  const INTERVAL = (Number(process.env.INTERVAL_SEC) || 90) * 1000;   // más frecuente = live games más frescos (ojo rate limit Riot)
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
        if (row && row.data){ const raw = JSON.stringify(row.data); fs.writeFileSync(path.join(CACHE_DIR, file), raw); lastSaved[id] = hashOf(raw); } } catch {}
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
        // El runner trabaja con lpGames del MÁS NUEVO al más viejo (unshift + slice(0,40) + [0].pending).
        // Antes aquí se ordenaba al revés (viejo→nuevo): tras cada reinicio el runner insertaba la
        // partida nueva al frente y su slice(0,40) botaba las MÁS RECIENTES → partidas sin ±LP.
        merged.sort((a, b) => (b.end || 0) - (a.end || 0));
        c.lpGames = merged.slice(0, 80);   // conserva las 80 más recientes
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
  // Solo se sube lo que cambió desde el último respaldo (p.ej. regions.json pesa ~1,9 MB y casi nunca cambia):
  // era la mayor parte de la banda "Service-Initiated" de Render.
  const lastSaved = {};
  const hashOf = raw => crypto.createHash('sha1').update(raw).digest('hex');
  const saveCache = async () => {
    for (const [id, file] of Object.entries(CACHE_FILES)){
      try { const raw = fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'), h = hashOf(raw);
        if (lastSaved[id] === h) continue;
        await q('INSERT INTO fetch_cache (id,data,updated_at) VALUES ($1,$2::jsonb,now()) ON CONFLICT (id) DO UPDATE SET data=$2::jsonb, updated_at=now()', [id, raw]);
        lastSaved[id] = h; } catch {}
    }
  };
  // Un ciclo del tracker nunca puede durar más de RUN_MAX_MS: antes, si quedaba colgado, el ranking (y las
  // partidas en vivo) se congelaban hasta el próximo reinicio.
  const RUN_MAX_MS = (Number(process.env.RUN_MAX_MIN) || 15) * 60 * 1000;
  const runOnce = () => new Promise(res => {
    const p = spawn(process.execPath, [path.join(ROOT, 'fetch-data.js')], { cwd: ROOT, env: process.env, stdio: 'inherit' });
    const kill = setTimeout(() => { console.warn('⚠ ciclo del tracker excedió ' + (RUN_MAX_MS / 60000) + ' min: se corta'); try { p.kill('SIGKILL'); } catch {} }, RUN_MAX_MS);
    const done = () => { clearTimeout(kill); res(); };
    p.on('exit', done); p.on('error', done);
  });

  console.log(`▶ Runner embebido activo — actualiza el ranking cada ${INTERVAL / 1000}s`);
  (async () => {
    // Muestra de inmediato el ÚLTIMO ranking bueno (guardado en DB), para no servir el
    // players.json viejo del repo durante los ~2-3 min del primer ciclo tras un redeploy.
    try { const row = await q1("SELECT data FROM fetch_cache WHERE id='players'"); if (row && row.data) liveData = row.data; } catch {}
    await loadCache();   // restaura el historial ±LP/aegis persistido
    let lastPersist = Date.now(), lastPlayersHash = '', lastPlayersAt = 0;   // el ranking (liviano) se respalda tras el 1er ciclo y luego cada 20 min
    const PERSIST_MS = (Number(process.env.PERSIST_MIN) || 120) * 60 * 1000;   // cada cuánto persistir los blobs a Supabase (antes: cada ciclo; luego 30 min)
    const persistPlayers = async () => { const raw = JSON.stringify(liveData), h = hashOf(raw); if (h === lastPlayersHash) return;
      try { await q("INSERT INTO fetch_cache (id,data,updated_at) VALUES ('players',$1::jsonb,now()) ON CONFLICT (id) DO UPDATE SET data=$1::jsonb, updated_at=now()", [raw]); lastPlayersHash = h; } catch {} };
    // Al apagarse (deploy/reinicio, Render manda SIGTERM y espera ~30 s) se respalda lo último: así el intervalo
    // largo no pierde historial.
    let stopping = false;
    process.once('SIGTERM', async () => { if (stopping) return; stopping = true;
      const t = setTimeout(() => process.exit(0), 20000); try { await saveCache(); await persistPlayers(); } catch {} clearTimeout(t); process.exit(0); });
    for (;;){
      const t = Date.now();
      try {
        await writeRoster(); await runOnce();
        liveData = JSON.parse(fs.readFileSync(path.join(ROOT, 'players.json'), 'utf8'));   // ranking fresco EN MEMORIA cada ciclo (gratis)
        // Los blobs de caché SOLO se leen al arrancar (restaurar tras un redeploy), así que persistirlos
        // cada 90s era ~64 GB/mes de egress a Supabase. Se persisten cada PERSIST_MS (30 min).
        if (Date.now() - lastPersist >= PERSIST_MS){
          lastPersist = Date.now();
          await saveCache();
          await persistPlayers(); lastPlayersAt = Date.now();
        } else if (Date.now() - lastPlayersAt >= 20 * 60 * 1000){ await persistPlayers(); lastPlayersAt = Date.now(); }   // así un reinicio no arranca con un ranking de horas atrás
        // Récord de LP: sube el peak_abs de cada cuenta si su LP actual lo supera (batch en un solo statement).
        try {
          const pls = (liveData.players || []).map(pl => ({ rid:(pl.rid||'').toLowerCase(), abs:absLPof(pl.tier, pl.div, pl.lp) })).filter(x => x.rid && x.abs != null);
          if (pls.length){
            const vals = pls.map((_, i) => `($${i*2+1},$${i*2+2})`).join(',');
            await q(`INSERT INTO peak_lp (rid, peak_abs) VALUES ${vals} ON CONFLICT (rid) DO UPDATE SET peak_abs=GREATEST(peak_lp.peak_abs, EXCLUDED.peak_abs), updated_at=now()`, pls.flatMap(x => [x.rid, x.abs]));
          }
        } catch {}
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
  const rid2puuid = await ridPuuidMap();   // mapa cacheado (evita re-escanear match_participants)
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
