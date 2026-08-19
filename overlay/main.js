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
const { autoUpdater } = require('electron-updater');

// ---- Una sola instancia ----
// Si ya hay un overlay corriendo, esta segunda instancia se cierra al instante y le
// pide a la primera que muestre el panel (showAll). Evita popups/atajos duplicados.
const hasLock = app.requestSingleInstanceLock();
if (!hasLock){ app.quit(); }
else {
  app.on('second-instance', () => { try { showAll(); } catch {} });
}

const ROSTER_FILE = path.join(__dirname, '..', 'players.json');
const NO_DIV = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const HIGH = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
// Config opcional (para el .exe: sin cmd ni variables de entorno). overlay/config.json:
//   { "riotApiKey": "RGAPI-...", "backend": "https://...onrender.com" }
function loadConfig(){ try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; } }
const CONFIG = loadConfig();
const BACKEND = (process.env.SQC_BACKEND || CONFIG.backend || 'https://soloquchile.cl').replace(/\/+$/, '');
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
let settings = { smallVisible: true, shellVisible: true, opacity: 1, hideOutOfGame: true, alwaysOnTop: true, volume: 0.8, voiceVolume: 0.9, autoLaunch: true, locked: true };
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch {}
function saveSettings(){ try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch {} }

// Log de diagnóstico (en la carpeta de datos del usuario)
let DEBUG_LOG; try { DEBUG_LOG = path.join(app.getPath('userData'), 'overlay-debug.log'); } catch { DEBUG_LOG = path.join(__dirname, 'overlay-debug.log'); }
function dlog(m){ try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${m}\n`); } catch {} }

let DD = null, myRidForShells = null;
const OVERLAY_START = Date.now();
let shownShellIds = new Set(Array.isArray(settings.shownShellIds) ? settings.shownShellIds : []);
let shownMsgIds  = new Set(Array.isArray(settings.shownMsgIds)  ? settings.shownMsgIds  : []);

// El roster/standing se baja del backend (players.json), no de un archivo local:
// así el .exe es independiente y usa datos frescos de la nube.
let rosterCache = { players: [] };
async function refreshRoster(){
  try { const r = await fetch(`${BACKEND}/players.json`); if (r.ok) rosterCache = await r.json(); } catch {}   // URL estable → cacheable en Cloudflare
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
// El scoreboard in-game (matchup de los 10 jugadores con sus rangos) se ELIMINÓ a
// propósito: era lo único que usaba la Riot API key DENTRO del exe. Para eso, quien
// quiera, que use una app aparte tipo Porofessor. La web ya tiene Live Games igual.

// ---- Ventanas ----
let win, shellWin, bigWin, bsWin, msgWin, audioWin, updWin;
function baseWin(w, h, x, y, show = true, focusable = false, opaque = false){
  // opaque=true: ventana NO transparente (fondo sólido). El panel (que embebe la web en un
  // iframe) debe ser opaco: en Windows, una ventana transparente renderiza en NEGRO el
  // contenido remoto de un iframe (bug de compositing de Electron/Chromium).
  return new BrowserWindow({ width: w, height: h, x, y, show,
    frame: false, transparent: !opaque, backgroundColor: opaque ? '#0b0b0b' : undefined,
    resizable: false, alwaysOnTop: true, skipTaskbar: true, focusable, hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false } });
}
function defaults(){ const wa = screen.getPrimaryDisplay().workArea; const M = 16;
  return { wa, M, smallX: wa.x + wa.width - 340 - M, smallY: wa.y + M, shellX: wa.x + wa.width - 278 - M, shellY: wa.y + M + 150 }; }
// Posición recordada (settings.pos[key]) si sigue visible en algún monitor; si no, la de por defecto.
function posFor(key, defX, defY){
  const p = settings.pos && settings.pos[key];
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)){
    const visible = screen.getAllDisplays().some(dsp => {
      const b = dsp.bounds;
      return p.x < b.x + b.width - 40 && p.x + 60 > b.x && p.y < b.y + b.height - 20 && p.y + 30 > b.y;
    });
    if (visible) return { x: Math.round(p.x), y: Math.round(p.y) };
  }
  return { x: defX, y: defY };
}
// No persistir posiciones hasta que se hayan RESTAURADO las guardadas (evita que, al
// arrancar con el PC —cuando los monitores aún no están listos— un 'moved' espurio
// sobrescriba la buena posición con la de por defecto).
let posReady = false;
function savePos(w){
  if (!posReady) return;
  if (!w || !w._posKey || w.isDestroyed()) return;
  const b = w.getBounds();
  settings.pos = settings.pos || {};
  settings.pos[w._posKey] = { x: b.x, y: b.y, w: b.width, h: b.height };   // w/h se usa para la ruleta (bs)
  saveSettings();
}
// Guarda la posición también con el evento nativo 'moved' (además del drag-end por IPC),
// por si se pierde el mouseup al soltar sobre el juego u otra ventana. Debounced para no
// escribir el archivo en cada píxel del arrastre.
function trackMoves(w){ let t; w.on('moved', () => { clearTimeout(t); t = setTimeout(() => savePos(w), 350); }); }
// Deja un punto dentro de algún monitor: si ya es visible lo respeta; si no (monitor
// desconectado) lo mete al área de trabajo primaria en vez de mandarlo a la esquina.
function clampToDisplays(x, y, w = 60, h = 30){
  const vis = screen.getAllDisplays().some(d => { const b = d.workArea;
    return x < b.x + b.width - 40 && x + w > b.x && y < b.y + b.height - 20 && y + h > b.y; });
  if (vis) return { x: Math.round(x), y: Math.round(y) };
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - w)),
           y: Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - h)) };
}
// Reaplica las posiciones guardadas a cada ventana. Se llama tras el arranque (cuando los
// monitores ya están listos) y cuando cambia la configuración de pantallas.
function restorePositions(){
  for (const [w, key] of [[win, 'small'], [shellWin, 'shell'], [bigWin, 'big']]){
    if (!w || w.isDestroyed()) continue;
    const p = settings.pos && settings.pos[key];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)){
      const pt = clampToDisplays(p.x, p.y);
      const b = w.getBounds();
      if (b.x !== pt.x || b.y !== pt.y) w.setPosition(pt.x, pt.y);
    }
  }
}
function createWindows(){
  const d = defaults();
  const sp = posFor('small', d.smallX, d.smallY);
  win = baseWin(340, 130, sp.x, sp.y); win._posKey = 'small'; win.setAlwaysOnTop(true, 'screen-saver'); win.loadFile(path.join(__dirname, 'overlay.html'));
  const shp = posFor('shell', d.shellX, d.shellY);
  shellWin = baseWin(278, 150, shp.x, shp.y); shellWin._posKey = 'shell'; shellWin.setAlwaysOnTop(true, 'screen-saver'); shellWin.loadFile(path.join(__dirname, 'shells.html'));
  const BW = 1200, BH = 780;
  // El panel es ENFOCABLE (a diferencia de los overlays chicos): así se puede escribir en
  // los campos de la web (login, tickets, etc.).
  const bp = posFor('big', Math.round(d.wa.x + (d.wa.width - BW) / 2), Math.round(d.wa.y + (d.wa.height - BH) / 2));
  bigWin = baseWin(BW, BH, bp.x, bp.y, false, true, true); bigWin._posKey = 'big';   // opaco (iframe web)
  bigWin.setAlwaysOnTop(true, 'screen-saver'); bigWin.loadFile(path.join(__dirname, 'panel.html'));
  [win, shellWin, bigWin].forEach(trackMoves);   // recuerda dónde los dejaste
  // Ventana de evento Blue Shell (ruleta fuera de partida / notificación en partida)
  bsWin = baseWin(720, 440, Math.round(d.wa.x + (d.wa.width - 720) / 2), Math.round(d.wa.y + (d.wa.height - 440) / 2), false);
  bsWin._posKey = 'bs'; bsWin.setResizable(true);   // ruleta movible + redimensionable (mín. lo limita el grip)
  bsWin.setAlwaysOnTop(true, 'screen-saver'); bsWin.loadFile(path.join(__dirname, 'bs-event.html'));
  // Notificación de mensaje del admin (abajo-centro): texto y/o voz.
  const MW = 460, MH = 104;
  msgWin = baseWin(MW, MH, Math.round(d.wa.x + (d.wa.width - MW) / 2), d.wa.y + d.wa.height - MH - 46, false);
  msgWin.setAlwaysOnTop(true, 'screen-saver'); msgWin.loadFile(path.join(__dirname, 'message.html'));
  // Ventana OCULTA que solo reproduce audio (voz adjunta a Blue Shells) — sin UI.
  audioWin = new BrowserWindow({ show:false, width:200, height:120, frame:false, skipTaskbar:true, focusable:false,
    webPreferences:{ nodeIntegration:true, contextIsolation:false } });
  audioWin.loadFile(path.join(__dirname, 'audio.html'));
  // Ventana VISIBLE de actualización (abajo-derecha): muestra el progreso del auto-update.
  const UW = 320, UH = 100;
  updWin = baseWin(UW, UH, d.wa.x + d.wa.width - UW - 16, d.wa.y + d.wa.height - UH - 46, false);
  updWin.setAlwaysOnTop(true, 'screen-saver'); updWin.loadFile(path.join(__dirname, 'update.html'));
}
// Muestra/actualiza la ventana de actualización. text = línea de estado; pct = % (o null = sin barra).
function showUpd(text, pct){
  if (!updWin || updWin.isDestroyed()) return;
  if (!updWin.isVisible()) updWin.showInactive();
  updWin.webContents.send('upd', { text, pct });
}
function hideUpd(){ if (updWin && !updWin.isDestroyed()) updWin.hide(); }
// Chequeo de actualización. manual=true (desde la bandeja) muestra también "ya estás al día"
// o el error; el automático solo aparece si hay algo que descargar.
let updManual = false;
function checkUpdates(manual){ if (!app.isPackaged) return; updManual = !!manual; try { autoUpdater.checkForUpdates().catch(() => {}); } catch {} }
function playVoice(dataUrl){
  if (audioWin && !audioWin.isDestroyed()) audioWin.webContents.send('play-audio', { audio: dataUrl, volume: settings.voiceVolume != null ? settings.voiceVolume : 0.9 });
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
      { label: 'Mostrar todo (Alt+X)', click: () => showAll() },
      { label: 'Cerrar overlay', click: () => hideAll() },
      { label: 'Probar Blue Shell (Alt+B)', click: () => showBlueShellEvent({ castigo: 'Autofill', from: 'Prueba' }) },
      { type: 'separator' },
      { label: 'Buscar actualizaciones', click: () => checkUpdates(true) },
      { label: 'Instalar actualización y reiniciar', click: () => { try { autoUpdater.quitAndInstall(); } catch {} } },
      { type: 'separator' },
      { label: 'Salir', click: () => app.quit() },
    ]));
    // Doble-click en la bandeja = mostrar TODO (standing + Blue Shells + panel), aunque estés fuera de partida.
    tray.on('double-click', () => showAll());
  } catch (e) { console.error('tray:', e.message); }
}

// ---- Drag / resize (dirigido a la ventana que envía) ----
ipcMain.on('drag-start', (e, { mx, my }) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return; const b = w.getBounds(); w._d = { dx: mx - b.x, dy: my - b.y }; });
ipcMain.on('drag-move',  (e, { mx, my }) => { const w = BrowserWindow.fromWebContents(e.sender); if (w && w._d) w.setPosition(Math.round(mx - w._d.dx), Math.round(my - w._d.dy)); });
ipcMain.on('drag-end',   (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w){ w._d = null; savePos(w); } });
ipcMain.on('resize',     (e, h) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return; const b = w.getBounds(); w.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.max(50, Math.min(900, Math.round(h))) }); });
// Redimensionado de la ruleta (grip esquina): fija ancho/alto manteniendo la posición.
ipcMain.on('bs-resize',     (e, { w, h }) => { const win = BrowserWindow.fromWebContents(e.sender); if (!win) return; const b = win.getBounds(); win.setBounds({ x: b.x, y: b.y, width: Math.max(320, Math.round(w)), height: Math.max(220, Math.round(h)) }); });
ipcMain.on('bs-resize-end', (e) => { const win = BrowserWindow.fromWebContents(e.sender); if (win) savePos(win); });   // guarda tamaño elegido

// ---- Aplicar settings ----
function applyOpacity(){ [win, shellWin, bigWin, bsWin, msgWin].forEach(w => { if (w) w.setOpacity(settings.opacity); }); }
function applyAlwaysOnTop(){ [win, shellWin, bigWin, bsWin, msgWin].forEach(w => { if (w) w.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver'); }); }
// Candado: cuando está bloqueado, la tarjeta de standing y el popup de Blue Shells son
// "click-through" (el mouse los atraviesa hacia el juego), así no los mueves sin querer al
// jugar. Al desbloquear (ajustes) vuelven a ser arrastrables para reposicionarlos.
// OJO: sin { forward:true }. Ese "forward" reenvía TODOS los eventos de mouse y hace que el
// cursor se trabe/freezee cada pocos segundos en Windows (bug conocido de Electron). No hace
// falta: las tarjetas son solo informativas (no necesitan hover). Bloqueado = click-through puro.
function applyLock(){ [win, shellWin].forEach(w => { if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(!!settings.locked); }); }
let smallShown = true, shellShown = true, lastInGame = false;
// Override manual: al hacer doble-click en la bandeja (o Alt+X) se muestra TODO aunque
// estés fuera de partida; al cerrar (Alt+X / botón ✕) se apaga y vuelve a mandar la config.
let forceShowAll = false;
function applyVis(){
  // Regla fija: la tarjeta de standing y el popup de Blue Shells SOLO se ven en partida,
  // salvo que se pida mostrar todo a mano (doble-click en bandeja / Alt+X).
  const okSmall = forceShowAll || (settings.smallVisible && lastInGame);
  const okShell = forceShowAll || (settings.shellVisible && lastInGame);
  if (win && okSmall !== smallShown){ smallShown = okSmall; okSmall ? win.showInactive() : win.hide(); }
  if (shellWin && okShell !== shellShown){ shellShown = okShell; okShell ? shellWin.showInactive() : shellWin.hide(); }
}
// Mostrar todo (tarjeta de standing + popup de Blue Shells + panel de la web).
function showAll(){
  forceShowAll = true;
  applyVis();
  if (bigWin && !bigWin.isDestroyed()){ bigWin.setAlwaysOnTop(true, 'screen-saver'); bigWin.show(); bigWin.moveTop(); bigWin.focus(); }
}
// Cerrar todo el overlay (respeta de nuevo la config: fuera de partida vuelve a ocultarse).
function hideAll(){
  forceShowAll = false;
  if (bigWin && !bigWin.isDestroyed()) bigWin.hide();
  applyVis();
}
function toggleAll(){ (forceShowAll || (bigWin && bigWin.isVisible())) ? hideAll() : showAll(); }
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
  else if (key === 'locked') applyLock();
  else if (key === 'alwaysOnTop') applyAlwaysOnTop();
  else if (key === 'autoLaunch') applyAutoLaunch();
  else if (key === 'volume') { /* se aplica en el próximo evento de Blue Shell */ }
  else applyVis();
});
ipcMain.on('reset-pos', () => {
  const d = defaults();
  settings.pos = {};   // olvida las posiciones recordadas
  if (win){ win.setPosition(d.smallX, d.smallY); if (!smallShown){ settings.smallVisible = true; } }
  if (shellWin){ shellWin.setPosition(d.shellX, d.shellY); if (!shellShown){ settings.shellVisible = true; } }
  if (bigWin){ const BW=1200, BH=780; bigWin.setPosition(Math.round(d.wa.x + (d.wa.width - BW) / 2), Math.round(d.wa.y + (d.wa.height - BH) / 2)); }
  saveSettings(); applyVis();
});
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('get-version', () => { try { return app.getVersion(); } catch { return '?'; } });
ipcMain.on('check-updates', () => checkUpdates(true));   // botón "Buscar actualizaciones" del panel
ipcMain.on('close-all', () => hideAll());   // botón ✕ del panel

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

      // ¿Hay jugadores del torneo en tu partida? Se detecta con la Live Client Data API
      // (local, en 127.0.0.1:2999, SIN Riot key) cruzando los 10 con el roster. Aliado/rival
      // según el equipo respecto al tuyo. Solo responde cuando ya estás dentro del juego.
      if (inSoloQ){
        try {
          const live = await liveClient();
          const all = live && Array.isArray(live.allPlayers) ? live.allPlayers : null;
          if (all){
            const ridOf = p => (p.riotId || p.summonerName || '').toLowerCase();
            const meId = ((live.activePlayer && (live.activePlayer.riotId || live.activePlayer.summonerName)) || myRid || '').toLowerCase();
            const meP = all.find(p => ridOf(p) === meId);
            const myTeam = meP ? meP.team : null;
            const rosterNick = {};
            (roster.players || []).forEach(p => { rosterNick[(p.rid || '').toLowerCase()] = p.nm || (p.rid || '').split('#')[0]; });
            payload.challengeInGame = all
              .filter(p => { const r = ridOf(p); return r && r !== meId && rosterNick[r] !== undefined; })
              .map(p => ({ name: rosterNick[ridOf(p)], ally: myTeam != null && p.team === myTeam }));
          }
        } catch {}
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
  if (mode === 'roulette'){
    // Usa el tamaño/posición que dejaste (settings.pos.bs); si no, centrado por defecto.
    const sp = (settings.pos && settings.pos.bs) || {};
    const W = Number.isFinite(sp.w) ? sp.w : 560, H = Number.isFinite(sp.h) ? sp.h : 320;
    const pos = posFor('bs', Math.round(d.wa.x + (d.wa.width - W) / 2), Math.round(d.wa.y + (d.wa.height - H) / 2));
    bsWin.setBounds({ x: pos.x, y: pos.y, width: W, height: H });
  } else { const W = 360, H = 110; bsWin.setBounds({ x: d.wa.x + d.wa.width - W - 16, y: d.wa.y + 140, width: W, height: H }); }
  bsWin.showInactive();
  // "Campeón aleatorio" -> icono del campeón. "Clase de campeón aleatoria" -> etiqueta en español (sin icono).
  const isChamp = s.castigo === 'Campeón aleatorio';
  const champ = extraLabel(s.castigo, s.extra);
  const champIcon = (isChamp && s.extra && DD) ? `https://ddragon.leagueoflegends.com/cdn/${DD.ver}/img/champion/${s.extra}.png` : null;
  bsWin.webContents.send('bs-event', { mode, castigo: s.castigo, from: s.from || 'Alguien', champ, champIcon, volume: settings.volume != null ? settings.volume : 0.8 });
  // Voz opcional adjunta a la shell: solo suena (sin UI), tras el reveal de la ruleta.
  if (s.audio) setTimeout(() => playVoice(s.audio), mode === 'roulette' ? 4300 : 500);
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

// ---- Mensajes del admin (texto y/o voz) -> notificación abajo-centro ----
ipcMain.on('msg-done', () => { if (msgWin && !msgWin.isDestroyed()) msgWin.hide(); });
function showAdminMessage(m){
  if (!msgWin || msgWin.isDestroyed()) return;
  const d = defaults();
  const MW = 460, MH = 104;
  msgWin.setBounds({ x: Math.round(d.wa.x + (d.wa.width - MW) / 2), y: d.wa.y + d.wa.height - MH - 46, width: MW, height: MH });
  msgWin.showInactive();
  msgWin.webContents.send('admin-msg', { text: m.text || '', audio: m.audio || null, volume: settings.voiceVolume != null ? settings.voiceVolume : 0.9 });
  dlog('admin-msg mostrado: ' + (m.text ? m.text.slice(0, 40) : '(voz)'));
}
async function pollMessages(){
  if (!msgWin || !myRidForShells) return;
  try {
    const r = await fetch(`${BACKEND}/api/overlay/messages?riotid=${encodeURIComponent(myRidForShells)}`);
    if (!r.ok) return;
    const msgs = await r.json();
    if (!Array.isArray(msgs)) return;
    const nuevas = msgs
      .filter(m => !shownMsgIds.has(m.id) && new Date(m.created_at).getTime() > OVERLAY_START - 60000)
      .sort((a, b) => a.id - b.id);
    if (!nuevas.length) return;
    dlog(`pollMessages: nuevas=${nuevas.map(m => m.id).join(',')}`);
    nuevas.forEach((m, i) => { shownMsgIds.add(m.id); setTimeout(() => showAdminMessage(m), i * 10000); });
    settings.shownMsgIds = [...shownMsgIds].slice(-80); saveSettings();
  } catch (e) { dlog('pollMessages error: ' + (e && e.message)); }
}

if (hasLock) app.whenReady().then(async () => {
  createWindows();
  createTray();
  applyOpacity(); applyAlwaysOnTop(); applyAutoLaunch(); applyLock();
  // Arranca oculto (aún no estás en partida). applyVis los mostrará al entrar a una SoloQ.
  smallShown = false; win.hide();
  shellShown = false; shellWin.hide();
  // Restaura las posiciones guardadas cuando los monitores ya están listos (al reiniciar el
  // PC la app arranca antes de que Windows reporte las pantallas → sin esto se iban al
  // default). Recién ahí se habilita el guardado, para no pisar la posición buena.
  const doRestore = () => restorePositions();
  setTimeout(() => { restorePositions(); posReady = true; }, 1500);
  screen.on('display-metrics-changed', doRestore);
  screen.on('display-added', doRestore);
  screen.on('display-removed', doRestore);
  try { DD = await loadDDragon(); } catch (e) { console.error('DDragon falló:', e.message); }
  // Atajo para mostrar/cerrar TODO el overlay. Alt+X es el principal; si otra app (o el
  // cliente de LoL) lo tiene tomado, el registro falla en silencio y el atajo "no funciona
  // en juego" — por eso probamos respaldos hasta que uno quede registrado.
  const HOTKEYS = ['Alt+X', 'Alt+Shift+X', 'Control+Shift+X', 'Control+Alt+X'];
  let activeHotkey = null;
  for (const acc of HOTKEYS){ if (globalShortcut.register(acc, () => toggleAll())){ activeHotkey = acc; break; } }
  dlog('Atajo panel registrado: ' + (activeHotkey || 'NINGUNO (todos ocupados)'));
  if (tray) tray.setToolTip('SoloQ Overlay — ' + (activeHotkey ? activeHotkey.replace('Control','Ctrl') + ' = panel' : 'sin atajo'));
  // Alt+B: probar el evento de Blue Shell recibida (ruleta si estás fuera de partida, notif si estás dentro)
  globalShortcut.register('Alt+B', () => {
    const cs = ['Sin Flash','Autofill','Campeón aleatorio','Sin pociones ni pinks','Clase de campeón aleatoria','Sin botas y sin pies veloces'];
    const castigo = cs[Math.floor(Math.random() * cs.length)];
    // extra de prueba para ver la insignia (campeón / clase)
    const extra = castigo === 'Campeón aleatorio' ? 'Yuumi' : castigo === 'Clase de campeón aleatoria' ? 'Tank' : null;
    showBlueShellEvent({ castigo, from: 'Prueba', extra });
  });
  // ---- Auto-actualización VISIBLE (electron-updater vía GitHub Releases público) ----
  // Muestra el progreso en una ventana (no en 2do plano) e instala apenas termina de bajar.
  if (app.isPackaged){
    try {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('checking-for-update', () => { if (updManual) showUpd('Buscando actualización…', null); });
      autoUpdater.on('update-available', i => { dlog('update disponible: ' + (i && i.version));
        showUpd('Actualización ' + (i && i.version ? 'v' + i.version : '') + ' — descargando…', 0); });
      autoUpdater.on('update-not-available', () => { dlog('sin updates');
        if (updManual){ showUpd('Ya tienes la última versión ✓', null); setTimeout(hideUpd, 4000); } updManual = false; });
      autoUpdater.on('download-progress', p => showUpd('Descargando actualización… ' + Math.round(p.percent) + '%', p.percent));
      autoUpdater.on('update-downloaded', i => { dlog('update descargada: ' + (i && i.version));
        showUpd('Actualización lista — reiniciando…', 100);
        setTimeout(() => { try { autoUpdater.quitAndInstall(); }
          catch (e){ dlog('quitAndInstall: ' + (e && e.message)); showUpd('Listo. Cierra y abre la app para aplicar la actualización.', null); } }, 2500); });
      autoUpdater.on('error', e => { dlog('updater error: ' + (e && e.message));
        if (updManual){ showUpd('No se pudo actualizar: ' + (e && e.message ? e.message.slice(0, 50) : 'error'), null); setTimeout(hideUpd, 6000); } updManual = false; });
      checkUpdates(false);
      setInterval(() => checkUpdates(false), 15 * 60 * 1000);   // revisa cada 15 min (beta: updates frecuentes)
    } catch (e) { dlog('updater init: ' + (e && e.message)); }
  }
  console.log('✔ Overlay listo. Alt+X = panel · Alt+B = probar Blue Shell.');
  await refreshRoster();
  poll();
  setInterval(poll, 3000);
  setInterval(refreshRoster, 30000);
  pollShells();
  setInterval(pollShells, 12000);   // revisa Blue Shells recibidas cada 12s
  pollMessages();
  setInterval(pollMessages, 8000);  // revisa mensajes del admin cada 8s
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
