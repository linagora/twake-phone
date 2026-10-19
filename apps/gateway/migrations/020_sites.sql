-- Step 6c (ADR 0024): the sites of an organisation for its emergency calls. A site has a postal address, a trunk and
-- the number of that trunk it presents when one of its people calls an emergency number (the operator ties it to the
-- address of the site); a person (user id of the directory) is in one site at most. A trunk removed takes its sites.
CREATE TABLE sites (
  tenant_id  text NOT NULL,
  id         text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  name       text NOT NULL,
  address    text NOT NULL,
  trunk_id   text NOT NULL,
  number     text NOT NULL CHECK (number ~ '^\+[1-9][0-9]{6,14}$'),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, trunk_id) REFERENCES trunk_configs (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE site_members (
  tenant_id text NOT NULL,
  user_id   text NOT NULL,
  site_id   text NOT NULL,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX site_members_site_idx ON site_members (tenant_id, site_id);
