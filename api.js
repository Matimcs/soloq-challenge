/* Helper de API compartido. Guarda el JWT y hace las llamadas al backend. */
window.SQC = (function(){
  const TOKEN_KEY = 'sqc_token';
  const token = () => localStorage.getItem(TOKEN_KEY);
  const setToken = t => localStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem('sqc_admin'); localStorage.removeItem('sqc_user'); };

  async function api(path, { method = 'GET', body } = {}){
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: 'Bearer ' + token() } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || ('Error ' + res.status));
    return data;
  }
  // Devuelve el usuario actual (o null si no hay sesión válida)
  async function me(){
    if (!token()) return null;
    try { return (await api('/me')).user; } catch { clearToken(); return null; }
  }
  function logout(){ clearToken(); }

  // Pinta la navbar según la sesión: revela Blue Shells/Tickets/Admin y
  // convierte "Iniciar sesión" en la píldora de usuario (avatar + nickname).
  function paintNav(user){
    const g = id => document.getElementById(id);
    const acc = g('nav-account'), logout = g('logout');
    if (user){
      ['nav-blueshell','nav-ticket'].forEach(id => { const e = g(id); if (e) e.style.display = ''; });
      if (user.isAdmin){ const a = g('nav-admin'); if (a) a.style.display = ''; localStorage.setItem('sqc_admin','1'); }
      else localStorage.removeItem('sqc_admin');
      // Cachea el perfil para pintar la píldora al instante en la próxima página (sin flash).
      localStorage.setItem('sqc_user', JSON.stringify({ nickname:user.nickname, avatar:user.avatar || null, isAdmin: !!user.isAdmin }));
      if (acc){
        acc.className = 'user-pill'; acc.href = 'perfil.html';
        acc.innerHTML = (user.avatar
          ? '<img class="uava" src="' + user.avatar + '">'
          : '<span class="uava">' + (user.nickname || '?').slice(0,1).toUpperCase() + '</span>')
          + '<span>' + (user.nickname || '') + '</span>';
      }
      if (logout){ logout.style.display = ''; logout.onclick = () => { clearToken(); location.href = 'index.html'; }; }
    } else {
      if (acc){ acc.className = 'login-pill'; acc.href = 'cuenta.html'; acc.textContent = 'Iniciar sesión'; }
      if (logout) logout.style.display = 'none';
      localStorage.removeItem('sqc_user');
    }
  }
  // Para páginas públicas: obtiene la sesión y pinta la navbar sola.
  async function mountNav(){ try { paintNav(await me()); } catch { paintNav(null); } navBadges(); }
  // Revelado optimista e inmediato (sin esperar la API) para evitar el parpadeo:
  // si hay token, muestra Blue Shells/Tickets ya; Admin si el flag está guardado.
  function preNav(){
    if (!token()) return;
    try { const u = JSON.parse(localStorage.getItem('sqc_user') || 'null'); if (u) paintNav(u); } catch {}
  }

  // Badges rojos de la navbar (Live Games = partidas en vivo; Encuentros = nuevos sin ver).
  function setBadge(id, n){ const el = document.getElementById(id); if (!el) return; el.textContent = n > 99 ? '99+' : n; el.style.display = n > 0 ? '' : 'none'; }
  async function navBadges(data){
    try { if (!data){ const r = await fetch('/players.json?t=' + Date.now(), { cache:'no-store' }); if (r.ok) data = await r.json(); } } catch {}
    const live = (data && Array.isArray(data.liveGames)) ? data.liveGames.length : 0;
    let seen = 0; try { seen = Number(localStorage.getItem('sqc_enc_lastseen') || 0) || 0; } catch {}
    const encNew = (data && Array.isArray(data.encounters)) ? data.encounters.filter(e => (e.end || 0) > seen).length : 0;
    setBadge('nav-live-count', live);
    setBadge('nav-enc-count', encNew);
  }

  return { api, token, setToken, clearToken, me, logout, paintNav, mountNav, preNav, navBadges };
})();
