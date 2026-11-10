-- Read-side indexes only; no synchronous analytics work in the collector ingest path.
CREATE INDEX idx_activity_server_time_metric ON activity_feed(server_id,occurred_at,metric);
CREATE INDEX idx_session_server_checkpoint ON player_sessions(server_id,checkpoint_at);
