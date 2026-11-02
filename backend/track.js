// ================= CUENTAS DE PRUEBA (solo superadmin) =================
// Trackea cuentas agregadas a mano (opcionalmente asociadas a un jugador) con su PROPIA API key: TRACK_RIOT_KEY.
// Nunca usa las otras keys. Guarda las partidas de la Grieta que mueven MMR (normales, rankeds, quickplay/swiftplay);
// las demás (ARAM, eventos, personalizadas) se anotan solo para no volver a pedirlas. Va aparte del ranking del challenge.
const PLATFORM = 'https://la2.api.riotgames.com', REGIONAL = 'https://americas.api.riotgames.com';
const QUEUES = { 400: 'Normal (reclutamiento)', 420: 'Ranked Solo/Dúo', 430: 'Normal (a ciegas)', 440: 'Ranked Flex', 480: 'Swiftplay', 490: 'Quickplay' };
const KEY = () => process.env.TRACK_RIOT_KEY || '';
const POLL_MS = 5 * 60 * 1000;     // cada 5 min revisa todas las cuentas
const GAP_MS = 1300;               // ~92 llamadas cada 2 min: bajo el límite de una key personal (100 / 2 min)
const FIRST_COUNT = 40;            // al agregar una cuenta: sus últimas 40 partidas

let last = 0;
async function riot(url){
  const k = KEY(); if (!k) throw new Error('Falta TRACK_RIOT_KEY');
  for (let tries = 0; tries < 3; tries++){
    const wait = last + GAP_MS - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    const r = await fetch(url, { headers: { 'X-Riot-Token': k } });
    if (r.status === 429){ const ra = Number(r.headers.get('retry-after')) || 10; await new Promise(res => setTimeout(res, ra * 1000)); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('Riot ' + r.status);
    return r.json();
  }
  throw new Error('Riot 429 (límite de llamadas)');
}

module.exports = function setupTrack(app, { q, q1, wrap, auth, isSuper }){
  const superOnly = (req, res, next) => isSuper(req.user && req.user.riotid) ? next() : res.status(403).json({ error: 'Solo superadmin' });

  async function checkAccount(acc, { first } = {}){
    try {
      const sum = await riot(`${PLATFORM}/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`);
      const ent = await riot(`${PLATFORM}/lol/league/v4/entries/by-puuid/${acc.puuid}`) || [];
      const pick = t => { const e = ent.find(x => x.queueType === t); return e ? { tier: e.tier, div: e.rank, lp: e.leaguePoints, w: e.wins, l: e.losses } : null; };
      const rank = { solo: pick('RANKED_SOLO_5x5'), flex: pick('RANKED_FLEX_SR') };
      // partidas nuevas desde la última revisada (la primera vez, las últimas FIRST_COUNT)
      const lastEnd = (await q1('SELECT max(game_end) m FROM track_matches WHERE puuid=$1', [acc.puuid])).m;
      const qs = first || !lastEnd ? `count=${FIRST_COUNT}` : `startTime=${Math.floor(Number(lastEnd) / 1000) + 1}&count=100`;
      const ids = await riot(`${REGIONAL}/lol/match/v5/matches/by-puuid/${acc.puuid}/ids?${qs}`) || [];
      const have = new Set((await q('SELECT match_id FROM track_matches WHERE puuid=$1 AND match_id = ANY($2)', [acc.puuid, ids])).map(r => r.match_id));
      let added = 0;
      for (const id of ids.filter(x => !have.has(x))){
        const m = await riot(`${REGIONAL}/lol/match/v5/matches/${id}`); if (!m || !m.info) continue;
        const inf = m.info, p = (inf.participants || []).find(x => x.puuid === acc.puuid); if (!p) continue;
        const counted = !!QUEUES[inf.queueId] && inf.mapId === 11;
        const tk = (inf.participants || []).filter(x => x.teamId === p.teamId).reduce((t, x) => t + (x.kills || 0), 0);
        const end = inf.gameEndTimestamp || (inf.gameStartTimestamp + inf.gameDuration * 1000);
        await q(`INSERT INTO track_matches (match_id, puuid, queue, counted, game_end, dur, win, remake, champ, pos, k, d, a, cs, gold, dmg, vis, lvl, kp)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT DO NOTHING`,
          [id, acc.puuid, inf.queueId, counted, end, inf.gameDuration, !!p.win, !!p.gameEndedInEarlySurrender, p.championName, p.teamPosition || p.individualPosition || null,
           p.kills, p.deaths, p.assists, (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0), p.goldEarned, p.totalDamageDealtToChampions, p.visionScore, p.champLevel,
           tk ? Math.round(((p.kills || 0) + (p.assists || 0)) / tk * 100) : 0]);
        if (counted) added++;
      }
      await q('UPDATE track_accounts SET rank=$2::jsonb, level=$3, icon=$4, last_check=now(), last_error=NULL WHERE id=$1',
        [acc.id, JSON.stringify(rank), sum ? sum.summonerLevel : acc.level, sum ? sum.profileIconId : acc.icon]);
      return { added };
    } catch (e){
      await q('UPDATE track_accounts SET last_check=now(), last_error=$2 WHERE id=$1', [acc.id, String(e.message).slice(0, 200)]).catch(() => {});
      return { error: e.message };
    }
  }
  let running = false;
  async function pollAll(){
    if (running || !KEY()) return; running = true;
    try { for (const acc of await q('SELECT * FROM track_accounts ORDER BY last_check NULLS FIRST')) await checkAccount(acc); }
    finally { running = false; }
  }
  if (!process.env.NO_RUNNER && KEY()){ setTimeout(pollAll, 60000); setInterval(pollAll, POLL_MS); }

  // ---- API (solo superadmin) ----
  app.get('/api/track/accounts', auth, superOnly, wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const accs = await q(`SELECT a.*, u.nickname FROM track_accounts a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at`);
    const st = await q(`SELECT puuid, count(*)::int g, sum(CASE WHEN win THEN 1 ELSE 0 END)::int w, sum(k)::int k, sum(d)::int d, sum(a)::int a,
                          sum(cs)::int cs, sum(dur)::int dur, max(game_end) last_game
                        FROM track_matches WHERE counted AND NOT remake GROUP BY puuid`);
    const by = {}; st.forEach(r => { by[r.puuid] = r; });
    const users = await q("SELECT id, nickname, riotid FROM users ORDER BY lower(nickname)");
    res.json({ hasKey: !!KEY(), queues: QUEUES, users, accounts: accs.map(a => ({ ...a, stats: by[a.puuid] || null })) });
  }));
  app.post('/api/track/accounts', auth, superOnly, wrap(async (req, res) => {
    const b = req.body || {}, rid = String(b.riotid || '').trim(), m = rid.match(/^(.+)#(.+)$/);
    if (!m) return res.status(400).json({ error: 'Riot ID debe ser Nombre#TAG' });
    let acc;
    try { acc = await riot(`${REGIONAL}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(m[1].trim())}/${encodeURIComponent(m[2].trim())}`); }
    catch (e){ return res.status(502).json({ error: 'No se pudo consultar a Riot: ' + e.message }); }
    if (!acc || !acc.puuid) return res.status(404).json({ error: 'Esa cuenta no existe en Riot' });
    if (await q1('SELECT 1 FROM track_accounts WHERE puuid=$1', [acc.puuid])) return res.status(400).json({ error: 'Esa cuenta ya está agregada' });
    const uid = Number(b.user_id) || null;
    const row = await q1('INSERT INTO track_accounts (riotid, puuid, user_id, note) VALUES ($1,$2,$3,$4) RETURNING *',
      [acc.gameName + '#' + acc.tagLine, acc.puuid, uid, String(b.note || '').trim().slice(0, 200) || null]);
    checkAccount(row, { first: true }).catch(() => {});   // baja sus últimas partidas en segundo plano
    res.json({ ok: true, account: row });
  }));
  app.post('/api/track/accounts/:id', auth, superOnly, wrap(async (req, res) => {
    const b = req.body || {}, id = Number(req.params.id);
    if (b.action === 'delete'){
      const a = await q1('DELETE FROM track_accounts WHERE id=$1 RETURNING puuid', [id]);
      if (a) await q('DELETE FROM track_matches WHERE puuid=$1', [a.puuid]);
      return res.json({ ok: true });
    }
    if (b.action === 'refresh'){
      const a = await q1('SELECT * FROM track_accounts WHERE id=$1', [id]); if (!a) return res.status(404).json({ error: 'No existe' });
      return res.json(await checkAccount(a));
    }
    await q('UPDATE track_accounts SET user_id=$2, note=$3 WHERE id=$1', [id, Number(b.user_id) || null, String(b.note || '').trim().slice(0, 200) || null]);
    res.json({ ok: true });
  }));
  app.get('/api/track/accounts/:id/matches', auth, superOnly, wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const a = await q1('SELECT puuid FROM track_accounts WHERE id=$1', [Number(req.params.id)]); if (!a) return res.status(404).json({ error: 'No existe' });
    res.json(await q('SELECT * FROM track_matches WHERE puuid=$1 AND counted ORDER BY game_end DESC LIMIT 100', [a.puuid]));
  }));
};
