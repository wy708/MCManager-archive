CREATE TABLE agent_accounts (
    id UUID PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    revoked BOOLEAN NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE TABLE agent_server_access (
    agent_id UUID NOT NULL REFERENCES agent_accounts(id),
    server_id UUID NOT NULL REFERENCES server_archives(id),
    scope VARCHAR(16) NOT NULL,
    PRIMARY KEY(agent_id, server_id, scope)
);
CREATE TABLE server_commands (
    id UUID PRIMARY KEY,
    agent_id UUID NOT NULL REFERENCES agent_accounts(id),
    server_id UUID NOT NULL REFERENCES server_archives(id),
    request_id UUID NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    reply_to UUID,
    target_player_key VARCHAR(64),
    agent_name VARCHAR(64) NOT NULL,
    message_text VARCHAR(512) NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    lease_id UUID,
    boot_id UUID,
    lease_until TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    error_code VARCHAR(64),
    UNIQUE(agent_id, request_id),
    UNIQUE(agent_id, server_id, reply_to)
);
CREATE INDEX idx_commands_pending ON server_commands(server_id, status, created_at);
