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
  try { const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'players.json'), 'utf8'));
    const i = (d.players||[]).findIndex(p => p.rid === riotid); return i >= 0 ? i+1 : null; } catch { return null; }
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
  const team = TEAMS.has(b.team) ? b.team : null;
  const riotid = b.riotid;   // la cuenta principal del jugador (la que se trackea)
  const hash = await bcrypt.hash(b.password, 10);
  const u = await q1(`INSERT INTO users (email,password_hash,nickname,realname,riotid,main,discord,pos1,pos2,avatar,champ1,champ2,champ3,flash_slot,team,confirmed,is_admin)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16) RETURNING *`,
    [b.email, hash, b.nickname, b.realname, riotid, b.main||null, b.discord, b.pos1, b.pos2, b.avatar||null, b.champ1, b.champ2, b.champ3, flash, team, ADMIN_RIDS.has(riotid)]);
  // Al inscribir esta cuenta, su equipo lo decide el jugador → quita cualquier equipo sembrado a mano.
  await q('DELETE FROM team_members WHERE lower(riotid)=lower($1)', [riotid]);
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
  if (u && u.riotid) await q('DELETE FROM team_members WHERE lower(riotid)=lower($1)', [u.riotid]);   // su elección manda
  res.json({ user: publicUser(u) });
}));

// Avatares públicos (para el ranking y los popups del sitio). Sin auth: el leaderboard es público.
// Devuelve una entrada por CUENTA: la main del usuario + sus smurfs, con etiqueta Main/Smurf N.
app.get('/api/avatars', wrap(async (req,res) => {
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
  res.json(out);
}));

// Equipo por cuenta (Exilium/Tide/Zenith) para la etiqueta del ranking. Público.
// Mezcla: cuentas de usuarios registrados con equipo (main + smurfs) + tabla team_members.
app.get('/api/teams', wrap(async (req,res) => {
  const tm     = await q("SELECT riotid, team FROM team_members WHERE team IS NOT NULL AND team<>''");
  const users  = await q("SELECT id, riotid, team FROM users WHERE team IS NOT NULL AND team<>''");
  const smurfs = await q('SELECT user_id, riotid FROM smurfs');
  const byUser = {}; smurfs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s.riotid); });
  const map = {};
  tm.forEach(r => { map[r.riotid.toLowerCase()] = { riotid:r.riotid, team:r.team }; });
  users.forEach(u => {   // el equipo del usuario registrado manda para sus cuentas
    map[u.riotid.toLowerCase()] = { riotid:u.riotid, team:u.team };
    (byUser[u.id] || []).forEach(rid => { map[rid.toLowerCase()] = { riotid:rid, team:u.team }; });
  });
  res.json(Object.values(map));
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
  await q('DELETE FROM team_members WHERE lower(riotid)=lower($1)', [riotid]);   // el equipo del dueño manda para su smurf
  res.json({ ok:true });
}));
app.post('/api/me/smurfs/remove', auth, wrap(async (req,res) => {
  await q('DELETE FROM smurfs WHERE id=$1 AND user_id=$2', [Number(req.body && req.body.id), req.user.id]);
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

  // Perfil desde la caché del ranking (players.json) + usuario registrado
  const lp = liveData && Array.isArray(liveData.players) ? liveData.players.find(p => p.rid === riotid) : null;
  const rankPos = lp && liveData ? liveData.players.indexOf(lp) + 1 : null;
  let u = await q1('SELECT * FROM users WHERE riotid=$1', [riotid]);
  let accLabel = u ? 'Main' : null;
  if (!u){ // ¿es una cuenta smurf? -> resuelve el dueño (para nick/blueshells)
    const s = await q1('SELECT user_id FROM smurfs WHERE lower(riotid)=lower($1)', [riotid]);
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
      const fulls = await q('SELECT match_id, data FROM matches WHERE match_id = ANY($1)', [ids]);
      const byId = {}; fulls.forEach(f => byId[f.match_id] = f.data);
      history = ids.map(id => buildHistoryRow(byId[id], puuid)).filter(Boolean);
    }
    // ±LP y aegis por partida (desde lpGames del caché), casando por 'end'.
    try {
      const r = await q1("SELECT data FROM fetch_cache WHERE id='matches'");
      const s = r && r.data && r.data[puuid];
      if (s && Array.isArray(s.lpGames)){
        const byEnd = {}; s.lpGames.forEach(g => { if (g.end) byEnd[g.end] = g; });
        const wd = s.lpGames.filter(g => g.delta > 0).slice(0, 15).map(g => g.delta).sort((a,b)=>a-b);
        const med = wd.length ? wd[Math.floor(wd.length/2)] : 0;
        history.forEach(h => { const g = byEnd[h.end]; if (g){ h.lp = g.delta; h.aegis = g.delta > 0 && med > 0 && g.delta >= 1.8*med; } });
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
  const row = await q1('SELECT data FROM matches WHERE match_id=$1', [id]);
  if (!row || !row.data || !row.data.info) return res.status(404).json({ error:'Partida no guardada' });
  const info = row.data.info;
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
  if (Date.now() - LB_CACHE.at < 60000) return LB_CACHE.players;
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
app.get('/api/ficha/:riotid', wrap(async (req,res) => {
  const riotid = (req.params.riotid || '').trim();
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
      const r = await q1("SELECT data FROM fetch_cache WHERE id='matches'");
      const s = r && r.data && r.data[puuid];
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

  const w = lp ? lp.w : 0, l = lp ? lp.l : 0, tot = w+l;
  res.json({
    profile: { riotid, nickname:(u&&u.nickname)||(lp&&lp.nm)||riotid.split('#')[0], realname:u&&u.realname, avatar:u&&u.avatar,
      tier:lp&&lp.tier, div:lp&&lp.div, lp:lp&&lp.lp, rankPos, role:(u&&u.pos1)||(lp&&lp.role),
      elo: lp && ['MASTER','GRANDMASTER','CHALLENGER'].includes(lp.tier) ? 'High Elo' : 'Low Elo',
      w, l, winrate: tot?Math.round(w/tot*100):0 },
    eloSeries, premios, records,
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
  res.json({ ok:true });
}));
// El overlay sondea sus mensajes recientes (últimos 5 min) por Riot ID. Sin auth (solo lectura de lo propio).
app.get('/api/overlay/messages', wrap(async (req,res) => {
  const riotid = (req.query.riotid || '').trim();
  if (!riotid) return res.json([]);
  const u = await q1('SELECT id FROM users WHERE riotid=$1', [riotid]);
  if (!u) return res.json([]);
  res.json(await q(`SELECT id, text, audio, created_at FROM admin_messages
    WHERE user_id=$1 AND created_at > now() - interval '5 minutes' ORDER BY id ASC LIMIT 10`, [u.id]));
}));

// Blue Shells recibidas por un jugador (para el overlay). Sin auth: solo lectura por Riot ID.
app.get('/api/overlay/shells', wrap(async (req,res) => {
  const riotid = (req.query.riotid || '').trim();
  if (!riotid) return res.json([]);
  const u = await q1('SELECT id FROM users WHERE riotid=$1', [riotid]);
  if (!u) return res.json([]);
  res.json(await q(`SELECT id, castigo, other AS "from", estado, extra, audio, created_at FROM events
    WHERE user_id=$1 AND kind='received' ORDER BY id DESC LIMIT 20`, [u.id]));
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
    return res.json({ bounce:true, castigo, champ: display, champIcon, msg:`¡Rebotó! El castigo te toca a TI: ${castigo}` });
  }
  await q("INSERT INTO events (kind,user_id,other,castigo,extra) VALUES ('sent',$1,$2,$3,$4)", [req.user.id, target.nickname, castigo, extra]);
  await q("INSERT INTO events (kind,user_id,other,castigo,extra,audio) VALUES ('received',$1,$2,$3,$4,$5)", [target.id, req.user.nickname, castigo, extra, audio]);
  res.json({ bounce:false, castigo, target: target.nickname, champ: display, champIcon, msg:`Le lanzaste una Blue Shell a ${target.nickname}. Le tocó: ${castigo}` });
}));

app.post('/api/blueshells/:id/cumplido', auth, wrap(async (req,res) => {
  const rows = await q("UPDATE events SET estado='cumplido' WHERE id=$1 AND user_id=$2 AND kind='received' RETURNING id", [Number(req.params.id), req.user.id]);
  if (!rows.length) return res.status(404).json({ error:'No encontrado' });
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
  res.json({ ok:true });
}));
app.post('/api/admin/penalty/remove', auth, requireAdmin, wrap(async (req,res) => {
  await q("DELETE FROM events WHERE id=$1 AND kind='received'", [Number(req.body && req.body.id)]);
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
app.get('/players.json', (req,res,next) => liveData ? res.json(liveData) : next());
app.get('/players.js',   (req,res,next) => liveData ? res.type('application/javascript').send('window.SQC_DATA = ' + JSON.stringify(liveData) + ';\n') : next());

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

// ---- Sitio estático ----
app.use(express.static(ROOT));

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
  const CACHE_FILES = { puuids:'puuids.json', ranks:'ranks.json', matches:'matches.json', encounters:'encounters.json', regions:'regions.json', positions:'positions.json' };
  // Escribe roster-extra.json (cuentas agregadas por el admin) para que fetch-data las incluya.
  const writeRoster = async () => {
    // roster manual (admin) + cuentas smurf de los jugadores → el runner las trackea.
    try {
      const rows = await q('SELECT riotid FROM roster ORDER BY created_at');
      const sm   = await q('SELECT riotid FROM smurfs ORDER BY id');
      const all  = [...new Set([...rows.map(r=>r.riotid), ...sm.map(r=>r.riotid)])];
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
        c.lpGames = (s.lpGames || []).slice(0, 40);   // el seed es la línea base de ±LP al arrancar; lo vivo se apila encima
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
    await loadCache();   // restaura el historial ±LP/aegis persistido
    for (;;){
      const t = Date.now();
      try { await writeRoster(); await runOnce(); await saveCache(); liveData = JSON.parse(fs.readFileSync(path.join(ROOT, 'players.json'), 'utf8')); }
      catch (e){ console.error('Runner embebido:', e.message); }
      await new Promise(r => setTimeout(r, Math.max(0, INTERVAL - (Date.now() - t))));
    }
  })();
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
    }
  }))
  .catch(e => { console.error('❌ No se pudo conectar a la base de datos:', e.message); process.exit(1); });
