/* ============================================================
   uLeague sync — baja el fixture (Google Sheets xlsx) + bases
   y genera ../../uleague-data.json para la web. Correr cuando
   el usuario pida "actualiza":  node tools/uleague/sync.js
   ============================================================ */
const https = require('https');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const SHEET_ID = '1HNYVHOWYPP6RrxG-yJQcjhkKZtWWJccq';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;
const OUT = path.join(__dirname, '..', '..', 'uleague-data.json');
const PUUID_CACHE = path.join(__dirname, 'puuid-cache.json');
const RESULTS_FILE = path.join(__dirname, 'results.json');

// uLeague es INDEPENDIENTE del ranking principal del sitio: sus rangos los baja esta
// herramienta y quedan en uleague-data.json. NO toca el tracker principal (players.json).
const WANT_RANKS = !process.argv.includes('--no-ranks');
const CLUSTER = 'americas', PLATFORM = 'la2';
// Lee la key de Riot desde backend/.env (no se commitea). uLeague usa su PROPIA key
// (ULEAGUE_RIOT_KEY, la de torneos) para no competir con el runner principal.
let RIOT_KEY = process.env.ULEAGUE_RIOT_KEY || '';
try {
  const env = {};
  fs.readFileSync(path.join(__dirname,'..','..','backend','.env'),'utf8').split('\n').forEach(l=>{const m=l.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/); if(m) env[m[1]]=m[2].replace(/^["']|["']$/g,'').trim();});
  if(!RIOT_KEY) RIOT_KEY = env.ULEAGUE_RIOT_KEY || env.RIOT_API_KEY || '';
} catch {}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function riot(url){ for(let tries=0;tries<4;tries++){ const buf=await getRaw(url,{'X-Riot-Token':RIOT_KEY});
  if(buf.status===429){ const wait=(+buf.headers['retry-after']||5); console.error('  429, espero '+wait+'s'); await sleep(wait*1000); continue; }
  if(buf.status===404) return null;
  if(buf.status>=200&&buf.status<300){ try{return JSON.parse(buf.body);}catch{return null;} }
  return null; } return null; }
const TIERV={IRON:0,BRONZE:1,SILVER:2,GOLD:3,PLATINUM:4,EMERALD:5,DIAMOND:6},DIVV={IV:0,III:1,II:2,I:3};
const NODIV=new Set(['MASTER','GRANDMASTER','CHALLENGER']);
function absLP(t,d,lp){ t=(t||'').toUpperCase(); if(NODIV.has(t))return 2800+(+lp||0); if(TIERV[t]==null)return null; return TIERV[t]*400+(DIVV[(d||'').toUpperCase()]||0)*100+(+lp||0); }

// Fechas/fases (de las bases oficiales uLeague Clausura 2026)
const PHASES = [
  { key:'suiza',   name:'Fase Suiza',        dates:'3 – 15 oct',      format:'Sistema suizo · 5 rondas · R1-2 Bo1, R3-5 Bo3',  detail:'Ganas 3 → clasificas al Top 16 · Pierdes 3 → eliminado' },
  { key:'octavos', name:'Octavos de final',  dates:'por confirmar',   format:'Bo3 · eliminación directa',                      detail:'16 clasificados, sorteo por récord suizo (3-0 / 3-1 / 3-2)' },
  { key:'cuartos', name:'Cuartos de final',  dates:'20 – 22 oct',     format:'Bo3 · online',                                   detail:'' },
  { key:'semis',   name:'Semifinales',       dates:'31 oct – 1 nov',  format:'Bo3 · online',                                   detail:'' },
  { key:'final',   name:'Final (presencial)',dates:'por confirmar',   format:'Bo3 · presencial en Santiago',                   detail:'Incluye definición por el 3er lugar' },
];

const OURS = new Set(['UCH A','UCH B','UCH C','UCH D']);

function get(url){ return new Promise((res,rej)=>{ https.get(url,{headers:{'User-Agent':'Mozilla/5.0'}},r=>{
  if(r.statusCode>=300&&r.statusCode<400&&r.headers.location) return res(get(r.headers.location));
  const chunks=[]; r.on('data',d=>chunks.push(d)); r.on('end',()=>res(Buffer.concat(chunks))); }).on('error',rej); }); }
function getRaw(url,headers){ return new Promise((res)=>{ https.get(url,{headers:headers||{}},r=>{
  let b=''; r.on('data',d=>b+=d); r.on('end',()=>res({status:r.statusCode,headers:r.headers,body:b})); })
  .on('error',()=>res({status:0,headers:{},body:''})); }); }

// Normaliza nombres entre hojas (Equipos usa "UTALCA A"/"DUOC UC"; Clasificatorias "UTAL A"/"DUOC")
function canon(n){ n=(n||'').toString().trim(); if(!n) return '';
  n = n.replace(/^UTALCA\b/i,'UTAL').replace(/^DUOC UC$/i,'DUOC');
  return n.replace(/\s+/g,' ').trim(); }

function grid(ws){ return XLSX.utils.sheet_to_json(ws,{header:1,defval:'',blankrows:false}).map(r=>r.map(c=>(c==null?'':String(c).trim()))); }

(async () => {
  const buf = await get(SHEET_URL);
  const wb = XLSX.read(buf);
  const shEq = grid(wb.Sheets['Equipos']);
  const shCl = grid(wb.Sheets['Clasificatorias']);
  const shEl = grid(wb.Sheets['Eliminatorias']);

  // --- set de nombres de equipo (autoritativo desde Clasificatorias R1) ---
  const teamSet = new Set();
  for (const row of shCl) for (const c of row){ const v=canon(c); if(v && v!=='v/s' && v!=='V/S' && !/^Ronda|^Rondas|^R\d|Equipos|Fixture|Clausura|Fase|Clasificados|Eliminados|^Lol$/i.test(v)) teamSet.add(v); }

  // --- EQUIPOS: columnas 1,3,5,7,9 → header (team) o jugador ---
  const COLS=[1,3,5,7,9];
  const teams=[]; const curByCol={};
  for (const row of shEq){
    for (const col of COLS){
      const cell=(row[col]||'').trim(); if(!cell) continue;
      if (teamSet.has(canon(cell))){ const disp=cell.replace(/^UTALCA\b/i,'UTAL'); const t={ name:disp, canon:canon(cell), ours:OURS.has(disp), players:[] }; curByCol[col]=t; teams.push(t); }
      else if (curByCol[col]) curByCol[col].players.push(cell);
    }
  }

  // --- CLASIFICATORIAS: rondas con buckets por récord ---
  // El sheet NO tiene columna "ganador": el resultado se deduce del bucket (récord) donde
  // aparece el equipo en la ronda siguiente (1-0 = ganó R1, 0-1 = perdió, etc.).
  const isHdr = v => /Ronda?s?\s*\d.*\/\s*BO\d/i.test(v||'');
  const recOf = v => { const m=(v||'').match(/(\d-\d(?:\s*v\/s\s*\d-\d)?)/i); return m?m[1].replace(/\s+/g,' '):''; };
  const swiss=[];
  for (let i=0;i<shCl.length;i++){
    shCl[i].forEach((cell,c)=>{
      if(!isHdr(cell)) return;
      const n=+(cell.match(/Ronda?s?\s*(\d)/i)[1]);
      const bo=(cell.match(/BO(\d)/i)[0]).toUpperCase();
      const record=recOf(cell);
      let rnd=swiss.find(r=>r.n===n); if(!rnd){ rnd={ n, bo, buckets:[] }; swiss.push(rnd); }
      let bucket=rnd.buckets.find(b=>b.record===record); if(!bucket){ bucket={ record, matches:[] }; rnd.buckets.push(bucket); }
      // partidos debajo: [c]=local [c+1]="v/s" [c+2]=visita. Paramos al toparnos con otra cabecera.
      for(let j=i+1;j<shCl.length;j++){
        const r2=shCl[j];
        if(r2.some(isHdr)) break;
        if((r2[c+1]||'').toLowerCase()!=='v/s') continue;
        const a=canon(r2[c]), b=canon(r2[c+2]);
        if(a&&b && teamSet.has(a) && teamSet.has(b)) bucket.matches.push({ a, b });
      }
    });
  }
  swiss.sort((x,y)=>x.n-y.n);

  // --- RESULTADOS MANUALES (Discord): marcan ganador por match ---
  // El Sheet no carga resultados; los traen por Discord. results.json persiste
  // los ganadores y se fusiona en cada sync (ubicando el match por ronda + par de equipos).
  const nteam = s => canon(String(s||'')).toLowerCase();
  try {
    const manual = JSON.parse(fs.readFileSync(RESULTS_FILE,'utf8'));

    // --- EMPAREJAMIENTOS MANUALES: rondas/records que el Sheet no trae (llegan por Discord) ---
    // Solo rellena un bucket si viene vacío del Sheet (para no pisar lo oficial si algún día lo carga).
    let pairN=0;
    const pairings = manual.pairings || {};
    for (const rk in pairings){
      const n=+rk; let rnd=swiss.find(r=>r.n===n);
      if(!rnd){ rnd={ n, bo:(n<=2?'BO1':'BO3'), buckets:[] }; swiss.push(rnd); }
      for (const rec in pairings[rk]){
        let bucket=rnd.buckets.find(b=>b.record===rec);
        if(!bucket){ bucket={ record:rec, matches:[] }; rnd.buckets.push(bucket); }
        if(bucket.matches.length) continue;   // el Sheet ya lo trajo: respetar
        (pairings[rk][rec]||[]).forEach(p=>{ const a=canon(p[0]), b=canon(p[1]);
          if(a&&b && teamSet.has(a) && teamSet.has(b)){ bucket.matches.push({ a, b }); pairN++; } });
      }
    }
    swiss.sort((x,y)=>x.n-y.n);
    if(pairN) console.log('emparejamientos manuales agregados:', pairN);

    let applied=0, missed=[];
    (manual.swiss||[]).forEach(res=>{
      const rnd = swiss.find(r=>r.n===res.round);
      const w=nteam(res.winner), l=nteam(res.loser);
      let hit=false;
      if(rnd) for(const b of rnd.buckets) for(const m of b.matches){
        const pair=[nteam(m.a),nteam(m.b)];
        if(pair.includes(w) && pair.includes(l)){ m.w = (nteam(m.a)===w)?m.a:m.b; hit=true; applied++; break; }
      }
      if(!hit) missed.push(`R${res.round} ${res.winner} vs ${res.loser}`);
    });
    console.log('resultados manuales aplicados:', applied + (missed.length?(' | sin match: '+missed.join('; ')):''));
  } catch(e){ if(e.code!=='ENOENT') console.log('⚠ results.json:', e.message); }

  // --- ELIMINATORIAS: slots por fase (se llenan cuando haya Top16) ---
  const bracket={ octavos:[], cuartos:[], semis:[], final:[] };
  // (estructura vacía por ahora; el parser se afina cuando el fixture tenga datos)

  // ---- RANGOS de uLeague (independiente del ranking principal del sitio) ----
  const rankByRid = {};
  if (WANT_RANKS && RIOT_KEY){
    let puuidCache={}; try{ puuidCache=JSON.parse(fs.readFileSync(PUUID_CACHE,'utf8')); }catch{}
    const allRids=[...new Set([].concat(...teams.map(t=>t.players)).map(s=>s.trim()).filter(r=>r.includes('#')))];
    console.log('bajando rangos de '+allRids.length+' cuentas (pausado para no romper la API, ~'+Math.ceil(allRids.length*2.4/60)+' min)...');
    let done=0;
    for (const rid of allRids){
      try {
        let puuid=puuidCache[rid.toLowerCase()];
        if(!puuid){ const [nm,tag]=rid.split('#'); const acc=await riot(`https://${CLUSTER}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(nm)}/${encodeURIComponent(tag||'')}`); await sleep(1200); if(acc&&acc.puuid){ puuid=acc.puuid; puuidCache[rid.toLowerCase()]=puuid; } }
        if(puuid){ const entries=await riot(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`); await sleep(1200);
          const e=Array.isArray(entries)?entries.find(x=>x.queueType==='RANKED_SOLO_5x5'):null;
          rankByRid[rid]= e? {tier:e.tier,div:NODIV.has(e.tier)?'':e.rank,lp:e.leaguePoints,w:e.wins,l:e.losses,abs:absLP(e.tier,e.rank,e.leaguePoints)} : null; }
      } catch {}
      if(++done%25===0){ console.log('  '+done+'/'+allRids.length); try{fs.writeFileSync(PUUID_CACHE,JSON.stringify(puuidCache));}catch{} }
    }
    try{ fs.writeFileSync(PUUID_CACHE,JSON.stringify(puuidCache)); }catch{}
    console.log('rangos obtenidos:', Object.values(rankByRid).filter(Boolean).length+'/'+allRids.length);
  } else if (WANT_RANKS){ console.log('⚠ sin RIOT_API_KEY — se omiten los rangos (corre con la key en backend/.env)'); }

  const data={
    tournament:'uLeague', edition:'Clausura 2026', game:'League of Legends',
    source:'https://docs.google.com/spreadsheets/d/'+SHEET_ID,
    updatedAt:new Date().toISOString(), startDate:'2026-10-03',
    phases:PHASES, ours:[...OURS],
    teams: teams.map(t=>({ name:t.name, canon:t.canon, ours:t.ours,
      players: t.players.map(rid=>({ rid, nm: rid.split('#')[0], rank: rankByRid[rid]||null })) })),
    swiss, bracket,
  };
  fs.writeFileSync(OUT, JSON.stringify(data,null,1));
  console.log('OK → '+OUT);
  console.log('equipos:', teams.length, '| nuestros:', teams.filter(t=>t.ours).map(t=>t.name).join(', '));
  console.log('swiss rondas:', swiss.map(r=>'R'+r.n+'('+r.buckets.reduce((s,b)=>s+b.matches.length,0)+' partidos)').join(', '));
})().catch(e=>{ console.error('ERROR:', e.message); process.exit(1); });
