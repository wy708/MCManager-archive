package org.mcmanager.archive;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
class ArchiveRepository {
    private final JdbcTemplate jdbc;
    ArchiveRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    private ServerArchive row(ResultSet rs, int index) throws SQLException {
        return new ServerArchive(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("description"),
                rs.getObject("start_date", LocalDate.class), rs.getObject("end_date", LocalDate.class), rs.getString("status"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant(), rs.getObject("updated_at", OffsetDateTime.class).toInstant());
    }

    List<ServerArchive> list() {
        return jdbc.query("SELECT * FROM server_archives ORDER BY start_date DESC, created_at DESC, id", this::row);
    }

    Optional<ServerArchive> find(UUID id) {
        return jdbc.query("SELECT * FROM server_archives WHERE id = ?", this::row, id).stream().findFirst();
    }
    Optional<ServerArchive> lock(UUID id) {
        return jdbc.query("SELECT * FROM server_archives WHERE id = ? FOR UPDATE", this::row, id).stream().findFirst();
    }
    boolean hasTelemetry(UUID id) {
        return jdbc.queryForObject("SELECT (SELECT COUNT(*) FROM telemetry_events WHERE server_id=?) + (SELECT COUNT(*) FROM container_audit WHERE server_id=?)", Long.class, id, id) > 0;
    }
    java.time.Instant latestTelemetry(UUID id) {
        OffsetDateTime latest = jdbc.queryForObject("SELECT MAX(occurred_at) FROM (SELECT occurred_at FROM telemetry_events WHERE server_id=? UNION ALL SELECT occurred_at FROM container_audit WHERE server_id=?) events", OffsetDateTime.class, id, id);
        return latest == null ? null : latest.toInstant();
    }

    ServerArchive create(String name, String description, LocalDate startDate) {
        UUID id = UUID.randomUUID();
        Instant now = Instant.now();
        jdbc.update("INSERT INTO server_archives(id, name, description, start_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'RECORDING', ?, ?)",
                id, name, description, startDate, OffsetDateTime.ofInstant(now, java.time.ZoneOffset.UTC), OffsetDateTime.ofInstant(now, java.time.ZoneOffset.UTC));
        return find(id).orElseThrow();
    }

    int edit(UUID id, String name, String description, LocalDate startDate) {
        // The date predicate also preserves the invariant when edit and archive race.
        return jdbc.update("UPDATE server_archives SET name = ?, description = ?, start_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (end_date IS NULL OR end_date >= ?)",
                name, description, startDate, id, startDate);
    }

    int archive(UUID id, LocalDate endDate) {
        return jdbc.update("UPDATE server_archives SET status = 'ARCHIVED', end_date = ?, sealed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'RECORDING' AND start_date <= ?",
                endDate, id, endDate);
    }
}
