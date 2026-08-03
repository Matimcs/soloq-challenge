/* ============================================================
   probe.js — Prueba que podemos leer los datos de Riot SIN Overwolf.
   Uso:  node probe.js   (con el cliente de LoL abierto)
   ============================================================ */
const { getCreds, lcu } = require('./lcu');
const { liveClient } = require('./liveclient');

(async () => {
  console.log('== Probe: datos locales de Riot (sin Overwolf) ==\n');

  const creds = getCreds();
  if (!creds) {
    console.log('❌ No detecté el League Client. Abre el cliente de LoL y reintenta.');
  } else {
    console.log(`✔ League Client detectado (puerto ${creds.port})\n`);

    const phase = await lcu(creds, '/lol-gameflow/v1/gameflow-phase');
    console.log('Fase actual:', phase);

    const me = await lcu(creds, '/lol-summoner/v1/current-summoner');
    if (me && !me.error) console.log(`Invocador: ${me.gameName}#${me.tagLine} (nivel ${me.summonerLevel})`);

    const ranked = await lcu(creds, '/lol-ranked/v1/current-ranked-stats');
    const solo = ranked && ranked.queues && ranked.queues.find(q => q.queueType === 'RANKED_SOLO_5x5');
    if (solo) console.log(`SoloQ: ${solo.tier} ${solo.division} ${solo.leaguePoints} LP (${solo.wins}V ${solo.losses}D)  <- LP EXACTO`);

    const lobby = await lcu(creds, '/lol-lobby/v2/lobby');
    if (lobby && !lobby.error && lobby.localMember) {
      console.log(`Roles en cola: ${lobby.localMember.firstPositionPreference} / ${lobby.localMember.secondPositionPreference}  <- para Autofill`);
    } else {
      console.log('Roles en cola: (no estás en un lobby de ranked ahora)');
    }

    const pages = await lcu(creds, '/lol-perks/v1/pages');
    const active = Array.isArray(pages) ? pages.find(p => p.current) : null;
    if (active) console.log(`Runas activas: "${active.name}"  <- para Runas predeterminadas`);
  }

  const live = await liveClient();
  if (live && live.allPlayers) {
    const t = Math.floor((live.gameData?.gameTime || 0) / 60);
    console.log(`\n🎮 EN PARTIDA — ${live.allPlayers.length} jugadores, ${t} min`);
    const meName = live.activePlayer?.riotId || live.activePlayer?.summonerName;
    const meLive = live.allPlayers.find(p => (p.riotId || p.summonerName) === meName);
    if (meLive) console.log(`  Tú: ${meLive.championName} · KDA ${meLive.scores.kills}/${meLive.scores.deaths}/${meLive.scores.assists} · CS ${meLive.scores.creepScore}`);
  } else {
    console.log('\n(No estás en una partida activa → Live Client Data no disponible ahora)');
  }
})();
