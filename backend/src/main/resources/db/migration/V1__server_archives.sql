CREATE TABLE server_archives (
    id UUID PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(2000) NOT NULL DEFAULT '',
    start_date DATE NOT NULL,
    end_date DATE,
    status VARCHAR(16) NOT NULL DEFAULT 'RECORDING',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT archive_status CHECK (status IN ('RECORDING', 'ARCHIVED')),
    CONSTRAINT archive_dates CHECK (end_date IS NULL OR end_date >= start_date),
    CONSTRAINT archive_end CHECK ((status = 'RECORDING' AND end_date IS NULL) OR (status = 'ARCHIVED' AND end_date IS NOT NULL))
);
CREATE INDEX idx_server_archives_start_date ON server_archives(start_date);
