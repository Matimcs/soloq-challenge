# SoloQ Challenge — Overlay Overwolf (MVP)

Overlay **inyectado** en League (como Porofessor), por lo que **se ve al compartir la
ventana de LoL en Discord/OBS**, a diferencia del overlay de Electron (`../overlay`),
que es una ventana aparte y solo se ve compartiendo el monitor completo.

Estado: **MVP**. Muestra la tarjeta de standing (puesto, elo, V/D, LP de sesión y cuánto
LP falta para pasar al de arriba). Datos desde el backend (`players.json`). El Riot ID se
configura a mano la primera vez (⚙). Pendiente: auto-detección por LCU, panel completo,
Blue Shells y mensajes del admin.

## Probarlo (modo desarrollador)

1. Instala el cliente de **Overwolf**: https://www.overwolf.com/
2. Abre la **Overwolf Developer Console**:
   - Bandeja/dock de Overwolf → engranaje → **Support** → **Development options** → **Open**
   - (o directamente la app "Overwolf Developer Tools")
3. Click en **Load unpacked extension** y elige esta carpeta `overwolf/`
   (la que tiene `manifest.json`).
4. La app queda instalada localmente. Abre **League of Legends**:
   - Al entrar al cliente/partida, el overlay aparece arriba-izquierda.
   - **Alt+X** lo muestra/oculta.
   - Click en **⚙** para poner tu Riot ID (Nombre#TAG).
5. Para probar la captura: en Discord comparte **la ventana de League** (no el monitor)
   con el juego en **Sin bordes/Borderless**. El overlay debe verse en el stream.

## Publicar para el equipo (después)

Para repartirlo sin que cada uno cargue la carpeta a mano, se sube a Overwolf como app
**privada/no listada** (requiere cuenta de desarrollador de Overwolf). Lo vemos cuando el
MVP esté aprobado.

## Estructura

- `manifest.json` — metadata, targeting de LoL (game id 5426), ventana in-game, hotkey Alt+X.
- `background.html` / `background.js` — controlador: abre/cierra el overlay con el juego, hotkey.
- `ingame.html` / `ingame.js` — la tarjeta de standing (in_game window, inyectada).
- `icons/` — íconos de la app.
