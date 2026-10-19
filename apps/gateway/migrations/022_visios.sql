-- « Passer en visio » (step 8d, ADR 0026): a conference of a call goes to a room of Meet. The passage is kept here, not in
-- a process: its Meet room, and what became of each person who was in the old room (to call again, being called, called
-- again in place of their call or by a new call, failed, gone). `old_room` is the call's room (one passage per room).
CREATE TABLE IF NOT EXISTS visios (
  old_room      text PRIMARY KEY,
  meet_room     text NOT NULL UNIQUE,
  tenant_id     text NOT NULL,
  owner_user_id text NOT NULL,
  slug          text NOT NULL,
  url           text,
  state         text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'halted', 'left')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visios_by_owner ON visios (tenant_id, owner_user_id);
CREATE TABLE IF NOT EXISTS visio_people (
  old_room text NOT NULL REFERENCES visios (old_room) ON DELETE CASCADE,
  key      text NOT NULL,
  position integer NOT NULL,
  number   text NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('extension', 'number', 'other')),
  status   text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'calling', 'swapped', 'called', 'failed', 'gone')),
  new_id   text,
  reason   text,
  PRIMARY KEY (old_room, key)
);
