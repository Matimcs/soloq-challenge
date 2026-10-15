// Manda la sesión (si hay) en todas las consultas a /api del propio sitio. El servidor decide qué entrega:
// la organización ve todo; los externos y visitantes no ven lo sensible (análisis, smurfs, live games,
// encuentros, historiales). Va en el <head> de cada página, antes que cualquier otro script.
(function () {
  var orig = window.fetch;
  if (!orig) return;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var same = /^\/api\//.test(url) || /^api\//.test(url) || url.indexOf(location.origin + '/api/') === 0;
      var t = same ? localStorage.getItem('sqc_token') : null;
      if (t) {
        init = init || {};
        var h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
        if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + t);
        init = Object.assign({}, init, { headers: h });
      }
    } catch (e) {}
    return orig.call(this, input, init);
  };
})();
