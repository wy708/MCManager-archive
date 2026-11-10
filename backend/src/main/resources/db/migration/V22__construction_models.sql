ALTER TABLE construction_phases ADD COLUMN model_version BIGINT NOT NULL DEFAULT 0;
CREATE TABLE construction_model_sections (
 project_id UUID NOT NULL, revision INTEGER NOT NULL,
 sx INTEGER NOT NULL, sy INTEGER NOT NULL, sz INTEGER NOT NULL,
 observed_at TIMESTAMP WITH TIME ZONE NOT NULL,
 payload_hash VARCHAR(64) NOT NULL, data_json TEXT NOT NULL, non_air INTEGER NOT NULL,
 PRIMARY KEY(project_id,revision,sx,sy,sz),
 FOREIGN KEY(project_id,revision) REFERENCES construction_phases(project_id,revision) ON DELETE CASCADE
);
