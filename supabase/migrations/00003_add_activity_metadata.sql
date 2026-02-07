-- Add metadata column for timing breakdown and other structured data
ALTER TABLE activity_log ADD COLUMN metadata JSONB;
