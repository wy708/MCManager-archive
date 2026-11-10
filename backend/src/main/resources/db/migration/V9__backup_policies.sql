CREATE TABLE backup_policies (
    server_id UUID PRIMARY KEY REFERENCES server_archives(id),
    host_id UUID NOT NULL REFERENCES backup_hosts(id),
    revision BIGINT NOT NULL CHECK (revision > 0),
    enabled BOOLEAN NOT NULL,
    interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 1 AND 43200),
    next_run_at TIMESTAMP WITH TIME ZONE,
    retention_enabled BOOLEAN NOT NULL,
    keep_count INTEGER CHECK (keep_count BETWEEN 1 AND 1000),
    max_age_days INTEGER CHECK (max_age_days BETWEEN 1 AND 3650),
    last_checked_at TIMESTAMP WITH TIME ZONE,
    last_outcome VARCHAR(48),
    last_job_id UUID,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    CHECK (NOT enabled OR next_run_at IS NOT NULL),
    CHECK (NOT retention_enabled OR keep_count IS NOT NULL OR max_age_days IS NOT NULL)
);
ALTER TABLE backup_jobs ADD COLUMN policy_server_id UUID REFERENCES backup_policies(server_id);
ALTER TABLE backup_jobs ADD COLUMN scheduled_for TIMESTAMP WITH TIME ZONE;
CREATE UNIQUE INDEX idx_backup_jobs_policy_slot ON backup_jobs(policy_server_id, scheduled_for);
CREATE TABLE backup_retention_events (
    backup_id UUID PRIMARY KEY REFERENCES game_backups(id),
    server_id UUID NOT NULL REFERENCES server_archives(id),
    policy_revision BIGINT NOT NULL,
    reason VARCHAR(16) NOT NULL CHECK (reason IN ('COUNT', 'AGE')),
    state VARCHAR(16) NOT NULL CHECK (state IN ('DELETING', 'DELETED', 'FAILED')),
    archive_bytes BIGINT NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    failure_code VARCHAR(48)
);
CREATE INDEX idx_backup_retention_server ON backup_retention_events(server_id, started_at);
CREATE INDEX idx_backups_retention ON game_backups(server_id, kind, permanent, status, created_at, id);
