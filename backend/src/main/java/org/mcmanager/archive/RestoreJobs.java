package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.text.Normalizer;
import java.time.*;
import java.util.*;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@Service
class RestoreJobs {
    record Job(UUID id,UUID backupId,UUID sourceServerId,UUID targetServerId,UUID hostId,String mode,String destinationName,String note,
               String status,boolean cancelRequested,UUID sourceBackupId,String archiveSha256,String archiveBytes,int fileCount,JsonNode sourceSummary,
               UUID restorationId,String errorCode,String resolutionNote,Instant createdAt,Instant startedAt,Instant completedAt,
               String statisticsPolicy,boolean worldRuntimeVerified) {}
    record Page(List<Job> items,long total,int page,int size) {}
    record Claim(Job job,UUID attemptId,Instant leaseUntil,boolean active) {}
    private record Attempt(UUID id,UUID jobId,UUID hostId,UUID runId,Instant until) {}
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ArchiveRepository archives;
    private final BackupHosts hosts;
    private final BackupService backups;
    private final CollectorCredentials collectors;
    private final ObjectMapper json;
    RestoreJobs(JdbcTemplate jdbc,TransactionTemplate transaction,ArchiveRepository archives,BackupHosts hosts,BackupService backups,CollectorCredentials collectors,ObjectMapper json) {
        this.jdbc=jdbc;this.transaction=transaction;this.archives=archives;this.hosts=hosts;this.backups=backups;this.collectors=collectors;this.json=json;
    }
    private void lock() { jdbc.queryForObject("SELECT id FROM ingestion_mutex WHERE id=1 FOR UPDATE",Integer.class); }
    private static OffsetDateTime now() {return OffsetDateTime.now(ZoneOffset.UTC);}
    private static ResponseStatusException error(HttpStatus status,String text) {return new ResponseStatusException(status,text);}
    private static void check(boolean condition,String text) {if(!condition)throw error(HttpStatus.CONFLICT,text);}
    private JsonNode parse(String text) {try{return json.readTree(text);}catch(IOException ex){throw error(HttpStatus.SERVICE_UNAVAILABLE,"恢复记录暂时无法读取");}}
    private Job row(ResultSet rs,int index) throws SQLException {
        String mode=rs.getString("mode");
        return new Job(rs.getObject("id",UUID.class),rs.getObject("backup_id",UUID.class),rs.getObject("source_server_id",UUID.class),rs.getObject("target_server_id",UUID.class),
                rs.getObject("host_id",UUID.class),mode,rs.getString("destination_name"),rs.getString("note"),rs.getString("status"),rs.getBoolean("cancel_requested"),rs.getObject("source_backup_id",UUID.class),
                rs.getString("archive_sha256"),rs.getString("archive_bytes"),rs.getInt("file_count"),parse(rs.getString("source_summary")),rs.getObject("restoration_id",UUID.class),rs.getString("error_code"),rs.getString("resolution_note"),
                TelemetryQueries.instant(rs,"created_at"),TelemetryQueries.instant(rs,"started_at"),TelemetryQueries.instant(rs,"completed_at"),
                mode.equals("CONTINUE")?"PRESERVE_CENTRAL_HISTORY_AND_IDEMPOTENT_CACHE_REPLAY":"ORIGINAL_CACHE_QUARANTINED_NO_AUTOMATIC_REPLAY",false);
    }
    private Job job(UUID id) {return jdbc.query("SELECT * FROM restore_jobs WHERE id=?",this::row,id).stream().findFirst().orElseThrow(()->error(HttpStatus.NOT_FOUND,"恢复任务不存在"));}
    private Job owned(BackupHosts.Identity identity,UUID id) {hosts.verify(identity);Job result=job(id);if(!result.hostId().equals(identity.hostId()))throw error(HttpStatus.NOT_FOUND,"恢复任务不存在");return result;}
    @Transactional public Job find(UUID id) {lock();hosts.expire();return job(id);}
    @Transactional public Job own(BackupHosts.Identity identity,UUID id) {lock();hosts.expire();return owned(identity,id);}
    @Transactional public Page list(UUID serverId,int page,int size) {
        if(page<0||page>100000||size<1||size>100)throw error(HttpStatus.BAD_REQUEST,"分页范围无效");
        lock();hosts.expire();String where=serverId==null?"":" WHERE source_server_id=? OR target_server_id=?";
        Object[] args=serverId==null?new Object[]{}:new Object[]{serverId,serverId};
        Object[] paged=serverId==null?new Object[]{size,page*size}:new Object[]{serverId,serverId,size,page*size};
        return new Page(jdbc.query("SELECT * FROM restore_jobs"+where+" ORDER BY created_at DESC,id LIMIT ? OFFSET ?",this::row,paged),jdbc.queryForObject("SELECT COUNT(*) FROM restore_jobs"+where,Long.class,args),page,size);
    }
    @Transactional public Job create(UUID backupId,RestoreController.Request request) {
        String folder=request.destinationName();
        if(!Normalizer.isNormalized(folder,Normalizer.Form.NFC)||!folder.matches("[\\p{L}\\p{N}][\\p{L}\\p{N}_-]{0,63}")||folder.matches("(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])"))throw error(HttpStatus.BAD_REQUEST,"目标须为一个新的目录名，不含路径或保留名称");
        if(request.note().codePoints().anyMatch(c->c<32&&c!=9&&c!=10&&c!=13))throw error(HttpStatus.BAD_REQUEST,"备注包含不支持的字符");
        boolean fork=request.mode().equals("FORK");
        if(fork?(request.forkName()==null||request.forkName().isBlank()||!request.forkName().equals(request.forkName().strip())||request.forkStartDate()==null||request.forkName().codePoints().anyMatch(Character::isISOControl)):(request.forkName()!=null||request.forkStartDate()!=null))
            throw error(HttpStatus.BAD_REQUEST,"新一期须填写名称和开服日期，其他恢复方式不能修改目标档案");
        lock();
        var previous=jdbc.queryForList("SELECT id FROM restore_jobs WHERE request_id=?",UUID.class,request.requestId());
        if(!previous.isEmpty()) {
            Job old=job(previous.getFirst());
            var fields=jdbc.queryForMap("SELECT fork_name,fork_start_date FROM restore_jobs WHERE id=?",old.id());
            String oldDate=fields.get("fork_start_date")==null?null:fields.get("fork_start_date").toString();
            check(old.backupId().equals(backupId)&&old.hostId().equals(request.hostId())&&old.mode().equals(request.mode())&&old.destinationName().equals(folder)&&old.note().equals(request.note().strip())
                    &&Objects.equals(fields.get("fork_name"),request.forkName())&&Objects.equals(oldDate,request.forkStartDate()==null?null:request.forkStartDate().toString()),"此请求标识已用于另一恢复任务");
            return old;
        }
        var host=hosts.host(request.hostId());check(!host.revoked()&&host.restoreEnabled(),"执行端尚未启用新目录恢复能力");
        UUID sourceId=backups.find(backupId).serverId();var source=archives.lock(sourceId).orElseThrow();var backup=backups.lockForRestore(backupId);
        if (backup.summary().path("archiveScope").asText().equals("WORLD")) {
            check(request.mode().equals("DISABLED"), "世界存档只能解压到新目录，不包含插件或统计迁移");
            check(supportsWorldBackup(host.version()), "世界存档恢复需要备份程序 0.7.0 或更高版本");
        }
        check(!request.mode().equals("CONTINUE")||(host.serverId().equals(sourceId)&&source.status().equals("RECORDING")),"继续原一期须使用该期执行端，且原档案仍在记录中");
        check(jdbc.queryForObject("SELECT COUNT(*) FROM restore_jobs WHERE host_id=? AND destination_key=?",Integer.class,host.id(),folder.toLowerCase(Locale.ROOT))==0,"此执行端的目标目录名已被使用，请选择新目录");
        UUID targetId=fork?archives.create(request.forkName(),"从完整备份创建的新一期",request.forkStartDate()).id():sourceId,id=UUID.randomUUID();
        jdbc.update("INSERT INTO restore_jobs(id,request_id,backup_id,source_server_id,target_server_id,host_id,mode,destination_name,destination_key,note,fork_name,fork_start_date,status,source_backup_id,archive_sha256,archive_bytes,file_count,source_summary) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'QUEUED',?,?,?,?,?)",
                id,request.requestId(),backupId,sourceId,targetId,host.id(),request.mode(),folder,folder.toLowerCase(Locale.ROOT),request.note().strip(),request.forkName(),request.forkStartDate(),backup.sourceBackupId(),backup.sha256(),Long.parseLong(backup.archiveBytes()),backup.fileCount(),backup.summary().toString());
        return job(id);
    }
    private Attempt attempt(UUID id) {return jdbc.query("SELECT * FROM restore_attempts WHERE id=?",(rs,i)->new Attempt(rs.getObject("id",UUID.class),rs.getObject("job_id",UUID.class),rs.getObject("host_id",UUID.class),rs.getObject("runner_id",UUID.class),TelemetryQueries.instant(rs,"lease_until")),id).stream().findFirst().orElseThrow(()->error(HttpStatus.CONFLICT,"恢复尝试不存在"));}
    private UUID currentAttempt(UUID id) {return jdbc.queryForObject("SELECT attempt_id FROM restore_jobs WHERE id=?",UUID.class,id);}
    private void runnable(BackupHosts.Host host,Job job) {
        check(host.restoreEnabled()&&Set.of("RUNNING","STOPPED").contains(host.runtimeState()),"执行端未就绪");
        if (backups.find(job.backupId()).summary().path("archiveScope").asText().equals("WORLD"))
            check(supportsWorldBackup(host.version()), "世界存档恢复需要备份程序 0.7.0 或更高版本");
        if(!job.mode().equals("DISABLED"))check(archives.lock(job.targetServerId()).orElseThrow().status().equals("RECORDING"),"目标档案已经封存，不能启用采集");
        if(job.mode().equals("CONTINUE")) {
            check(host.runtimeState().equals("STOPPED"),"继续原一期须先停止原游戏并使用恢复维护模式");
            check(archives.lock(job.targetServerId()).orElseThrow().status().equals("RECORDING"),"原档案已经封存，不能启用继续采集");
        }
    }
    static boolean supportsWorldBackup(String version) {
        if (version == null || !version.matches("[0-9]+\\.[0-9]+\\.[0-9]+")) return false;
        try { String[] parts=version.split("\\."); return Integer.parseInt(parts[0])>0 || Integer.parseInt(parts[1])>=7; }
        catch (NumberFormatException ex) { return false; }
    }
    private Job require(BackupHosts.Identity identity,UUID id,HostController.Lease lease,boolean executing) {
        var host=hosts.runner(identity,lease.runId());Job result=owned(identity,id);Attempt a=attempt(lease.attemptId());
        check(a.jobId().equals(id)&&a.hostId().equals(identity.hostId())&&a.runId().equals(lease.runId())&&a.id().equals(currentAttempt(id))&&a.until().isAfter(Instant.now()),"恢复租约已过期或运行实例已改变");
        if(executing){check(!result.cancelRequested(),"恢复正在取消");runnable(host,result);}
        return result;
    }
    @Transactional public Claim claim(BackupHosts.Identity identity,HostController.ClaimRequest request) {
        lock();hosts.expire();var host=hosts.runner(identity,request.runId());
        var old=jdbc.queryForList("SELECT id FROM restore_attempts WHERE claim_request_id=?",UUID.class,request.requestId());
        if(!old.isEmpty()) {Attempt a=attempt(old.getFirst());check(a.hostId().equals(host.id())&&a.runId().equals(request.runId()),"领取标识属于其他运行实例");Job j=job(a.jobId());return new Claim(j,a.id(),a.until(),a.id().equals(currentAttempt(j.id()))&&a.until().isAfter(Instant.now())&&Set.of("CLAIMED","RUNNING").contains(j.status()));}
        if(!host.restoreEnabled()||!Set.of("RUNNING","STOPPED").contains(host.runtimeState()))return null;
        if(jdbc.queryForObject("SELECT COUNT(*) FROM backup_jobs WHERE host_id=? AND status IN ('CLAIMED','RUNNING','UPLOADING','UNCERTAIN')",Integer.class,host.id())>0
                ||jdbc.queryForObject("SELECT COUNT(*) FROM restore_jobs WHERE host_id=? AND status IN ('CLAIMED','RUNNING','UNCERTAIN')",Integer.class,host.id())>0)return null;
        var queued=jdbc.query("SELECT * FROM restore_jobs WHERE host_id=? AND status='QUEUED' AND (mode<>'CONTINUE' OR ?='STOPPED') ORDER BY created_at,id LIMIT 1",this::row,host.id(),host.runtimeState());
        if(queued.isEmpty())return null;Job j=queued.getFirst();
        if (backups.find(j.backupId()).summary().path("archiveScope").asText().equals("WORLD") && !supportsWorldBackup(host.version())) return null;
        UUID id=UUID.randomUUID();OffsetDateTime until=now().plusSeconds(120);
        jdbc.update("INSERT INTO restore_attempts(id,claim_request_id,job_id,host_id,runner_id,lease_until) VALUES (?,?,?,?,?,?)",id,request.requestId(),j.id(),host.id(),request.runId(),until);
        jdbc.update("UPDATE restore_jobs SET status='CLAIMED',attempt_id=?,error_code=NULL WHERE id=?",id,j.id());return new Claim(job(j.id()),id,until.toInstant(),true);
    }
    @Transactional public Job start(BackupHosts.Identity identity,UUID id,HostController.Lease lease) {
        lock();Job j=require(identity,id,lease,true);
        if(j.status().equals("CLAIMED"))jdbc.update("UPDATE restore_jobs SET status='RUNNING',started_at=? WHERE id=?",now(),id);
        else check(j.status().equals("RUNNING"),"恢复任务不能开始");return job(id);
    }
    @Transactional public Job renew(BackupHosts.Identity identity,UUID id,HostController.Lease lease) {
        lock();Job j=require(identity,id,lease,false);check(Set.of("CLAIMED","RUNNING").contains(j.status()),"恢复已不再执行");
        jdbc.update("UPDATE restore_attempts SET lease_until=? WHERE id=?",now().plusSeconds(120),lease.attemptId());return j;
    }
    @Transactional public Job cancel(UUID id) {
        lock();hosts.expire();Job j=job(id);
        if(Set.of("QUEUED","CLAIMED").contains(j.status()))jdbc.update("UPDATE restore_jobs SET status='CANCELLED',cancel_requested=TRUE,completed_at=? WHERE id=?",now(),id);
        else if(Set.of("RUNNING","UNCERTAIN").contains(j.status()))jdbc.update("UPDATE restore_jobs SET cancel_requested=TRUE WHERE id=?",id);
        cleanupFork(id);return job(id);
    }
    @Transactional public Job resolve(UUID id,HostController.Resolution request) {
        lock();hosts.expire();check(job(id).status().equals("UNCERTAIN"),"只有不确定任务可人工处理");
        if(!request.note().equals(request.note().strip())||request.note().codePoints().anyMatch(Character::isISOControl))throw error(HttpStatus.BAD_REQUEST,"处理说明无效");
        jdbc.update("UPDATE restore_jobs SET status=?,cancel_requested=TRUE,error_code='OPERATOR_RESOLVED',resolution_note=?,completed_at=? WHERE id=?",request.outcome(),request.note(),now(),id);cleanupFork(id);return job(id);
    }
    @Transactional public Job report(BackupHosts.Identity identity,UUID id,RestoreController.Report request) {
        lock();Job j=require(identity,id,new HostController.Lease(request.runId(),request.attemptId()),false);
        if(j.status().equals(request.outcome()))return j;
        check(Set.of("CLAIMED","RUNNING","UNCERTAIN").contains(j.status()),"恢复已经结束");
        jdbc.update("UPDATE restore_jobs SET status=?,error_code=?,completed_at=? WHERE id=?",request.outcome(),request.code(),request.outcome().equals("UNCERTAIN")?null:now(),id);cleanupFork(id);return job(id);
    }
    private void cleanupFork(UUID id) {jdbc.update("DELETE FROM collector_credentials c WHERE EXISTS (SELECT 1 FROM restore_jobs r WHERE r.id=? AND r.mode='FORK' AND r.target_server_id=c.server_id AND r.collector_hash=c.token_hash AND (r.status IN ('FAILED','CANCELLED') OR r.cancel_requested=TRUE) AND r.status<>'READY')",id);}
    private void authenticateCollector(String token) {try {collectors.authenticate("Bearer "+token);}catch(ResponseStatusException ex){throw error(HttpStatus.CONFLICT,"目标采集凭据无效或已轮换");}}
    @Transactional public Job collector(BackupHosts.Identity identity,UUID id,RestoreController.Credential request) {
        lock();Job j=require(identity,id,new HostController.Lease(request.runId(),request.attemptId()),true);check(j.status().equals("RUNNING")&&!j.mode().equals("DISABLED"),"此任务不需要启用采集");
        String token=request.collectorToken();check(token!=null&&token.matches(java.util.regex.Pattern.quote(j.targetServerId().toString())+"\\.[A-Za-z0-9_-]{43}"),"目标采集凭据无效");
        collectors.lockServer(j.targetServerId());String hash=CollectorCredentials.hash(token.getBytes(StandardCharsets.UTF_8));String recorded=jdbc.queryForObject("SELECT collector_hash FROM restore_jobs WHERE id=?",String.class,id);
        if(j.mode().equals("CONTINUE")) authenticateCollector(token);
        else if(recorded==null) {
            check(jdbc.queryForObject("SELECT COUNT(*) FROM collector_credentials WHERE server_id=?",Integer.class,j.targetServerId())==0,"新一期已有其他采集凭据，请先核实");
            jdbc.update("INSERT INTO collector_credentials(server_id,token_hash,created_at) VALUES (?,?,?)",j.targetServerId(),hash,now());
        } else {check(recorded.equals(hash),"必须继续使用原恢复凭据");authenticateCollector(token);}
        if(recorded!=null)check(recorded.equals(hash),"恢复凭据已改变，请先核实原结果");
        jdbc.update("UPDATE restore_jobs SET collector_hash=? WHERE id=?",hash,id);return j;
    }
    private void credentialValid(Job j) {
        if(j.mode().equals("DISABLED"))return;
        collectors.lockServer(j.targetServerId());String hash=jdbc.queryForObject("SELECT collector_hash FROM restore_jobs WHERE id=?",String.class,j.id());
        check(hash!=null&&jdbc.queryForObject("SELECT COUNT(*) FROM collector_credentials WHERE server_id=? AND token_hash=?",Integer.class,j.targetServerId(),hash)==1,"目标采集凭据尚未确认或已经改变");
    }
    @Transactional public Job ready(BackupHosts.Identity identity,UUID id,RestoreController.Ready request,boolean recovery) {
        lock();hosts.expire();Job j=owned(identity,id);
        check(j.sourceBackupId().equals(request.sourceBackupId())&&j.targetServerId().equals(request.targetServerId())&&j.mode().equals(request.mode())&&j.destinationName().equals(request.destinationName())&&j.archiveSha256().equals(request.sha256())&&j.fileCount()==request.fileCount(),"恢复结果与原任务不一致");
        if(j.status().equals("READY")){check(j.restorationId().equals(request.restorationId()),"恢复结果身份不能改变");return j;}
        if(recovery) {
            var host=hosts.runner(identity,request.runId());Attempt a=attempt(request.attemptId());
            check(a.jobId().equals(id)&&a.hostId().equals(identity.hostId())&&a.id().equals(currentAttempt(id))&&Set.of("RUNNING","UNCERTAIN").contains(j.status())&&!j.cancelRequested(),"原恢复尝试不能重新确认");runnable(host,j);
        } else {require(identity,id,new HostController.Lease(request.runId(),request.attemptId()),true);check(j.status().equals("RUNNING"),"恢复尚未开始");}
        credentialValid(j);
        try {jdbc.update("UPDATE restore_jobs SET status='READY',restoration_id=?,error_code=NULL,completed_at=? WHERE id=?",request.restorationId(),now(),id);}
        catch(DuplicateKeyException ex){throw error(HttpStatus.CONFLICT,"恢复结果身份已用于其他任务");}return job(id);
    }
    private Job readable(BackupHosts.Identity identity,UUID id,HostController.Lease lease) {
        return transaction.execute(tx->{lock();Job j=require(identity,id,lease,true);check(j.status().equals("RUNNING"),"恢复归档只供正在执行的原任务读取");return j;});
    }
    BackupService.Download content(BackupHosts.Identity identity,UUID id,HostController.Lease lease) throws IOException {
        Job j=readable(identity,id,lease);var source=backups.download(j.backupId());
        try {check(source.sha256().equals(j.archiveSha256())&&Long.toString(source.bytes()).equals(j.archiveBytes()),"原归档已经改变");readable(identity,id,lease);}
        catch(RuntimeException ex){source.stream().close();throw ex;}
        InputStream guarded=new InputStream() {
            final InputStream input=source.stream();
            long bytes=1048576,checked=0;
            void fence() {long time=System.nanoTime();if(bytes>=1048576||time-checked>=1_000_000_000L){readable(identity,id,lease);bytes=0;checked=time;}}
            @Override public int read() throws IOException {fence();int value=input.read();if(value>=0)bytes++;else readable(identity,id,lease);return value;}
            @Override public int read(byte[] data,int offset,int length) throws IOException {Objects.checkFromIndexSize(offset,length,data.length);if(length==0)return 0;fence();int value=input.read(data,offset,(int)Math.min(length,1048576-bytes));if(value>0)bytes+=value;else if(value==-1)readable(identity,id,lease);return value;}
            @Override public void close() throws IOException {input.close();}
        };
        return new BackupService.Download(guarded,source.bytes(),source.sha256());
    }
}
