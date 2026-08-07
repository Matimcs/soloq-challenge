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

const PORT = process.env.PORT || 8123;
const JWT_SECRET = process.env.JWT_SECRET || 'sqc-dev-secret-cambiar-en-produccion';
const ADMIN_RID = 'SionAntisionista#SAS';
const ROOT = path.join(__dirname, '..');

const SHELLS = [
  { name:'Sin tus 3 campeones más jugados', w:17 }, { name:'Una partida con Yuumi', w:11 },
  { name:'Campeón aleatorio', w:11 }, { name:'Sin Flash', w:11 }, { name:'Autofill', w:11 },
  { name:'Sin botas y sin pies veloces', w:11 }, { name:'Hechizos cambiados', w:6 },
  { name:'Sensibilidad x2', w:6 }, { name:'Sin objetos completos hasta min 15', w:6 },
  { name:'Reverse', w:6 }, { name:'Runas predeterminadas', w:4 },
];
const MAX_SHELLS = 3;
function rollShell(){ const t = SHELLS.reduce((a,s)=>a+s.w,0); let r = Math.random()*t; for (const s of SHELLS){ if ((r-=s.w)<=0) return s.name; } return SHELLS[0].name; }
function reverseChance(pos){ return (pos && pos<=5) ? pos : 15; }
function ladderPos(riotid){
  try { const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'players.json'), 'utf8'));
    const i = (d.players||[]).findIndex(p => p.rid === riotid); return i >= 0 ? i+1 : null; } catch { return null; }
}

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use((req,res,next)=>{ res.header('Access-Control-Allow-Origin','*'); res.header('Access-Control-Allow-Headers','Content-Type,Authorization'); res.header('Access-Control-Allow-Methods','GET,POST,OPTIONS'); if(req.method==='OPTIONS') return res.sendStatus(204); next(); });

const wrap = fn => (req,res) => fn(req,res).catch(e => { console.error(e); res.status(500).json({ error:'Error del servidor' }); });
const sign = u => jwt.sign({ uid: u.id }, JWT_SECRET, { expiresIn: '30d' });
const publicUser = u => ({ id:u.id, email:u.email, nickname:u.nickname, realname:u.realname, riotid:u.riotid, main:u.main, discord:u.discord, pos1:u.pos1, pos2:u.pos2, avatar:u.avatar, isAdmin: !!u.is_admin });
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
  for (const f of ['email','password','nickname','realname','riotid','discord','pos1','pos2','avatar'])
    if (!b[f]) return res.status(400).json({ error:`Falta el campo: ${f}` });
  if (!/^.+#.+$/.test(b.riotid)) return res.status(400).json({ error:'Riot ID debe ser Nombre#TAG' });
  if (await q1('SELECT 1 FROM users WHERE email=$1', [b.email])) return res.status(409).json({ error:'Ese email ya está registrado' });
  const hash = await bcrypt.hash(b.password, 10);
  const u = await q1(`INSERT INTO users (email,password_hash,nickname,realname,riotid,main,discord,pos1,pos2,avatar,is_admin)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [b.email, hash, b.nickname, b.realname, b.riotid, b.main||null, b.discord, b.pos1, b.pos2, b.avatar||null, b.riotid === ADMIN_RID]);
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
  const sets = [], vals = []; let i = 1;
  for (const f of ['nickname','realname','riotid','main','discord','pos1','pos2','avatar','email'])
    if (b[f] !== undefined){ sets.push(`${f}=$${i++}`); vals.push(b[f] || null); }
  if (b.password){ if (String(b.password).length < 6) return res.status(400).json({ error:'La contraseña debe tener al menos 6 caracteres' });
    sets.push(`password_hash=$${i++}`); vals.push(await bcrypt.hash(b.password, 10)); }
  if (!sets.length) return res.json({ user: publicUser(req.user) });
  vals.push(req.user.id);
  const u = await q1(`UPDATE users SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
  res.json({ user: publicUser(u) });
}));

// Avatares públicos (para el ranking y los popups del sitio). Sin auth: el leaderboard es público.
app.get('/api/avatars', wrap(async (req,res) => {
  const rows = await q('SELECT riotid, nickname, avatar, pos1 FROM users WHERE avatar IS NOT NULL');
  res.json(rows.map(r => ({ riotid:r.riotid, nickname:r.nickname, avatar:r.avatar, pos1:r.pos1 })));
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

  await q('DELETE FROM shells WHERE id=$1', [shell.id]);
  let castigo = rollShell(), bounce = false;
  if (castigo === 'Reverse'){ bounce = true; do { castigo = rollShell(); } while (castigo === 'Reverse'); }
  if (Math.random()*100 < reverseChance(ladderPos(target.riotid))) bounce = true;

  if (bounce){
    await q("INSERT INTO events (kind,user_id,other,castigo,bounce) VALUES ('received',$1,$2,$3,true)", [req.user.id, '↩️ rebote (' + target.nickname + ')', castigo]);
    return res.json({ bounce:true, castigo, msg:`¡Rebotó! El castigo te toca a TI: ${castigo}` });
  }
  await q("INSERT INTO events (kind,user_id,other,castigo) VALUES ('sent',$1,$2,$3)", [req.user.id, target.nickname, castigo]);
  await q("INSERT INTO events (kind,user_id,other,castigo) VALUES ('received',$1,$2,$3)", [target.id, req.user.nickname, castigo]);
  res.json({ bounce:false, castigo, target: target.nickname, msg:`Le lanzaste una Blue Shell a ${target.nickname}. Le tocó: ${castigo}` });
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
  const CACHE_FILES = { puuids:'puuids.json', ranks:'ranks.json', matches:'matches.json', encounters:'encounters.json' };
  // Escribe roster-extra.json (cuentas agregadas por el admin) para que fetch-data las incluya.
  const writeRoster = async () => {
    try { const rows = await q('SELECT riotid FROM roster ORDER BY created_at');
      fs.writeFileSync(path.join(ROOT, 'roster-extra.json'), JSON.stringify(rows.map(r=>r.riotid))); } catch {}
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
  .then(() => app.listen(PORT, () => { console.log(`✔ Backend + web en http://localhost:${PORT}`); startEmbeddedRunner(); }))
  .catch(e => { console.error('❌ No se pudo conectar a la base de datos:', e.message); process.exit(1); });
