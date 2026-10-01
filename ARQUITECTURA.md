# Cómo funciona la página — SoloQ Challenge + Torneos

> Léeme antes de tocar tracking, rangos, roster, estadísticas o torneos.
> Este doc existe para no volver a **mezclar datos de torneos con el SoloQ Challenge**.

## Son DOS productos separados

### A) SoloQ Challenge (lo principal del sitio)
Ranking de LP, Live Games, **Encuentros**, **Estadísticas**, **Récords**, SoloQdle.
Trackea **solo a la crew** (los ~pocos jugadores del SoloQ Challenge), nunca a rivales de torneos.

- **Quién se trackea** = lista fija `RIOT_IDS` en `fetch-data.js` + tabla **`roster`** (cuentas que agrega el admin) + tabla **`smurfs`** + mains de **`users`** registrados.
  El server escribe `roster-extra.json` desde esas tablas y `fetch-data.js` lo lee.
- **Runner**: `fetch-data.js` corre embebido en `backend/server.js` (`startEmbeddedRunner`) cada `INTERVAL_SEC` (90s). Escribe `players.json` / `players.js` y cachés en `cache/` + tabla `fetch_cache` (Supabase).
- **Key de Riot del runner principal**: `RIOT_API_KEY` en `backend/.env`.

### B) Torneos (aparte, en la sección Torneos)
- **uLeague** (`uleague.html`) — torneo principal actual. Primera pestaña (nav "Torneos" → `uleague.html`).
- **UDPORROS** (`torneos.html`) — **cerrado/congelado** (rangos ya no se actualizan; cron `refresh-tourney-pl.yml` desactivado).
- uLeague es **100% independiente** del tracker principal. Sus datos salen de `uleague-data.json`, que genera `tools/uleague/sync.js` leyendo el fixture (Google Sheets) + bases, y bajando rangos con la **key de torneos** (`ULEAGUE_RIOT_KEY`).
- Cuando el usuario diga **"actualiza"** (uLeague): `node tools/uleague/sync.js` (usa `ULEAGUE_RIOT_KEY`). No toca nada del SoloQ Challenge.

## ⛔ Reglas de oro (lo que causó la contaminación)

1. **NUNCA metas jugadores de torneos (uLeague, rivales, etc.) en la tabla `roster`** ni en `RIOT_IDS`. Eso hace que el runner los trackee y sus partidas entren a **Encuentros, Estadísticas, Récords y ranking** del SoloQ Challenge.
2. Los rangos/datos de uLeague se muestran **solo** en `uleague.html`, leyendo `uleague-data.json`. No pasan por el tracker principal.
3. `reflagTournament()` en `fetch-data.js` **solo pone `is_tournament=true`, nunca false**. Si contaminaste, hay que limpiar a mano (ver receta abajo).
4. El ranking principal (`index.html`) debe mostrar solo la crew. Si aparecen desconocidos → alguien entró al `roster`/`RIOT_IDS`.

## Riot keys (en `backend/.env`, gitignored — nunca commitear)
- `RIOT_API_KEY` → runner principal del SoloQ Challenge.
- `ULEAGUE_RIOT_KEY` → sync de uLeague/torneos (`tools/uleague/sync.js`).
- Son keys distintas a propósito, para que el sync de torneos no choque (429) con el runner principal.

## Dónde vive cada dato
- **Ranking / Live / Encuentros**: `players.json` (en memoria `liveData`, blob `fetch_cache.id='players'`). Se regenera cada ciclo desde los trackeados.
- **Encuentros**: se arman en `fetch-data.js` desde `matchStore` solo de los trackeados; blob `fetch_cache.id='encounters'` (se **acumula**, se recorta a 60).
- **Estadísticas / Menciones / Récords**: consultan la tabla **`match_participants`** con `WHERE is_tournament=true`. Caché corta en memoria del server.
- **Récord de LP**: tabla `peak_lp` (rid → peak_abs).
- **uLeague**: `uleague-data.json` (equipos, rosters, rangos, fase suiza, bracket).

## Receta: limpiar contaminación (si entran ajenos al SoloQ Challenge)
Set a purgar = cuentas ajenas (p.ej. jugadores de equipos no-UCH de uLeague) que NO sean crew.
```sql
-- 1) Sacar de estadísticas/menciones/encuentros-build
UPDATE match_participants SET is_tournament=false WHERE lower(riotid) = ANY($purgar);
-- 2) Récord de LP
DELETE FROM peak_lp WHERE lower(rid) = ANY($purgar);
-- 3) roster (si quedaron)
DELETE FROM roster WHERE lower(riotid) = ANY($purgar);
```
- Limpiar también los blobs `fetch_cache` (`encounters`, `players`) quitando esos jugadores.
- Si los encuentros contaminados siguen en memoria, **reiniciar el runner** (redeploy / restart en Render): el blob se recarga limpio y, como ya no están trackeados, no se vuelven a agregar.
- Ojo: filtrar por "no está en el set actual" **sobre-borra** (hay historial legítimo de la era UDPORROS). Purga por el set EXACTO de ajenos (p.ej. jugadores de los equipos no-UCH del `uleague-data.json`).

## Deploy
- Render despliega al hacer push a `main`. El **auto-deploy puede estar apagado/atrasado**: si los cambios no aparecen en vivo, hacer **Manual Deploy → Deploy latest commit** en Render.
- `backend/.env` está gitignoreado (secrets nunca se suben). Las keys también viven en el entorno de Render.
