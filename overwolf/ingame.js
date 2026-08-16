/* ============================================================
   ingame.js — tarjeta de standing dentro del juego (ventana in_game).
   Baja players.json del backend y muestra el puesto/elo/racha del jugador
   y cuánto LP le falta para pasar al de arriba. El Riot ID se guarda local
   (sqc_rid). Auto-detección por LCU queda para una versión siguiente.
   ============================================================ */
const BACKEND = 'https://soloq-challenge-em9q.onrender.com';
const RID_KEY = 'sqc_rid';
const NO_DIV = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const HIGH   = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const TIER_IDX = { IRON:0,BRONZE:1,SILVER:2,GOLD:3,PLATINUM:4,EMERALD:5,DIAMOND:6,MASTER:7,GRANDMASTER:7,CHALLENGER:7 };
const DIV_OFF  = { I:300, II:200, III:100, IV:0, '':0 };
const TIER_LBL = { CHALLENGER:'Challenger',GRANDMASTER:'Grandmaster',MASTER:'Master',DIAMOND:'Diamond',EMERALD:'Emerald',PLATINUM:'Platinum',GOLD:'Gold',SILVER:'Silver',BRONZE:'Bronze',IRON:'Iron',UNRANKED:'Unranked' };
function absLP(p){ if(!p||!p.tier) return 0; if(HIGH.has(p.tier)) return 2800+(p.lp||0); return (TIER_IDX[p.tier]??0)*400+(DIV_OFF[p.div]||0)+(p.lp||0); }
function eloLabel(p){ if(!p||!p.tier||p.tier==='UNRANKED') return 'Unranked'; const d = NO_DIV.has(p.tier)?'':' '+(p.div||''); return `${TIER_LBL[p.tier]||p.tier}${d} · ${p.lp||0} LP`; }

const $ = id => document.getElementById(id);
const content = $('content');
let rid = null;
try { rid = localStorage.getItem(RID_KEY); } catch {}

// ---- Arrastre y cierre (APIs de Overwolf) ----
let winId = null;
overwolf.windows.getCurrentWindow(r => { if (r && r.success) winId = r.window.id; });
$('drag').addEventListener('mousedown', e => {
  if (e.target.classList.contains('x')) return;      // no arrastrar al clickear ⚙/✕
  if (winId) overwolf.windows.dragMove(winId);
});
$('close').addEventListener('click', () => { if (winId) overwolf.windows.hide(winId); });
$('gear').addEventListener('click', () => renderConfig());

// ---- Vistas ----
function renderConfig(err){
  content.innerHTML = `
    <div class="cfg">
      <p>Ingresa tu Riot ID para ver tu puesto en el torneo:</p>
      <input id="rid-in" placeholder="Nombre#TAG" value="${rid ? rid.replace(/"/g,'&quot;') : ''}" spellcheck="false">
      ${err ? `<div class="err">${err}</div>` : ''}
      <button id="rid-save">Guardar</button>
    </div>`;
  const inp = $('rid-in'); inp.focus();
  const save = () => {
    const v = (inp.value || '').trim();
    if (!/^.+#.+$/.test(v)) return renderConfig('Formato: Nombre#TAG');
    rid = v; try { localStorage.setItem(RID_KEY, v); } catch {}
    load();
  };
  $('rid-save').addEventListener('click', save);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
}

function renderCard(me, above, lpToAbove){
  const s = me.session || { w:0, l:0, lp:0 };
  const lpSign = (s.lp||0) >= 0 ? '+' : '';
  content.innerHTML = `
    <div class="body">
      <div class="row1">
        <div class="pos">#${me._pos}</div>
        <div class="nk">${me.nm || rid.split('#')[0]}</div>
        <div class="elo">${eloLabel(me)}</div>
      </div>
      <div class="row2">
        <div class="stat">Torneo<b>${me.w||0}V · ${me.l||0}D</b></div>
        <div class="stat">Sesión<b><span class="${(s.w||0)>=(s.l||0)?'g':'r'}">${s.w||0}V · ${s.l||0}D</span></b></div>
        <div class="stat">LP sesión<b class="${(s.lp||0)>=0?'g':'r'}" style="color:${(s.lp||0)>=0?'var(--up)':'var(--down)'}">${lpSign}${s.lp||0}</b></div>
      </div>
      ${above ? `<div class="target">Para pasar a <b>${above.nm}</b> te faltan <span class="lp">${lpToAbove} LP</span></div>`
              : `<div class="target">👑 Vas <b>1°</b> del torneo</div>`}
    </div>`;
}

function renderMsg(html){ content.innerHTML = `<div class="cfg"><p class="muted">${html}</p></div>`; }

// ---- Carga de datos ----
async function load(){
  if (!rid) return renderConfig();
  renderMsg('Cargando…');
  try {
    const r = await fetch(`${BACKEND}/players.json`);   // URL estable → cacheable
    if (!r.ok) return renderMsg('No se pudo conectar al servidor.');
    const data = await r.json();
    const players = (data && data.players) || [];
    const idx = players.findIndex(p => (p.rid||'').toLowerCase() === rid.toLowerCase());
    if (idx < 0) return renderConfig(`"${rid}" no está en el ranking. Revisa el Riot ID.`);
    const me = players[idx]; me._pos = idx + 1;
    const above = idx > 0 ? players[idx-1] : null;
    const lpTo = above ? Math.max(0, absLP(above) - absLP(me)) : 0;
    renderCard(me, above, lpTo);
  } catch (e) { renderMsg('Error: ' + (e.message || e)); }
}

load();
setInterval(() => { if (rid) load(); }, 30000);   // refresca cada 30s
