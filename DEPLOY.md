# Deploy del SoloQ Challenge

El backend (`backend/server.js`) sirve **la web + la API** en un solo servicio Node.
La base de datos ya vive en **Supabase** (no se despliega, solo se conecta).

## Arquitectura online

```
   [ Tu PC ]                         [ Render / Railway ]        [ Supabase ]
  runner.js  ──POST /api/ingest──►   server.js (web+API)  ──────►  Postgres
  (Riot key)   (players.json)         :PORT                        (auth, shells…)
                                          ▲
                              jugadores ──┘  (navegador)
```

- **Auth, Blue Shells, tickets, admin** → 100% online (usan Supabase). Funcionan sin tu PC.
- **Ranking / Live Games** → los genera `runner.js` en tu PC (tiene la Riot key) y los
  **empuja** al server con `POST /api/ingest`. Si tu PC/runner no está corriendo, el
  ranking queda en la última foto recibida (no se rompe, solo no se actualiza).

---

## Opción recomendada: Render (plan Free)

### 1. Subir el código a GitHub
1. Crea un repo **privado** en GitHub (ej. `soloq-challenge`).
2. Desde esta carpeta:
   ```bash
   git remote add origin https://github.com/<tu-usuario>/soloq-challenge.git
   git branch -M main
   git push -u origin main
   ```
   (El `.gitignore` ya excluye `backend/.env` y `cache/` — tus secretos NO se suben.)

### 2. Crear el Web Service en Render
1. https://render.com → **New +** → **Web Service** → conecta tu repo.
2. Configuración:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
3. **Environment** → agrega estas variables:

   | Key | Valor |
   |-----|-------|
   | `DATABASE_URL` | (el mismo de tu `backend/.env`, la cadena de Supabase) |
   | `JWT_SECRET` | (el mismo de tu `backend/.env`) |
   | `INGEST_SECRET` | inventa uno largo y aleatorio (ej. 32+ caracteres) |

4. **Create Web Service.** Render te da una URL tipo `https://soloq-challenge.onrender.com`.

### 3. Apuntar tu runner local al server
En tu PC, corre el runner con las variables de ingesta:
```bash
set RIOT_API_KEY=<app1>
set INGEST_URL=https://soloq-challenge.onrender.com
set INGEST_SECRET=<el mismo que pusiste en Render>
node runner.js
```
Cada ~90s empujará el ranking al sitio online. Verás `↑ ranking enviado al server online`.

---

## Notas
- **Free tier de Render** duerme tras ~15 min sin visitas; la primera visita después
  tarda ~50s en despertar. Para el evento en vivo puedes upgradear a Starter (~7 USD/mes)
  o simplemente abrir el sitio unos segundos antes.
- El overlay (`overlay/`) sigue corriendo **local** en cada PC — no se despliega.
- Si cambias la Riot key, borra `cache/` (los PUUIDs se cifran por key).
- Railway o Fly.io también sirven; los pasos son equivalentes (Root = `backend`,
  Start = `npm start`, mismas env vars).
