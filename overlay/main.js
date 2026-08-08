/* ============================================================
   main.js — Electron (overlay sin Overwolf)
   Ventanas independientes:
     - win      : tarjeta de identidad/standing (overlay.html)
     - shellWin : popup de Blue Shells (shells.html)
     - bigWin   : panel scoreboard (panel.html, Alt+X)
   Cada una se mueve y se activa/desactiva por separado.
   Solo tiene en cuenta partidas de SoloQ (queue 420).
   ============================================================ */
const { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { getCreds, lcu } = require('./lcu');
const { liveClient } = require('./liveclient');

const ROSTER_FILE = path.join(__dirname, '..', 'players.json');
const NO_DIV = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const HIGH = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
// Config opcional (para el .exe: sin cmd ni variables de entorno). overlay/config.json:
//   { "riotApiKey": "RGAPI-...", "backend": "https://...onrender.com" }
function loadConfig(){ try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; } }
const CONFIG = loadConfig();
const KEY = process.env.RIOT_API_KEY || CONFIG.riotApiKey || null;
const BACKEND = (process.env.SQC_BACKEND || CONFIG.backend || 'https://soloq-challenge-em9q.onrender.com').replace(/\/+$/, '');
const PLATFORM = 'la2', CLUSTER = 'americas';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Catálogo Blue Shell -> nombre de archivo de imagen en /assets/shells/<slug>.png
const SHELL_IMG = {
  'Sin tus 3 campeones más jugados': 'sin-3-campeones', 'Una partida con Yuumi': 'yuumi', 'Campeón aleatorio': 'campeon-aleatorio',
  'Sin Flash': 'sin-flash', 'Autofill': 'autofill', 'Sin botas y sin pies veloces': 'sin-botas', 'Hechizos cambiados': 'hechizos-cambiados',
  'Sin pociones ni pinks': 'sin-pociones', 'Sin objetos completos hasta min 15': 'sin-objetos-min15', 'Reverse': 'reverse', 'Clase de campeón aleatoria': 'clase-campeon',
};
// Traduce el "extra" de una shell para mostrarlo. En "Clase de campeón aleatoria" el extra es un
// tag de DDragon en inglés (Tank, Mage…) -> se muestra en español. En el resto (p.ej.
// "Campeón aleatorio") el extra ya es legible (id del campeón).
const CLASS_ES = { Fighter:'Luchador', Tank:'Tanque', Mage:'Mago', Assassin:'Asesino', Marksman:'Tirador', Support:'Soporte' };
function extraLabel(castigo, extra){ if (!extra) return null; return castigo === 'Clase de campeón aleatoria' ? (CLASS_ES[extra] || extra) : extra; }
// URL absoluta file:// de la imagen (robusto en Electron; la relativa fallaba)
function shellImgUrl(name){ const s = SHELL_IMG[name]; return s ? pathToFileURL(path.join(__dirname, 'assets', 'shells', s + '.png')).href : ''; }
// Castigos actuales del jugador = las Blue Shells recibidas pendientes (para el popup).
// Las llena pollShells desde el backend (ya no hay castigos de prueba).
let myShells = [];
function myCastigosForPopup(){
  return (myShells || [])
    .filter(s => s.estado !== 'cumplido')
    .map(s => { const lbl = extraLabel(s.castigo, s.extra); return { name: s.castigo + (lbl ? ' (' + lbl + ')' : ''), from: s.from || null, to: 'tú', img: shellImgUrl(s.castigo) }; });
}

// LP absoluto (para calcular distancia al jugador de arriba)
const TIER_IDX = { IRON:0,BRONZE:1,SILVER:2,GOLD:3,PLATINUM:4,EMERALD:5,DIAMOND:6,MASTER:7,GRANDMASTER:7,CHALLENGER:7 };
const DIV_OFF  = { I:300, II:200, III:100, IV:0, '':0 };
function absLP(p){ if(!p) return 0; if(HIGH.has(p.tier)) return 2800 + (p.lp||0); return (TIER_IDX[p.tier]??0)*400 + (DIV_OFF[p.div]||0) + (p.lp||0); }

// ---- Settings persistentes ----
// En el .exe empaquetado __dirname es de solo lectura → guardar en la carpeta de datos del usuario.
let SETTINGS_FILE;
try { SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json'); } catch { SETTINGS_FILE = path.join(__dirname, 'settings.json'); }
let settings = { smallVisible: true, shellVisible: true, opacity: 1, hideOutOfGame: true, alwaysOnTop: true, volume: 0.8, autoLaunch: true };
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch {}
function saveSettings(){ try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch {} }

// Log de diagnóstico (en la carpeta de datos del usuario)
let DEBUG_LOG; try { DEBUG_LOG = path.join(app.getPath('userData'), 'overlay-debug.log'); } catch { DEBUG_LOG = path.join(__dirname, 'overlay-debug.log'); }
function dlog(m){ try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${m}\n`); } catch {} }

let DD = null, cachedMatchup = null, myApiPuuid = null, myRidForShells = null;
const OVERLAY_START = Date.now();
let shownShellIds = new Set(Array.isArray(settings.shownShellIds) ? settings.shownShellIds : []);

// El roster/standing se baja del backend (players.json), no de un archivo local:
// así el .exe es independiente y usa datos frescos de la nube.
let rosterCache = { players: [] };
async function refreshRoster(){
  try { const r = await fetch(`${BACKEND}/players.json?t=${Date.now()}`); if (r.ok) rosterCache = await r.json(); } catch {}
}
function loadRoster(){ return rosterCache; }

async function loadDDragon(){
  const ver = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
  const base = `https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US`;
  const [rr, champ, summ] = await Promise.all([
    (await fetch(`${base}/runesReforged.json`)).json(),
    (await fetch(`${base}/champion.json`)).json(),
    (await fetch(`${base}/summoner.json`)).json(),
  ]);
  const runeById = {}, champById = {}, spellByKey = {};
  rr.forEach(s => { runeById[s.id] = { icon: s.icon, name: s.name };
    s.slots.forEach(sl => sl.runes.forEach(r => { runeById[r.id] = { icon: r.icon, name: r.name }; })); });
  for (const k in champ.data){ const c = champ.data[k]; champById[c.key] = { id: c.id, name: c.name }; }
  for (const k in summ.data){ const s = summ.data[k]; spellByKey[s.key] = s.id; }
  return { ver, runeById, champById, spellByKey };
}
async function leagueByPuuid(puuid){
  if (!KEY || !puuid || puuid.length < 10) return null;
  try { const r = await fetch(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`, { headers: { 'X-Riot-Token': KEY } });
    if (!r.ok) return null; const arr = await r.json();
    return Array.isArray(arr) ? arr.find(e => e.queueType === 'RANKED_SOLO_5x5') : null; } catch { return null; }
}
async function spectator(puuid){
  if (!KEY) return null;
  try { const r = await fetch(`https://${PLATFORM}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}`, { headers: { 'X-Riot-Token': KEY } }); return r.ok ? r.json() : null; } catch { return null; }
}
const TIER_LABEL = { CHALLENGER:'Challenger', GRANDMASTER:'Grandmaster', MASTER:'Master', DIAMOND:'Diamond', EMERALD:'Emerald', PLATINUM:'Platinum', GOLD:'Gold', SILVER:'Silver', BRONZE:'Bronze', IRON:'Iron' };
function rankText(entry){
  if (!entry) return { tier:'UNRANKED', label:'Unranked' };
  const tier = entry.tier; const div = NO_DIV.has(tier) ? '' : ' ' + entry.rank;
  return { tier, label: `${TIER_LABEL[tier] || tier}${div} · ${entry.leaguePoints} LP` };
}
async function accountPuuid(gameName, tagLine){
  if (!KEY) return null;
  try { const r = await fetch(`https://${CLUSTER}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, { headers: { 'X-Riot-Token': KEY } });
    return r.ok ? (await r.json()).puuid : null; } catch { return null; }
}
// Devuelve una partida con el MISMO formato que el Live Games de la web.
async function buildMatchup(spec, myPuuid, roster){
  const rosterByRid = new Map((roster.players || []).map((p, i) => [p.rid, i + 1]));
  const rows = { 100: [], 200: [] };
  for (const p of spec.participants){
    const ks = p.perks && p.perks.perkIds && p.perks.perkIds[0];
    const entry = await leagueByPuuid(p.puuid); await sleep(120);
    const rid = p.riotId || ''; const h = rid.indexOf('#');
    const gn = h >= 0 ? rid.slice(0, h) : rid, tg = h >= 0 ? rid.slice(h + 1) : '';
    const pos = rosterByRid.get(rid) || null; const rt = rankText(entry);
    (rows[p.teamId] || (rows[p.teamId] = [])).push({
      championImg: DD.champById[p.championId] && DD.champById[p.championId].id,
      champion: (DD.champById[p.championId] && DD.champById[p.championId].name) || '',
      spell1: DD.spellByKey[p.spell1Id] || null, spell2: DD.spellByKey[p.spell2Id] || null,
      runeIcon: DD.runeById[ks] && DD.runeById[ks].icon,
      name: gn, tag: tg, tier: rt.tier, rankLabel: rt.label,
      tracked: !!pos, position: pos, isMe: p.puuid === myPuuid,
    });
  }
  const bans = { 100: [], 200: [] };
  (spec.bannedChampions || []).forEach(b => { if (b.championId > 0 && bans[b.teamId]) bans[b.teamId].push(DD.champById[b.championId] && DD.champById[b.championId].id); });
  const blue = rows[100] || [], red = rows[200] || [];
  const tracked = [...blue, ...red].filter(r => r.tracked);
  const mainTier = tracked[0] ? tracked[0].tier : 'UNRANKED';
  return {
    elo: HIGH.has(mainTier) ? 'HIGH ELO' : 'LOW ELO',
    gameStartTime: spec.gameStartTime || 0, gameLength: spec.gameLength || 0,
    blue, red, bansBlue: bans[100], bansRed: bans[200],
    tracked: tracked.map(r => ({ nm: r.name, position: r.position })),
  };
}

// ---- Ventanas ----
let win, shellWin, bigWin, bsWin;
function baseWin(w, h, x, y, show = true){
  return new BrowserWindow({ width: w, height: h, x, y, show,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false } });
}
function defaults(){ const wa = screen.getPrimaryDisplay().workArea; const M = 16;
  return { wa, M, smallX: wa.x + wa.width - 340 - M, smallY: wa.y + M, shellX: wa.x + wa.width - 250 - M, shellY: wa.y + M + 150 }; }
function createWindows(){
  const d = defaults();
  win = baseWin(340, 130, d.smallX, d.smallY); win.setAlwaysOnTop(true, 'screen-saver'); win.loadFile(path.join(__dirname, 'overlay.html'));
  shellWin = baseWin(250, 130, d.shellX, d.shellY); shellWin.setAlwaysOnTop(true, 'screen-saver'); shellWin.loadFile(path.join(__dirname, 'shells.html'));
  const BW = 1200, BH = 780;
  bigWin = baseWin(BW, BH, Math.round(d.wa.x + (d.wa.width - BW) / 2), Math.round(d.wa.y + (d.wa.height - BH) / 2), false);
  bigWin.setAlwaysOnTop(true, 'screen-saver'); bigWin.loadFile(path.join(__dirname, 'panel.html'));
  // Ventana de evento Blue Shell (ruleta fuera de partida / notificación en partida)
  bsWin = baseWin(680, 380, Math.round(d.wa.x + (d.wa.width - 680) / 2), Math.round(d.wa.y + (d.wa.height - 380) / 2), false);
  bsWin.setAlwaysOnTop(true, 'screen-saver'); bsWin.loadFile(path.join(__dirname, 'bs-event.html'));
}

// Ícono en la bandeja (íconos ocultos) con menú para cerrar el overlay.
let tray;
function createTray(){
  try {
    const raw = nativeImage.createFromPath(path.join(__dirname, 'assets', 'logo.png'));
    tray = new Tray(raw.isEmpty() ? nativeImage.createEmpty() : raw.resize({ width: 18, height: 18 }));
    tray.setToolTip('SoloQ Overlay');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'SoloQ Challenge — Overlay', enabled: false },
      { type: 'separator' },
      { label: 'Panel de la web (Alt+X)', click: () => { if (bigWin) bigWin.isVisible() ? bigWin.hide() : bigWin.show(); } },
      { label: 'Probar Blue Shell (Alt+B)', click: () => showBlueShellEvent({ castigo: 'Autofill', from: 'Prueba' }) },
      { type: 'separator' },
      { label: 'Salir', click: () => app.quit() },
    ]));
    tray.on('double-click', () => { if (win) win.isVisible() ? win.hide() : win.showInactive(); });
  } catch (e) { console.error('tray:', e.message); }
}

// ---- Drag / resize (dirigido a la ventana que envía) ----
ipcMain.on('drag-start', (e, { mx, my }) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return; const b = w.getBounds(); w._d = { dx: mx - b.x, dy: my - b.y }; });
ipcMain.on('drag-move',  (e, { mx, my }) => { const w = BrowserWindow.fromWebContents(e.sender); if (w && w._d) w.setPosition(Math.round(mx - w._d.dx), Math.round(my - w._d.dy)); });
ipcMain.on('drag-end',   (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w._d = null; });
ipcMain.on('resize',     (e, h) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return; const b = w.getBounds(); w.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.max(50, Math.min(900, Math.round(h))) }); });

// ---- Aplicar settings ----
function applyOpacity(){ [win, shellWin, bigWin, bsWin].forEach(w => { if (w) w.setOpacity(settings.opacity); }); }
function applyAlwaysOnTop(){ [win, shellWin, bigWin, bsWin].forEach(w => { if (w) w.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver'); }); }
let smallShown = true, shellShown = true, lastInGame = false;
function applyVis(){
  const okSmall = settings.smallVisible && !(settings.hideOutOfGame && !lastInGame);
  const okShell = settings.shellVisible && !(settings.hideOutOfGame && !lastInGame);
  if (win && okSmall !== smallShown){ smallShown = okSmall; okSmall ? win.showInactive() : win.hide(); }
  if (shellWin && okShell !== shellShown){ shellShown = okShell; okShell ? shellWin.showInactive() : shellWin.hide(); }
}
function applyAutoLaunch(){
  try {
    const opts = { openAtLogin: settings.autoLaunch !== false, args: [] };
    // En el .exe portable, process.execPath es una ruta temporal; usar el exe real.
    if (process.env.PORTABLE_EXECUTABLE_FILE) opts.path = process.env.PORTABLE_EXECUTABLE_FILE;
    app.setLoginItemSettings(opts);
  } catch (e) { dlog('autoLaunch: ' + e.message); }
}
ipcMain.on('setting', (_e, { key, value }) => {
  settings[key] = value; saveSettings();
  if (key === 'opacity') applyOpacity();
  else if (key === 'alwaysOnTop') applyAlwaysOnTop();
  else if (key === 'autoLaunch') applyAutoLaunch();
  else if (key === 'volume') { /* se aplica en el próximo evento de Blue Shell */ }
  else applyVis();
});
ipcMain.on('reset-pos', () => {
  const d = defaults();
  if (win){ win.setPosition(d.smallX, d.smallY); if (!smallShown){ settings.smallVisible = true; } }
  if (shellWin){ shellWin.setPosition(d.shellX, d.shellY); if (!shellShown){ settings.shellVisible = true; } }
  saveSettings(); applyVis();
});
ipcMain.handle('get-settings', () => settings);

// Reporta a la nube el rango del jugador (sacado del cliente vía LCU, GRATIS) y si está en
// partida, para que el runner NO gaste llamadas a la Riot API por este jugador. Máx. 1/min.
let lastReportAt = 0;
async function reportToBackend(riotid, solo, inGame){
  if (!riotid) return;
  if (Date.now() - lastReportAt < 60000) return;
  lastReportAt = Date.now();
  // Solo mandamos "entry" si tenemos rango completo (para no ensuciar el ranking).
  let entry = null;
  if (solo && solo.tier && Number.isFinite(solo.wins) && Number.isFinite(solo.losses)){
    entry = { tier: solo.tier, rank: NO_DIV.has(solo.tier) ? '' : solo.division,
              leaguePoints: solo.leaguePoints || 0, wins: solo.wins, losses: solo.losses, hotStreak: !!solo.isHotStreak };
  }
  try {
    await fetch(`${BACKEND}/api/overlay/report`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ riotid, entry, inGame: !!inGame, secret: CONFIG.reportSecret || undefined }),
    });
  } catch (e) { dlog('report error: ' + (e && e.message)); }
}

async function poll(){
  const roster = loadRoster();
  const creds = getCreds();
  let payload = { connected: false, ddVer: DD && DD.ver, castigos: myCastigosForPopup() };

  try {
    if (creds){
      const me      = await lcu(creds, '/lol-summoner/v1/current-summoner');
      const gsession = await lcu(creds, '/lol-gameflow/v1/session');
      const ranked  = await lcu(creds, '/lol-ranked/v1/current-ranked-stats');
      const solo    = ranked && ranked.queues && ranked.queues.find(q => q.queueType === 'RANKED_SOLO_5x5');

      const queueId = gsession && gsession.gameData && gsession.gameData.queue && gsession.gameData.queue.id;
      const phase = gsession && gsession.phase;
      const inSoloQ = queueId === 420 && phase === 'InProgress';

      const myRid = (me && !me.error) ? `${me.gameName}#${me.tagLine}` : null;
      if (myRid !== myRidForShells) dlog('myRid = ' + myRid);
      myRidForShells = myRid;
      const players = roster.players || [];
      const idx = players.findIndex(p => p.rid === myRid);
      const standing = idx >= 0 ? players[idx] : null;
      const tier = (solo && solo.tier) || (standing && standing.tier) || 'UNRANKED';

      Object.assign(payload, {
        connected: true, name: me && me.gameName,
        tier, div: (solo && !NO_DIV.has(solo.tier)) ? solo.division : '',
        lp: (solo && solo.leaguePoints) != null ? solo.leaguePoints : (standing ? standing.lp : 0),
        pos: idx >= 0 ? idx + 1 : null, elo: HIGH.has(tier) ? 'HIGH' : 'LOW',
        session: (standing && standing.session) || { w: 0, l: 0, lp: 0 },
        torneo: { w: standing ? standing.w : 0, l: standing ? standing.l : 0 },
        recent: (standing && standing.recent) || [],
        // Objetivo: jugador justo arriba en la ladder + LP para alcanzarlo (null si es #1)
        target: idx > 0 ? { name: players[idx - 1].nm, lp: Math.max(0, absLP(players[idx - 1]) - absLP(standing)) } : null,
        matchup: null,
      });

      lastInGame = inSoloQ;
      reportToBackend(myRid, solo, inSoloQ);   // manda rango/estado a la nube (ahorra API)
      if (inSoloQ && DD && KEY && me && me.gameName){
        if (!myApiPuuid) myApiPuuid = await accountPuuid(me.gameName, me.tagLine);
        if (!cachedMatchup && myApiPuuid){
          const spec = await spectator(myApiPuuid);
          if (spec && spec.gameQueueConfigId === 420) cachedMatchup = await buildMatchup(spec, myApiPuuid, roster);
        }
        payload.matchup = cachedMatchup;
        if (cachedMatchup){
          const mySide = cachedMatchup.blue.some(r => r.isMe) ? cachedMatchup.blue : cachedMatchup.red;
          payload.challengeInGame = [...cachedMatchup.blue, ...cachedMatchup.red]
            .filter(r => r.tracked && !r.isMe)
            .map(r => ({ name: r.name, ally: mySide.includes(r) }));
        }
      } else {
        cachedMatchup = null;
      }
    } else { lastInGame = false; }
  } catch (e) { payload = { connected: false, error: String(e.message || e), castigos: [] }; lastInGame = false; }

  applyVis();
  [win, shellWin, bigWin].forEach(w => { if (w && !w.isDestroyed()) w.webContents.send('data', payload); });
}

// ---- Blue Shells recibidas: ruleta (fuera de partida) / notificación (en partida) ----
ipcMain.on('bs-done', () => { if (bsWin && !bsWin.isDestroyed()) bsWin.hide(); });
function showBlueShellEvent(s){
  if (!bsWin || bsWin.isDestroyed()){ dlog('showBlueShellEvent: bsWin no disponible'); return; }
  const d = defaults();
  const mode = lastInGame ? 'notif' : 'roulette';
  dlog(`showBlueShellEvent: ${s.from} → ${s.castigo} (${mode})`);
  if (mode === 'roulette'){ const W = 680, H = 380; bsWin.setBounds({ x: Math.round(d.wa.x + (d.wa.width - W) / 2), y: Math.round(d.wa.y + (d.wa.height - H) / 2), width: W, height: H }); }
  else { const W = 360, H = 110; bsWin.setBounds({ x: d.wa.x + d.wa.width - W - 16, y: d.wa.y + 140, width: W, height: H }); }
  bsWin.showInactive();
  // "Campeón aleatorio" -> icono del campeón. "Clase de campeón aleatoria" -> etiqueta en español (sin icono).
  const isChamp = s.castigo === 'Campeón aleatorio';
  const champ = extraLabel(s.castigo, s.extra);
  const champIcon = (isChamp && s.extra && DD) ? `https://ddragon.leagueoflegends.com/cdn/${DD.ver}/img/champion/${s.extra}.png` : null;
  bsWin.webContents.send('bs-event', { mode, castigo: s.castigo, from: s.from || 'Alguien', champ, champIcon, volume: settings.volume != null ? settings.volume : 0.8 });
}
async function pollShells(){
  if (!bsWin) return;
  if (!myRidForShells){ dlog('pollShells: sin myRid (¿LoL abierto en tu cuenta registrada?)'); return; }
  try {
    const r = await fetch(`${BACKEND}/api/overlay/shells?riotid=${encodeURIComponent(myRidForShells)}`);
    if (!r.ok){ dlog(`pollShells: HTTP ${r.status} rid=${myRidForShells}`); return; }
    const shells = await r.json();
    if (!Array.isArray(shells)) return;
    myShells = shells;   // alimenta el popup con tus castigos reales
    // Solo las recibidas DESPUÉS de abrir el overlay (margen de 60s por desfase de reloj) y no mostradas aún.
    const nuevas = shells
      .filter(s => !shownShellIds.has(s.id) && new Date(s.created_at).getTime() > OVERLAY_START - 60000)
      .sort((a, b) => a.id - b.id);
    if (!nuevas.length) return;
    dlog(`pollShells: rid=${myRidForShells} nuevas=${nuevas.map(s => s.id + ':' + s.castigo).join(', ')} inGame=${lastInGame}`);
    nuevas.forEach((s, i) => { shownShellIds.add(s.id); setTimeout(() => showBlueShellEvent(s), i * 12000); });
    settings.shownShellIds = [...shownShellIds].slice(-80); saveSettings();
  } catch (e) { dlog('pollShells error: ' + (e && e.message)); }
}

app.whenReady().then(async () => {
  createWindows();
  createTray();
  applyOpacity(); applyAlwaysOnTop(); applyAutoLaunch();
  if (!settings.smallVisible){ smallShown = false; win.hide(); }
  if (!settings.shellVisible){ shellShown = false; shellWin.hide(); }
  try { DD = await loadDDragon(); } catch (e) { console.error('DDragon falló:', e.message); }
  globalShortcut.register('Alt+X', () => { if (bigWin) bigWin.isVisible() ? bigWin.hide() : bigWin.show(); });
  // Alt+B: probar el evento de Blue Shell recibida (ruleta si estás fuera de partida, notif si estás dentro)
  globalShortcut.register('Alt+B', () => {
    const cs = ['Sin Flash','Autofill','Campeón aleatorio','Sin pociones ni pinks','Clase de campeón aleatoria','Sin botas y sin pies veloces'];
    const castigo = cs[Math.floor(Math.random() * cs.length)];
    // extra de prueba para ver la insignia (campeón / clase)
    const extra = castigo === 'Campeón aleatorio' ? 'Yuumi' : castigo === 'Clase de campeón aleatoria' ? 'Tank' : null;
    showBlueShellEvent({ castigo, from: 'Prueba', extra });
  });
  console.log('✔ Overlay listo. Alt+X = panel · Alt+B = probar Blue Shell.' + (KEY ? '' : '  (sin Riot key: rango/runas deshabilitados)'));
  await refreshRoster();
  poll();
  setInterval(poll, 3000);
  setInterval(refreshRoster, 30000);
  pollShells();
  setInterval(pollShells, 12000);   // revisa Blue Shells recibidas cada 12s
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
