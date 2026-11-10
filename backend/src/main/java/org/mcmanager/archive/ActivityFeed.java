package org.mcmanager.archive;

import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.TelemetryValidation.*;

@Service
class ActivityFeed {
    record Entry(String cursor, UUID serverId, UUID eventId, String source, String kind, Instant occurredAt,
                 Instant receivedAt, String playerKey, String actorName, String dimension, String metric,
                 String value, String subject, String cause, String text, ConstructionProjects.Position position) {}
    record Page(List<Entry> items, String nextCursor, String highWatermark, boolean hasMore, int retentionDays) {}
    record SessionChat(Page messages, Instant startedAt, Instant confirmedThrough) {}
    private record SessionWindow(String playerKey, Instant startedAt, Instant checkpointAt) {}
    record RetentionPreview(int currentDays, int requestedDays, Instant cutoff, long chatEntries, long behaviorEntries) {}
    record RetentionResult(int retentionDays, int removedEntries, boolean batchLimitReached) {}
    private record Policy(int days, Instant purgeBefore) {
        Instant cutoff(Instant now, int requestedDays) {
            Instant requested = now.minus(Duration.ofDays(requestedDays));
            return purgeBefore != null && purgeBefore.isAfter(requested) ? purgeBefore : requested;
        }
    }
    private static final int PRUNE_LIMIT = 5000;
    private final JdbcTemplate jdbc;
    private final ActivitySignal signal;
    ActivityFeed(JdbcTemplate jdbc, ActivitySignal signal) { this.jdbc = jdbc; this.signal = signal; }

    // Caller holds ingestion_mutex until commit. Feed and statistics commit or roll back together.
    void record(UUID server, TelemetryPayload.Event event) {
        append(server, event.eventId(), "PLAYER", event.kind().name(), event.at(), event.player().key(),
                event.player().name(), event.dimension(), metric(event),
                switch (event.kind()) { case COUNTER -> event.value(); case SESSION -> event.onlineMillis(); default -> 1L; },
                event.subject(), event.cause(), event.text(),event.position());
    }
    void append(UUID server, UUID eventId, String source, String kind, Instant at, String playerKey,
                String name, String dimension, String metric, Long value, String subject, String cause, String text) {
        append(server,eventId,source,kind,at,playerKey,name,dimension,metric,value,subject,cause,text,null);
    }
    void append(UUID server, UUID eventId, String source, String kind, Instant at, String playerKey,
                String name, String dimension, String metric, Long value, String subject, String cause, String text,ConstructionProjects.Position position) {
        jdbc.update("UPDATE activity_stream SET last_cursor = last_cursor + 1 WHERE id = 1");
        long cursor = jdbc.queryForObject("SELECT last_cursor FROM activity_stream WHERE id = 1", Long.class);
        jdbc.update("INSERT INTO activity_feed(cursor_id, server_id, event_id, source, kind, occurred_at, received_at, player_key, actor_name, dimension, metric, event_value, subject, cause, message_text,block_x,block_y,block_z) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?)",
                cursor, server, eventId, source, kind, TelemetryService.time(at), playerKey, name, dimension, metric, value, subject, cause, text,position==null?null:position.x(),position==null?null:position.y(),position==null?null:position.z());
        signal.publishOnCommit();
    }
    Page recent(UUID server, String playerKey, int limit) {
        var cursors = jdbc.queryForList("SELECT cursor_id FROM activity_feed WHERE server_id = ? AND player_key = ? AND kind <> 'CHAT' AND source = 'PLAYER' ORDER BY cursor_id DESC LIMIT ?", Long.class, server, playerKey, limit);
        return read(server, cursors.isEmpty() ? 0 : cursors.getLast() - 1, limit, false, false, playerKey);
    }
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Page read(UUID server, long after, int limit, boolean chat, boolean includeAgents, String playerKey) {
        return read(server, after, limit, chat, includeAgents, playerKey, null);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public SessionChat sessionChat(UUID server, UUID session, long after, int limit) {
        var rows = jdbc.query("""
                SELECT player_key, started_at, checkpoint_at FROM player_sessions WHERE server_id = ? AND session_id = ?
                """, (rs, i) -> new SessionWindow(rs.getString("player_key"),
                TelemetryQueries.instant(rs, "started_at"), TelemetryQueries.instant(rs, "checkpoint_at")), server, session);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "在线会话不存在");
        SessionWindow window = rows.getFirst();
        return new SessionChat(read(server, after, limit, true, false, window.playerKey(), window),
                window.startedAt(), window.checkpointAt());
    }

    private Page read(UUID server, long after, int limit, boolean chat, boolean includeAgents, String playerKey,
                      SessionWindow window) {
        check(after >= 0 && limit >= 1 && limit <= 200, "游标或页大小无效");
        long high = jdbc.queryForObject("SELECT last_cursor FROM activity_stream WHERE id = 1", Long.class);
        check(after <= high, "游标超出当前行为流，请从 0 开始读取");
        Policy policy = policy();
        String where = " WHERE server_id = ? AND cursor_id > ? AND cursor_id <= ? AND received_at >= ?";
        List<Object> args = new ArrayList<>(List.of(server, after, high, TelemetryService.time(policy.cutoff(Instant.now(), policy.days()))));
        // Non-chat tools cannot return chat bodies, including through activity events.
        where += chat ? " AND kind = 'CHAT'" : " AND kind <> 'CHAT'";
        if (!includeAgents) where += " AND source = 'PLAYER'";
        if (playerKey != null) { check(playerKey.length() <= 64, "玩家身份无效"); where += " AND player_key = ?"; args.add(playerKey); }
        if (window != null) {
            where += " AND occurred_at BETWEEN ? AND ?";
            args.add(TelemetryService.time(window.startedAt()));
            args.add(TelemetryService.time(window.checkpointAt()));
        }
        args.add(limit + 1);
        var rows = jdbc.query("SELECT * FROM activity_feed" + where + " ORDER BY cursor_id LIMIT ?", (rs, i) -> new Entry(
                Long.toString(rs.getLong("cursor_id")), rs.getObject("server_id", UUID.class), rs.getObject("event_id", UUID.class),
                rs.getString("source"), rs.getString("kind"), TelemetryQueries.instant(rs, "occurred_at"), TelemetryQueries.instant(rs, "received_at"),
                rs.getString("player_key"), rs.getString("actor_name"), rs.getString("dimension"), rs.getString("metric"),
                rs.getObject("event_value") == null ? null : Long.toString(rs.getLong("event_value")), rs.getString("subject"), rs.getString("cause"), rs.getString("message_text"),rs.getObject("block_x")==null?null:new ConstructionProjects.Position(rs.getInt("block_x"),rs.getInt("block_y"),rs.getInt("block_z"))), args.toArray());
        boolean more = rows.size() > limit;
        List<Entry> items = List.copyOf(rows.subList(0, Math.min(rows.size(), limit)));
        return new Page(items, more ? items.getLast().cursor() : Long.toString(high), Long.toString(high), more, policy.days());
    }
    int retentionDays() {
        return policy().days();
    }
    private Policy policy() {
        return jdbc.queryForObject("SELECT retention_days, purge_before FROM activity_stream WHERE id = 1",
                (rs, i) -> new Policy(rs.getInt("retention_days"), TelemetryQueries.instant(rs, "purge_before")));
    }
    OffsetDateTime retainedSince() {
        Policy policy = policy();
        return TelemetryService.time(policy.cutoff(Instant.now(), policy.days()));
    }
    private static void validateDays(int days) {
        check(days >= 1 && days <= 365, "行为和聊天明细保留期须为 1-365 天");
    }
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public RetentionPreview preview(int days) {
        validateDays(days);
        Policy policy = policy();
        Instant cutoff = policy.cutoff(Instant.now(), Math.min(days, policy.days()));
        return jdbc.queryForObject("""
                SELECT COUNT(CASE WHEN kind = 'CHAT' THEN 1 END) AS chat_entries,
                       COUNT(CASE WHEN kind <> 'CHAT' THEN 1 END) AS behavior_entries
                FROM activity_feed WHERE received_at < ?
                """, (rs, i) -> new RetentionPreview(policy.days(), days, cutoff, rs.getLong("chat_entries"), rs.getLong("behavior_entries")),
                TelemetryService.time(cutoff));
    }
    @Transactional
    public RetentionResult retention(int days, Integer expectedDays) {
        validateDays(days);
        jdbc.queryForObject("SELECT id FROM ingestion_mutex WHERE id = 1 FOR UPDATE", Integer.class);
        Policy policy = policy();
        if (expectedDays != null && expectedDays != policy.days()) throw conflict("保留期已更改，请刷新并重新预览");
        OffsetDateTime cutoff = TelemetryService.time(policy.cutoff(Instant.now(), Math.min(days, policy.days())));
        jdbc.update("UPDATE activity_stream SET retention_days = ?, purge_before = ? WHERE id = 1", days, cutoff);
        int removed = prune(cutoff);
        return new RetentionResult(days, removed, removed == PRUNE_LIMIT);
    }
    @Transactional
    public int pruneExpired() {
        jdbc.queryForObject("SELECT id FROM ingestion_mutex WHERE id = 1 FOR UPDATE", Integer.class);
        return prune(retainedSince());
    }
    private int prune(OffsetDateTime cutoff) {
        return jdbc.update("""
                DELETE FROM activity_feed WHERE cursor_id IN (
                    SELECT cursor_id FROM activity_feed WHERE received_at < ? ORDER BY received_at, cursor_id LIMIT ?
                )
                """, cutoff, PRUNE_LIMIT);
    }
}
