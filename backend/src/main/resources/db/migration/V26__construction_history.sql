CREATE TABLE construction_scene_snapshots (
 id UUID PRIMARY KEY, project_id UUID NOT NULL, revision INTEGER NOT NULL,
 version BIGINT NOT NULL, saved_at TIMESTAMP WITH TIME ZONE NOT NULL,
 observed_at TIMESTAMP WITH TIME ZONE, sections BIGINT NOT NULL,
 UNIQUE(project_id,revision,version),
 FOREIGN KEY(project_id,revision) REFERENCES construction_phases(project_id,revision) ON DELETE CASCADE
);
CREATE INDEX idx_scene_history_time ON construction_scene_snapshots(project_id,revision,saved_at,id);
CREATE TABLE construction_scene_blobs (
 project_id UUID NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
 hash VARCHAR(64) NOT NULL, data_json TEXT NOT NULL,
 PRIMARY KEY(project_id,hash)
);
CREATE TABLE construction_scene_snapshot_parts (
 snapshot_id UUID NOT NULL REFERENCES construction_scene_snapshots(id) ON DELETE CASCADE,
 project_id UUID NOT NULL, hash VARCHAR(64) NOT NULL,
 sx INTEGER NOT NULL,sy INTEGER NOT NULL,sz INTEGER NOT NULL,
 observed_at TIMESTAMP WITH TIME ZONE NOT NULL,
 PRIMARY KEY(snapshot_id,sx,sy,sz),
 FOREIGN KEY(project_id,hash) REFERENCES construction_scene_blobs(project_id,hash)
);
CREATE INDEX idx_project_event_position ON construction_events(project_id,revision,x,y,z,occurred_at,event_id);
