// Instalador FIJO (~1 MB): siempre el mismo .exe (overlay/installer/SoloQ-Overlay-Installer.exe, NO se recompila),
// que al abrirlo descarga la ÚLTIMA versión de la app desde:
//   https://github.com/Matimcs/soloq-overlay-releases/releases/latest/download/<installer/package-name.txt>
// (el instalador web SIEMPRE agrega al final el nombre del paquete con que se compiló — sqc-overlay-0.2.37-x64.nsis.7z —,
//  así que en cada versión se sube el paquete nuevo con ESE mismo nombre).
// Al ser siempre el mismo archivo, Windows SmartScreen le va acumulando reputación (y si algún día se firma, basta una vez).
// En cada versión este script solo arma el paquete de la app y lo sube con ese nombre fijo (+ el instalador fijo)
// al release de la versión. El auto-update de quienes ya la tienen sigue usando el instalador completo (latest.yml).
// Uso: npm run publish-web   (después de npm run publish-app y de marcar el release como latest; requiere `gh`)
const { execSync } = require('child_process'), fs = require('fs'), path = require('path');
const pkg = require('./package.json'), v = pkg.version, REPO = 'Matimcs/soloq-overlay-releases';
const run = c => { console.log('> ' + c); execSync(c, { stdio: 'inherit' }); };
const STUB = path.join(__dirname, 'installer', 'SoloQ-Overlay-Installer.exe');
if (!fs.existsSync(STUB)) throw new Error('Falta el instalador fijo: ' + STUB);
const PKG_NAME = fs.readFileSync(path.join(__dirname, 'installer', 'package-name.txt'), 'utf8').trim();   // nombre que pide el instalador fijo

// el paquete de la app (el .7z que descarga el instalador); el instalador que se genera acá se descarta
run(`npx electron-builder --win nsis-web --publish never -c.nsisWeb.artifactName=descartar-web-setup.\${ext}`);
const built = path.join(__dirname, 'dist', 'nsis-web', `${pkg.name}-${v}-x64.nsis.7z`);
if (!fs.existsSync(built)) throw new Error('No se generó ' + built);
const out = path.join(__dirname, 'dist', 'web-release'); fs.mkdirSync(out, { recursive: true });
const app7z = path.join(out, PKG_NAME);
fs.copyFileSync(built, app7z);
console.log(`Paquete de la app: ${(fs.statSync(app7z).size / 1048576).toFixed(1)} MB · instalador fijo: ${(fs.statSync(STUB).size / 1048576).toFixed(1)} MB`);
if (process.argv.includes('--no-upload')) process.exit(0);
run(`gh release upload v${v} "${STUB}" "${app7z}" -R ${REPO} --clobber`);
console.log('Listo: https://github.com/' + REPO + '/releases/latest/download/SoloQ-Overlay-Installer.exe  (paquete: ' + PKG_NAME + ')');
