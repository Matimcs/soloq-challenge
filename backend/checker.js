/* ============================================================
   checker.js — Detección automática de cumplimiento de castigos.
   Para cada Blue Shell RECIBIDA pendiente cuyo castigo sea
   auto-detectable, busca las partidas SoloQ del jugador POSTERIORES
   a haberla recibido y, si alguna cumple la condición, la marca
   como 'cumplido'. El resto de castigos van por verificación manual.
   Requiere RIOT_API_KEY (misma key del runner).
   ============================================================ */
const CLUSTER = 'americas', PLATFORM = 'la2';
const FLASH = 4;
const POS = { TOP:'Top', JUNGLE:'Jungla', MIDDLE:'Medio', BOTTOM:'ADC', UTILITY:'Support' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function riot(url, KEY){
  try { const r = await fetch(url, { headers: { 'X-Riot-Token': KEY } }); return r.ok ? r.json() : null; } catch { return null; }
}

// Riot ID -> PUUID (cache en memoria del proceso)
const puuidCache = {};
async function getPuuid(riotid, KEY){
  if (puuidCache[riotid]) return puuidCache[riotid];
  const h = riotid.indexOf('#'); if (h < 0) return null;
  const gn = riotid.slice(0, h), tg = riotid.slice(h + 1);
  const a = await riot(`https://${CLUSTER}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gn)}/${encodeURIComponent(tg)}`, KEY);
  if (a && a.puuid){ puuidCache[riotid] = a.puuid; return a.puuid; }
  return null;
}

// Castigos auto-detectables y su condición sobre el participante (me) de una partida.
const CHECKS = {
  'Una partida con Yuumi':            (me) => me.championName === 'Yuumi',
  'Sin Flash':                        (me) => me.summoner1Id !== FLASH && me.summoner2Id !== FLASH,
  'Sin tus 3 campeones más jugados':  (me, ctx) => Array.isArray(ctx.top3) && !ctx.top3.includes(me.championId),
  'Autofill':                         (me, ctx) => { const p = POS[me.teamPosition]; return !!p && p !== ctx.pos1 && p !== ctx.pos2; },
};
const AUTO = Object.keys(CHECKS);

async function runCheck({ q, KEY }){
  if (!KEY) return;
  let pend;
  try {
    pend = await q(`SELECT e.id, e.castigo, e.created_at, u.riotid, u.pos1, u.pos2
      FROM events e JOIN users u ON u.id = e.user_id
      WHERE e.kind='received' AND e.estado='pendiente' AND e.castigo = ANY($1)
      ORDER BY e.id LIMIT 12`, [AUTO]);
  } catch (e) { console.error('checker query:', e.message); return; }
  if (!pend.length) return;

  for (const p of pend){
    try {
      const puuid = await getPuuid(p.riotid, KEY); await sleep(120);
      if (!puuid) continue;
      const startSec = Math.floor(new Date(p.created_at).getTime() / 1000);
      const ids = await riot(`https://${CLUSTER}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&startTime=${startSec}&count=8`, KEY);
      await sleep(120);
      if (!Array.isArray(ids) || !ids.length) continue;

      // contexto extra según el castigo
      const ctx = { pos1: p.pos1, pos2: p.pos2 };
      if (p.castigo === 'Sin tus 3 campeones más jugados'){
        const top = await riot(`https://${PLATFORM}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=3`, KEY);
        await sleep(120);
        ctx.top3 = Array.isArray(top) ? top.map(t => t.championId) : null;
        if (!ctx.top3) continue;   // sin datos de maestría → no evaluamos (queda pendiente)
      }

      let cumplido = false;
      for (const id of ids){
        const m = await riot(`https://${CLUSTER}.api.riotgames.com/lol/match/v5/matches/${id}`, KEY);
        await sleep(120);
        if (!m || !m.info) continue;
        const me = (m.info.participants || []).find(x => x.puuid === puuid);
        if (me && CHECKS[p.castigo](me, ctx)){ cumplido = true; break; }
      }
      if (cumplido){
        await q("UPDATE events SET estado='cumplido' WHERE id=$1", [p.id]);
        console.log(`✔ Castigo auto-cumplido: ${p.riotid} — ${p.castigo}`);
      }
    } catch (e) { console.error('checker:', e.message); }
  }
}

module.exports = { runCheck, AUTO, CHECKS };
