# Imágenes de los Blue Shells

Deja aquí un PNG por cada Blue Shell, con **exactamente** estos nombres de archivo
(cuadradas, idealmente 128×128, fondo transparente):

| Blue Shell | Archivo |
|---|---|
| Sin tus 3 campeones más jugados | `sin-3-campeones.png` |
| Una partida con Yuumi | `yuumi.png` |
| Campeón aleatorio | `campeon-aleatorio.png` |
| Sin Flash | `sin-flash.png` |
| Autofill | `autofill.png` |
| Sin botas y sin pies veloces | `sin-botas.png` |
| Hechizos cambiados | `hechizos-cambiados.png` |
| Sensibilidad x2 | `sensibilidad-x2.png` |
| Sin objetos completos hasta min 15 | `sin-objetos-min15.png` |
| Reverse | `reverse.png` |
| Runas predeterminadas | `runas-predeterminadas.png` |

Ruta completa: `overlay/assets/shells/<archivo>.png`

Mientras un archivo no exista, el popup muestra solo el texto (sin imagen) — apenas lo
agregues con el nombre correcto, aparece solo. El mapa nombre→archivo está en
`overlay/main.js` (`SHELL_IMG`).
