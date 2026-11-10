package org.mcmanager.archive;

import java.math.BigInteger;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.TelemetryValidation.*;

@Service
@Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
class TelemetryQueries {
    record Filter(UUID serverId, String playerKey,
                  @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate fromDate,
                  @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate toDate, String dimension) {}
    record Scope(String daily, String events, MapSqlParameterSource params) {}
    record Measurement(String quality, String algorithmVersion, String value) {}
    record MetricResult(String key, String label, String unit, String aggregation, String value,
                        int coveredServers, int selectedServers, List<Measurement> measurements) {}
    record Summary(String statisticsZone, long playerCount, Long sessionCount, String longestSessionMillis,
                   String woodBlocks, String oreBlocks, List<MetricResult> metrics, Long confirmedJoinCount) {}
    private record SessionSummary(long records, Long confirmedJoins, String longest) {}
    record DailyPoint(LocalDate day, String metric, String quality, String algorithmVersion, String value) {}
    record DimensionPoint(String dimension, String metric, String quality, String algorithmVersion, String value) {}
    record Contribution(UUID serverId, String serverName, String metric, String quality, String algorithmVersion, String value) {}
    record PlayerRow(String key, String name, Instant firstSeenAt, Instant lastSeenAt) {}
    record NameHistory(String name, Instant firstSeenAt, Instant lastSeenAt) {}
    record PlayerServer(UUID serverId, String serverName, String serverStatus, Instant firstSeenAt, Instant lastSeenAt) {}
    record PlayerProfile(PlayerRow player, List<NameHistory> names, List<PlayerServer> servers) {}
    record Page<T>(List<T> items, long total, int page, int pageSize) {}
    record Breakdown(String subject, String dimension, String category, String quality, String algorithmVersion, String value) {}
    record SubjectRanking(String subject, String value, List<Breakdown> breakdown) {}
    record DetailedStatistics<T>(String statisticsZone, MetricCatalog.Metric metric, Filter filter,
            int coveredServers, List<T> items, long total, int page, int pageSize, String dataNotice) {}
    record Death(UUID eventId, UUID serverId, String serverName, String playerKey, String playerName,
                 Instant at, String dimension, String cause, String killerType) {}
    record Session(UUID sessionId, UUID serverId, String serverName, String playerKey, String playerName,
                   Instant startedAt, Instant checkpointAt, String onlineMillis, boolean ended, String endReason, String state, String startReason) {}
    record Coverage(String metric, String quality, String algorithmVersion, boolean dimensionAware, Instant firstObservedAt, Instant lastObservedAt) {}
    record CollectorInfo(String version, String bdsVersion, String leviLaminaVersion, UUID bootId, Instant reportedAt, Instant lastSeenAt, long pendingEvents) {}
    record CollectorDiagnostic(UUID bootId, Instant reportedAt, int queuedEvents, long rejectedSubmissions,
                               long captureGaps, boolean diskError, long diskFaults, boolean finalReport) {}
    record CollectorStatus(UUID serverId, String serverName, boolean credentialConfigured, String connectionState,
                           CollectorInfo collector, List<TelemetryPayload.Capability> capabilities, List<Coverage> coverage,
                           CollectorDiagnostic diagnostics, List<CollectorDiagnostic> previousAnomalies) {}

    private static final String AGGREGATE = "CASE WHEN metric = 'level.max' THEN MAX(statistic_value) ELSE SUM(statistic_value) END";
    private final NamedParameterJdbcTemplate jdbc;
    private final ZoneId configuredZone;
    TelemetryQueries(NamedParameterJdbcTemplate jdbc, @Value("${mcmanager.statistics-zone:Asia/Hong_Kong}") String zone) {
        this.jdbc = jdbc; this.configuredZone = ZoneId.of(zone);
    }
    ZoneId zone() {
        String stored = jdbc.getJdbcTemplate().queryForObject("SELECT statistics_zone FROM telemetry_settings WHERE id = 1", String.class);
        return stored == null ? configuredZone : ZoneId.of(stored);
    }
    static Instant instant(ResultSet rs, String column) throws SQLException {
        OffsetDateTime time = rs.getObject(column, OffsetDateTime.class);
        return time == null ? null : time.toInstant();
    }
    Scope scope(Filter filter) {
        check(filter.fromDate() == null || filter.fromDate().getYear() >= 1970 && filter.fromDate().getYear() < 9999, "日期超出允许范围");
        check(filter.toDate() == null || filter.toDate().getYear() >= 1970 && filter.toDate().getYear() < 9999, "日期超出允许范围");
        check(filter.fromDate() == null || filter.toDate() == null || !filter.fromDate().isAfter(filter.toDate()), "开始日期不能晚于结束日期");
        check(filter.dimension() == null || resource(filter.dimension()), "维度筛选格式无效");
        MapSqlParameterSource params = new MapSqlParameterSource();
        String shared = " WHERE 1=1";
        if (filter.serverId() != null) {
            if (jdbc.queryForObject("SELECT COUNT(*) FROM server_archives WHERE id = :id", Map.of("id", filter.serverId()), Long.class) == 0) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "服务器档案不存在");
            shared += " AND server_id = :server"; params.addValue("server", filter.serverId());
        }
        if (filter.playerKey() != null) {
            check(filter.playerKey().length() <= 64, "玩家身份格式无效");
            if (jdbc.queryForObject("SELECT COUNT(*) FROM players WHERE player_key = :key", Map.of("key", filter.playerKey()), Long.class) == 0) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "玩家档案不存在");
            shared += " AND player_key = :player"; params.addValue("player", filter.playerKey());
            if (filter.serverId() != null && jdbc.queryForObject("SELECT COUNT(*) FROM player_servers WHERE server_id = :server AND player_key = :player", params, Long.class) == 0) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "玩家没有参与此期服务器的记录");
            }
        }
        if (filter.dimension() != null) { shared += " AND dimension = :dimension"; params.addValue("dimension", filter.dimension()); }
        String daily = shared, events = shared;
        if (filter.fromDate() != null) {
            daily += " AND statistic_day >= :fromDate"; events += " AND occurred_at >= :fromInstant";
            params.addValue("fromDate", filter.fromDate()).addValue("fromInstant", TelemetryService.time(filter.fromDate().atStartOfDay(zone()).toInstant()));
        }
        if (filter.toDate() != null) {
            daily += " AND statistic_day <= :toDate"; events += " AND occurred_at < :untilInstant";
            params.addValue("toDate", filter.toDate()).addValue("untilInstant", TelemetryService.time(filter.toDate().plusDays(1).atStartOfDay(zone()).toInstant()));
        }
        return new Scope(daily, events, params);
    }
    private String population(Scope scope) {
        return "SELECT player_key FROM telemetry_events" + scope.events() + " UNION SELECT player_key FROM daily_statistics" + scope.daily();
    }
    private long selectedServers(Filter filter) {
        return filter.serverId() == null ? jdbc.queryForObject("SELECT COUNT(*) FROM server_archives", Map.of(), Long.class) : 1;
    }
    private Map<String, Integer> coverage(Filter filter, Scope scope) {
        String where = " WHERE 1=1";
        if (filter.serverId() != null) where += " AND server_id = :server";
        if (filter.fromDate() != null) where += " AND last_observed_at >= :fromInstant";
        if (filter.toDate() != null) where += " AND first_observed_at < :untilInstant";
        if (filter.dimension() != null) where += " AND dimension_aware = TRUE";
        Map<String, Integer> result = new HashMap<>();
        jdbc.query("SELECT metric, COUNT(DISTINCT server_id) AS covered FROM metric_coverage" + where + " GROUP BY metric", scope.params(), rs -> {
            result.put(rs.getString("metric"), rs.getInt("covered"));
        });
        return result;
    }
    Summary summary(Filter filter) {
        Scope scope = scope(filter);
        var measurements = new HashMap<String, List<Measurement>>();
        jdbc.query("SELECT metric, quality, algorithm_version, " + AGGREGATE + " AS total FROM daily_statistics" + scope.daily() + " GROUP BY metric, quality, algorithm_version ORDER BY metric, quality, algorithm_version", scope.params(), rs -> {
            measurements.computeIfAbsent(rs.getString("metric"), key -> new ArrayList<>()).add(new Measurement(rs.getString("quality"), rs.getString("algorithm_version"), rs.getBigDecimal("total").toBigIntegerExact().toString()));
        });
        Map<String, Integer> coverage = coverage(filter, scope);
        int servers = Math.toIntExact(selectedServers(filter));
        long players = jdbc.queryForObject("SELECT COUNT(*) FROM (" + population(scope) + ") population", scope.params(), Long.class);
        List<MetricResult> metrics = new ArrayList<>();
        for (var metric : MetricCatalog.ALL.values()) {
            List<Measurement> segments = measurements.getOrDefault(metric.key(), List.of());
            BigInteger value = BigInteger.ZERO;
            for (var segment : segments) value = metric.aggregation() == MetricCatalog.Aggregation.MAX ? value.max(new BigInteger(segment.value())) : value.add(new BigInteger(segment.value()));
            int covered = coverage.getOrDefault(metric.key(), 0);
            metrics.add(new MetricResult(metric.key(), metric.label(), metric.unit(), metric.aggregation().name(),
                    segments.isEmpty() && (covered == 0 || filter.playerKey() != null && players == 0) ? null : value.toString(), covered, servers, segments));
        }
        SessionSummary sessions = null;
        if (filter.dimension() == null && coverage.getOrDefault("online.millis", 0) > 0 && (filter.playerKey() == null || players > 0)) {
            String where = " WHERE 1=1";
            if (filter.serverId() != null) where += " AND server_id = :server";
            if (filter.playerKey() != null) where += " AND player_key = :player";
            if (filter.fromDate() != null) where += " AND started_at >= :fromInstant";
            if (filter.toDate() != null) where += " AND started_at < :untilInstant";
            sessions = jdbc.queryForObject("""
                    SELECT COUNT(*) AS records, COUNT(start_reason) AS classified,
                           COUNT(CASE WHEN start_reason = 'JOIN' THEN 1 END) AS confirmed,
                           MAX(online_millis) AS longest FROM player_sessions
                    """ + where, scope.params(), (rs, i) -> new SessionSummary(rs.getLong("records"),
                    rs.getLong("classified") == 0 ? null : rs.getLong("confirmed"), rs.getString("longest")));
        }
        String wood = null, ore = null;
        if (coverage.getOrDefault("blocks.mined", 0) > 0 && (filter.playerKey() == null || players > 0)) {
            wood = "0"; ore = "0";
            var categories = jdbc.query("SELECT category, SUM(statistic_value) AS total FROM daily_statistics" + scope.daily() + " AND metric = 'blocks.mined' GROUP BY category", scope.params(), (rs, i) -> Map.entry(rs.getString("category"), rs.getBigDecimal("total").toBigIntegerExact().toString()));
            for (var category : categories) { if (category.getKey().equals("WOOD")) wood = category.getValue(); if (category.getKey().equals("ORE")) ore = category.getValue(); }
        }
        return new Summary(zone().getId(), players, sessions == null ? null : sessions.records(),
                sessions == null ? null : sessions.longest(), wood, ore, metrics,
                sessions == null ? null : sessions.confirmedJoins());
    }
    List<DailyPoint> daily(Filter input) {
        LocalDate to = input.toDate() == null ? LocalDate.now(zone()) : input.toDate();
        LocalDate from = input.fromDate() == null ? to.minusDays(6) : input.fromDate();
        check(!from.isBefore(to.minusDays(365)), "每日趋势一次最多查询 366 天");
        Scope scope = scope(new Filter(input.serverId(), input.playerKey(), from, to, input.dimension()));
        return jdbc.query("SELECT statistic_day, metric, quality, algorithm_version, " + AGGREGATE + " AS total FROM daily_statistics" + scope.daily() + " GROUP BY statistic_day, metric, quality, algorithm_version ORDER BY statistic_day, metric, quality, algorithm_version", scope.params(),
                (rs, i) -> new DailyPoint(rs.getObject("statistic_day", LocalDate.class), rs.getString("metric"), rs.getString("quality"), rs.getString("algorithm_version"), rs.getBigDecimal("total").toBigIntegerExact().toString()));
    }
    List<Contribution> contributions(Filter filter) {
        Scope scope = scope(filter);
        return jdbc.query("SELECT server_id, (SELECT name FROM server_archives a WHERE a.id = server_id) AS server_name, metric, quality, algorithm_version, " + AGGREGATE + " AS total FROM daily_statistics" + scope.daily() + " GROUP BY server_id, metric, quality, algorithm_version ORDER BY server_id, metric, quality, algorithm_version", scope.params(),
                (rs, i) -> new Contribution(rs.getObject("server_id", UUID.class), rs.getString("server_name"), rs.getString("metric"), rs.getString("quality"), rs.getString("algorithm_version"), rs.getBigDecimal("total").toBigIntegerExact().toString()));
    }
    List<DimensionPoint> dimensions(Filter filter, String metric) {
        MetricCatalog.require(metric); Scope scope = scope(filter); scope.params().addValue("metric", metric);
        return jdbc.query("SELECT dimension, metric, quality, algorithm_version, " + AGGREGATE + " AS total FROM daily_statistics" + scope.daily() + " AND metric = :metric GROUP BY dimension, metric, quality, algorithm_version ORDER BY dimension, quality, algorithm_version", scope.params(),
                (rs, i) -> new DimensionPoint(rs.getString("dimension"), rs.getString("metric"), rs.getString("quality"), rs.getString("algorithm_version"), rs.getBigDecimal("total").toBigIntegerExact().toString()));
    }
    static void page(int page, int pageSize) { check(page >= 1 && page <= 10000 && pageSize >= 1 && pageSize <= 100, "分页范围无效"); }
    private PlayerRow player(ResultSet rs, int index) throws SQLException {
        return new PlayerRow(rs.getString("player_key"), rs.getString("current_name"), instant(rs, "first_seen_at"), instant(rs, "last_seen_at"));
    }
    Page<PlayerRow> players(Filter filter, String search, int page, int pageSize) {
        page(page, pageSize); Scope scope = scope(filter);
        String where = " WHERE p.player_key IN (" + population(scope) + ")";
        if (search != null && !search.isBlank()) {
            check(search.length() <= 80, "搜索词过长");
            String escaped = search.toLowerCase(Locale.ROOT).replace("!", "!!").replace("%", "!%").replace("_", "!_");
            scope.params().addValue("search", "%" + escaped + "%");
            where += " AND (LOWER(p.current_name) LIKE :search ESCAPE '!' OR EXISTS (SELECT 1 FROM player_names n WHERE n.player_key = p.player_key AND LOWER(n.name) LIKE :search ESCAPE '!'))";
        }
        long total = jdbc.queryForObject("SELECT COUNT(*) FROM players p" + where, scope.params(), Long.class);
        scope.params().addValue("limit", pageSize).addValue("offset", (page - 1) * pageSize);
        var items = jdbc.query("SELECT p.* FROM players p" + where + " ORDER BY p.last_seen_at DESC, p.player_key LIMIT :limit OFFSET :offset", scope.params(), this::player);
        return new Page<>(items, total, page, pageSize);
    }
    PlayerProfile profile(String key) {
        var params = Map.of("key", key);
        var rows = jdbc.query("SELECT * FROM players WHERE player_key = :key", params, this::player);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "玩家档案不存在");
        var names = jdbc.query("SELECT * FROM player_names WHERE player_key = :key ORDER BY last_seen_at DESC, name", params,
                (rs, i) -> new NameHistory(rs.getString("name"), instant(rs, "first_seen_at"), instant(rs, "last_seen_at")));
        var servers = jdbc.query("SELECT ps.*, a.name, a.status FROM player_servers ps JOIN server_archives a ON a.id = ps.server_id WHERE player_key = :key ORDER BY ps.first_seen_at, ps.server_id", params,
                (rs, i) -> new PlayerServer(rs.getObject("server_id", UUID.class), rs.getString("name"), rs.getString("status"), instant(rs, "first_seen_at"), instant(rs, "last_seen_at")));
        return new PlayerProfile(rows.getFirst(), names, servers);
    }
    Page<Breakdown> breakdown(Filter filter, String metric, String category, int page, int pageSize) {
        page(page, pageSize); MetricCatalog.require(metric); Scope scope = scope(filter);
        String where = scope.daily() + " AND metric = :metric"; scope.params().addValue("metric", metric);
        if (category != null) {
            check(metric.equals("blocks.mined") && Set.of("WOOD", "ORE", "OTHER").contains(category), "分类筛选仅适用于挖掘方块");
            where += " AND category = :category"; scope.params().addValue("category", category);
        }
        String grouped = " FROM daily_statistics" + where + " GROUP BY metric, subject, dimension, category, quality, algorithm_version";
        long total = jdbc.queryForObject("SELECT COUNT(*) FROM (SELECT 1" + grouped + ") groups", scope.params(), Long.class);
        scope.params().addValue("limit", pageSize).addValue("offset", (page - 1) * pageSize);
        var items = jdbc.query("SELECT subject, dimension, category, quality, algorithm_version, " + AGGREGATE + " AS total" + grouped + " ORDER BY total DESC, subject, dimension, quality, algorithm_version LIMIT :limit OFFSET :offset", scope.params(),
                (rs, i) -> new Breakdown(rs.getString("subject"), rs.getString("dimension"), rs.getString("category"), rs.getString("quality"), rs.getString("algorithm_version"), rs.getBigDecimal("total").toBigIntegerExact().toString()));
        return new Page<>(items, total, page, pageSize);
    }
    <T> DetailedStatistics<T> detailedResult(Filter filter, String metric, Page<T> rows) {
        return new DetailedStatistics<>(zone().getId(), MetricCatalog.require(metric), filter,
                coverage(filter, scope(filter)).getOrDefault(metric, 0), rows.items(), rows.total(), rows.page(), rows.pageSize(),
                "仅统计已采集的数据；空结果不等于从未发生。subject 为空表示未分类。排名按 subject 合并所选维度，保留质量和算法版本明细；不同算法的历史口径可能不同。数值为十进制字符串，不能丢失精度。items.used 指已确认的成功使用，不是持有时长或使用请求。");
    }
    Page<SubjectRanking> subjectRanking(Filter filter, String metric, String category, int page, int pageSize) {
        page(page, pageSize); MetricCatalog.require(metric); Scope scope = scope(filter);
        String where = scope.daily() + " AND metric = :metric"; scope.params().addValue("metric", metric);
        if (category != null) {
            check(metric.equals("blocks.mined") && Set.of("WOOD", "ORE", "OTHER").contains(category), "分类筛选仅适用于挖掘方块");
            where += " AND category = :category"; scope.params().addValue("category", category);
        }
        String grouped = " FROM daily_statistics" + where + " GROUP BY metric, subject";
        long total = jdbc.queryForObject("SELECT COUNT(*) FROM (SELECT 1" + grouped + ") groups", scope.params(), Long.class);
        scope.params().addValue("limit", pageSize).addValue("offset", (page - 1) * pageSize);
        record RankedSubject(String subject, String value) {}
        var ranked = jdbc.query("SELECT subject, " + AGGREGATE + " AS total" + grouped + " ORDER BY total DESC, subject LIMIT :limit OFFSET :offset", scope.params(),
                (rs, i) -> new RankedSubject(rs.getString("subject"), rs.getBigDecimal("total").toBigIntegerExact().toString()));
        Map<String, List<Breakdown>> details = new HashMap<>();
        if (!ranked.isEmpty()) {
            scope.params().addValue("subjects", ranked.stream().map(RankedSubject::subject).toList());
            jdbc.query("SELECT subject, dimension, category, quality, algorithm_version, " + AGGREGATE + " AS total FROM daily_statistics" + where
                    + " AND subject IN (:subjects) GROUP BY metric, subject, dimension, category, quality, algorithm_version ORDER BY subject, dimension, category, quality, algorithm_version", scope.params(), rs -> {
                String subject = rs.getString("subject");
                details.computeIfAbsent(subject, ignored -> new ArrayList<>()).add(new Breakdown(subject, rs.getString("dimension"), rs.getString("category"),
                        rs.getString("quality"), rs.getString("algorithm_version"), rs.getBigDecimal("total").toBigIntegerExact().toString()));
            });
        }
        return new Page<>(ranked.stream().map(row -> new SubjectRanking(row.subject(), row.value(), details.getOrDefault(row.subject(), List.of()))).toList(), total, page, pageSize);
    }
    Page<Death> deaths(Filter filter, int page, int pageSize) {
        page(page, pageSize); Scope scope = scope(filter);
        long total = jdbc.queryForObject("SELECT COUNT(*) FROM player_deaths" + scope.events(), scope.params(), Long.class);
        scope.params().addValue("limit", pageSize).addValue("offset", (page - 1) * pageSize);
        var items = jdbc.query("SELECT *, (SELECT name FROM server_archives a WHERE a.id = server_id) AS server_name, (SELECT current_name FROM players p WHERE p.player_key = player_deaths.player_key) AS player_name FROM player_deaths" + scope.events() + " ORDER BY occurred_at DESC, server_id, event_id LIMIT :limit OFFSET :offset", scope.params(),
                (rs, i) -> new Death(rs.getObject("event_id", UUID.class), rs.getObject("server_id", UUID.class), rs.getString("server_name"), rs.getString("player_key"), rs.getString("player_name"), instant(rs, "occurred_at"), rs.getString("dimension"), rs.getString("cause"), rs.getString("killer_type")));
        return new Page<>(items, total, page, pageSize);
    }
    Page<Session> sessions(Filter filter, int page, int pageSize) {
        page(page, pageSize); check(filter.dimension() == null, "会话会跨越多个维度，不能用单一维度筛选完整会话");
        Scope scope = scope(filter);
        String where = scope.events().replace("occurred_at", "started_at");
        long total = jdbc.queryForObject("SELECT COUNT(*) FROM player_sessions" + where, scope.params(), Long.class);
        scope.params().addValue("limit", pageSize).addValue("offset", (page - 1) * pageSize);
        var items = jdbc.query("SELECT *, (SELECT name FROM server_archives a WHERE a.id = server_id) AS server_name, (SELECT current_name FROM players p WHERE p.player_key = player_sessions.player_key) AS player_name FROM player_sessions" + where + " ORDER BY started_at DESC, server_id, session_id LIMIT :limit OFFSET :offset", scope.params(), (rs, i) -> {
            Instant checkpoint = instant(rs, "checkpoint_at"); boolean ended = rs.getBoolean("ended");
            String state = ended ? "REPLACED".equals(rs.getString("end_reason")) ? "INTERRUPTED" : "ENDED" : checkpoint.isBefore(Instant.now().minusSeconds(120)) ? "STALE" : "OPEN";
            return new Session(rs.getObject("session_id", UUID.class), rs.getObject("server_id", UUID.class), rs.getString("server_name"), rs.getString("player_key"), rs.getString("player_name"), instant(rs, "started_at"), checkpoint, Long.toString(rs.getLong("online_millis")), ended, rs.getString("end_reason"), state, rs.getString("start_reason"));
        });
        return new Page<>(items, total, page, pageSize);
    }
    List<CollectorStatus> collectors(UUID serverId) {
        Scope scope = scope(new Filter(serverId, null, null, null, null));
        String where = serverId == null ? "" : " WHERE id = :server";
        return jdbc.query("SELECT id, name, EXISTS(SELECT 1 FROM collector_credentials c WHERE c.server_id = a.id) AS configured FROM server_archives a" + where + " ORDER BY start_date DESC, id", scope.params(), (rs, index) -> {
            UUID id = rs.getObject("id", UUID.class); Map<String, Object> params = Map.of("id", id);
            var info = jdbc.query("SELECT * FROM collector_state WHERE server_id = :id", params, (r, i) -> new CollectorInfo(r.getString("collector_version"), r.getString("bds_version"), r.getString("levi_lamina_version"), r.getObject("boot_id", UUID.class), instant(r, "reported_at"), instant(r, "last_seen_at"), r.getLong("pending_events")));
            var caps = jdbc.query("SELECT * FROM collector_capabilities WHERE server_id = :id ORDER BY metric", params, (r, i) -> new TelemetryPayload.Capability(r.getString("metric"), TelemetryPayload.CapabilityState.valueOf(r.getString("state")), r.getString("quality") == null ? null : TelemetryPayload.Quality.valueOf(r.getString("quality")), r.getString("algorithm_version"), r.getBoolean("dimension_aware")));
            var coverage = jdbc.query("SELECT * FROM metric_coverage WHERE server_id = :id ORDER BY metric, quality, algorithm_version", params, (r, i) -> new Coverage(r.getString("metric"), r.getString("quality"), r.getString("algorithm_version"), r.getBoolean("dimension_aware"), instant(r, "first_observed_at"), instant(r, "last_observed_at")));
            CollectorInfo collector = info.isEmpty() ? null : info.getFirst();
            String state = collector == null ? "UNCONNECTED" : collector.lastSeenAt().isBefore(Instant.now().minusSeconds(120)) ? "STALE" : collector.pendingEvents() > 0 ? "REPLAYING" : "CONNECTED";
            if (collector == null) return new CollectorStatus(id, rs.getString("name"), rs.getBoolean("configured"), state, null, caps, coverage, null, List.of());
            Map<String, Object> bootParams = Map.of("id", id, "boot", collector.bootId());
            var current = jdbc.query("SELECT * FROM collector_boot_diagnostics WHERE server_id = :id AND boot_id = :boot", bootParams, (r, i) -> diagnostic(r));
            var history = jdbc.query("""
                    SELECT * FROM collector_boot_diagnostics WHERE server_id = :id AND boot_id <> :boot
                      AND (rejected_submissions > 0 OR capture_gaps > 0 OR disk_faults > 0)
                    ORDER BY reported_at DESC, boot_id LIMIT 10
                    """, bootParams, (r, i) -> diagnostic(r));
            return new CollectorStatus(id, rs.getString("name"), rs.getBoolean("configured"), state, collector, caps, coverage, current.isEmpty() ? null : current.getFirst(), history);
        });
    }

    private CollectorDiagnostic diagnostic(java.sql.ResultSet row) throws java.sql.SQLException {
        return new CollectorDiagnostic(row.getObject("boot_id", UUID.class), instant(row, "reported_at"), row.getInt("queued_events"),
                row.getLong("rejected_submissions"), row.getLong("capture_gaps"), row.getBoolean("disk_error"),
                row.getLong("disk_faults"), row.getBoolean("final_report"));
    }
}
