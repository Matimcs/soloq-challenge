/* ============================================================
   granter.js — Otorga Blue Shells automáticamente por logros en SoloQ.
   Escanea las partidas NUEVAS (posteriores a la activación) de cada usuario
   registrado y entrega shells según las reglas de normas.html.

   NO es retroactivo: la primera vez que ve a un usuario fija una "línea base"
   (su última partida) y solo cuenta lo que juegue desde ese momento. Así no
   reparte un aluvión de shells por el historial viejo.

   Requiere RIOT_API_KEY (la misma del runner/checker).
   ============================================================ */
const CLUSTER = 'americas';
const MAX_SHELLS = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function riot(url, KEY){
  try { const r = await fetch(url, { headers:{ 'X-Riot-Token':KEY } }); return r.ok ? r.json() : null; } catch { return null; }
}
const puuidCache = {};
async function getPuuid(riotid, KEY){
  if (puuidCache[riotid]) return puuidCache[riotid];
  const h = riotid.indexOf('#'); if (h < 0) return null;
  const gn = riotid.slice(0, h), tg = riotid.slice(h + 1);
  const a = await riot(`https://${CLUSTER}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gn)}/${encodeURIComponent(tg)}`, KEY);
  if (a && a.puuid){ puuidCache[riotid] = a.puuid; return a.puuid; }
  return null;
}

// Otorga n shells a userId respetando el máximo (las de más se pierden). Devuelve cuántas entraron.
async function award(q, userId, n, motivo){
  let given = 0;
  for (let i = 0; i < n; i++){
    const c = await q('SELECT COUNT(*)::int AS c FROM shells WHERE owner_id=$1', [userId]);
    if (c[0].c >= MAX_SHELLS) break;
    await q('INSERT INTO shells (owner_id,motivo) VALUES ($1,$2)', [userId, motivo]);
    given++;
  }
  // Registro permanente de "conseguidas" (aunque el inventario esté lleno, cuenta el logro).
  if (n > 0) { try { await q('INSERT INTO shell_log (user_id,motivo) VALUES ($1,$2)', [userId, motivo]); } catch {} }
  if (given) console.log(`🛡 +${given} Blue Shell(s) a user ${userId} — ${motivo}`);
  return given;
}

// Máximo déficit de oro que tuvo MI equipo durante la partida (para el comeback).
function teamGoldDeficitMax(tl, myPid){
  if (!tl || !tl.info || !Array.isArray(tl.info.frames)) return 0;
  const mine  = myPid <= 5 ? [1,2,3,4,5] : [6,7,8,9,10];
  const enemy = myPid <= 5 ? [6,7,8,9,10] : [1,2,3,4,5];
  let maxDef = 0;
  for (const fr of tl.info.frames){
    const pf = fr.participantFrames || {};
    let g = 0, e = 0;
    for (const id of mine)  g += (pf[id] && pf[id].totalGold) || 0;
    for (const id of enemy) e += (pf[id] && pf[id].totalGold) || 0;
    if (e - g > maxDef) maxDef = e - g;
  }
  return maxDef;
}

async function runGrant({ q, KEY }){
  if (!KEY) return;
  const users = await q("SELECT id, riotid FROM users WHERE riotid IS NOT NULL AND riotid <> ''");
  if (!users.length) return;

  // Mapa puuid -> userId de TODOS los registrados (para "robar shell al ganar a un rival").
  const puuidToUser = {};
  for (const u of users){
    const p = await getPuuid(u.riotid, KEY); await sleep(80);
    if (p) puuidToUser[p] = u.id;
  }

  for (const u of users){
    try {
      const puuid = await getPuuid(u.riotid, KEY); if (!puuid) continue;
      const rows = await q('SELECT * FROM shell_progress WHERE user_id=$1', [u.id]);
      let prog = rows[0];

      // Línea base: primera vez -> no repartir retroactivo, solo marcar hasta dónde vamos.
      if (!prog){
        const ids0 = await riot(`https://${CLUSTER}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&count=1`, KEY); await sleep(90);
        let base = Date.now();
        if (Array.isArray(ids0) && ids0[0]){
          const m0 = await riot(`https://${CLUSTER}.api.riotgames.com/lol/match/v5/matches/${ids0[0]}`, KEY); await sleep(90);
          if (m0 && m0.info) base = m0.info.gameEndTimestamp || m0.info.gameStartTimestamp || Date.now();
        }
        await q("INSERT INTO shell_progress (user_id,last_end,streak,champ_wins,castigo_wins) VALUES ($1,$2,0,'[]',0) ON CONFLICT (user_id) DO NOTHING", [u.id, base]);
        continue;
      }

      const lastEnd = Number(prog.last_end) || 0;
      const startSec = lastEnd ? Math.floor(lastEnd / 1000) : Math.floor(Date.now() / 1000) - 3 * 3600;
      const ids = await riot(`https://${CLUSTER}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&startTime=${startSec}&count=10`, KEY); await sleep(90);
      if (!Array.isArray(ids) || !ids.length) continue;

      let streak      = Number(prog.streak) || 0;
      let champWins   = Array.isArray(prog.champ_wins) ? prog.champ_wins.slice() : [];
      let castigoWins = Number(prog.castigo_wins) || 0;
      let newLastEnd  = lastEnd;
      let prevStart   = lastEnd;    // ms; ventana para "victoria con castigo"

      // Riot devuelve del más nuevo al más viejo -> procesamos en orden cronológico.
      for (const id of ids.slice().reverse()){
        const m = await riot(`https://${CLUSTER}.api.riotgames.com/lol/match/v5/matches/${id}`, KEY); await sleep(90);
        if (!m || !m.info) continue;
        const end   = m.info.gameEndTimestamp || m.info.gameStartTimestamp || 0;
        const start = m.info.gameStartTimestamp || end;
        if (end && end <= lastEnd) continue;   // ya procesada en una pasada anterior
        const me = (m.info.participants || []).find(x => x.puuid === puuid);
        if (!me){ if (end > newLastEnd) newLastEnd = end; prevStart = start; continue; }
        const win = !!me.win;
        const dur = m.info.gameDuration || 0;  // segundos

        // ----- Logros de una sola partida -----
        if (me.pentaKills  >= 1) await award(q, u.id, 2, 'Pentakill');
        if (me.quadraKills >= 1) await award(q, u.id, 1, 'Cuádruple asesinato');
        if (me.kills       >= 22) await award(q, u.id, 1, '22 asesinatos en una partida');
        if (me.assists     >= 30) await award(q, u.id, 1, '30 asistencias en una partida');
        if (me.deaths === 0 && (me.kills + me.assists) > 20) await award(q, u.id, 1, 'KDA perfecto superior a 20');
        if (win && dur >= 2400)  await award(q, u.id, 1, 'Victoria de 40+ minutos');

        // ----- Racha de 6 victorias -----
        if (win){ streak++; if (streak >= 6){ await award(q, u.id, 1, 'Racha de 6 victorias'); streak = 0; } }
        else streak = 0;

        if (win){
          // ----- Cada 5 victorias con campeón distinto -----
          if (!champWins.includes(me.championName)){
            champWins.push(me.championName);
            if (champWins.length >= 5){ await award(q, u.id, 1, '5 victorias con campeones distintos'); champWins = []; }
          }

          // ----- Cada 5 victorias jugando con castigo -----
          // (partida = la primera SoloQ tras recibir un castigo: created_at en (partida previa, esta])
          const cw = await q(
            "SELECT COUNT(*)::int AS c FROM events WHERE user_id=$1 AND kind='received' AND created_at > to_timestamp($2/1000.0) AND created_at <= to_timestamp($3/1000.0)",
            [u.id, prevStart, start]);
          if (cw[0].c > 0){ castigoWins++; if (castigoWins >= 5){ await award(q, u.id, 1, '5 victorias jugando con castigo'); castigoWins = 0; } }

          // ----- Comeback de 7.000 de oro (pide la timeline) -----
          const tl = await riot(`https://${CLUSTER}.api.riotgames.com/lol/match/v5/matches/${id}/timeline`, KEY); await sleep(90);
          if (teamGoldDeficitMax(tl, me.participantId) >= 7000) await award(q, u.id, 1, 'Comeback de 7.000 de oro');

          // ----- Robar shell al ganar a un rival del torneo que lleve una -----
          for (const p of (m.info.participants || [])){
            if (p.teamId === me.teamId) continue;              // solo rivales
            const enemyId = puuidToUser[p.puuid];
            if (!enemyId || enemyId === u.id) continue;        // rival registrado (no yo)
            const s = await q('SELECT id FROM shells WHERE owner_id=$1 ORDER BY id LIMIT 1', [enemyId]);
            if (s.length){
              await q('DELETE FROM shells WHERE id=$1', [s[0].id]);
              await award(q, u.id, 1, 'Robada a un rival al ganarle');
            }
          }
        }

        if (end > newLastEnd) newLastEnd = end;
        prevStart = start;
      }

      await q('UPDATE shell_progress SET last_end=$2, streak=$3, champ_wins=$4, castigo_wins=$5, updated_at=now() WHERE user_id=$1',
        [u.id, newLastEnd, streak, JSON.stringify(champWins), castigoWins]);
    } catch (e){ console.error('granter user', u.riotid, e.message); }
  }
}

module.exports = { runGrant };
