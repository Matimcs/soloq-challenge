/* ============================================================
   background.js — controlador de la app Overwolf (ventana de fondo).
   - Abre la ventana in-game "ingame" cuando entras a League y la cierra al salir.
   - Alt+X (hotkey del manifest) muestra/oculta el overlay.
   La ventana "ingame" es in_game:true → Overwolf la inyecta en el render del
   juego, por eso se captura al compartir la VENTANA de LoL en Discord/OBS.
   ============================================================ */
const LOL_CLASS_ID = 5426;         // League of Legends en Overwolf
const INGAME = 'ingame';
const HOTKEY = 'sqc_toggle';

let ingameVisible = false;

// ---- Helpers de ventanas ----
function obtain(name){
  return new Promise(res => overwolf.windows.obtainDeclaredWindow(name, r => res(r && r.success ? r.window : null)));
}
async function showIngame(){
  const w = await obtain(INGAME); if (!w) return;
  overwolf.windows.restore(w.id, () => { ingameVisible = true; });
}
async function hideIngame(){
  const w = await obtain(INGAME); if (!w) return;
  overwolf.windows.hide(w.id, () => { ingameVisible = false; });
}
function toggleIngame(){ ingameVisible ? hideIngame() : showIngame(); }

// ---- ¿Está corriendo League? ----
function isLoL(info){ return !!(info && info.isRunning && info.classId === LOL_CLASS_ID); }

overwolf.games.onGameInfoUpdated.addListener(e => {
  if (!e || !e.gameInfo) return;
  if (e.gameInfo.classId !== LOL_CLASS_ID) return;
  if (e.runningChanged || e.gameChanged){
    e.gameInfo.isRunning ? showIngame() : hideIngame();
  }
});

// Al arrancar la app, si ya estás en League, muestra el overlay de una.
overwolf.games.getRunningGameInfo(info => { if (isLoL(info)) showIngame(); });

// ---- Hotkey Alt+X ----
overwolf.settings.hotkeys.onPressed.addListener(e => { if (e && e.name === HOTKEY) toggleIngame(); });

// Cierra la app del todo si se cierra la ventana de fondo.
overwolf.windows.onStateChanged.addListener(() => {});
