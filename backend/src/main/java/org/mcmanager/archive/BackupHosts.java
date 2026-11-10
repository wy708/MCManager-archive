package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
class BackupHosts {
    record Identity(UUID hostId, String tokenHash) {}
    record Host(UUID id, UUID serverId, String name, boolean revoked, UUID runnerId, Instant heartbeatAt,
                String runtimeState, String version, boolean online, Instant createdAt,boolean restoreEnabled) {}
    record Issued(Host host, String token) {}
    record Job(UUID id, UUID serverId, UUID hostId, String kind, String note, boolean permanent, String status,
               boolean cancelRequested, UUID backupId, UUID sourceBackupId, String archiveSha256, String archiveBytes,
               String errorCode, String resolutionNote, Instant createdAt, Instant startedAt, Instant completedAt, String archiveStatus) {}
    record Page(List<Job> items, long total, int page, int size) {}
    record Claim(Job job, UUID attemptId, Instant leaseUntil, boolean active) {}
    private record Attempt(UUID id, UUID jobId, UUID hostId, UUID runnerId, Instant leaseUntil) {}
    private final JdbcTemplate jdbc;
    private final ArchiveRepository archives;
    private final BackupService backups;
    BackupHosts(JdbcTemplate jdbc, ArchiveRepository archives, BackupService backups) {
        this.jdbc = jdbc; this.archives = archives; this.backups = backups;
    }
    private static ResponseStatusException error(HttpStatus code, String text) { return new ResponseStatusException(code, text); }
    private static void check(boolean valid, String text) { if (!valid) throw error(HttpStatus.BAD_REQUEST, text); }
    private static OffsetDateTime now() { return OffsetDateTime.now(ZoneOffset.UTC); }
    private static Instant instant(ResultSet rs, String name) throws SQLException { return TelemetryQueries.instant(rs, name); }
    private void lock() { jdbc.queryForObject("SELECT id FROM ingestion_mutex WHERE id=1 FOR UPDATE", Integer.class); }
    Identity authenticate(String authorization) {
        if (authorization == null || !authorization.matches("Bearer mcmhost\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}")) throw unauthorized();
        try {
            String token = authorization.substring(7);
            var identity = new Identity(UUID.fromString(token.substring(8, 44)), CollectorCredentials.hash(token.getBytes(StandardCharsets.UTF_8)));
            verify(identity); return identity;
        } catch (IllegalArgumentException ex) { throw unauthorized(); }
    }
    private static ResponseStatusException unauthorized() { return error(HttpStatus.UNAUTHORIZED, "备份执行端凭据无效或已撤销"); }
    void verify(Identity identity) {
        var values = jdbc.queryForList("SELECT token_hash FROM backup_hosts WHERE id=? AND revoked=FALSE", String.class, identity.hostId());
        if (values.isEmpty() || !MessageDigest.isEqual(values.getFirst().getBytes(StandardCharsets.US_ASCII), identity.tokenHash().getBytes(StandardCharsets.US_ASCII))) throw unauthorized();
    }
    private Host hostRow(ResultSet rs, int index) throws SQLException {
        Instant heartbeat = instant(rs, "heartbeat_at");
        return new Host(rs.getObject("id", UUID.class), rs.getObject("server_id", UUID.class), rs.getString("name"), rs.getBoolean("revoked"),
                rs.getObject("runner_id", UUID.class), heartbeat, rs.getString("runtime_state"), rs.getString("version"),
                !rs.getBoolean("revoked") && heartbeat != null && heartbeat.isAfter(Instant.now().minusSeconds(60)), instant(rs, "created_at"),rs.getBoolean("restore_enabled"));
    }
    Host host(UUID id) { return jdbc.query("SELECT * FROM backup_hosts WHERE id=?", this::hostRow, id).stream().findFirst()
            .orElseThrow(() -> error(HttpStatus.NOT_FOUND, "备份执行端不存在")); }
    List<Host> hosts(UUID serverId) { return serverId == null ? jdbc.query("SELECT * FROM backup_hosts ORDER BY created_at,id", this::hostRow)
            : jdbc.query("SELECT * FROM backup_hosts WHERE server_id=? ORDER BY created_at,id", this::hostRow, serverId); }
    private String token(UUID id) { byte[] value = new byte[32]; new SecureRandom().nextBytes(value); return "mcmhost." + id + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(value); }
    @Transactional public Issued create(UUID serverId, String name) {
        check(name != null && !name.isBlank() && name.equals(name.strip()) && name.length() <= 64
                && name.codePoints().noneMatch(c -> Character.isISOControl(c) || Character.getType(c) == Character.SURROGATE), "执行端名称无效");
        lock(); if (archives.find(serverId).isEmpty()) throw error(HttpStatus.NOT_FOUND, "服务器档案不存在");
        if (!hosts(serverId).isEmpty()) throw error(HttpStatus.CONFLICT, "此服务器已有执行端，请轮换其凭据");
        UUID id = UUID.randomUUID(); String token = token(id);
        jdbc.update("INSERT INTO backup_hosts(id,server_id,name,token_hash) VALUES (?,?,?,?)", id, serverId, name, CollectorCredentials.hash(token.getBytes(StandardCharsets.UTF_8)));
        return new Issued(host(id), token);
    }
    @Transactional public Issued rotate(UUID id) {
        lock(); host(id); String token = token(id);
        jdbc.update("UPDATE backup_hosts SET token_hash=?,revoked=FALSE,runner_id=NULL,heartbeat_at=NULL WHERE id=?", CollectorCredentials.hash(token.getBytes(StandardCharsets.UTF_8)), id);
        jdbc.update("UPDATE backup_jobs SET status='QUEUED',attempt_id=NULL WHERE host_id=? AND status='CLAIMED'", id);
        jdbc.update("UPDATE backup_jobs SET status='UNCERTAIN',error_code='CREDENTIAL_CHANGED' WHERE host_id=? AND status IN ('RUNNING','UPLOADING')", id);
        fenceRestores(id,"CREDENTIAL_CHANGED",false);
        return new Issued(host(id), token);
    }
    @Transactional public void revoke(UUID id) {
        lock(); host(id); jdbc.update("UPDATE backup_hosts SET revoked=TRUE WHERE id=?", id);
        jdbc.update("UPDATE backup_jobs SET status='CANCELLED',cancel_requested=TRUE,error_code='ACCESS_REVOKED',completed_at=? WHERE host_id=? AND status IN ('QUEUED','CLAIMED')", now(), id);
        jdbc.update("UPDATE backup_jobs SET status='UNCERTAIN',cancel_requested=TRUE,error_code='ACCESS_REVOKED' WHERE host_id=? AND status IN ('RUNNING','UPLOADING','UNCERTAIN')", id);
        fenceRestores(id,"ACCESS_REVOKED",true);
    }
    private void fenceRestores(UUID id,String reason,boolean revoked) {
        jdbc.update("UPDATE restore_jobs SET status=?,attempt_id=NULL,cancel_requested=?,error_code=?,completed_at=? WHERE host_id=? AND status IN ('QUEUED','CLAIMED')",
                revoked?"CANCELLED":"QUEUED",revoked,reason,revoked?now():null,id);
        jdbc.update("UPDATE restore_jobs SET status='UNCERTAIN',cancel_requested=(cancel_requested OR ?),error_code=? WHERE host_id=? AND status IN ('RUNNING','UNCERTAIN')",revoked,reason,id);
        if(revoked) jdbc.update("DELETE FROM collector_credentials c WHERE EXISTS (SELECT 1 FROM restore_jobs r WHERE r.host_id=? AND r.mode='FORK' AND r.target_server_id=c.server_id AND r.collector_hash=c.token_hash AND r.cancel_requested=TRUE AND r.status<>'READY')",id);
    }
    Host runner(Identity identity, UUID runId) {
        verify(identity); Host host = host(identity.hostId());
        if (!runId.equals(host.runnerId()) || !host.online()) throw error(HttpStatus.CONFLICT, "执行端运行实例已改变或心跳已过期");
        return host;
    }
    @Transactional public Host heartbeat(Identity identity, HostController.Heartbeat request) {
        lock(); verify(identity); expire(); Host host = host(identity.hostId());
        if (host.runnerId() != null && !host.runnerId().equals(request.runId())) {
            boolean restoring=jdbc.queryForObject("SELECT COUNT(*) FROM restore_jobs WHERE host_id=? AND status IN ('CLAIMED','RUNNING')",Integer.class,host.id())>0;
            if (host.online() && (!"STOPPED".equals(host.runtimeState())||restoring)) throw error(HttpStatus.CONFLICT, "另一运行实例正在使用此执行端");
            jdbc.update("UPDATE backup_jobs SET status='QUEUED',attempt_id=NULL WHERE host_id=? AND status='CLAIMED'", host.id());
            jdbc.update("UPDATE backup_jobs SET status='UNCERTAIN',error_code='RUNNER_CHANGED' WHERE host_id=? AND status IN ('RUNNING','UPLOADING')", host.id());
            fenceRestores(host.id(),"RUNNER_CHANGED",false);
        }
        jdbc.update("UPDATE backup_hosts SET runner_id=?,heartbeat_at=?,runtime_state=?,version=?,restore_enabled=? WHERE id=?", request.runId(), now(), request.state(), request.version(),request.restoreEnabled(), host.id());
        return host(host.id());
    }
    private Job jobRow(ResultSet rs, int index) throws SQLException {
        Object bytes = rs.getObject("archive_bytes");
        return new Job(rs.getObject("id", UUID.class), rs.getObject("server_id", UUID.class), rs.getObject("host_id", UUID.class), rs.getString("kind"),
                rs.getString("note"), rs.getBoolean("permanent"), rs.getString("status"), rs.getBoolean("cancel_requested"), rs.getObject("backup_id", UUID.class),
                rs.getObject("source_backup_id", UUID.class), rs.getString("archive_sha256"), bytes == null ? null : bytes.toString(), rs.getString("error_code"),
                rs.getString("resolution_note"), instant(rs, "created_at"), instant(rs, "started_at"), instant(rs, "completed_at"),
                rs.getObject("backup_id",UUID.class)==null?null:jdbc.queryForObject("SELECT status FROM game_backups WHERE id=?",String.class,rs.getObject("backup_id",UUID.class)));
    }
    private Job job(UUID id) { return jdbc.query("SELECT * FROM backup_jobs WHERE id=?", this::jobRow, id).stream().findFirst()
            .orElseThrow(() -> error(HttpStatus.NOT_FOUND, "备份任务不存在")); }
    void expire() {
        jdbc.update("UPDATE backup_jobs SET status='QUEUED',attempt_id=NULL,error_code='CLAIM_EXPIRED' WHERE status='CLAIMED' AND EXISTS (SELECT 1 FROM backup_job_attempts a WHERE a.id=backup_jobs.attempt_id AND a.lease_until<=?)", now());
        jdbc.update("UPDATE backup_jobs SET status='UNCERTAIN',error_code='EXECUTION_EXPIRED' WHERE status IN ('RUNNING','UPLOADING') AND EXISTS (SELECT 1 FROM backup_job_attempts a WHERE a.id=backup_jobs.attempt_id AND a.lease_until<=?)", now());
        jdbc.update("UPDATE restore_jobs SET status='QUEUED',attempt_id=NULL,error_code='CLAIM_EXPIRED' WHERE status='CLAIMED' AND EXISTS (SELECT 1 FROM restore_attempts a WHERE a.id=restore_jobs.attempt_id AND a.lease_until<=?)",now());
        jdbc.update("UPDATE restore_jobs SET status='UNCERTAIN',error_code='EXECUTION_EXPIRED' WHERE status='RUNNING' AND EXISTS (SELECT 1 FROM restore_attempts a WHERE a.id=restore_jobs.attempt_id AND a.lease_until<=?)",now());
    }
    @Transactional public Job find(UUID id) { lock(); expire(); return job(id); }
    @Transactional public Job own(Identity identity, UUID id) {
        lock(); verify(identity); expire(); Job job = job(id);
        if (!job.hostId().equals(identity.hostId())) throw error(HttpStatus.NOT_FOUND, "备份任务不存在"); return job;
    }
    @Transactional public Page jobs(UUID serverId, int page, int size) {
        check(page >= 0 && page <= 100000 && size >= 1 && size <= 100, "分页范围无效"); lock(); expire();
        String where = serverId == null ? "" : " WHERE server_id=?";
        Object[] count = serverId == null ? new Object[]{} : new Object[]{serverId};
        Object[] args = serverId == null ? new Object[]{size, page * size} : new Object[]{serverId, size, page * size};
        return new Page(jdbc.query("SELECT * FROM backup_jobs" + where + " ORDER BY created_at DESC,id LIMIT ? OFFSET ?", this::jobRow, args),
                jdbc.queryForObject("SELECT COUNT(*) FROM backup_jobs" + where, Long.class, count), page, size);
    }
    @Transactional public Job enqueue(UUID serverId, HostController.JobRequest request) {
        lock(); Host host = host(request.hostId());
        if (!host.serverId().equals(serverId)) throw error(HttpStatus.CONFLICT, "执行端不属于当前服务器");
        check(request.note().codePoints().noneMatch(c -> c < 32 && c != 9 && c != 10 && c != 13), "备注包含不支持的字符");
        boolean permanent = request.permanent() || request.kind().equals("FINAL");
        var existing = jdbc.query("SELECT * FROM backup_jobs WHERE request_id=?", this::jobRow, request.requestId());
        if (!existing.isEmpty()) {
            Job previous = existing.getFirst();
            if (!previous.hostId().equals(host.id()) || !previous.kind().equals(request.kind()) || !previous.note().equals(request.note().strip()) || previous.permanent() != permanent)
                throw error(HttpStatus.CONFLICT, "此请求标识已用于另一任务");
            return previous;
        }
        if (host.revoked()) throw error(HttpStatus.CONFLICT, "执行端凭据已撤销");
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO backup_jobs(id,request_id,host_id,server_id,kind,note,permanent,status) VALUES (?,?,?,?,?,?,?,'QUEUED')",
                id, request.requestId(), host.id(), serverId, request.kind(), request.note().strip(), permanent);
        return job(id);
    }
    @Transactional public Job cancel(UUID id) {
        lock(); expire(); Job job = job(id);
        if (Set.of("QUEUED", "CLAIMED").contains(job.status())) jdbc.update("UPDATE backup_jobs SET status='CANCELLED',cancel_requested=TRUE,completed_at=? WHERE id=?", now(), id);
        else if (Set.of("RUNNING", "UPLOADING", "UNCERTAIN").contains(job.status())) jdbc.update("UPDATE backup_jobs SET cancel_requested=TRUE WHERE id=?", id);
        return job(id);
    }
    @Transactional public Job resolve(UUID id, HostController.Resolution request) {
        lock(); expire(); Job job = job(id);
        if (!job.status().equals("UNCERTAIN")) throw error(HttpStatus.CONFLICT, "只有结果不确定的任务需要人工处理");
        check(request.note().equals(request.note().strip()) && request.note().codePoints().noneMatch(Character::isISOControl), "处理说明无效");
        jdbc.update("UPDATE backup_jobs SET status=?,cancel_requested=TRUE,error_code='OPERATOR_RESOLVED',resolution_note=?,completed_at=? WHERE id=?", request.outcome(), request.note(), now(), id);
        return job(id);
    }
    private Attempt attemptRow(ResultSet rs, int index) throws SQLException { return new Attempt(rs.getObject("id", UUID.class), rs.getObject("job_id", UUID.class),
            rs.getObject("host_id", UUID.class), rs.getObject("runner_id", UUID.class), instant(rs, "lease_until")); }
    private Attempt attempt(UUID id) { return jdbc.query("SELECT * FROM backup_job_attempts WHERE id=?", this::attemptRow, id).stream().findFirst()
            .orElseThrow(() -> error(HttpStatus.CONFLICT, "备份任务租约已失效")); }
    private UUID currentAttempt(UUID jobId) { return jdbc.queryForObject("SELECT attempt_id FROM backup_jobs WHERE id=?", UUID.class, jobId); }
    @Transactional public Claim claim(Identity identity, HostController.ClaimRequest request) {
        lock(); Host current = runner(identity, request.runId()); expire();
        var old = jdbc.query("SELECT * FROM backup_job_attempts WHERE claim_request_id=?", this::attemptRow, request.requestId());
        if (!old.isEmpty()) {
            Attempt a = old.getFirst();
            if (!a.hostId().equals(identity.hostId()) || !a.runnerId().equals(request.runId())) throw error(HttpStatus.CONFLICT, "领取标识已被其他运行实例使用");
            Job job = job(a.jobId());
            return new Claim(job, a.id(), a.leaseUntil(), a.id().equals(currentAttempt(job.id())) && a.leaseUntil().isAfter(Instant.now())
                    && Set.of("CLAIMED", "RUNNING", "UPLOADING").contains(job.status()));
        }
        if (!"RUNNING".equals(current.runtimeState())) return null;
        if (jdbc.queryForObject("SELECT COUNT(*) FROM restore_jobs WHERE host_id=? AND status IN ('CLAIMED','RUNNING','UNCERTAIN')",Integer.class,identity.hostId())>0) return null;
        if (jdbc.queryForObject("SELECT COUNT(*) FROM backup_jobs WHERE host_id=? AND status IN ('CLAIMED','RUNNING','UPLOADING','UNCERTAIN')", Integer.class, identity.hostId()) > 0) return null;
        var queued = jdbc.query("SELECT * FROM backup_jobs WHERE host_id=? AND status='QUEUED' ORDER BY created_at,id LIMIT 1", this::jobRow, identity.hostId());
        if (queued.isEmpty()) return null;
        Job job = queued.getFirst();
        if (job.kind().equals("AUTOMATIC") && archives.lock(job.serverId()).map(server -> server.status().equals("ARCHIVED")).orElse(true)) {
            jdbc.update("UPDATE backup_jobs SET status='CANCELLED',cancel_requested=TRUE,error_code='SERVER_ARCHIVED',completed_at=? WHERE id=?", now(), job.id());
            return null;
        }
        UUID attempt = UUID.randomUUID(); OffsetDateTime until = now().plusSeconds(120);
        jdbc.update("INSERT INTO backup_job_attempts(id,claim_request_id,job_id,host_id,runner_id,lease_until) VALUES (?,?,?,?,?,?)", attempt, request.requestId(), job.id(), identity.hostId(), request.runId(), until);
        jdbc.update("UPDATE backup_jobs SET status='CLAIMED',attempt_id=?,error_code=NULL WHERE id=?", attempt, job.id());
        return new Claim(job(job.id()), attempt, until.toInstant(), true);
    }
    private Job requireAttempt(Identity identity, UUID id, UUID runId, UUID attemptId, boolean executing) {
        runner(identity, runId); Job job = job(id); Attempt a = attempt(attemptId);
        if (!a.hostId().equals(identity.hostId()) || !job.hostId().equals(identity.hostId()) || !a.jobId().equals(id)
                || !attemptId.equals(currentAttempt(id)) || !a.runnerId().equals(runId) || !a.leaseUntil().isAfter(Instant.now()))
            throw error(HttpStatus.CONFLICT, "备份任务租约已失效");
        if (executing && job.cancelRequested()) throw error(HttpStatus.CONFLICT, "备份任务正在取消");
        return job;
    }
    @Transactional public Job start(Identity identity, UUID id, HostController.Lease request) {
        lock(); Job job = requireAttempt(identity, id, request.runId(), request.attemptId(), true);
        if (!"RUNNING".equals(host(identity.hostId()).runtimeState())) throw error(HttpStatus.CONFLICT, "游戏服务尚未运行");
        if (job.status().equals("CLAIMED") && job.kind().equals("AUTOMATIC") && archives.lock(job.serverId()).map(server -> server.status().equals("ARCHIVED")).orElse(true))
            throw error(HttpStatus.CONFLICT, "服务器已封存，不能开始自动备份");
        if (job.status().equals("CLAIMED")) jdbc.update("UPDATE backup_jobs SET status='RUNNING',started_at=? WHERE id=?", now(), id);
        else if (!Set.of("RUNNING", "UPLOADING", "SUCCEEDED").contains(job.status())) throw error(HttpStatus.CONFLICT, "任务不能开始执行");
        return job(id);
    }
    @Transactional public Job renew(Identity identity, UUID id, HostController.Lease request) {
        lock(); Job job = requireAttempt(identity, id, request.runId(), request.attemptId(), false);
        if (!Set.of("CLAIMED", "RUNNING", "UPLOADING").contains(job.status())) throw error(HttpStatus.CONFLICT, "任务已不再执行");
        jdbc.update("UPDATE backup_job_attempts SET lease_until=? WHERE id=?", now().plusSeconds(120), request.attemptId()); return job;
    }
    @Transactional public Job report(Identity identity, UUID id, HostController.Report request) {
        lock(); Job job = requireAttempt(identity, id, request.runId(), request.attemptId(), false);
        if (!Set.of("CLAIMED", "RUNNING", "UPLOADING", "UNCERTAIN").contains(job.status())) {
            if (job.status().equals(request.outcome()) && Objects.equals(job.errorCode(), request.code())) return job;
            throw error(HttpStatus.CONFLICT, "任务已结束");
        }
        if (request.outcome().equals("CANCELLED") && !job.cancelRequested()) throw error(HttpStatus.CONFLICT, "任务没有取消请求");
        jdbc.update("UPDATE backup_jobs SET status=?,error_code=?,completed_at=? WHERE id=?", request.outcome(), request.code(),
                request.outcome().equals("UNCERTAIN") ? null : now(), id); return job(id);
    }
    @Transactional public BackupService.Backup prepare(Identity identity, UUID id, HostController.Artifact request, boolean recovery) {
        lock(); runner(identity, request.runId()); expire(); Job job = job(id); Attempt a = attempt(request.attemptId());
        if (recovery) {
            if (!job.hostId().equals(identity.hostId()) || !a.hostId().equals(identity.hostId()) || !a.jobId().equals(id)
                    || !a.id().equals(currentAttempt(id)) || job.cancelRequested() || !Set.of("UNCERTAIN", "UPLOADING").contains(job.status()))
                throw error(HttpStatus.CONFLICT, "任务不能从此归档恢复");
            jdbc.update("UPDATE backup_job_attempts SET runner_id=?,lease_until=? WHERE id=?", request.runId(), now().plusSeconds(120), a.id());
        } else {
            requireAttempt(identity, id, request.runId(), request.attemptId(), true);
            if (!Set.of("RUNNING", "UPLOADING", "SUCCEEDED").contains(job.status())) throw error(HttpStatus.CONFLICT, "任务尚未开始制作");
        }
        if (job.sourceBackupId() != null && (!job.sourceBackupId().equals(request.sourceBackupId()) || !job.archiveSha256().equals(request.sha256()) || !job.archiveBytes().equals(request.bytes())))
            throw error(HttpStatus.CONFLICT, "任务必须继续上传原始归档");
        if (job.backupId() != null) {
            if (!job.status().equals("SUCCEEDED")) jdbc.update("UPDATE backup_jobs SET status='UPLOADING',error_code=NULL WHERE id=?", id);
            return backups.find(job.backupId());
        }
        var backup = backups.reserve(job.serverId(), new BackupController.Reservation(id, job.kind(), job.note(), job.permanent(), request.bytes()));
        jdbc.update("UPDATE backup_jobs SET backup_id=?,source_backup_id=?,archive_sha256=?,archive_bytes=?,status='UPLOADING',error_code=NULL WHERE id=?",
                backup.id(), request.sourceBackupId(), request.sha256(), Long.parseLong(request.bytes()), id);
        return backup;
    }
    BackupService.Backup upload(Identity identity, UUID id, UUID runId, UUID attemptId, InputStream input, long length) {
        return backups.upload(uploadId(identity, id), input, length, proof -> {
            lock(); Job job = requireAttempt(identity, id, runId, attemptId, true);
            if (!job.status().equals("UPLOADING")) throw error(HttpStatus.CONFLICT, "任务不在上传状态");
            if (proof != null) {
                if (!Objects.equals(job.archiveSha256(), proof.path("sha256").asText()) || !Objects.equals(job.sourceBackupId().toString(), proof.path("backupId").asText())
                        || !proof.path("snapshotMode").asText().equals("BDS_SAVE_QUERY")) throw error(HttpStatus.CONFLICT, "上传内容不匹配此在线备份任务");
                jdbc.update("UPDATE backup_jobs SET status='SUCCEEDED',completed_at=?,error_code=NULL WHERE id=?", now(), id);
            }
        });
    }
    private UUID uploadId(Identity identity, UUID id) {
        // This read is only a hint. Publication and receiving both recheck under
        // BackupService's transaction, in host-lock then object-lock order.
        verify(identity); Job job = job(id);
        if (!job.hostId().equals(identity.hostId()) || job.backupId() == null) throw error(HttpStatus.NOT_FOUND, "上传任务不存在");
        return job.backupId();
    }
}
