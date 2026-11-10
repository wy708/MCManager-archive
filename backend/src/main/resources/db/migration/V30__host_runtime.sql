ALTER TABLE server_runtime_samples ADD COLUMN host_cpu_percent DOUBLE PRECISION;
ALTER TABLE server_runtime_samples ADD COLUMN host_logical_processors INTEGER;
ALTER TABLE server_runtime_samples ADD COLUMN host_network_receive_bps DOUBLE PRECISION;
ALTER TABLE server_runtime_samples ADD COLUMN host_network_send_bps DOUBLE PRECISION;
ALTER TABLE server_runtime_samples ADD COLUMN host_disks_json TEXT;
