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
      if (teamSet.has(canon(cell))){ const t={ name:cell, canon:canon(cell), ours:OURS.has(cell), players:[] }; curByCol[col]=t; teams.push(t); }
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

  // --- ELIMINATORIAS: slots por fase (se llenan cuando haya Top16) ---
  const bracket={ octavos:[], cuartos:[], semis:[], final:[] };
  // (estructura vacía por ahora; el parser se afina cuando el fixture tenga datos)

  const data={
    tournament:'uLeague', edition:'Clausura 2026', game:'League of Legends',
    source:'https://docs.google.com/spreadsheets/d/'+SHEET_ID,
    updatedAt:new Date().toISOString(), startDate:'2026-10-03',
    phases:PHASES, ours:[...OURS],
    teams: teams.map(t=>({ name:t.name, canon:t.canon, ours:t.ours, players:t.players })),
    swiss, bracket,
  };
  fs.writeFileSync(OUT, JSON.stringify(data,null,1));
  console.log('OK → '+OUT);
  console.log('equipos:', teams.length, '| nuestros:', teams.filter(t=>t.ours).map(t=>t.name).join(', '));
  console.log('swiss rondas:', swiss.map(r=>'R'+r.n+'('+r.buckets.reduce((s,b)=>s+b.matches.length,0)+' partidos)').join(', '));
})().catch(e=>{ console.error('ERROR:', e.message); process.exit(1); });
