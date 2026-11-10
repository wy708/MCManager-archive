CREATE TABLE qq_binding_codes (
    server_id UUID NOT NULL REFERENCES server_archives(id),
    request_id UUID NOT NULL,
    player_key VARCHAR(64) NOT NULL,
    code_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_qq VARCHAR(20),
    PRIMARY KEY(server_id, request_id),
    UNIQUE(server_id, code_hash)
);
CREATE INDEX idx_qq_codes_expiry ON qq_binding_codes(expires_at);
CREATE TABLE qq_player_bindings (
    id UUID PRIMARY KEY,
    server_id UUID NOT NULL REFERENCES server_archives(id),
    qq_id VARCHAR(20) NOT NULL,
    player_key VARCHAR(64) NOT NULL,
    bound_at TIMESTAMP WITH TIME ZONE NOT NULL,
    agent_id UUID NOT NULL REFERENCES agent_accounts(id),
    UNIQUE(server_id, qq_id),
    UNIQUE(server_id, player_key)
);
CREATE TABLE qq_binding_attempts (
    agent_id UUID NOT NULL REFERENCES agent_accounts(id),
    server_id UUID NOT NULL REFERENCES server_archives(id),
    window_at TIMESTAMP WITH TIME ZONE NOT NULL,
    attempts INTEGER NOT NULL,
    PRIMARY KEY(agent_id, server_id)
);
