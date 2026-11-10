ALTER TABLE server_archives ADD COLUMN sealed_at TIMESTAMP WITH TIME ZONE;
UPDATE server_archives SET sealed_at = updated_at WHERE status = 'ARCHIVED';

CREATE TABLE collector_credentials (
    server_id UUID PRIMARY KEY REFERENCES server_archives(id),
    token_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Cross-server player identities and counters are serialized while a batch commits.
-- Reads remain concurrent; each transaction is bounded to 1000 events / 1 MiB.
CREATE TABLE ingestion_mutex (id INTEGER PRIMARY KEY);
INSERT INTO ingestion_mutex(id) VALUES (1);
CREATE TABLE telemetry_settings (id INTEGER PRIMARY KEY, statistics_zone VARCHAR(64));
INSERT INTO telemetry_settings(id, statistics_zone) VALUES (1, NULL);

CREATE TABLE collector_state (
    server_id UUID PRIMARY KEY REFERENCES server_archives(id),
    collector_version VARCHAR(64) NOT NULL,
    bds_version VARCHAR(64) NOT NULL,
    levi_lamina_version VARCHAR(64) NOT NULL,
    boot_id UUID NOT NULL,
    reported_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL,
    pending_events BIGINT NOT NULL
);
CREATE TABLE collector_capabilities (
    server_id UUID NOT NULL REFERENCES server_archives(id),
    metric VARCHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL,
    quality VARCHAR(16),
    algorithm_version VARCHAR(64),
    dimension_aware BOOLEAN NOT NULL,
    reported_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY(server_id, metric)
);
CREATE TABLE metric_coverage (
    server_id UUID NOT NULL REFERENCES server_archives(id),
    metric VARCHAR(64) NOT NULL,
    quality VARCHAR(16) NOT NULL,
    algorithm_version VARCHAR(64) NOT NULL,
    dimension_aware BOOLEAN NOT NULL,
    first_observed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_observed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY(server_id, metric, quality, algorithm_version)
);

CREATE TABLE players (
    player_key VARCHAR(64) PRIMARY KEY,
    current_name VARCHAR(80) NOT NULL,
    name_observed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    first_seen_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE TABLE player_names (
    player_key VARCHAR(64) NOT NULL REFERENCES players(player_key),
    name VARCHAR(80) NOT NULL,
    first_seen_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY(player_key, name)
);
CREATE TABLE player_servers (
    server_id UUID NOT NULL REFERENCES server_archives(id),
    player_key VARCHAR(64) NOT NULL REFERENCES players(player_key),
    first_seen_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY(server_id, player_key)
);
CREATE TABLE telemetry_batches (
    server_id UUID NOT NULL REFERENCES server_archives(id),
    batch_id UUID NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    event_count INTEGER NOT NULL,
    received_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY(server_id, batch_id)
);
CREATE TABLE telemetry_events (
    server_id UUID NOT NULL REFERENCES server_archives(id),
    event_id UUID NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    player_key VARCHAR(64) NOT NULL REFERENCES players(player_key),
    kind VARCHAR(16) NOT NULL,
    dimension VARCHAR(80) NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY(server_id, event_id)
);
CREATE INDEX idx_telemetry_events_time ON telemetry_events(server_id, occurred_at);
CREATE TABLE player_sessions (
    server_id UUID NOT NULL REFERENCES server_archives(id),
    session_id UUID NOT NULL,
    player_key VARCHAR(64) NOT NULL REFERENCES players(player_key),
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    checkpoint_at TIMESTAMP WITH TIME ZONE NOT NULL,
    sequence_number BIGINT NOT NULL,
    online_millis BIGINT NOT NULL CHECK (online_millis >= 0),
    ended BOOLEAN NOT NULL,
    end_reason VARCHAR(16),
    PRIMARY KEY(server_id, session_id)
);
CREATE INDEX idx_sessions_player ON player_sessions(player_key, server_id);
CREATE TABLE daily_statistics (
    server_id UUID NOT NULL REFERENCES server_archives(id),
    player_key VARCHAR(64) NOT NULL REFERENCES players(player_key),
    statistic_day DATE NOT NULL,
    metric VARCHAR(64) NOT NULL,
    dimension VARCHAR(80) NOT NULL,
    subject VARCHAR(128) NOT NULL,
    category VARCHAR(16) NOT NULL,
    quality VARCHAR(16) NOT NULL,
    algorithm_version VARCHAR(64) NOT NULL,
    statistic_value BIGINT NOT NULL CHECK (statistic_value >= 0),
    PRIMARY KEY(server_id, player_key, statistic_day, metric, dimension, subject, quality, algorithm_version)
);
CREATE INDEX idx_daily_query ON daily_statistics(metric, statistic_day, server_id);
CREATE TABLE player_deaths (
    server_id UUID NOT NULL REFERENCES server_archives(id),
    event_id UUID NOT NULL,
    player_key VARCHAR(64) NOT NULL REFERENCES players(player_key),
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
    dimension VARCHAR(80) NOT NULL,
    cause VARCHAR(80) NOT NULL,
    killer_type VARCHAR(128),
    PRIMARY KEY(server_id, event_id)
);
CREATE INDEX idx_deaths_player_time ON player_deaths(player_key, occurred_at);
