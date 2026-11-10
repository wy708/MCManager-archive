package org.mcmanager.archive;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import static org.mcmanager.archive.TelemetryPayload.*;
import static org.mcmanager.archive.TelemetryValidation.*;

@Service
class TelemetryService {
    private final JdbcTemplate jdbc;
    private final TelemetryValidation validation;
    private final CollectorCredentials credentials;
    private final ObjectMapper mapper;
    private final ZoneId zone;
    private final ActivityFeed activity;
    private final ContainerAudit containers;
    private final ConstructionProjects projects;
    private final ServerRuntime runtime;
    TelemetryService(JdbcTemplate jdbc, TelemetryValidation validation, CollectorCredentials credentials,
                     ObjectMapper mapper, ActivityFeed activity, ContainerAudit containers, ConstructionProjects projects, ServerRuntime runtime, @Value("${mcmanager.statistics-zone:Asia/Hong_Kong}") String zone) {
        this.jdbc = jdbc; this.validation = validation; this.credentials = credentials; this.mapper = mapper;
        this.zone = ZoneId.of(zone);
        this.activity = activity;
        this.containers = containers;
        this.projects = projects;
        this.runtime = runtime;
    }
    static OffsetDateTime time(Instant instant) { return instant.atOffset(ZoneOffset.UTC); }
    private record Period(LocalDate start, LocalDate end, Instant sealedAt) {}
    private record SessionState(String player, Instant start, Instant checkpoint, long sequence, long millis, boolean ended) {}
    String eventHash(Event event) {
        // Keep the V2 canonical bytes, including its null fields, when replaying old outboxes.
        var tree = mapper.<com.fasterxml.jackson.databind.node.ObjectNode>valueToTree(event);
        if (event.text() == null) tree.remove("text");
        if (event.sessionStart() == null) tree.remove("sessionStart");
        if (event.sessionEnd() == null) tree.remove("sessionEnd");
        if (event.playerObservedAt() == null) tree.remove("playerObservedAt");
        if (event.container() == null) tree.remove("container");
        if (event.position() == null) tree.remove("position");
        try { return CollectorCredentials.hash(mapper.writeValueAsBytes(tree)); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
    }

    @Transactional(timeout = 30)
    public Receipt ingest(CollectorCredentials.Identity identity, Batch batch, byte[] body) {
        return ingestGroup(identity, List.of(batch), List.of(body)).getFirst();
    }

    @Transactional(timeout = 30)
    public List<Receipt> ingestBulk(CollectorCredentials.Identity identity, List<Batch> batches, List<byte[]> bodies) {
        check(!batches.isEmpty() && batches.size() <= 16 && batches.size() == bodies.size(), "补传批次数量无效");
        check(batches.stream().allMatch(b -> b != null && b.events() != null), "补传批次不能为空");
        check(batches.stream().mapToInt(b -> b.events().size()).sum() <= 512, "每次补传最多 512 条事件");
        return ingestGroup(identity, batches, bodies);
    }

    private List<Receipt> ingestGroup(CollectorCredentials.Identity identity, List<Batch> batches, List<byte[]> bodies) {
        // Validate before taking the global ordering lock. One bounded group commits
        // atomically; original batch/event hashes and event order are unchanged.
        var capabilities = batches.stream().map(validation::validate).toList();
        jdbc.queryForObject("SELECT id FROM ingestion_mutex WHERE id = 1 FOR UPDATE", Integer.class);
        String savedZone = jdbc.queryForObject("SELECT statistics_zone FROM telemetry_settings WHERE id = 1", String.class);
        if (savedZone == null) jdbc.update("UPDATE telemetry_settings SET statistics_zone = ? WHERE id = 1", zone.getId());
        else if (!savedZone.equals(zone.getId())) throw conflict("统计时区已固定为 " + savedZone + "，不能通过修改环境变量重划历史日期");
        credentials.lockServer(identity.serverId());
        // Rotation can occur after the authentication filter and before this transaction.
        credentials.check(identity);
        UUID server = identity.serverId();
        Period period = jdbc.queryForObject("SELECT start_date, end_date, sealed_at FROM server_archives WHERE id = ?", (rs, i) -> {
            OffsetDateTime sealed = rs.getObject("sealed_at", OffsetDateTime.class);
            return new Period(rs.getObject("start_date", LocalDate.class), rs.getObject("end_date", LocalDate.class), sealed == null ? null : sealed.toInstant());
        }, server);
        var context = new IngestionContext(server);
        var receipts = new ArrayList<Receipt>();
        for (int i = 0; i < batches.size(); i++)
            receipts.add(ingestLocked(server, period, batches.get(i), bodies.get(i), capabilities.get(i), context));
        context.flush();
        return receipts;
    }

    private Receipt ingestLocked(UUID server, Period period, Batch batch, byte[] body,
                                 Map<String, Capability> capabilities, IngestionContext context) {
        String hash = CollectorCredentials.hash(body);
        List<String> previous = jdbc.queryForList("SELECT payload_hash FROM telemetry_batches WHERE server_id = ? AND batch_id = ?", String.class, server, batch.batchId());
        if (!previous.isEmpty()) {
            if (!previous.getFirst().equals(hash)) throw conflict("批次 ID 已被不同内容使用");
            jdbc.update("UPDATE collector_state SET last_seen_at = CURRENT_TIMESTAMP WHERE server_id = ?", server);
            return new Receipt(batch.batchId(), 0, batch.events().size(), true);
        }
        LocalDate startDate = period.start();
        LocalDate endDate = period.end();
        Instant sealedAt = period.sealedAt();
        List<Event> accepted = new ArrayList<>();
        int duplicates = 0;
        for (Event event : batch.events()) {
            String eventHash = eventHash(event);
            List<String> stored = jdbc.queryForList("SELECT payload_hash FROM telemetry_events WHERE server_id = ? AND event_id = ? UNION ALL SELECT payload_hash FROM container_audit WHERE server_id = ? AND event_id = ?", String.class, server, event.eventId(), server, event.eventId());
            if (!stored.isEmpty()) {
                if (!stored.getFirst().equals(eventHash)) throw conflict("事件 ID 已被不同内容使用");
                duplicates++; continue;
            }
            LocalDate day = event.at().atZone(zone).toLocalDate();
            check(!day.isBefore(startDate), "事件早于本期服务器开服日期");
            if (endDate != null) {
                check(!day.isAfter(endDate) && !event.at().isAfter(sealedAt), "封存档案只接受封存前且结束日期内的补传数据");
            }
            if (event.player() != null) context.observe(event);
            if (event.kind() == Kind.CONTAINER) {
                containers.store(server, event, eventHash, batch.collector());
                accepted.add(event);
                continue;
            }
            Capability capability = capabilities.get(metric(event));
            switch (event.kind()) {
                case COUNTER -> addValue(server, event.player().key(), day, event.metric(),
                        event.dimension() == null ? "unknown" : event.dimension(), event.subject() == null ? "all" : event.subject(),
                        event.metric().equals("blocks.mined") ? MetricCatalog.blockCategory(event.subject()) : "OTHER", capability, event.value());
                case SESSION -> checkpoint(server, event, capability, startDate);
                case DEATH -> {
                    jdbc.update("INSERT INTO player_deaths(server_id, event_id, player_key, occurred_at, dimension, cause, killer_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            server, event.eventId(), event.player().key(), time(event.at()), event.dimension(), event.cause(), event.killerType());
                    addValue(server, event.player().key(), day, "deaths", event.dimension(), event.cause(), "OTHER", capability, 1);
                }
                case CHAT -> {
                    for (String key : List.of("chat.messages", "chat.contents"))
                        addValue(server, event.player().key(), day, key, event.dimension() == null ? "unknown" : event.dimension(),
                                "all", "OTHER", capabilities.get(key), 1);
                }
            }
            jdbc.update("INSERT INTO telemetry_events(server_id, event_id, payload_hash, player_key, kind, dimension, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    server, event.eventId(), eventHash, event.player().key(), event.kind().name(), event.dimension() == null ? "unknown" : event.dimension(), time(event.at()));
            activity.record(server, event);
            projects.record(server, event);
            accepted.add(event);
        }
        updateCollector(server, batch, capabilities, accepted, context);
        runtime.store(server,batch.collector());
        jdbc.update("INSERT INTO telemetry_batches(server_id, batch_id, payload_hash, event_count, received_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
                server, batch.batchId(), hash, batch.events().size());
        return new Receipt(batch.batchId(), accepted.size(), duplicates, false);
    }

    private record CoverageKey(String metric, String quality, String algorithm) {}
    private static final class Coverage {
        final boolean dimensions; Instant first, last; boolean existing, dirty;
        Coverage(boolean dimensions, Instant first, Instant last, boolean existing) {
            this.dimensions=dimensions; this.first=first; this.last=last; this.existing=existing; this.dirty=!existing;
        }
    }
    private static final class Observation {
        Instant first, last, nameAt; String name;
        final Map<String, Instant[]> names = new LinkedHashMap<>();
        int count;
        void add(Event event) {
            Instant at=event.at(), observed=event.playerObservedAt()==null?at:event.playerObservedAt();
            if(first==null || at.isBefore(first))first=at;
            if(last==null || at.isAfter(last))last=at;
            if(nameAt==null || !observed.isBefore(nameAt)){nameAt=observed;name=event.player().name();}
            var span=names.computeIfAbsent(event.player().name(), ignored->new Instant[]{observed,observed});
            if(observed.isBefore(span[0]))span[0]=observed;
            if(observed.isAfter(span[1]))span[1]=observed;
            count++;
        }
    }
    // This cache belongs to a single database transaction, never to the service or
    // server lifetime. A rollback cannot leave uncommitted metadata in a later upload.
    private final class IngestionContext {
        final UUID server;
        final Map<String, Observation> players = new LinkedHashMap<>();
        Map<CoverageKey, Coverage> coverage;
        IngestionContext(UUID server){this.server=server;}
        void observe(Event event) {
            String key=event.player().key();
            var observation=players.get(key);
            if(observation==null) {
                // Materialize FK parents before appending the first detailed event.
                observePlayer(server,event); observation=new Observation();players.put(key,observation);
            }
            observation.add(event);
        }
        void cover(Capability cap, Instant first, Instant last) {
            if(coverage==null) {
                coverage=new LinkedHashMap<>();
                jdbc.query("SELECT metric,quality,algorithm_version,dimension_aware,first_observed_at,last_observed_at FROM metric_coverage WHERE server_id=?", rs->{
                    var key=new CoverageKey(rs.getString("metric"),rs.getString("quality"),rs.getString("algorithm_version"));
                    coverage.put(key,new Coverage(rs.getBoolean("dimension_aware"),rs.getObject("first_observed_at",OffsetDateTime.class).toInstant(),rs.getObject("last_observed_at",OffsetDateTime.class).toInstant(),true));
                },server);
            }
            var key=new CoverageKey(cap.metric(),cap.quality().name(),cap.algorithmVersion());
            var saved=coverage.get(key);
            if(saved==null){coverage.put(key,new Coverage(cap.dimensionAware(),first,last,false));return;}
            if(saved.dimensions!=cap.dimensionAware())throw conflict("维度能力发生变化时必须更新算法版本");
            if(first.isBefore(saved.first)){saved.first=first;saved.dirty=true;}
            if(last.isAfter(saved.last)){saved.last=last;saved.dirty=true;}
        }
        void flush() {
            if(coverage!=null)coverage.forEach((key,c)->{
                if(!c.dirty)return;
                if(c.existing)jdbc.update("UPDATE metric_coverage SET first_observed_at=?,last_observed_at=? WHERE server_id=? AND metric=? AND quality=? AND algorithm_version=?",
                        time(c.first),time(c.last),server,key.metric(),key.quality(),key.algorithm());
                else jdbc.update("INSERT INTO metric_coverage(server_id,metric,quality,algorithm_version,dimension_aware,first_observed_at,last_observed_at) VALUES (?,?,?,?,?,?,?)",
                        server,key.metric(),key.quality(),key.algorithm(),c.dimensions,time(c.first),time(c.last));
            });
            players.forEach((key,o)->{
                if(o.count==1)return; // The initial observation has already been stored.
                jdbc.update("UPDATE players SET current_name=CASE WHEN name_observed_at<=? THEN ? ELSE current_name END,name_observed_at=GREATEST(name_observed_at,?),first_seen_at=LEAST(first_seen_at,?),last_seen_at=GREATEST(last_seen_at,?) WHERE player_key=?",
                        time(o.nameAt),o.name,time(o.nameAt),time(o.first),time(o.last),key);
                jdbc.update("UPDATE player_servers SET first_seen_at=LEAST(first_seen_at,?),last_seen_at=GREATEST(last_seen_at,?) WHERE server_id=? AND player_key=?",
                        time(o.first),time(o.last),server,key);
                o.names.forEach((name,span)->{
                    int updated=jdbc.update("UPDATE player_names SET first_seen_at=LEAST(first_seen_at,?),last_seen_at=GREATEST(last_seen_at,?) WHERE player_key=? AND name=?",time(span[0]),time(span[1]),key,name);
                    if(updated==0)jdbc.update("INSERT INTO player_names(player_key,name,first_seen_at,last_seen_at) VALUES (?,?,?,?)",key,name,time(span[0]),time(span[1]));
                    updated=jdbc.update("UPDATE player_server_names SET first_seen_at=LEAST(first_seen_at,?),last_seen_at=GREATEST(last_seen_at,?) WHERE server_id=? AND player_key=? AND name=?",time(span[0]),time(span[1]),server,key,name);
                    if(updated==0)jdbc.update("INSERT INTO player_server_names(server_id,player_key,name,first_seen_at,last_seen_at) VALUES (?,?,?,?,?)",server,key,name,time(span[0]),time(span[1]));
                });
            });
        }
    }

    private void observePlayer(UUID server, Event event) {
        String key = event.player().key();
        OffsetDateTime at = time(event.at());
        OffsetDateTime observedAt = event.playerObservedAt() == null ? at : time(event.playerObservedAt());
        int updated = jdbc.update("UPDATE players SET current_name = CASE WHEN name_observed_at <= ? THEN ? ELSE current_name END, name_observed_at = GREATEST(name_observed_at, ?), first_seen_at = LEAST(first_seen_at, ?), last_seen_at = GREATEST(last_seen_at, ?) WHERE player_key = ?",
                observedAt, event.player().name(), observedAt, observedAt, at, key);
        if (updated == 0) jdbc.update("INSERT INTO players(player_key, current_name, name_observed_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", key, event.player().name(), observedAt, observedAt, at);
        updated = jdbc.update("UPDATE player_names SET first_seen_at = LEAST(first_seen_at, ?), last_seen_at = GREATEST(last_seen_at, ?) WHERE player_key = ? AND name = ?", observedAt, observedAt, key, event.player().name());
        if (updated == 0) jdbc.update("INSERT INTO player_names(player_key, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)", key, event.player().name(), observedAt, observedAt);
        updated = jdbc.update("UPDATE player_servers SET first_seen_at = LEAST(first_seen_at, ?), last_seen_at = GREATEST(last_seen_at, ?) WHERE server_id = ? AND player_key = ?", at, at, server, key);
        if (updated == 0) jdbc.update("INSERT INTO player_servers(server_id, player_key, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)", server, key, at, at);
        updated = jdbc.update("UPDATE player_server_names SET first_seen_at = LEAST(first_seen_at, ?), last_seen_at = GREATEST(last_seen_at, ?) WHERE server_id = ? AND player_key = ? AND name = ?", observedAt, observedAt, server, key, event.player().name());
        if (updated == 0) jdbc.update("INSERT INTO player_server_names(server_id, player_key, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)", server, key, event.player().name(), observedAt, observedAt);
    }

    private void checkpoint(UUID server, Event event, Capability capability, LocalDate archiveStart) {
        check(!event.startedAt().atZone(zone).toLocalDate().isBefore(archiveStart), "会话早于开服日期");
        var rows = jdbc.query("SELECT * FROM player_sessions WHERE server_id = ? AND session_id = ?", (rs, i) -> new SessionState(
                rs.getString("player_key"), rs.getObject("started_at", OffsetDateTime.class).toInstant(), rs.getObject("checkpoint_at", OffsetDateTime.class).toInstant(),
                rs.getLong("sequence_number"), rs.getLong("online_millis"), rs.getBoolean("ended")), server, event.sessionId());
        if (rows.isEmpty()) {
            if (event.sequence() != 0 || event.onlineMillis() != 0 || !event.startedAt().equals(event.at()) || event.ended()) {
                throw conflict("缺少会话起点：必须先上传 sequence=0、onlineMillis=0 的开始事件");
            }
            if (jdbc.queryForObject("SELECT COUNT(*) FROM player_sessions WHERE server_id = ? AND player_key = ? AND checkpoint_at > ?", Integer.class, server, event.player().key(), time(event.startedAt())) != 0) {
                throw conflict("新会话与已有会话时间重叠，须按本地事件顺序补传");
            }
            jdbc.update("UPDATE player_sessions SET ended = TRUE, end_reason = 'REPLACED' WHERE server_id = ? AND player_key = ? AND ended = FALSE", server, event.player().key());
            jdbc.update("INSERT INTO player_sessions(server_id, session_id, player_key, started_at, checkpoint_at, sequence_number, online_millis, ended, start_reason) VALUES (?, ?, ?, ?, ?, 0, 0, FALSE, ?)",
                    server, event.sessionId(), event.player().key(), time(event.startedAt()), time(event.at()),
                    event.sessionStart() == null ? null : event.sessionStart().name());
            return;
        }
        SessionState old = rows.getFirst();
        if (!old.player().equals(event.player().key()) || !old.start().equals(event.startedAt())) throw conflict("会话身份或开始时间发生改变");
        if (old.ended() || event.sequence() != old.sequence() + 1) throw conflict("会话已结束或检查点序号不连续，须按顺序补传");
        Instant previousAt = old.checkpoint();
        long oldMillis = old.millis();
        long elapsed = Duration.between(previousAt, event.at()).toMillis();
        check(elapsed >= 0 && elapsed <= 86_400_000L && event.onlineMillis() >= oldMillis && event.onlineMillis() - oldMillis == elapsed,
                "会话时间增量必须等于相邻检查点真实经过的毫秒数，检查点间隔不能超过 24 小时");
        Instant cursor = previousAt;
        while (cursor.isBefore(event.at())) {
            LocalDate day = cursor.atZone(zone).toLocalDate();
            Instant midnight = day.plusDays(1).atStartOfDay(zone).toInstant();
            Instant end = midnight.isBefore(event.at()) ? midnight : event.at();
            addValue(server, event.player().key(), day, "online.millis", event.dimension(), "all", "OTHER", capability, Duration.between(cursor, end).toMillis());
            cursor = end;
        }
        jdbc.update("UPDATE player_sessions SET checkpoint_at = ?, sequence_number = ?, online_millis = ?, ended = ?, end_reason = ? WHERE server_id = ? AND session_id = ?",
                time(event.at()), event.sequence(), event.onlineMillis(), event.ended(),
                event.sessionEnd() != null ? event.sessionEnd().name() : event.ended() ? "NORMAL" : null, server, event.sessionId());
    }

    private void addValue(UUID server, String player, LocalDate day, String metric, String dimension, String subject, String category, Capability cap, long value) {
        String where = "server_id = ? AND player_key = ? AND statistic_day = ? AND metric = ? AND dimension = ? AND subject = ? AND quality = ? AND algorithm_version = ?";
        Object[] key = {server, player, day, metric, dimension, subject, cap.quality().name(), cap.algorithmVersion()};
        var values = jdbc.queryForList("SELECT statistic_value FROM daily_statistics WHERE " + where, Long.class, key);
        if (values.isEmpty()) {
            jdbc.update("INSERT INTO daily_statistics(server_id, player_key, statistic_day, metric, dimension, subject, category, quality, algorithm_version, statistic_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    server, player, day, metric, dimension, subject, category, cap.quality().name(), cap.algorithmVersion(), value);
        } else {
            long next;
            try { next = MetricCatalog.require(metric).aggregation() == MetricCatalog.Aggregation.MAX ? Math.max(values.getFirst(), value) : Math.addExact(values.getFirst(), value); }
            catch (ArithmeticException ex) { throw conflict("统计累计值超出存储范围"); }
            List<Object> params = new ArrayList<>(); params.add(next); params.addAll(Arrays.asList(key));
            jdbc.update("UPDATE daily_statistics SET statistic_value = ? WHERE " + where, params.toArray());
        }
    }

    private void updateCollector(UUID server, Batch batch, Map<String, Capability> capabilities, List<Event> accepted, IngestionContext context) {
        Collector collector = batch.collector();
        if (collector.diagnostics() != null) updateDiagnostics(server, collector, batch.reportedAt());
        var rows = jdbc.queryForList("SELECT reported_at FROM collector_state WHERE server_id = ?", OffsetDateTime.class, server);
        boolean current = rows.isEmpty() || !batch.reportedAt().isBefore(rows.getFirst().toInstant());
        if (rows.isEmpty()) {
            jdbc.update("INSERT INTO collector_state(server_id, collector_version, bds_version, levi_lamina_version, boot_id, reported_at, last_seen_at, pending_events) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)",
                    server, collector.version(), collector.bdsVersion(), collector.leviLaminaVersion(), collector.bootId(), time(batch.reportedAt()), collector.pendingEvents());
        } else if (current) {
            jdbc.update("UPDATE collector_state SET collector_version = ?, bds_version = ?, levi_lamina_version = ?, boot_id = ?, reported_at = ?, last_seen_at = CURRENT_TIMESTAMP, pending_events = ? WHERE server_id = ?",
                    collector.version(), collector.bdsVersion(), collector.leviLaminaVersion(), collector.bootId(), time(batch.reportedAt()), collector.pendingEvents(), server);
        } else jdbc.update("UPDATE collector_state SET last_seen_at = CURRENT_TIMESTAMP WHERE server_id = ?", server);
        if (current) {
            jdbc.update("DELETE FROM collector_capabilities WHERE server_id = ?", server);
            for (Capability cap : capabilities.values()) {
                jdbc.update("INSERT INTO collector_capabilities(server_id, metric, state, quality, algorithm_version, dimension_aware, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        server, cap.metric(), cap.state().name(), cap.quality() == null ? null : cap.quality().name(), cap.algorithmVersion(), cap.dimensionAware(), time(batch.reportedAt()));
            }
        }
        for (Capability cap : capabilities.values()) {
            if (cap.state() != CapabilityState.ACTIVE) continue;
            Instant first = accepted.stream().filter(event -> metric(event).equals(cap.metric()) || event.kind() == Kind.CHAT && cap.metric().equals("chat.messages")).map(Event::at).min(Instant::compareTo).orElse(batch.reportedAt());
            context.cover(cap, first, batch.reportedAt());
        }
    }

    private void updateDiagnostics(UUID server, Collector collector, Instant reportedAt) {
        var report = collector.diagnostics();
        var sequence = jdbc.queryForList("SELECT latest_sequence FROM collector_boot_diagnostics WHERE server_id = ? AND boot_id = ?",
                Long.class, server, collector.bootId());
        if (sequence.isEmpty()) {
            jdbc.update("""
                    INSERT INTO collector_boot_diagnostics(server_id, boot_id, latest_sequence, reported_at, queued_events,
                        rejected_submissions, capture_gaps, disk_error, disk_faults, final_report)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, server, collector.bootId(), report.sequence(), time(reportedAt), report.queuedEvents(),
                    report.rejectedSubmissions(), report.captureGaps(), report.diskError(), report.diskFaults(), report.finalReport());
        } else if (report.sequence() > sequence.getFirst()) {
            jdbc.update("""
                    UPDATE collector_boot_diagnostics SET latest_sequence = ?, reported_at = ?, queued_events = ?,
                        rejected_submissions = GREATEST(rejected_submissions, ?), capture_gaps = GREATEST(capture_gaps, ?),
                        disk_error = ?, disk_faults = GREATEST(disk_faults, ?), final_report = ?
                    WHERE server_id = ? AND boot_id = ?
                    """, report.sequence(), time(reportedAt), report.queuedEvents(), report.rejectedSubmissions(),
                    report.captureGaps(), report.diskError(), report.diskFaults(), report.finalReport(), server, collector.bootId());
        }
    }
}
