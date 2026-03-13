-- Connectors: named AI connector configurations
CREATE TABLE connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  connector_type TEXT NOT NULL,
  model TEXT,
  base_url TEXT,
  thinking_max_tokens INTEGER,
  timeout_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_connectors_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER connectors_updated_at
  BEFORE UPDATE ON connectors
  FOR EACH ROW
  EXECUTE FUNCTION update_connectors_updated_at();

-- Link threads to connectors
ALTER TABLE threads ADD COLUMN connector_id UUID REFERENCES connectors(id);
