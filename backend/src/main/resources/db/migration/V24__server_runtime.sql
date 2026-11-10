CREATE TABLE server_runtime_samples (
    server_id UUID NOT NULL REFERENCES server_archives(id) ON DELETE CASCADE,
    boot_id UUID NOT NULL, sequence_number BIGINT NOT NULL,
    observed_at TIMESTAMP WITH TIME ZONE NOT NULL, received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    window_millis BIGINT NOT NULL, uptime_millis BIGINT NOT NULL, ticks BIGINT NOT NULL, players INTEGER NOT NULL,
    last_tick_at TIMESTAMP WITH TIME ZONE, max_tick_interval DOUBLE PRECISION NOT NULL, cpu_percent DOUBLE PRECISION,
    working_set_bytes BIGINT, private_bytes BIGINT, host_memory_total_bytes BIGINT, host_memory_available_bytes BIGINT,
    stopped BOOLEAN NOT NULL, payload_hash VARCHAR(64) NOT NULL,
    PRIMARY KEY(server_id,boot_id,sequence_number)
);
CREATE INDEX idx_runtime_time ON server_runtime_samples(server_id,observed_at DESC);
