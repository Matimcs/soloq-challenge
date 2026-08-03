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
  for (const f of ['email','password','nickname','realname','riotid','discord','pos1','pos2'])
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

// ---- Sitio estático ----
app.use(express.static(ROOT));

init()
  .then(() => app.listen(PORT, () => console.log(`✔ Backend + web en http://localhost:${PORT}`)))
  .catch(e => { console.error('❌ No se pudo conectar a la base de datos:', e.message); process.exit(1); });
