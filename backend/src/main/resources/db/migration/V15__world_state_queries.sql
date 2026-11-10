CREATE TABLE world_queries (
    id UUID PRIMARY KEY,
    agent_id UUID NOT NULL REFERENCES agent_accounts(id),
    server_id UUID NOT NULL REFERENCES server_archives(id),
    request_id UUID NOT NULL,
    target_hash VARCHAR(64) NOT NULL,
    request_json TEXT NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    lease_id UUID,
    boot_id UUID,
    lease_until TIMESTAMP WITH TIME ZONE,
    result_json TEXT,
    observed_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(agent_id, request_id)
);
CREATE INDEX idx_world_queries_pending ON world_queries(server_id, status, created_at);
CREATE TABLE world_state_cache (
    server_id UUID NOT NULL REFERENCES server_archives(id),
    target_hash VARCHAR(64) NOT NULL,
    observed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY(server_id, target_hash)
);
