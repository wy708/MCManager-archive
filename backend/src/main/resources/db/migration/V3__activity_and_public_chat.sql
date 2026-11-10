-- This cursor is transactional, not a sequence: committed cursors cannot arrive out of order.
-- All writers first lock ingestion_mutex, including future Agent message receipts.
CREATE TABLE activity_stream (id INTEGER PRIMARY KEY, last_cursor BIGINT NOT NULL, retention_days INTEGER NOT NULL);
INSERT INTO activity_stream(id, last_cursor, retention_days) VALUES (1, 0, 30);
CREATE TABLE activity_feed (
    cursor_id BIGINT PRIMARY KEY,
    server_id UUID NOT NULL REFERENCES server_archives(id),
    event_id UUID NOT NULL,
    source VARCHAR(16) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
    received_at TIMESTAMP WITH TIME ZONE NOT NULL,
    player_key VARCHAR(64),
    actor_name VARCHAR(80) NOT NULL,
    dimension VARCHAR(80),
    metric VARCHAR(64),
    event_value BIGINT,
    subject VARCHAR(128),
    cause VARCHAR(80),
    message_text VARCHAR(1024),
    UNIQUE(server_id, event_id)
);
CREATE INDEX idx_activity_server_cursor ON activity_feed(server_id, cursor_id);
CREATE INDEX idx_activity_received ON activity_feed(received_at);
CREATE TABLE player_server_names (
    server_id UUID NOT NULL,
    player_key VARCHAR(64) NOT NULL,
    name VARCHAR(80) NOT NULL,
    first_seen_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY(server_id, player_key, name),
    FOREIGN KEY(server_id, player_key) REFERENCES player_servers(server_id, player_key)
);
-- Old global name history cannot prove which server observed a name; do not backfill it.
