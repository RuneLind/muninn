ALTER TABLE threads
  ADD COLUMN auto_respond_paused BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE threads
  ADD COLUMN pause_reason TEXT;
