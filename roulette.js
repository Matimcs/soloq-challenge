/* ============================================================
   roulette.js — Ruleta de Blue Shells (reutilizable: web + overlay).
   SQCRoulette.show({ castigo, imgBase, audioUrl, audio, title, subtitle,
                      champIcon, champName, mount, onDone })
   - Cinta de cartas con color según la rareza (probabilidad real) que gira y
     frena sobre el castigo elegido, sincronizada con "Roulette Sound.mp3"
     (revela al seg 4.14).
   ============================================================ */
window.SQCRoulette = (function(){
  // [nombre, archivo, probabilidad %]
  const CASTIGOS = [
    ['Sin tus 3 campeones más jugados','sin-3-campeones',17],
    ['Una partida con Yuumi','yuumi',11],
    ['Campeón aleatorio','campeon-aleatorio',11],
    ['Sin Flash','sin-flash',11],
    ['Autofill','autofill',11],
    ['Sin botas y sin pies veloces','sin-botas',11],
    ['Hechizos cambiados','hechizos-cambiados',6],
    ['Sin pociones ni pinks','sin-pociones',6],
    ['Sin objetos completos hasta min 15','sin-objetos-min15',6],
    ['Reverse','reverse',6],
    ['Clase de campeón aleatoria','clase-campeon',4],
  ];
  // rareza: común (≥11%), raro (6%), épico (4%) y Reverse aparte (especial: rebota)
  const RAR = { comun:{ n:'Común', c:'#9aa0a6' }, raro:{ n:'Raro', c:'#4aa3ff' }, epico:{ n:'Épico', c:'#b77bff' }, especial:{ n:'Especial', c:'#ffd24a' } };
  const find = nm => CASTIGOS.find(c => c[0] === nm) || CASTIGOS[9];
  const rarOf = nm => nm === 'Reverse' ? 'especial' : find(nm)[2] >= 11 ? 'comun' : find(nm)[2] >= 6 ? 'raro' : 'epico';
  const slugFor = nm => find(nm)[1];
  const REVEAL_MS = 4140;   // el sonido revela al seg 4.14
  let injected = false;

  function injectCss(){
    if (injected) return; injected = true;
    const s = document.createElement('style');
    s.textContent = `
      .sqcr-overlay{ position:fixed; inset:0; z-index:100000; display:grid; place-items:center; background:rgba(5,6,10,.84);
        -webkit-backdrop-filter:blur(5px); backdrop-filter:blur(5px); font-family:'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif; animation:sqcr-fade .2s ease; }
      @keyframes sqcr-fade{ from{opacity:0} to{opacity:1} }
      .sqcr-box{ position:relative; width:min(720px,94vw); background:#0d0e12; border:1px solid rgba(255,255,255,.1); border-radius:20px;
        padding:20px 18px 22px; box-shadow:0 24px 70px rgba(0,0,0,.65); text-align:center; overflow:hidden; }
      .sqcr-box::before{ content:''; position:absolute; inset:-40% -10% auto; height:70%; background:radial-gradient(closest-side, rgba(74,163,255,.14), transparent); pointer-events:none; }
      .sqcr-title{ position:relative; font-size:19px; font-weight:800; color:#fff; letter-spacing:.01em; }
      .sqcr-sub{ position:relative; font-size:13px; color:rgba(255,255,255,.55); margin-top:3px; }
      .sqcr-track{ position:relative; margin:16px 0 10px; height:176px; overflow:hidden; border-radius:14px; background:#08090c; border:1px solid rgba(255,255,255,.07);
        -webkit-mask-image:linear-gradient(90deg,transparent,#000 14%,#000 86%,transparent); mask-image:linear-gradient(90deg,transparent,#000 14%,#000 86%,transparent); }
      .sqcr-pointer{ position:absolute; left:50%; top:0; bottom:0; width:2px; transform:translateX(-50%); z-index:3;
        background:var(--accent,#e9ff1f); box-shadow:0 0 14px rgba(233,255,31,.9); }
      .sqcr-pointer::before,.sqcr-pointer::after{ content:''; position:absolute; left:50%; transform:translateX(-50%); border-left:8px solid transparent; border-right:8px solid transparent; }
      .sqcr-pointer::before{ top:-1px; border-top:10px solid var(--accent,#e9ff1f); }
      .sqcr-pointer::after{ bottom:-1px; border-bottom:10px solid var(--accent,#e9ff1f); }
      .sqcr-strip{ display:flex; align-items:center; height:100%; padding:0 8px; will-change:transform; }
      .sqcr-card{ --rc:#9aa0a6; position:relative; width:128px; flex:0 0 128px; height:148px; margin-right:10px; border-radius:12px; box-sizing:border-box; padding:12px 8px 0;
        background:linear-gradient(180deg, rgba(255,255,255,.04), color-mix(in srgb, var(--rc) 16%, transparent)); border:1px solid color-mix(in srgb, var(--rc) 35%, transparent);
        display:flex; flex-direction:column; align-items:center; transition:transform .25s, box-shadow .25s; }
      .sqcr-card::after{ content:''; position:absolute; left:0; right:0; bottom:0; height:5px; border-radius:0 0 11px 11px; background:var(--rc); }
      .sqcr-card img{ width:72px; height:72px; object-fit:contain; filter:drop-shadow(0 4px 8px rgba(0,0,0,.5)); }
      .sqcr-cn{ font-size:11px; font-weight:700; color:rgba(255,255,255,.82); margin-top:8px; line-height:1.2; height:28px; overflow:hidden; }
      .sqcr-card.win{ transform:scale(1.1); z-index:2; box-shadow:0 0 0 2px var(--rc), 0 0 28px color-mix(in srgb, var(--rc) 70%, transparent); animation:sqcr-pop .5s ease; }
      @keyframes sqcr-pop{ 0%{transform:scale(1)} 40%{transform:scale(1.18)} 100%{transform:scale(1.1)} }
      .sqcr-flash{ position:absolute; inset:0; z-index:4; pointer-events:none; background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.55), transparent 55%); opacity:0; }
      .sqcr-overlay.done .sqcr-flash{ animation:sqcr-flash .55s ease-out; }
      @keyframes sqcr-flash{ 0%{opacity:.95} 100%{opacity:0} }
      .sqcr-legend{ position:relative; display:flex; gap:12px; justify-content:center; flex-wrap:wrap; font-size:10.5px; color:rgba(255,255,255,.45); margin-top:2px; }
      .sqcr-legend i{ display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:4px; vertical-align:0; }
      .sqcr-result{ position:relative; min-height:58px; opacity:0; transform:translateY(6px); transition:opacity .35s, transform .35s; }
      .sqcr-overlay.done .sqcr-result{ opacity:1; transform:none; }
      .sqcr-rar{ display:inline-block; font-size:10.5px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; padding:3px 10px; border-radius:999px; color:#0b0b0b; background:var(--rc); }
      .sqcr-name{ font-size:19px; font-weight:800; color:#fff; margin-top:6px; }
      .sqcr-pct{ font-size:12px; color:rgba(255,255,255,.5); margin-top:2px; }
      .sqcr-hint{ position:relative; font-size:11px; color:rgba(255,255,255,.35); margin-top:10px; opacity:0; transition:opacity .3s; }
      .sqcr-overlay.done .sqcr-hint{ opacity:1; }
      .sqcr-spinner{ width:54px; height:54px; border-radius:50%; border:4px solid rgba(255,255,255,.15); border-top-color:var(--accent,#e9ff1f); animation:sqcr-spin .8s linear infinite; }
      @keyframes sqcr-spin{ to{ transform:rotate(360deg); } }
      .sqcr-champ-badge{ position:absolute; right:16px; bottom:14px; display:flex; align-items:center; gap:7px; opacity:0; transition:opacity .3s; }
      .sqcr-overlay.done .sqcr-champ-badge{ opacity:1; }
      .sqcr-champ-badge img{ width:46px; height:46px; border-radius:50%; border:2px solid var(--accent,#e9ff1f); object-fit:cover; box-shadow:0 0 10px rgba(233,255,31,.4); }
      .sqcr-champ-badge span{ font-size:12px; font-weight:800; color:#fff; }`;
    document.head.appendChild(s);
  }

  // Precarga las 11 imágenes de castigos. Resuelve cuando todas cargaron.
  function preloadImages(imgBase){
    imgBase = imgBase || 'overlay/assets/shells/';
    return Promise.all(CASTIGOS.map(([,slug]) => new Promise(res => {
      const im = new Image(); im.onload = im.onerror = () => res(); im.src = imgBase + slug + '.png';
    })));
  }
  // Espera a que el audio esté listo para reproducirse sin cortes (o timeout).
  function waitAudio(audio, maxMs){
    return new Promise(res => {
      if (!audio) return res();
      if (audio.readyState >= 4) return res();   // HAVE_ENOUGH_DATA
      let done = false; const finish = () => { if (done) return; done = true; res(); };
      audio.addEventListener('canplaythrough', finish, { once:true });
      setTimeout(finish, maxMs || 5000);
    });
  }
  // Círculo de carga a pantalla completa (mientras se precarga todo).
  function loading(on){
    injectCss();
    let el = document.getElementById('sqcr-loading');
    if (on){ if (!el){ el = document.createElement('div'); el.id = 'sqcr-loading'; el.className = 'sqcr-overlay'; el.innerHTML = '<div class="sqcr-spinner"></div>'; document.body.appendChild(el); } }
    else if (el){ el.remove(); }
  }

  function show(opts){
    opts = opts || {};
    injectCss();
    const castigo  = opts.castigo || 'Reverse';
    const imgBase  = opts.imgBase  || 'overlay/assets/shells/';
    const audioUrl = opts.audioUrl || 'overlay/assets/Roulette Sound.mp3';
    const onDone   = opts.onDone   || function(){};
    const CARDS = 90, winIdx = 76;   // más recorrido → gira más rápido

    // la tira respeta las probabilidades: los comunes salen más seguido que los raros
    const bag = []; CASTIGOS.forEach(c => { for (let k = 0; k < c[2]; k++) bag.push(c); });
    const strip = [];
    for (let i = 0; i < CARDS; i++) strip.push(i === winIdx ? find(castigo) : bag[Math.floor(Math.random() * bag.length)]);
    const cardsHtml = strip.map(([nm, slug], i) =>
      `<div class="sqcr-card" data-i="${i}" style="--rc:${RAR[rarOf(nm)].c}"><img src="${imgBase}${slug}.png" alt="" onerror="this.style.visibility='hidden'"><div class="sqcr-cn">${nm}</div></div>`).join('');
    const r = RAR[rarOf(castigo)], pct = find(castigo)[2];

    const overlay = document.createElement('div');
    overlay.className = 'sqcr-overlay';
    overlay.innerHTML = `
      <div class="sqcr-box">
        <div class="sqcr-title">${opts.title || '🛡 Blue Shell'}</div>
        ${opts.subtitle ? `<div class="sqcr-sub">${opts.subtitle}</div>` : ''}
        <div class="sqcr-track"><div class="sqcr-pointer"></div><div class="sqcr-flash"></div><div class="sqcr-strip">${cardsHtml}</div></div>
        <div class="sqcr-legend">${Object.values(RAR).map(x => `<span><i style="background:${x.c}"></i>${x.n}</span>`).join('')}</div>
        <div class="sqcr-result" style="--rc:${r.c}"><span class="sqcr-rar">${r.n}</span><div class="sqcr-name">${castigo}</div><div class="sqcr-pct">${pct}% de probabilidad${castigo === 'Reverse' ? ' · ¡rebota!' : ''}</div></div>
        <div class="sqcr-hint">Click para cerrar</div>
        ${(opts.champIcon || opts.champName) ? `<div class="sqcr-champ-badge">${opts.champIcon ? `<img src="${opts.champIcon}" alt="" onerror="this.style.display='none'">` : ''}<span>${opts.champName || ''}</span></div>` : ''}
      </div>`;
    (opts.mount || document.body).appendChild(overlay);

    // audio: usa el que ya venía sonando (para no perder el gesto del click) o crea uno
    let audio = opts.audio;
    if (!audio){ try { audio = new Audio(audioUrl); audio.play().catch(()=>{}); } catch(e){} }

    const stripEl = overlay.querySelector('.sqcr-strip');
    const trackEl = overlay.querySelector('.sqcr-track');
    const winEl   = overlay.querySelector(`.sqcr-card[data-i="${winIdx}"]`);

    let closed = false;
    function close(){ if (closed) return; closed = true; try{ overlay.remove(); }catch(e){} try{ if(audio){audio.pause();} }catch(e){} onDone(); }

    let waits = 0;
    function startSpin(){
      // si el recuadro aún no tiene tamaño (ventana recién abierta), espera un poco para no caer en otra carta
      if ((!trackEl.clientWidth || !winEl.offsetWidth) && waits++ < 30) return setTimeout(startSpin, 16);
      const elapsed = (audio && audio.currentTime) ? audio.currentTime*1000 : 0;
      const dur = Math.max(600, REVEAL_MS - elapsed);   // aterriza en el seg 4.14 del audio
      const target = (winEl.offsetLeft + winEl.offsetWidth/2) - trackEl.clientWidth/2
        + (Math.random()-0.5) * winEl.offsetWidth * 0.4;   // jitter leve (queda sobre la carta)
      // easeOutCirc: mantiene la velocidad alta y frena de golpe al final (menos predecible)
      stripEl.style.transition = `transform ${dur}ms cubic-bezier(0,.55,.45,1)`;
      requestAnimationFrame(() => { stripEl.style.transform = `translateX(${-target}px)`; });
      setTimeout(() => {
        winEl.classList.add('win');
        overlay.classList.add('done');
        setTimeout(() => overlay.addEventListener('click', close), 150);
      }, dur);
    }

    // Precarga las imágenes ANTES de girar (para que la elegida no aparezca "cargando").
    // Máximo 1.2s de espera; el audio ya suena mientras tanto (el reveal sigue sincronizado).
    const slugs = [...new Set(strip.map(c => c[1]))];
    Promise.race([
      Promise.all(slugs.map(sl => new Promise(res => { const im = new Image(); im.onload = im.onerror = res; im.src = imgBase + sl + '.png'; }))),
      new Promise(res => setTimeout(res, 1200)),
    ]).then(startSpin);

    return { close };
  }

  // Precarga (web): calienta el caché de las 11 imágenes al cargar la página.
  try { CASTIGOS.forEach(([,slug]) => { const im = new Image(); im.src = 'overlay/assets/shells/' + slug + '.png'; }); } catch(e){}

  return { show, CASTIGOS, slugFor, preloadImages, waitAudio, loading };
})();
