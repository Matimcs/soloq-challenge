/* ============================================================
   lcu.js — Conexión directa al League Client (LCU). SIN Overwolf.
   ------------------------------------------------------------
   El LCU es la API local del cliente de escritorio de LoL.
   Da: LP/rango exacto, runas, roles en cola, champ select, etc.
   Autenticación: usuario "riot" + un token que expone el cliente,
   sobre https local con certificado self-signed.
   ============================================================ */
const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');

// Rutas comunes del lockfile (Windows). LOL_DIR permite forzar una.
const COMMON = [
  'C:/Riot Games/League of Legends/lockfile',
  'D:/Riot Games/League of Legends/lockfile',
  'C:/Program Files/Riot Games/League of Legends/lockfile',
  'C:/Program Files (x86)/Riot Games/League of Legends/lockfile',
];

// lockfile: "LeagueClient:pid:port:password:protocol"
function parseLock(text){
  const parts = text.trim().split(':');
  return { port: Number(parts[2]), password: parts[3], protocol: parts[4] || 'https' };
}

function viaLockfile(){
  const extra = process.env.LOL_DIR ? [process.env.LOL_DIR.replace(/[\\/]+$/,'') + '/lockfile'] : [];
  for (const p of [...extra, ...COMMON]) {
    try { if (fs.existsSync(p)) return parseLock(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return null;
}

// Fallback: lee los args del proceso LeagueClientUx.exe (no depende de la ruta de instalación)
function viaProcess(){
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ? Name -eq LeagueClientUx.exe | % CommandLine"',
      { encoding: 'utf8' });
    const port  = /--app-port=(\d+)/.exec(out)?.[1];
    const token = /--remoting-auth-token=([\w-]+)/.exec(out)?.[1];
    if (port && token) return { port: Number(port), password: token, protocol: 'https' };
  } catch {}
  return null;
}

function getCreds(){ return viaLockfile() || viaProcess(); }

// Request al LCU. Devuelve el JSON, o { error: <status> } si el endpoint no aplica ahora.
function lcu(creds, path, method = 'GET', body = null){
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: '127.0.0.1', port: creds.port, path, method,
      auth: `riot:${creds.password}`,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      rejectUnauthorized: false,   // cert self-signed del cliente
    }, res => {
      let buf = ''; res.on('data', d => buf += d);
      res.on('end', () => {
        if (res.statusCode >= 400) return resolve({ error: res.statusCode });
        try { resolve(buf ? JSON.parse(buf) : null); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

module.exports = { getCreds, lcu };
