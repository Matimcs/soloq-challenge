/* sfx.js — efectos de sonido de Ranked y del draft (sin música ni archivos: se sintetizan con Web Audio).
   Los navegadores no dejan sonar nada hasta que el usuario hace clic o toca una tecla en la página: el primer
   clic "desbloquea" el audio. Se pueden silenciar con SFX.toggle() (queda guardado en este navegador). */
window.SFX = (function(){
  let ctx = null, master = null, noiseBuf = null;
  const KEY = 'sqc_sfx_muted';
  let muted = false; try { muted = localStorage.getItem(KEY) === '1'; } catch (e) {}
  function ac(){
    if (!ctx){
      const C = window.AudioContext || window.webkitAudioContext; if (!C) return null;
      ctx = new C(); master = ctx.createGain(); master.gain.value = 0.45; master.connect(ctx.destination);
    }
    return ctx;
  }
  const unlock = () => { const c = ac(); if (c && c.state === 'suspended') c.resume().catch(() => {}); };
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, unlock, { passive: true }));
  const ready = () => { if (muted) return null; const c = ac(); if (!c || c.state !== 'running') return null; return c; };

  // un tono con envolvente (ataque corto, caída exponencial) y deslizamiento opcional de frecuencia
  function tone(freq, dur, o){
    o = o || {}; const c = ready(); if (!c) return;
    const t0 = c.currentTime + (o.delay || 0), g = c.createGain(), osc = c.createOscillator();
    osc.type = o.type || 'sine'; osc.frequency.setValueAtTime(freq, t0);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(o.slide, t0 + dur);
    const v = (o.vol == null ? 0.5 : o.vol);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(v, t0 + (o.attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master); osc.start(t0); osc.stop(t0 + dur + 0.02);
  }
  // ráfaga de ruido filtrado (golpes, "whoosh")
  function noise(dur, o){
    o = o || {}; const c = ready(); if (!c) return;
    if (!noiseBuf){ noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const t0 = c.currentTime + (o.delay || 0), src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = noiseBuf; f.type = o.filter || 'lowpass'; f.frequency.setValueAtTime(o.from || 2000, t0);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(o.vol || 0.4, t0 + (o.attack || 0.01)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master); src.start(t0); src.stop(t0 + dur + 0.02);
  }
  const S = {
    // ¡partida encontrada!: arpegio brillante, dos veces
    found(){ [0, 0.55].forEach(d => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.32, { type: 'triangle', vol: 0.45, delay: d + i * 0.09 }))); },
    accept(){ tone(660, 0.12, { type: 'triangle', vol: 0.45 }); tone(990, 0.22, { type: 'triangle', vol: 0.45, delay: 0.09 }); },
    queue(){ tone(520, 0.1, { type: 'sine', vol: 0.35 }); tone(780, 0.16, { type: 'sine', vol: 0.3, delay: 0.08 }); },
    cancel(){ tone(600, 0.12, { type: 'sine', vol: 0.3, slide: 380 }); },
    // cambio de fase del draft
    phase(){ noise(0.45, { filter: 'bandpass', from: 400, to: 3000, vol: 0.18 }); tone(392, 0.4, { type: 'triangle', vol: 0.25, delay: 0.05 }); tone(587.33, 0.45, { type: 'triangle', vol: 0.22, delay: 0.12 }); },
    // ¡es tu turno!: campana
    turn(){ [880, 1318.5].forEach((f, i) => tone(f, 0.9, { type: 'sine', vol: 0.4 - i * 0.12, attack: 0.004 })); tone(1760, 0.5, { type: 'sine', vol: 0.12, delay: 0.02 }); },
    select(){ tone(1250, 0.045, { type: 'square', vol: 0.08 }); },
    // campeón fijado: golpe grave + brillo
    lock(){ noise(0.22, { from: 900, to: 120, vol: 0.35 }); tone(140, 0.35, { type: 'sine', vol: 0.55, slide: 55 }); tone(784, 0.45, { type: 'triangle', vol: 0.18, delay: 0.04 }); tone(1174.7, 0.5, { type: 'triangle', vol: 0.12, delay: 0.08 }); },
    // ban: golpe descendente
    ban(){ noise(0.18, { from: 1500, to: 200, vol: 0.3 }); tone(330, 0.32, { type: 'sawtooth', vol: 0.16, slide: 110 }); },
    tick(){ tone(1000, 0.05, { type: 'square', vol: 0.09 }); },
    tickLast(){ tone(1500, 0.07, { type: 'square', vol: 0.13 }); },
    // solicitud recibida (cambio de rol, de turno, de campeón, de ban…)
    notify(){ tone(740, 0.12, { type: 'sine', vol: 0.4, slide: 990 }); tone(1180, 0.18, { type: 'sine', vol: 0.3, delay: 0.1 }); },
    // alerta: alguien pidió cambiar un pick o un ban (dos "ding-dong" seguidos, más notorio)
    alert(){ [0, 0.32].forEach(d => { tone(988, 0.16, { type: 'triangle', vol: 0.5, delay: d }); tone(1319, 0.24, { type: 'triangle', vol: 0.45, delay: d + 0.12 }); }); },
    // fin del draft
    done(){ [392, 523.25, 659.25, 783.99].forEach((f, i) => tone(f, 0.5, { type: 'triangle', vol: 0.35, delay: i * 0.11 })); },
    win(){ [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, 0.55, { type: 'triangle', vol: 0.35, delay: i * 0.1 })); },
    lose(){ [440, 349.23, 293.66].forEach((f, i) => tone(f, 0.6, { type: 'triangle', vol: 0.32, delay: i * 0.16 })); },
    get muted(){ return muted; },
    toggle(){ muted = !muted; try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) {} if (!muted){ unlock(); setTimeout(() => S.select(), 30); } return muted; },
  };
  return S;
})();
