-- Accounts synchronised from the organisation's directory: where a mapping comes from, and when the
-- synchronisation last wrote it (an unchanged row keeps its date).
ALTER TABLE user_mappings
  ADD COLUMN department text,
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ldap')),
  ADD COLUMN synced_at timestamptz;
