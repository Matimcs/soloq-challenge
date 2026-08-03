/* ============================================================
   runner.js — Re-corre fetch-data.js en loop (auto-refresh).
   Uso:  RIOT_API_KEY=xxxx node runner.js
   Intervalo configurable:  INTERVAL_SEC=90 (por defecto 90s).
   Cada corrida es un proceso fresco (limpio); el caché en disco
   hace que las corridas siguientes sean baratas.
   ============================================================ */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const INTERVAL = (Number(process.env.INTERVAL_SEC) || 90) * 1000;

function runOnce(){
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(__dirname, 'fetch-data.js')],
      { stdio: 'inherit', env: process.env });
    p.on('exit', code => resolve(code));
  });
}

// Empuja players.json al server online (si está configurado) para mantener
// vivo el ranking del sitio desplegado. Sin INGEST_URL/SECRET no hace nada.
async function pushToServer(){
  const url = process.env.INGEST_URL, secret = process.env.INGEST_SECRET;
  if (!url || !secret) return;
  try {
    const body = fs.readFileSync(path.join(__dirname, 'players.json'), 'utf8');
    const r = await fetch(url.replace(/\/+$/, '') + '/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-secret': secret },
      body,
    });
    console.log(r.ok ? '   ↑ ranking enviado al server online' : `   ⚠ ingest respondió HTTP ${r.status}`);
  } catch (e) { console.log('   ⚠ no se pudo enviar al server online: ' + e.message); }
}

(async () => {
  if (!process.env.RIOT_API_KEY){ console.error('Falta RIOT_API_KEY'); process.exit(1); }
  console.log(`▶ Runner activo — refresca cada ${INTERVAL / 1000}s. Ctrl+C para parar.\n`);
  if (process.env.INGEST_URL) console.log(`   (empujando ranking a ${process.env.INGEST_URL})\n`);
  for (;;){
    const t = Date.now();
    await runOnce();
    await pushToServer();
    const wait = Math.max(0, INTERVAL - (Date.now() - t));
    console.log(`\n… próxima actualización en ${Math.round(wait / 1000)}s\n`);
    await new Promise(r => setTimeout(r, wait));
  }
})();
