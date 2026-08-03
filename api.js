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

  return { api, token, setToken, clearToken, me, logout };
})();
