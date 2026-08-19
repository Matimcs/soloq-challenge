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
    CREATE TABLE IF NOT EXISTS team_members (   -- equipo por cuenta (para cuentas NO registradas, seed del admin)
      riotid     TEXT PRIMARY KEY,
      team       TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('✔ Esquema Postgres listo');
}

module.exports = { pool, q, q1, init };
