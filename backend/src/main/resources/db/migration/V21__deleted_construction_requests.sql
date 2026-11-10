-- Keep only retry identifiers after an administrator deletes an entire project.
-- Prevent a delayed original CREATE request from resurrecting deleted content.
CREATE TABLE construction_deleted_requests (
    server_id UUID NOT NULL,
    request_id UUID NOT NULL,
    deleted_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY(server_id,request_id)
);
