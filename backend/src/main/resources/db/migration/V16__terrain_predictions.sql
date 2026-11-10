CREATE TABLE terrain_profiles (
    server_id UUID PRIMARY KEY REFERENCES server_archives(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL,
    seed_value VARCHAR(20) NOT NULL,
    generation_version VARCHAR(24) NOT NULL,
    revision UUID NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);
ALTER TABLE world_state_cache ADD COLUMN target_kind VARCHAR(16);
ALTER TABLE world_state_cache ADD COLUMN dimension VARCHAR(40);
ALTER TABLE world_state_cache ADD COLUMN pos_x INTEGER;
ALTER TABLE world_state_cache ADD COLUMN pos_y INTEGER;
ALTER TABLE world_state_cache ADD COLUMN pos_z INTEGER;
CREATE INDEX idx_world_cache_location ON world_state_cache(server_id,dimension,pos_x,pos_z);
