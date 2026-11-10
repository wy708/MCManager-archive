CREATE TABLE construction_projects (
 id UUID PRIMARY KEY, server_id UUID NOT NULL REFERENCES server_archives(id),
 name VARCHAR(80) NOT NULL, owner_key VARCHAR(80) NOT NULL, owner_name VARCHAR(80) NOT NULL,
 dimension VARCHAR(80) NOT NULL, min_x INTEGER NOT NULL, max_x INTEGER NOT NULL,
 min_z INTEGER NOT NULL, max_z INTEGER NOT NULL, revision INTEGER NOT NULL,
 status VARCHAR(16) NOT NULL, created_at TIMESTAMP WITH TIME ZONE NOT NULL,
 UNIQUE(server_id,owner_key,name)
);
CREATE TABLE construction_phases (
 project_id UUID NOT NULL REFERENCES construction_projects(id), revision INTEGER NOT NULL,
 started_at TIMESTAMP WITH TIME ZONE NOT NULL, ended_at TIMESTAMP WITH TIME ZONE,
 status VARCHAR(16) NOT NULL, dimension VARCHAR(80) NOT NULL,
 min_x INTEGER NOT NULL,max_x INTEGER NOT NULL,min_z INTEGER NOT NULL,max_z INTEGER NOT NULL,
 summary TEXT, map_image BYTEA, map_metadata TEXT, map_at TIMESTAMP WITH TIME ZONE,
 PRIMARY KEY(project_id,revision)
);
CREATE TABLE construction_events (
 project_id UUID NOT NULL REFERENCES construction_projects(id), revision INTEGER NOT NULL,
 event_id UUID NOT NULL, occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
 player_key VARCHAR(80) NOT NULL, player_name VARCHAR(80) NOT NULL,
 operation VARCHAR(16) NOT NULL, block VARCHAR(128) NOT NULL,
 x INTEGER NOT NULL,y INTEGER NOT NULL,z INTEGER NOT NULL,
 PRIMARY KEY(project_id,event_id)
);
CREATE INDEX idx_project_event_phase ON construction_events(project_id,revision,occurred_at);
CREATE INDEX idx_project_scope ON construction_projects(server_id,status,dimension,min_x,max_x,min_z,max_z);
CREATE TABLE construction_requests (
 server_id UUID NOT NULL, request_id UUID NOT NULL, actor_key VARCHAR(80) NOT NULL,
 payload_hash VARCHAR(64) NOT NULL, project_id UUID NOT NULL REFERENCES construction_projects(id),
 revision INTEGER NOT NULL, action VARCHAR(16) NOT NULL,
 PRIMARY KEY(server_id,request_id)
);
