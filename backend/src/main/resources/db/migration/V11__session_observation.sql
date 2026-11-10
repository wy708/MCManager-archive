ALTER TABLE player_sessions ADD COLUMN start_reason VARCHAR(16);
ALTER TABLE player_sessions ADD CONSTRAINT player_sessions_start_reason_check
    CHECK (start_reason IN ('JOIN', 'OBSERVED'));
