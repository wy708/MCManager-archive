ALTER TABLE game_backups ADD COLUMN lease_at TIMESTAMP WITH TIME ZONE;
UPDATE game_backups SET lease_at=updated_at WHERE status IN ('RECEIVING', 'VERIFYING');
