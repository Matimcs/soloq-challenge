/* Servidor estático mínimo para previsualizar la web localmente.
   Uso: node serve.js   → http://localhost:8123 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8123;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css' };

http.createServer((req, res) => {
  let file = decodeURIComponent(req.url.split('?')[0]);
  if (file === '/' ) file = '/index.html';
  const full = path.join(__dirname, file);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
