/* Helper de API compartido. Guarda el JWT y hace las llamadas al backend. */
window.SQC = (function(){
  const TOKEN_KEY = 'sqc_token';
  const token = () => localStorage.getItem(TOKEN_KEY);
  const setToken = t => localStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

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
      if (user.isAdmin){ const a = g('nav-admin'); if (a) a.style.display = ''; }
      if (acc){
        acc.className = 'user-pill'; acc.href = 'blueshell.html';
        acc.innerHTML = (user.avatar
          ? '<img class="uava" src="' + user.avatar + '">'
          : '<span class="uava">' + (user.nickname || '?').slice(0,1).toUpperCase() + '</span>')
          + '<span>' + (user.nickname || '') + '</span>';
      }
      if (logout){ logout.style.display = ''; logout.onclick = () => { clearToken(); location.href = 'index.html'; }; }
    } else {
      if (acc){ acc.className = 'login-pill'; acc.href = 'cuenta.html'; acc.textContent = 'Iniciar sesión'; }
      if (logout) logout.style.display = 'none';
    }
  }
  // Para páginas públicas: obtiene la sesión y pinta la navbar sola.
  async function mountNav(){ try { paintNav(await me()); } catch { paintNav(null); } }

  return { api, token, setToken, clearToken, me, logout, paintNav, mountNav };
})();
