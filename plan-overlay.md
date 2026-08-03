# SoloQ Challenge — Plan del Overlay (Overwolf) + Sistema Blue Shell

> Documento de referencia para el equipo. Cubre (1) la app/overlay de Overwolf y
> (2) el sistema Blue Shell con sus normas y qué puede verificar la app.

---

## 1. Objetivo

App de **Overwolf** que corre en el PC de cada jugador del challenge y:
- Muestra un **overlay in-game** con estado del challenge y Blue Shells.
- **Captura datos locales** que la API pública de Riot no da (bien o rápido) y los empuja al backend → enriquece la web.
- **Verifica el cumplimiento** de los Blue Shells (incluidos los que la API pública no ve).

Todo se informa al jugador al instalar (consentimiento explícito). Solo se leen **datos propios del jugador** o **públicos del rival** (su rango).

---

## 2. App Overwolf — features

### 2.1 Overlay (lo que ve el jugador)

| Feature | Fuente | Nota |
|---|---|---|
| ⚔️ Rival del challenge detectado | Live Client Data (10 Riot IDs) × roster | "Estás contra Rakyz (#7 HIGH)" + su rango |
| 🤝 Aliado del challenge | Igual | "Tienes de aliado a X" |
| Estado Blue Shell | Backend | Inventario (máx. 3) + castigo activo ("Sin castigo actual") |
| Tu standing | Backend | #7 HIGH · MASTER 493 LP · sesión 12W-6L · +288 LP |
| Proyección de LP | Promedios ±LP | "Ganas ≈ +26 → subes a #6 · Pierdes ≈ -19" |
| ⭐ Partida Aegis | Tracking LP | Avisa si el game vale ~doble LP |
| Head-to-head | Backend | "Vs Rakyz: 2-1 este mes" |
| Post-game | LP exacto + backend | "+28 LP · subiste 2 puestos · +1 Blue Shell" |
| Ticker de ladder | Backend | "🔺 Te pasó Petu" · "Entraste al Top 5" |

### 2.2 Datos que captura para la web

| Dato | Resuelve |
|---|---|
| **Rol/posición de cada jugador** | Llena la columna **Rol** (vacía) y los roles del Live Games |
| **Roles que pusiste en la cola** (primario/secundario) | Auto-verifica **Autofill** y fija tu rol antes de jugar (LCU lobby) |
| **±LP exacto por partida** | ±LP y Aegis **precisos** (no estimados) |
| **Inicio/fin de partida instantáneo** | Live Games sin delay del spectator |
| **KDA / CS / oro en vivo** | Scoreboard del Live Games con stats reales |
| **Enfrentamientos internos** | Marcar "clásicos del challenge" |
| **Presencia (online/en cliente)** | Badge "online" en la web |
| **Detección de condiciones de logro** | Pentakill, 20 kills, KDA>20, etc. (ver §4.5) |

---

## 3. Plan técnico

### 3.1 Stack
App = **HTML/CSS/JS** (o React) en el runtime de Overwolf.
- **`manifest.json`**: LoL (game id **5426**), permisos de Game Events, ventanas.
- **Ventana background** (controller, sin UI): escucha eventos y habla con el backend.
- **Ventana in-game overlay** (transparente): tarjeta de Blue Shells / rival / standing.
- **Ventana desktop** (opcional): dashboard fuera de partida.

### 3.2 Fuentes de datos
- **Overwolf GEP** (Game Events Provider) → eventos normalizados: `match_start/end`, `kill`, `death`, `gold`, `level`, roster…
- **Live Client Data API** (local `:2999`) → 10 jugadores, campeones, KDA, CS, posiciones, ítems, eventos, en vivo.
- **LCU** (cliente de escritorio) → **LP/rango exacto**, **runas**, **keybinds**, **settings**, champ select, historial.

### 3.3 Integración con el backend
```
App Overwolf (PC jugador) --HTTPS--> backend (endpoint nuevo) --> DB --> web
```
La app **empuja** eventos (partida, LP exacto, rol, KDA, cumplimiento de shells). Bonus: **menos requests a Riot**.

### 3.4 Identidad
**Código de vinculación de un solo uso**: el jugador genera un código en la web y lo pega en la app → liga su cuenta ↔ instalación.

### 3.5 Privacidad / consentimiento
- Pantalla de consentimiento al primer arranque (qué se lee, a dónde va, para qué).
- Recolecta **solo lo divulgado**. Desvincular/desinstalar limpio.

### 3.6 Fases
- **MVP**: overlay (standing + Blue Shells + rival) + captura de **rol** y **±LP exacto**.
- **v2**: post-game con LP exacto, KDA en vivo al Live Games, head-to-head.
- **v3**: notificaciones de ladder, bounties, metas, sonidos.

### 3.7 Distribución
Grupo cerrado → builds **directos/unlisted**, sin store. Público → aprobación de Overwolf.

---

## 4. Sistema Blue Shell

Nerfs/handicaps estilo Mario Kart que los participantes se lanzan para equilibrar la ladder. Total **11 cartas = 100%**.

### 4.1 Las 11 Blue Shells (aparición + verificación)

| # | Blue Shell | % | ¿API pública lo ve? | ¿Overlay lo verifica? |
|---|---|---|---|---|
| 1 | Sin tus 3 campeones más jugados | 17% | ✅ auto | ✅ |
| 2 | Una partida con Yuumi | 11% | ✅ auto | ✅ |
| 3 | Campeón aleatorio | 11% | ✅ auto | ✅ |
| 4 | Sin Flash | 11% | ✅ auto | ✅ |
| 5 | Autofill | 11% | ✅ auto | ✅ |
| 6 | Sin botas y sin pies veloces | 11% | ✅ auto | ✅ |
| 7 | Hechizos cambiados (Flash de slot) | 6% | ⚠️ slot sí, keybind no | ✅ **detecta el re-mapeo tramposo** |
| 8 | Sensibilidad x2 | 6% | ❌ manual | ✅ **con baseline guardada** |
| 9 | Sin objetos completos hasta min 15 | 6% | ❌ manual | ✅ **lee ítems en vivo** |
| 10 | Reverse | 6% | — (no es castigo, rebota) | — |
| 11 | Runas predeterminadas | 4% | ❌ manual | ✅ **lee runas del cliente** |

> **El gran aporte del overlay:** los 3 que la API pública NO ve (runas, sensibilidad, sin ítems a min 15) pasan a **auto-verificables**, y "hechizos cambiados" se blinda contra el truco del keybind.

### 4.2 Detalle de verificación por la app

- **Autofill** → compara los **roles que pusiste en la cola** (LCU lobby: primario/secundario) con el **rol asignado**. Si jugaste fuera de tus preferencias → autofill cumplido.
- **Runas predeterminadas** → LCU expone las runas elegidas + las 3 páginas recomendadas del juego. Se compara pertenencia.
- **Hechizos cambiados** → cruza **slot del hechizo** (Live Client Data) con **keybind** (settings del cliente). Si el Flash está en el slot correcto pero el bind se cambió para reinvertir (dedo igual) → **trampa detectada**. Se exige keybinds en default.
- **Sensibilidad x2** → la app guarda la **sensibilidad base** del jugador (al instalar) y verifica ≈ 2× esa base cuando el castigo está activo.
- **Sin objetos completos hasta min 15** → lee ítems en vivo; marca si completó un ítem grande antes del min 15.
- **Snapshots en momentos clave** (lock-in de campeón, inicio de partida) para dificultar la trampa. Verificación = buena fe + disuasión + registro para admins (no es jaula perfecta si cierran la app).

---

### 4.3 Normas — Cooldown de recepción
Tiempo mínimo entre recibir una shell y poder recibir otra:
- **Top 1**: sin cooldown (barra libre).
- **Top 2**: 4 h.
- **Top 3-5**: 6 h.
- **Resto de participantes**: 12 h.

### 4.4 Normas — Reverse
- Cuanto **más abajo** esté tu objetivo, más probable es que la shell **rebote** y cumplas tú el castigo. Tirar **hacia arriba** es más seguro.
- Probabilidad de rebote según puesto del objetivo:
  - Top 1: **1%** · Top 2: **2%** · Top 3: **3%** · Top 4: **4%** · Top 5: **5%** · Resto: **15%**.
- Si sale Reverse **no haces nada**: rebota sola y el castigo se sortea para quien la lanzó.

### 4.5 Normas — Inventario
- **Máximo 3 Blue Shells** por participante. Si ganas más con el inventario lleno, **se pierden**.

### 4.6 Normas — Lanzamiento
- **No** puedes lanzar una Blue Shell si estás en **cola**, **selección de campeón** o **en partida**.
- Tampoco en los **minutos posteriores** a terminar una partida, mientras se procesa el resultado.
- **Motivo:** que nadie se quite la shell de encima al ver que va a perderla. Se revisa a mano y queda **registrada la hora exacta** de cada lanzamiento.

### 4.7 Normas — Cómo conseguir una Blue Shell
- Pentakill.
- 20 kills en una partida.
- 30 asistencias en una partida.
- Racha de 5 victorias.
- Comeback de 10.000 de oro.
- KDA perfecto superior a 20.
- Ganar una partida de 45 minutos o más.
- Cada 5 victorias con un campeón distinto.
- Ganar a alguien que lleve una Blue Shell → **se la roba**.

> Varias son **auto-detectables** por la app/GEP en tiempo real (pentakill, 20 kills, 30 asist., KDA>20, duración ≥45 min, rachas). El "robo" requiere detección de enfrentamiento interno + estado de inventario en el backend.

### 4.8 Normas — Drop diario
- **Deshabilitado de inicio.** Solo se activa si circulan muy pocas Blue Shells.
- Si se activa: la organización lanza un reto sencillo (ganar una partida, triple kill, first blood…) y se lleva la shell **el primero** que lo cumpla en una partida **iniciada tras el lanzamiento**.

### 4.9 Normas — Cumplimiento del castigo
- Se cumple en la **siguiente partida posible**.
- **Excepción**: si ya habías aceptado la cola cuando te llegó. Si te llega antes de que salte, puedes pausar la cola (no es obligatorio).
- **Excepción**: si es imposible cumplirlo (p. ej. te toca un campeón y está baneado) → se cumple en la siguiente que puedas.
- **Prohibido sabotear tu propio castigo** para librarte (banear el campeón que te tocó, o maniobras similares para volverlo imposible).
- Jugar partidas **ignorando** un castigo pendiente = incumplir la norma.

### 4.10 Normas — Cómo se da por cumplido
- La **mayoría se detectan solos** al analizar la partida: campeón aleatorio, sin Flash, autofill, Yuumi, hechizos cambiados, sin botas, sin tus 3 campeones.
- **Tres se revisan a mano** porque la API pública no los ve: **runas predeterminadas, sensibilidad x2, sin objetos completos hasta el min 15**. *(→ la app de Overwolf los vuelve auto-verificables, ver §4.1–4.2.)*
- Si el tuyo no se marca solo: puedes **marcarlo desde tu panel de Blue Shell**, abrir un **ticket**, o esperar la **verificación de la organización**.

---

## 5. Login / Signup en la web

Objetivo: identificar al jugador para personalizar su panel y **habilitar las acciones de Blue Shell** (enviar / recibir) según su estado.

### 5.1 Autenticación
- **Ideal — Riot Sign-On (RSO / OAuth de Riot):** verifica identidad Riot real. Requiere aprobación de Riot para RSO.
- **Alternativa simple:** login con email u OAuth (Google) + **vincular el Riot ID**, verificado con el **código de un solo uso** de la app Overwolf (o poniendo un código temporal en el estado/ícono del invocador).

### 5.2 Perfil del usuario
- **Rol principal** (y secundario), Riot ID, avatar.
- El rol principal se setea manual, y la app Overwolf puede **auto-sugerirlo** viendo qué rol encolas más seguido (§2.2).

### 5.3 Panel de Blue Shell (lo que habilita el login)
Según quién eres y tu estado, se muestran solo las opciones válidas:
- **Inventario** (máx. 3), **cooldown de recepción** restante, **castigo activo**.
- **Enviar** una Blue Shell a un objetivo — respetando reglas de §4.6 (bloqueado si estás en cola / champ select / partida / post-partida). Registra la **hora exacta**.
- **Marcar castigo cumplido** (para los de revisión manual) o **abrir ticket** (§4.10).
- **Historial** de shells enviadas / recibidas.
- **Estado de envío**: muestra habilitado/deshabilitado según cooldown, inventario y si el objetivo puede recibir.

### 5.4 Roles y permisos
El login define identidad → el backend sabe qué acciones puede tomar cada usuario (enviar solo si tiene shells y no está en cooldown; el objetivo debe poder recibir). Un rol **admin** para la organización: verificar castigos, activar drop diario, resolver tickets.

---

## 6. Bot de auto-spectate / streaming (futuro)

Bot en un **PC físico dedicado 24/7** que transmite el match en vivo más interesante del challenge (canal tipo "POV en vivo").

### 6.1 Pipeline
```
spectator-v5  →  elegir mejor game  →  lanzar cliente LoL en modo spectator
   →  controlar cámara/POV (Replay API :2999)  →  OBS captura  →  Twitch/YouTube
```
1. **Detección:** spectator-v5 (ya lo usamos) da `gameId`, `platformId` y `observers.encryptionKey` por partida activa.
2. **Lanzar spectator:** cliente de LoL por línea de comandos con host del server spectator + encryptionKey + gameId + región (método documentado).
3. **Cámara/POV:** el cliente en modo replay expone la **Replay API local (:2999, `/replay/...`)** → fijar cámara al Top 1, cambiar velocidad, etc.
4. **Streaming:** OBS captura la ventana; **OBS WebSocket** cambia escenas (ej. "esperando partida").
5. **Transición:** al terminar el game o aparecer uno mejor, cierra y lanza el siguiente.

### 6.2 Director — elegir el match más interesante
```
score(game) = (nº jugadores del challenge en la partida) × 10
            + (bonus si contiene al Top 1)                × 100
            + (LP del jugador más alto presente)
```
Cambiar de partida solo si el nuevo supera al actual por un margen (evita saltos).

### 6.3 Hardware / Vanguard ⚠️
- **Vanguard es obligatorio** para correr el cliente; spectear corre **con** Vanguard activo (lo de "desactivarlo" suele ser info desactualizada).
- **Vanguard bloquea VMs** y exige **TPM 2.0 + Secure Boot** → **no** sirve una VM de la nube. Se necesita un **PC físico real** (mini-PC dedicado) 24/7.
- **Verificar** el comportamiento actual de spectator + Vanguard en LAS **antes de invertir** — es la parte más frágil y Riot lo cambia seguido.

### 6.4 Delay / reglas
- Retraso obligatorio de **~3 min** (integridad competitiva). **No eliminarlo** — habilita stream-sniping y viola reglas.
- Transmitir partidas de participantes está OK (consienten al entrar), manteniendo el delay.

### 6.5 Alcance
Proyecto de infra aparte: PC físico, gestión del ciclo de vida del cliente (lanzar/detectar/controlar/cerrar), OBS automatizado, manejo de caídas/reinicios.

---

## 7. Próximos pasos
1. Definir el endpoint del backend que recibe eventos de la app.
2. Esqueleto de la app Overwolf (manifest + ventana overlay con datos de ejemplo).
3. MVP overlay: standing + Blue Shells + detección de rival + captura de rol y ±LP exacto.
4. Web: login/signup + panel de Blue Shell (enviar/recibir).
5. Futuro: bot de auto-spectate/streaming.
