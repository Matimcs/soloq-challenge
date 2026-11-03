// Instalador WEB (chico): un .exe de ~1-2 MB que al abrirlo descarga la app desde GitHub y la instala.
// Se publica ADEMÁS del instalador completo (que sigue usando el auto-update), en el mismo release.
// Uso: npm run publish-web   (después de npm run publish-app; requiere `gh` con sesión)
const { execSync } = require('child_process'), fs = require('fs'), path = require('path');
const pkg = require('./package.json'), v = pkg.version, REPO = 'Matimcs/soloq-overlay-releases';
const pkgFile = `${pkg.name}-${v}-x64.nsis.7z`;                       // paquete de la app que descarga el instalador web
const url = `https://github.com/${REPO}/releases/download/v${v}/${pkgFile}`;
const run = c => { console.log('> ' + c); execSync(c, { stdio: 'inherit' }); };

run(`npx electron-builder --win nsis-web --publish never -c.nsisWeb.appPackageUrl=${url} -c.nsisWeb.artifactName=SoloQ-Overlay-Web-Setup.\${ext}`);
const dir = path.join(__dirname, 'dist', 'nsis-web');
const stub = path.join(dir, 'SoloQ-Overlay-Web-Setup.exe'), pack = path.join(dir, pkgFile);
for (const f of [stub, pack]) if (!fs.existsSync(f)) throw new Error('No se generó ' + f);
console.log(`Instalador web: ${(fs.statSync(stub).size / 1048576).toFixed(1)} MB · paquete: ${(fs.statSync(pack).size / 1048576).toFixed(1)} MB`);
if (process.argv.includes('--no-upload')) process.exit(0);
run(`gh release upload v${v} "${stub}" "${pack}" -R ${REPO} --clobber`);
console.log('Listo: https://github.com/' + REPO + '/releases/latest/download/SoloQ-Overlay-Web-Setup.exe');
