CREATE TABLE backup_hosts (
    id UUID PRIMARY KEY,
    server_id UUID NOT NULL UNIQUE REFERENCES server_archives(id),
    name VARCHAR(64) NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    runner_id UUID,
    heartbeat_at TIMESTAMP WITH TIME ZONE,
    runtime_state VARCHAR(16),
    version VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE backup_jobs (
    id UUID PRIMARY KEY,
    request_id UUID NOT NULL UNIQUE,
    host_id UUID NOT NULL REFERENCES backup_hosts(id),
    server_id UUID NOT NULL REFERENCES server_archives(id),
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('MANUAL', 'AUTOMATIC', 'FINAL')),
    note VARCHAR(1000) NOT NULL,
    permanent BOOLEAN NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('QUEUED', 'CLAIMED', 'RUNNING', 'UPLOADING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'CANCELLED')),
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    attempt_id UUID,
    backup_id UUID REFERENCES game_backups(id),
    source_backup_id UUID,
    archive_sha256 VARCHAR(64),
    archive_bytes BIGINT,
    error_code VARCHAR(48),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE TABLE backup_job_attempts (
    id UUID PRIMARY KEY,
    claim_request_id UUID NOT NULL UNIQUE,
    job_id UUID NOT NULL REFERENCES backup_jobs(id),
    host_id UUID NOT NULL REFERENCES backup_hosts(id),
    runner_id UUID NOT NULL,
    lease_until TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_backup_jobs_host_status ON backup_jobs(host_id, status, created_at, id);
CREATE INDEX idx_backup_jobs_server_created ON backup_jobs(server_id, created_at, id);
