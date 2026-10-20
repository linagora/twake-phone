-- Step 11c-2 (ADR 0028): the call flows of an organisation, set by an administrator: a sequential group (its members ring
-- one after the other), a queue (callers wait for a free member) or a voice menu (SVI: a digit leads to a number). The
-- flows are the Gateway's: it has Wazo run them and tells OpenSIPS which numbers go there. One number a flow in a tenant.
CREATE TABLE call_flow_configs (
  tenant_id text NOT NULL,
  number    text NOT NULL CHECK (number ~ '^[0-9]{2,16}$'),
  kind      text NOT NULL CHECK (kind IN ('sequential', 'queue', 'menu')),
  name      text NOT NULL,
  members   text[] NOT NULL DEFAULT '{}',
  ring_sec  integer CHECK (ring_sec BETWEEN 5 AND 60),
  wait_sec  integer CHECK (wait_sec BETWEEN 15 AND 600),
  choices   jsonb NOT NULL DEFAULT '{}',
  greeting  text,
  PRIMARY KEY (tenant_id, number)
);
