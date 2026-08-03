/* ============================================================
   liveclient.js — Live Client Data API de Riot (local, puerto 2999).
   Solo responde cuando estás DENTRO de una partida.
   Da: los 10 jugadores, campeones, KDA, CS, oro, eventos en vivo.
   ============================================================ */
const https = require('https');

function liveClient(path = '/liveclientdata/allgamedata'){
  return new Promise(resolve => {
    const req = https.request(
      { hostname: '127.0.0.1', port: 2999, path, method: 'GET', rejectUnauthorized: false },
      res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }
    );
    req.on('error', () => resolve(null));          // no hay partida activa
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

module.exports = { liveClient };
