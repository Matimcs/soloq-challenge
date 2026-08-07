/* ============================================================
   roulette.js — Ruleta de Blue Shells (reutilizable: web + overlay).
   SQCRoulette.show({ castigo, imgBase, audioUrl, audio, title, subtitle,
                      mount, onDone })
   - Muestra una cinta con TODOS los castigos que gira y frena sobre el
     elegido, sincronizada con "Roulette Sound.mp3": aterriza al seg 3.48.
   ============================================================ */
window.SQCRoulette = (function(){
  const CASTIGOS = [
    ['Sin tus 3 campeones más jugados','sin-3-campeones'],
    ['Una partida con Yuumi','yuumi'],
    ['Campeón aleatorio','campeon-aleatorio'],
    ['Sin Flash','sin-flash'],
    ['Autofill','autofill'],
    ['Sin botas y sin pies veloces','sin-botas'],
    ['Hechizos cambiados','hechizos-cambiados'],
    ['Sensibilidad x2','sensibilidad-x2'],
    ['Sin objetos completos hasta min 15','sin-objetos-min15'],
    ['Reverse','reverse'],
    ['Runas predeterminadas','runas-predeterminadas'],
  ];
  const REVEAL_MS = 4140;   // el sonido revela al seg 4.14
  let injected = false;

  function injectCss(){
    if (injected) return; injected = true;
    const s = document.createElement('style');
    s.textContent = `
      .sqcr-overlay{ position:fixed; inset:0; z-index:100000; display:grid; place-items:center;
        background:rgba(5,6,10,.82); -webkit-backdrop-filter:blur(4px); backdrop-filter:blur(4px);
        font-family:'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif; animation:sqcr-fade .2s ease; }
      @keyframes sqcr-fade{ from{opacity:0} to{opacity:1} }
      .sqcr-box{ width:min(680px,92vw); background:#0d0e12; border:1px solid rgba(255,255,255,.1); border-radius:18px;
        padding:22px 20px 24px; box-shadow:0 20px 60px rgba(0,0,0,.6); text-align:center; }
      .sqcr-title{ font-size:18px; font-weight:800; color:#fff; letter-spacing:.01em; }
      .sqcr-sub{ font-size:13px; color:rgba(255,255,255,.55); margin-top:3px; }
      .sqcr-track{ position:relative; margin:18px 0 8px; height:150px; overflow:hidden; border-radius:12px;
        background:#08090c; border:1px solid rgba(255,255,255,.07);
        -webkit-mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent);
                mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent); }
      .sqcr-pointer{ position:absolute; left:50%; top:0; bottom:0; width:3px; transform:translateX(-50%); z-index:3;
        background:var(--accent,#e9ff1f); box-shadow:0 0 12px rgba(233,255,31,.8); border-radius:2px; }
      .sqcr-pointer::before,.sqcr-pointer::after{ content:''; position:absolute; left:50%; transform:translateX(-50%);
        border-left:7px solid transparent; border-right:7px solid transparent; }
      .sqcr-pointer::before{ top:-1px; border-top:9px solid var(--accent,#e9ff1f); }
      .sqcr-pointer::after{ bottom:-1px; border-bottom:9px solid var(--accent,#e9ff1f); }
      .sqcr-strip{ display:flex; align-items:center; height:100%; padding:0 8px; will-change:transform; }
      .sqcr-card{ width:116px; flex:0 0 116px; margin-right:12px; text-align:center; opacity:.9; }
      .sqcr-card img{ width:66px; height:66px; object-fit:contain; }
      .sqcr-cn{ font-size:10.5px; font-weight:600; color:rgba(255,255,255,.7); margin-top:5px; line-height:1.2;
        height:26px; overflow:hidden; }
      .sqcr-card.win{ opacity:1; transform:scale(1.06); }
      .sqcr-card.win img{ filter:drop-shadow(0 0 10px rgba(233,255,31,.6)); }
      .sqcr-card.win .sqcr-cn{ color:var(--accent,#e9ff1f); font-weight:800; }
      .sqcr-result{ min-height:26px; font-size:16px; font-weight:800; color:var(--accent,#e9ff1f); opacity:0; transition:opacity .3s; }
      .sqcr-overlay.done .sqcr-result{ opacity:1; }
      .sqcr-hint{ font-size:11px; color:rgba(255,255,255,.35); margin-top:8px; opacity:0; transition:opacity .3s; }
      .sqcr-overlay.done .sqcr-hint{ opacity:1; }`;
    document.head.appendChild(s);
  }

  function slugFor(name){ const f = CASTIGOS.find(c => c[0] === name); return f ? f[1] : 'reverse'; }

  function show(opts){
    opts = opts || {};
    injectCss();
    const castigo  = opts.castigo || 'Reverse';
    const imgBase  = opts.imgBase  || 'overlay/assets/shells/';
    const audioUrl = opts.audioUrl || 'overlay/assets/Roulette Sound.mp3';
    const onDone   = opts.onDone   || function(){};
    const CARDS = 90, winIdx = 76;   // más recorrido → gira más rápido

    const strip = [];
    for (let i = 0; i < CARDS; i++)
      strip.push(i === winIdx ? [castigo, slugFor(castigo)] : CASTIGOS[Math.floor(Math.random()*CASTIGOS.length)]);
    const cardsHtml = strip.map(([nm,slug],i) =>
      `<div class="sqcr-card" data-i="${i}"><img src="${imgBase}${slug}.png" onerror="this.style.visibility='hidden'"><div class="sqcr-cn">${nm}</div></div>`).join('');

    const overlay = document.createElement('div');
    overlay.className = 'sqcr-overlay';
    overlay.innerHTML = `
      <div class="sqcr-box">
        <div class="sqcr-title">${opts.title || '🛡 Blue Shell'}</div>
        ${opts.subtitle ? `<div class="sqcr-sub">${opts.subtitle}</div>` : ''}
        <div class="sqcr-track"><div class="sqcr-pointer"></div><div class="sqcr-strip">${cardsHtml}</div></div>
        <div class="sqcr-result"></div>
        <div class="sqcr-hint">Click para cerrar</div>
      </div>`;
    (opts.mount || document.body).appendChild(overlay);

    // audio: usa el que ya venía sonando (para no perder el gesto del click) o crea uno
    let audio = opts.audio;
    if (!audio){ try { audio = new Audio(audioUrl); audio.play().catch(()=>{}); } catch(e){} }
    const elapsed = (audio && audio.currentTime) ? audio.currentTime*1000 : 0;
    const dur = Math.max(600, REVEAL_MS - elapsed);   // aterriza en el seg 3.48 del audio

    const stripEl = overlay.querySelector('.sqcr-strip');
    const trackEl = overlay.querySelector('.sqcr-track');
    const winEl   = overlay.querySelector(`.sqcr-card[data-i="${winIdx}"]`);

    requestAnimationFrame(() => {
      const target = (winEl.offsetLeft + winEl.offsetWidth/2) - trackEl.clientWidth/2
        + (Math.random()-0.5) * winEl.offsetWidth * 0.4;   // jitter leve (queda sobre la carta)
      // easeOutCirc: mantiene la velocidad alta y frena de golpe al final (menos predecible)
      stripEl.style.transition = `transform ${dur}ms cubic-bezier(0,.55,.45,1)`;
      requestAnimationFrame(() => { stripEl.style.transform = `translateX(${-target}px)`; });
    });

    let closed = false;
    function close(){ if (closed) return; closed = true; try{ overlay.remove(); }catch(e){} try{ if(audio){audio.pause();} }catch(e){} onDone(); }
    setTimeout(() => {
      if (winEl) winEl.classList.add('win');
      overlay.querySelector('.sqcr-result').innerHTML = `<b>${castigo}</b>`;
      overlay.classList.add('done');
      setTimeout(() => overlay.addEventListener('click', close), 150);
    }, dur);

    return { close };
  }

  return { show, CASTIGOS, slugFor };
})();
