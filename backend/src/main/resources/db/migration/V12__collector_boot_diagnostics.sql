CREATE TABLE collector_boot_diagnostics (
    server_id UUID NOT NULL REFERENCES server_archives(id),
    boot_id UUID NOT NULL,
    latest_sequence BIGINT NOT NULL,
    reported_at TIMESTAMP WITH TIME ZONE NOT NULL,
    queued_events INTEGER NOT NULL,
    rejected_submissions BIGINT NOT NULL,
    capture_gaps BIGINT NOT NULL,
    disk_error BOOLEAN NOT NULL,
    disk_faults BIGINT NOT NULL,
    final_report BOOLEAN NOT NULL,
    PRIMARY KEY (server_id, boot_id)
);
CREATE INDEX idx_collector_boot_diagnostics_time ON collector_boot_diagnostics(server_id, reported_at);
