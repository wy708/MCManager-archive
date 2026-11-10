package org.mcmanager.archive;

import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@Service
class BackupPolicies {
    record Policy(UUID serverId, UUID hostId, long revision, boolean enabled, int intervalMinutes, Instant nextRunAt,
                  boolean retentionEnabled, Integer keepCount, Integer maxAgeDays, Instant lastCheckedAt, String lastOutcome,
                  UUID lastJobId, Instant updatedAt, long prunedCount, Instant lastPrunedAt, String cleanupError, String dailyTime) {}
    record Candidate(UUID id, String bytes, Instant createdAt, String reason) {}
    record Preview(List<Candidate> items,long total,String bytes) {}
    private record RetentionSummary(long total,Instant latest) {}
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ArchiveRepository archives;
    private final BackupHosts hosts;
    private final BackupService backups;
    BackupPolicies(JdbcTemplate jdbc, TransactionTemplate transaction, ArchiveRepository archives, BackupHosts hosts, BackupService backups) {
        this.jdbc=jdbc; this.transaction=transaction; this.archives=archives; this.hosts=hosts; this.backups=backups;
    }
    private static OffsetDateTime at(Instant now) { return now.atOffset(ZoneOffset.UTC); }
    private void lock() { jdbc.queryForObject("SELECT id FROM ingestion_mutex WHERE id=1 FOR UPDATE", Integer.class); }
    private static ResponseStatusException conflict(String message) { return new ResponseStatusException(HttpStatus.CONFLICT, message); }
    private static void check(boolean condition, String message) { if (!condition) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message); }
    private Policy row(ResultSet rs, int index) throws SQLException {
        UUID id=rs.getObject("server_id",UUID.class);
        var summary=jdbc.queryForObject("SELECT COUNT(*) AS total, MAX(completed_at) AS latest FROM backup_retention_events WHERE server_id=? AND state='DELETED'",
                (summaryRs,i)->new RetentionSummary(summaryRs.getLong("total"),TelemetryQueries.instant(summaryRs,"latest")),id);
        var failures=jdbc.queryForList("SELECT failure_code FROM backup_retention_events WHERE server_id=? AND state='FAILED' ORDER BY started_at DESC LIMIT 1",String.class,id);
        return new Policy(id,rs.getObject("host_id",UUID.class),rs.getLong("revision"),rs.getBoolean("enabled"),rs.getInt("interval_minutes"),TelemetryQueries.instant(rs,"next_run_at"),
                rs.getBoolean("retention_enabled"),rs.getObject("keep_count",Integer.class),rs.getObject("max_age_days",Integer.class),TelemetryQueries.instant(rs,"last_checked_at"),rs.getString("last_outcome"),
                rs.getObject("last_job_id",UUID.class),TelemetryQueries.instant(rs,"updated_at"),summary.total(),summary.latest(),failures.isEmpty()?null:failures.getFirst(),rs.getString("daily_time"));
    }
    List<Policy> list(UUID serverId) { return serverId==null?jdbc.query("SELECT * FROM backup_policies ORDER BY server_id",this::row):jdbc.query("SELECT * FROM backup_policies WHERE server_id=?",this::row,serverId); }
    private Policy find(UUID serverId) { return list(serverId).stream().findFirst().orElse(null); }
    Policy save(UUID serverId, BackupPolicyController.Settings request) {
        Instant now=Instant.now();
        String daily=request.dailyTime();
        check(daily==null || daily.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]"),"请选择有效的每日备份时间");
        check(daily==null || request.firstRunAt()==null,"每日定时不同时设置首次执行日期");
        check(!request.retentionEnabled() || request.keepCount()!=null || request.maxAgeDays()!=null,"启用自动轮换须填写数量或天数");
        check(request.firstRunAt()==null || (!request.firstRunAt().isBefore(now.minusSeconds(60)) && !request.firstRunAt().isAfter(now.plus(Duration.ofDays(365)))),"首次备份时间须在当前时间至未来一年内");
        return transaction.execute(tx->{
            lock(); var server=archives.lock(serverId).orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND,"服务器档案不存在"));
            var host=hosts.host(request.hostId()); check(host.serverId().equals(serverId),"执行端不属于当前服务器");
            if(request.enabled() && (host.revoked() || server.status().equals("ARCHIVED"))) throw conflict("已撤销的执行端或已封存服务器不能开启自动备份");
            Policy previous=find(serverId); long revision=previous==null?0:previous.revision();
            if(request.revision()!=revision) throw conflict("策略已变更，请重新加载后核对设置");
            int interval=daily==null?request.intervalMinutes():1440;
            boolean reset=previous==null || !previous.enabled() || previous.intervalMinutes()!=interval || !Objects.equals(previous.dailyTime(),daily) || request.firstRunAt()!=null;
            Instant next=request.enabled()?(reset?(daily!=null?nextDaily(now,daily):request.firstRunAt()==null?now.plusSeconds(interval*60L):request.firstRunAt()):previous.nextRunAt()):null;
            if(previous==null) jdbc.update("INSERT INTO backup_policies(server_id,host_id,revision,enabled,interval_minutes,next_run_at,retention_enabled,keep_count,max_age_days,updated_at,daily_time) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    serverId,host.id(),1,request.enabled(),interval,next==null?null:at(next),request.retentionEnabled(),request.keepCount(),request.maxAgeDays(),at(now),daily);
            else jdbc.update("UPDATE backup_policies SET revision=?,enabled=?,interval_minutes=?,next_run_at=?,retention_enabled=?,keep_count=?,max_age_days=?,updated_at=?,daily_time=?,last_outcome=NULL WHERE server_id=?",
                    revision+1,request.enabled(),interval,next==null?null:at(next),request.retentionEnabled(),request.keepCount(),request.maxAgeDays(),at(now),daily,serverId);
            if(!request.enabled() || reset) cancelWaiting(serverId,"POLICY_CHANGED",now);
            return find(serverId);
        });
    }
    static Instant nextDaily(Instant now,String time) {
        var local=now.atOffset(ZoneOffset.ofHours(8));
        var next=local.toLocalDate().atTime(LocalTime.parse(time)).atOffset(ZoneOffset.ofHours(8));
        return (next.toInstant().isAfter(now)?next:next.plusDays(1)).toInstant();
    }
    private void cancelWaiting(UUID serverId,String reason,Instant now) {
        jdbc.update("UPDATE backup_jobs SET status='CANCELLED',cancel_requested=TRUE,error_code=?,completed_at=? WHERE policy_server_id=? AND status IN ('QUEUED','CLAIMED')",reason,at(now),serverId);
    }
    void run(Instant now) {
        // Only short state decisions hold the global mutex. File I/O occurs after commit.
        for(UUID id:jdbc.queryForList("SELECT backup_id FROM backup_retention_events WHERE state IN ('DELETING','FAILED') ORDER BY started_at LIMIT 32",UUID.class)) finishDeletion(id,now);
        for(UUID serverId:jdbc.queryForList("SELECT server_id FROM backup_policies WHERE enabled=TRUE OR retention_enabled=TRUE ORDER BY server_id",UUID.class)) {
            dispatch(serverId,now);
            for(Candidate candidate:previewEnabled(serverId,now).stream().limit(32).toList()) prune(serverId,candidate,now);
        }
    }
    void dispatch(UUID serverId,Instant now) {
        transaction.executeWithoutResult(tx->{
            lock(); var server=archives.lock(serverId).orElseThrow(); Policy policy=find(serverId); if(policy==null) return;
            if(server.status().equals("ARCHIVED")) {
                cancelWaiting(serverId,"SERVER_ARCHIVED",now);
                jdbc.update("UPDATE backup_policies SET enabled=FALSE,next_run_at=NULL,last_outcome='SERVER_ARCHIVED',last_checked_at=? WHERE server_id=?",at(now),serverId); return;
            }
            if(!policy.enabled() || policy.nextRunAt().isAfter(now)) return;
            hosts.expire(); var host=hosts.host(policy.hostId()); String outcome;
            if(host.revoked()) outcome="HOST_REVOKED";
            else if(jdbc.queryForObject("SELECT COUNT(*) FROM backup_jobs WHERE server_id=? AND status IN ('QUEUED','CLAIMED','RUNNING','UPLOADING','UNCERTAIN')",Integer.class,serverId)>0) {
                outcome="WAITING_TASK";
                // A queued/offline or long-running backup covers missed daily slots. Do not
                // immediately enqueue another catch-up when that existing task finishes.
                if(policy.dailyTime()!=null) jdbc.update("UPDATE backup_policies SET next_run_at=? WHERE server_id=?",at(nextDaily(now,policy.dailyTime())),serverId);
            }
            else {
                UUID requestId=UUID.nameUUIDFromBytes(("scheduled-backup:"+serverId+":"+policy.nextRunAt()).getBytes(StandardCharsets.UTF_8));
                var job=hosts.enqueue(serverId,new HostController.JobRequest(requestId,host.id(),"AUTOMATIC","定期游戏备份",false));
                jdbc.update("UPDATE backup_jobs SET policy_server_id=?,scheduled_for=? WHERE id=?",serverId,at(policy.nextRunAt()),job.id());
                long seconds=policy.intervalMinutes()*60L, missed=Duration.between(policy.nextRunAt(),now).getSeconds()/seconds;
                Instant next=policy.dailyTime()!=null?nextDaily(now,policy.dailyTime()):policy.nextRunAt().plusSeconds((missed+1)*seconds);
                jdbc.update("UPDATE backup_policies SET next_run_at=?,last_job_id=? WHERE server_id=?",at(next),job.id(),serverId);
                outcome=host.online()&&"RUNNING".equals(host.runtimeState())?"QUEUED":"QUEUED_OFFLINE";
            }
            jdbc.update("UPDATE backup_policies SET last_outcome=?,last_checked_at=? WHERE server_id=?",outcome,at(now),serverId);
        });
    }
    List<Candidate> preview(UUID serverId,Integer count,Integer days,Instant now) {
        return previewSummary(serverId,count,days,now).items();
    }
    Preview previewSummary(UUID serverId,Integer count,Integer days,Instant now) {
        check(count==null || count>=1 && count<=1000,"保留数量须为 1 至 1000"); check(days==null || days>=1 && days<=3650,"保留天数须为 1 至 3650");
        if(archives.find(serverId).isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND,"服务器档案不存在");
        String ranked=" FROM (SELECT id,archive_bytes,created_at,ROW_NUMBER() OVER (ORDER BY created_at DESC,id DESC) AS ordinal FROM game_backups WHERE server_id=? AND kind='AUTOMATIC' AND permanent=FALSE AND status='READY' AND NOT EXISTS (SELECT 1 FROM restore_jobs r WHERE r.backup_id=game_backups.id AND r.status IN ('QUEUED','CLAIMED','RUNNING','UNCERTAIN'))) ranked";
        String age=days==null?"FALSE":"created_at<?", filter=" WHERE ordinal>1 AND ("+(count==null?"FALSE":"ordinal>"+count)+" OR "+age+")";
        Object[] args=days==null?new Object[]{serverId}:new Object[]{serverId,at(now.minus(Duration.ofDays(days)))};
        var items=jdbc.query("SELECT id,archive_bytes,created_at"+ranked+filter+" ORDER BY created_at,id LIMIT 50",(rs,index)->{
            Instant created=TelemetryQueries.instant(rs,"created_at"); return new Candidate(rs.getObject("id",UUID.class),rs.getString("archive_bytes"),created,days!=null&&created.isBefore(now.minus(Duration.ofDays(days)))?"AGE":"COUNT");
        },args);
        return jdbc.queryForObject("SELECT COUNT(*) AS total,COALESCE(SUM(archive_bytes),0) AS bytes"+ranked+filter,
                (rs,index)->new Preview(items,rs.getLong("total"),rs.getBigDecimal("bytes").toPlainString()),args);
    }
    private List<Candidate> previewEnabled(UUID serverId,Instant now) {
        Policy policy=find(serverId);
        if(policy==null || !policy.retentionEnabled() || archives.find(serverId).map(s->s.status().equals("ARCHIVED")).orElse(true)) return List.of();
        return preview(serverId,policy.keepCount(),policy.maxAgeDays(),now);
    }
    void prune(UUID serverId,Candidate candidate,Instant now) {
        AtomicReference<Policy> decision=new AtomicReference<>(); AtomicReference<Candidate> selected=new AtomicReference<>();
        try {
            backups.deleteAutomatic(candidate.id(),()->{
                lock(); archives.lock(serverId).orElseThrow(); Policy policy=find(serverId);
                Candidate current=previewEnabled(serverId,now).stream().filter(value->value.id().equals(candidate.id())).findFirst().orElseThrow(()->conflict("备份已不符合轮换条件"));
                decision.set(policy); selected.set(current);
            },value->jdbc.update("INSERT INTO backup_retention_events(backup_id,server_id,policy_revision,reason,state,archive_bytes,started_at) VALUES (?,?,?,?,'DELETING',?,?)",
                    value.id(),serverId,decision.get().revision(),selected.get().reason(),Long.parseLong(value.archiveBytes()),at(now)));
            deleted(candidate.id(),now);
        } catch(RuntimeException ex) { jdbc.update("UPDATE backup_retention_events SET state='FAILED',failure_code='FILE_DELETE_FAILED' WHERE backup_id=? AND state<>'DELETED'",candidate.id()); }
    }
    private void deleted(UUID id,Instant now) { jdbc.update("UPDATE backup_retention_events SET state='DELETED',completed_at=?,failure_code=NULL WHERE backup_id=?",at(now),id); }
    private void finishDeletion(UUID id,Instant now) {
        try { backups.delete(id); deleted(id,now); }
        catch(RuntimeException ex) { jdbc.update("UPDATE backup_retention_events SET state='FAILED',failure_code='FILE_DELETE_FAILED' WHERE backup_id=? AND state<>'DELETED'",id); }
    }
}
