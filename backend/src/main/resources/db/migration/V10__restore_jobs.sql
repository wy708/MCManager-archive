ALTER TABLE backup_hosts ADD COLUMN restore_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE restore_jobs (
    id UUID PRIMARY KEY,
    request_id UUID NOT NULL UNIQUE,
    backup_id UUID NOT NULL REFERENCES game_backups(id),
    source_server_id UUID NOT NULL REFERENCES server_archives(id),
    target_server_id UUID NOT NULL REFERENCES server_archives(id),
    host_id UUID NOT NULL REFERENCES backup_hosts(id),
    mode VARCHAR(16) NOT NULL CHECK (mode IN ('DISABLED','CONTINUE','FORK')),
    destination_name VARCHAR(64) NOT NULL,
    destination_key VARCHAR(128) NOT NULL,
    note VARCHAR(1000) NOT NULL,
    fork_name VARCHAR(64),
    fork_start_date DATE,
    status VARCHAR(16) NOT NULL CHECK (status IN ('QUEUED','CLAIMED','RUNNING','READY','FAILED','UNCERTAIN','CANCELLED')),
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    attempt_id UUID,
    source_backup_id UUID NOT NULL,
    archive_sha256 VARCHAR(64) NOT NULL,
    archive_bytes BIGINT NOT NULL,
    file_count INTEGER NOT NULL,
    source_summary TEXT NOT NULL,
    collector_hash VARCHAR(64),
    restoration_id UUID UNIQUE,
    error_code VARCHAR(48),
    resolution_note VARCHAR(1000),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(host_id,destination_key)
);
CREATE TABLE restore_attempts (
    id UUID PRIMARY KEY,
    claim_request_id UUID NOT NULL UNIQUE,
    job_id UUID NOT NULL REFERENCES restore_jobs(id),
    host_id UUID NOT NULL REFERENCES backup_hosts(id),
    runner_id UUID NOT NULL,
    lease_until TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX idx_restore_host_status ON restore_jobs(host_id,status,created_at,id);
CREATE INDEX idx_restore_backup_status ON restore_jobs(backup_id,status);
