/* Base de datos Postgres del SoloQ Challenge (pg).
   Requiere la variable de entorno DATABASE_URL (cadena de conexión). */
const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url){ console.error('❌ Falta DATABASE_URL (la cadena de conexión de Postgres/Supabase).'); process.exit(1); }

const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
const pool = new Pool({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } });

const q  = (sql, params = []) => pool.query(sql, params).then(r => r.rows);
const q1 = (sql, params = []) => q(sql, params).then(rows => rows[0] || null);

async function init(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname      TEXT NOT NULL,
      realname      TEXT NOT NULL,
      riotid        TEXT NOT NULL,
      main          TEXT,
      discord       TEXT,
      pos1          TEXT,
      pos2          TEXT,
      avatar        TEXT,
      is_admin      BOOLEAN DEFAULT false,
      created_at    TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS shells (
      id         SERIAL PRIMARY KEY,
      owner_id   INTEGER NOT NULL,
      motivo     TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS events (
      id         SERIAL PRIMARY KEY,
      kind       TEXT NOT NULL,                 -- 'sent' | 'received'
      user_id    INTEGER NOT NULL,
      other      TEXT,
      castigo    TEXT NOT NULL,
      estado     TEXT DEFAULT 'pendiente',      -- 'pendiente' | 'cumplido'
      bounce     BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      asunto     TEXT,
      mensaje    TEXT,
      estado     TEXT DEFAULT 'abierto',        -- 'abierto' | 'resuelto'
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS verifications (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      castigo    TEXT,
      estado     TEXT DEFAULT 'pendiente',      -- 'pendiente' | 'aprobado' | 'rechazado'
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS drops (
      id         SERIAL PRIMARY KEY,
      reto       TEXT NOT NULL,
      estado     TEXT DEFAULT 'activo',         -- 'activo' | 'cerrado'
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS fetch_cache (
      id         TEXT PRIMARY KEY,              -- 'puuids' | 'ranks' | 'matches'
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS fetch_seed (     -- semilla inicial; el runner nunca la sobrescribe
      id         TEXT PRIMARY KEY,              -- 'puuids' | 'matches'
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS roster (         -- cuentas agregadas manualmente por el admin
      riotid     TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS smurfs (         -- cuentas smurf asociadas a un jugador (aparecen en el ranking)
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      riotid     TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS smurfs_user_idx ON smurfs (user_id);
    CREATE TABLE IF NOT EXISTS roster_hidden (  -- cuentas eliminadas del ranking por el admin
      riotid     TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS match_participants ( -- datos crudos: cada participante de cada partida de un jugador del torneo (historial para stats)
      match_id      TEXT,
      puuid         TEXT,
      riotid        TEXT,
      name          TEXT,
      champion      TEXT,
      position      TEXT,
      team_id       INTEGER,
      win           BOOLEAN,
      kills         INTEGER,
      deaths        INTEGER,
      assists       INTEGER,
      is_tournament BOOLEAN DEFAULT false,
      game_end      BIGINT,
      cs            INTEGER,
      gold          INTEGER,
      damage        INTEGER,
      vision        INTEGER,
      penta         INTEGER,
      first_blood   BOOLEAN,
      champ_level   INTEGER,
      duration      INTEGER,
      created_at    TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (match_id, puuid)
    );
    CREATE INDEX IF NOT EXISTS mp_puuid_idx        ON match_participants (puuid);
    CREATE INDEX IF NOT EXISTS mp_tournament_idx   ON match_participants (is_tournament);
    -- columnas nuevas (para tablas ya creadas)
    ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS cs          INTEGER;
    ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS gold        INTEGER;
    ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS damage      INTEGER;
    ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS vision      INTEGER;
    ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS penta       INTEGER;
    ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS first_blood BOOLEAN;
    ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS champ_level INTEGER;
    ALTER TABLE match_participants ADD COLUMN IF NOT EXISTS duration    INTEGER;
    CREATE TABLE IF NOT EXISTS matches (        -- partida COMPLETA (match-v5 entero) para historial detallado
      match_id   TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      game_end   BIGINT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS admin_messages ( -- mensajes (texto y/o voz) del admin al overlay de un jugador
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      text       TEXT,
      audio      TEXT,                           -- data URL base64 del audio grabado (opcional)
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS admin_msg_user_idx ON admin_messages (user_id, id);
    CREATE TABLE IF NOT EXISTS shell_log (      -- registro permanente de Blue Shells CONSEGUIDAS (el granter otorga)
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER,
      motivo     TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS shell_log_user_idx ON shell_log (user_id);
    CREATE TABLE IF NOT EXISTS overlay_reports ( -- datos que el overlay (exe) manda para ahorrar API a la nube
      riotid     TEXT PRIMARY KEY,
      entry      JSONB,                          -- entrada de liga (tier, rank, leaguePoints, wins, losses)
      in_game    BOOLEAN DEFAULT false,          -- si está en una SoloQ ahora mismo
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS shell_progress ( -- progreso para otorgar Blue Shells automáticamente
      user_id     INTEGER PRIMARY KEY,
      last_end    BIGINT  DEFAULT 0,            -- gameEndTimestamp (ms) de la última partida procesada
      streak      INTEGER DEFAULT 0,            -- racha de victorias en curso
      champ_wins  JSONB   DEFAULT '[]',         -- campeones distintos ganados (hacia "5 distintos")
      castigo_wins INTEGER DEFAULT 0,           -- victorias jugando con castigo (hacia "5 con castigo")
      updated_at  TIMESTAMPTZ DEFAULT now()
    );
    -- Progreso POR CUENTA (main + smurfs): { riotid: {last_end, streak, champ_wins, castigo_wins} }.
    -- Así el granter otorga shells por logros hechos en cualquier cuenta del jugador, no solo la main.
    ALTER TABLE shell_progress ADD COLUMN IF NOT EXISTS accounts JSONB DEFAULT '{}';
    -- Columnas nuevas (perfil): 3 campeones más jugados, slot del Flash, confirmación del admin.
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS champ1     TEXT;
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS champ2     TEXT;
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS champ3     TEXT;
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS flash_slot INTEGER;   -- 1 (D) | 2 (F)
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS confirmed  BOOLEAN DEFAULT false;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS extra      TEXT;       -- ej. campeón aleatorio asignado
    ALTER TABLE events ADD COLUMN IF NOT EXISTS audio      TEXT;       -- audio opcional (voz) que suena al recibir la shell
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS team       TEXT;       -- equipo de la U: Exilium | Tide | Zenith (o null)
    CREATE TABLE IF NOT EXISTS team_members (   -- equipo(s) por cuenta; ahora un jugador puede tener varios
      riotid     TEXT,
      team       TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    -- Multi-equipo: la PK pasa de (riotid) a (riotid, team) para permitir varios equipos por cuenta.
    DELETE FROM team_members WHERE team IS NULL OR team='';
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='team_members'::regclass AND contype='p' AND array_length(conkey,1)=1) THEN
        ALTER TABLE team_members DROP CONSTRAINT team_members_pkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='team_members'::regclass AND contype='p') THEN
        ALTER TABLE team_members ADD PRIMARY KEY (riotid, team);
      END IF;
    END $$;
    -- Pasa los equipos elegidos por los jugadores (users.team) a team_members (fuente única del display).
    INSERT INTO team_members (riotid, team)
      SELECT riotid, team FROM users WHERE team IS NOT NULL AND team<>''
      ON CONFLICT (riotid, team) DO NOTHING;
    -- Rol en el equipo (puede diferir del de SoloQ) y titular/suplente, por (cuenta, equipo).
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS role    TEXT;             -- TOP|JUNGLE|MID|ADC|SUPPORT|null
    ALTER TABLE team_members ADD COLUMN IF NOT EXISTS starter BOOLEAN DEFAULT true;  -- true=titular, false=suplente
    -- Vínculos smurf→main para jugadores NO registrados (para que los rosters muestren una sola
    -- fila por jugador con el elo de su cuenta más alta, igual que hace 'smurfs' con los registrados).
    CREATE TABLE IF NOT EXISTS smurf_links (
      smurf_riotid TEXT PRIMARY KEY,
      main_riotid  TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT now()
    );
    -- Resultados de la fase de grupos del torneo (los pone el admin desde la web).
    -- match_id = "grupo|ronda|local|visita"; winner = nombre del equipo ganador.
    CREATE TABLE IF NOT EXISTS tourney_results (
      match_id   TEXT PRIMARY KEY,
      winner     TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    -- Etiqueta manual de un jugador (PRO / Streamer / Competitivo), la pone el admin.
    CREATE TABLE IF NOT EXISTS player_tags (
      riotid     TEXT PRIMARY KEY,
      tag        TEXT NOT NULL,           -- PRO | STREAMER | COMPETITIVO
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    -- Transmisiones en vivo (streams) que el admin agrega a mano para verlas embebidas en la web.
    CREATE TABLE IF NOT EXISTS streams (
      id         SERIAL PRIMARY KEY,
      url        TEXT NOT NULL,
      label      TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- Seguridad: activa Row-Level Security en TODAS las tablas del schema public. Sin políticas,
    -- esto bloquea la API pública (anon) de Supabase (PostgREST). El backend NO se ve afectado
    -- porque se conecta como 'postgres' (bypassrls). Idempotente y cubre tablas futuras.
    DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      END LOOP;
    END $$;
  `);
  console.log('✔ Esquema Postgres listo');
}

module.exports = { pool, q, q1, init };
