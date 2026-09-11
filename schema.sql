-- Blitzclip schema. Applied lazily on first request (every statement is idempotent).

CREATE TABLE IF NOT EXISTS users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  tanks         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replays (
  id             bigserial PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256         text NOT NULL,
  file_name      text NOT NULL,
  file_size      integer NOT NULL,
  blob_url       text,
  blob_pathname  text,
  tank_id        integer,
  vehicle_code   text,
  vehicle        text,
  map            text,
  player         text,
  duration       real,
  max_shot       integer,
  total_damage   integer,
  kills          integer,
  shots          jsonb NOT NULL,
  error          text,
  parser_version text,
  battle_time    timestamptz,
  status         text NOT NULL DEFAULT 'new',
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, sha256)
);

CREATE INDEX IF NOT EXISTS replays_user_created ON replays (user_id, created_at DESC);
