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
    CREATE TABLE IF NOT EXISTS roster_hidden (  -- cuentas eliminadas del ranking por el admin
      riotid     TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    -- Columnas nuevas (perfil): 3 campeones más jugados, slot del Flash, confirmación del admin.
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS champ1     TEXT;
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS champ2     TEXT;
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS champ3     TEXT;
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS flash_slot INTEGER;   -- 1 (D) | 2 (F)
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS confirmed  BOOLEAN DEFAULT false;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS extra      TEXT;       -- ej. campeón aleatorio asignado
  `);
  console.log('✔ Esquema Postgres listo');
}

module.exports = { pool, q, q1, init };
