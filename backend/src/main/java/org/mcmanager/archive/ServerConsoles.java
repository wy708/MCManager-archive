package org.mcmanager.archive;

import java.sql.*;
import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
class ServerConsoles {
    record Console(UUID hostId,UUID runId,Instant heartbeatAt,String state,Long pid) {}
    record Log(String id,UUID runId,long sequence,Instant observedAt,String line) {}
    record Command(UUID id,UUID hostId,UUID runId,String action,String command,String requestedBy,String status,Instant createdAt,Instant deliveredAt,Instant completedAt,String message) {}
    record View(UUID serverId,String serverName,UUID hostId,Console console,boolean online,List<Log> lines,String cursor,boolean truncated,List<Command> commands) {}
    record Synced(UUID serverId,UUID hostId,UUID runId,Command command) {}
    private final JdbcTemplate jdbc;
    private final BackupHosts hosts;
    private final ArchiveRepository archives;
    ServerConsoles(JdbcTemplate jdbc,BackupHosts hosts,ArchiveRepository archives) { this.jdbc=jdbc;this.hosts=hosts;this.archives=archives; }
    private static OffsetDateTime now(){return OffsetDateTime.now(ZoneOffset.UTC);}
    private static ResponseStatusException error(HttpStatus status,String message){return new ResponseStatusException(status,message);}
    private static void check(boolean test,String message){if(!test)throw error(HttpStatus.CONFLICT,message);}
    private void lock(){jdbc.queryForObject("SELECT id FROM ingestion_mutex WHERE id=1 FOR UPDATE",Integer.class);}
    private Console console(UUID host){return jdbc.query("SELECT * FROM server_consoles WHERE host_id=?",(rs,n)->new Console(host,rs.getObject("run_id",UUID.class),TelemetryQueries.instant(rs,"heartbeat_at"),rs.getString("state"),(Long)rs.getObject("pid")),host).stream().findFirst().orElse(null);}
    private boolean online(Console c){return c!=null&&!c.state().equals("DISCONNECTED")&&c.heartbeatAt().isAfter(Instant.now().minusSeconds(30));}
    private Command row(ResultSet rs,int n)throws SQLException{return new Command(rs.getObject("id",UUID.class),rs.getObject("host_id",UUID.class),rs.getObject("run_id",UUID.class),rs.getString("action"),rs.getString("command"),rs.getString("requested_by"),rs.getString("status"),TelemetryQueries.instant(rs,"created_at"),TelemetryQueries.instant(rs,"delivered_at"),TelemetryQueries.instant(rs,"completed_at"),rs.getString("message"));}
    private Command find(UUID id){return jdbc.query("SELECT * FROM server_console_commands WHERE id=?",this::row,id).stream().findFirst().orElse(null);}
    private void expire(UUID host){
        jdbc.update("UPDATE server_console_commands SET status='EXPIRED',completed_at=?,message='执行端未及时领取，请重新确认服务器状态' WHERE host_id=? AND status='QUEUED' AND created_at<?",now(),host,now().minusSeconds(30));
        jdbc.update("UPDATE server_console_commands SET status='UNCERTAIN',completed_at=?,message='未收到执行回执，请查看日志；不会自动重复执行' WHERE host_id=? AND status='DELIVERED' AND delivered_at<?",now(),host,now().minusMinutes(3));
    }
    @Transactional public View view(UUID server,long after){
        if(after<0)throw error(HttpStatus.BAD_REQUEST,"日志游标无效");
        var archive=archives.find(server).orElseThrow(()->error(HttpStatus.NOT_FOUND,"服务器不存在"));
        var owners=hosts.hosts(server); if(owners.isEmpty())return new View(server,archive.name(),null,null,false,List.of(),"0",false,List.of());
        var host=owners.getFirst();lock();expire(host.id());Console c=console(host.id());
        List<Log> lines=jdbc.query("SELECT * FROM server_console_logs WHERE host_id=? AND id>? ORDER BY id DESC LIMIT 300",(rs,n)->new Log(rs.getString("id"),rs.getObject("run_id",UUID.class),rs.getLong("sequence"),TelemetryQueries.instant(rs,"observed_at"),rs.getString("line")),host.id(),after);
        Collections.reverse(lines);
        long count=jdbc.queryForObject("SELECT COUNT(*) FROM server_console_logs WHERE host_id=? AND id>?",Long.class,host.id(),after);
        String cursor=lines.isEmpty()?Long.toString(after):lines.getLast().id();
        return new View(server,archive.name(),host.id(),c,!host.revoked()&&online(c),lines,cursor,count>300,jdbc.query("SELECT * FROM server_console_commands WHERE host_id=? ORDER BY created_at DESC,id DESC LIMIT 30",this::row,host.id()));
    }
    static String validateCommand(String text){
        if(text.isBlank()||!text.equals(text.strip())||text.length()>1000||text.codePoints().anyMatch(Character::isISOControl))throw error(HttpStatus.BAD_REQUEST,"请输入一行游戏命令，不能包含换行或控制字符");
        String verb=text.replaceFirst("^/","").split("\\s+",2)[0].toLowerCase(Locale.ROOT);
        if(java.util.regex.Pattern.compile("(?:^/?|\\brun\\s+)(?:minecraft:)?(?:stop|save|archivebackup)(?:\\s|$)",java.util.regex.Pattern.CASE_INSENSITIVE).matcher(text).find())throw error(HttpStatus.BAD_REQUEST,"停服请使用停服按钮；存档控制命令由备份执行端管理");
        return text;
    }
    @Transactional public Command enqueue(UUID server,ServerConsoleController.Request request,String actor){
        lock();var host=hosts.host(request.hostId());check(host.serverId().equals(server),"执行端不属于当前服务器");
        Command existing=find(request.requestId());
        if(existing!=null){check(existing.hostId().equals(host.id())&&existing.runId().equals(request.runId())&&existing.action().equals(request.action())&&existing.command().equals(request.command()),"请求编号已经用于其他操作");return existing;}
        check(!host.revoked(),"执行端凭据已撤销");
        check(archives.find(server).orElseThrow().status().equals("RECORDING"),"已封存服务器不能执行控制台操作");
        Console c=console(host.id());check(online(c)&&c.runId().equals(request.runId()),"执行端已离线或重新连接，请刷新后重试");expire(host.id());
        check(jdbc.queryForObject("SELECT COUNT(*) FROM server_console_commands WHERE host_id=? AND status IN ('QUEUED','DELIVERED')",Integer.class,host.id())==0,"前一个操作仍在处理中，请查看操作记录");
        if(request.action().equals("COMMAND")){validateCommand(request.command());check(c.state().equals("RUNNING"),"游戏尚未运行");}
        else {if(!request.command().isEmpty())throw error(HttpStatus.BAD_REQUEST,"启停操作不能附加命令");check(request.action().equals("START")?Set.of("STOPPED","ERROR").contains(c.state()):c.state().equals("RUNNING"),"当前状态不能执行该操作");}
        jdbc.update("INSERT INTO server_console_commands(id,host_id,run_id,action,command,requested_by,status,created_at) VALUES (?,?,?,?,?,?,'QUEUED',?)",request.requestId(),host.id(),c.runId(),request.action(),request.command(),actor,now());
        // Retain bounded recent command history, never delete an active command.
        var old=jdbc.queryForList("SELECT id FROM server_console_commands WHERE host_id=? ORDER BY created_at DESC,id DESC OFFSET 500 ROWS",UUID.class,host.id());
        for(UUID id:old)jdbc.update("DELETE FROM server_console_commands WHERE id=? AND status NOT IN ('QUEUED','DELIVERED')",id);
        return find(request.requestId());
    }
    static String redact(String line){return line.replaceAll("\\x1b\\[[0-?]*[ -/]*[@-~]","").replaceAll("mcm(?:agent|host|collector)\\.[A-Za-z0-9_.-]+","[凭据已隐藏]").replaceAll("/upload/[a-fA-F0-9]{64}","/upload/[已隐藏]");}
    @Transactional public Synced sync(BackupHosts.Identity identity,ServerConsoleController.Sync request){
        lock();hosts.verify(identity);var host=hosts.host(identity.hostId());Console c=console(host.id());
        if(c!=null&&!c.runId().equals(request.runId()))check(!online(c),"已有控制台执行端在线");
        if(c==null)jdbc.update("INSERT INTO server_consoles(host_id,run_id,heartbeat_at,state,pid) VALUES (?,?,?,?,?)",host.id(),request.runId(),now(),request.state(),request.pid());
        else jdbc.update("UPDATE server_consoles SET run_id=?,heartbeat_at=?,state=?,pid=? WHERE host_id=?",request.runId(),now(),request.state(),request.pid(),host.id());
        jdbc.update("UPDATE server_console_commands SET status='UNCERTAIN',completed_at=?,message='执行端已重新连接，请检查日志；不会自动重发' WHERE host_id=? AND run_id<>? AND status IN ('QUEUED','DELIVERED')",now(),host.id(),request.runId());
        expire(host.id());
        if(!archives.find(host.serverId()).orElseThrow().status().equals("RECORDING"))jdbc.update("UPDATE server_console_commands SET status='EXPIRED',completed_at=?,message='服务器已封存，未执行此操作' WHERE host_id=? AND status='QUEUED'",now(),host.id());
        for(var line:request.lines()){
            if(line.line().contains("MCM_ARCHIVE_BACKUP "))continue;
            if(jdbc.queryForObject("SELECT COUNT(*) FROM server_console_logs WHERE host_id=? AND run_id=? AND sequence=?",Integer.class,host.id(),request.runId(),line.sequence())==0)
                jdbc.update("INSERT INTO server_console_logs(host_id,run_id,sequence,observed_at,line) VALUES (?,?,?,?,?)",host.id(),request.runId(),line.sequence(),OffsetDateTime.ofInstant(line.observedAt(),ZoneOffset.UTC),redact(line.line()));
        }
        var cutoff=jdbc.queryForList("SELECT id FROM server_console_logs WHERE host_id=? ORDER BY id DESC OFFSET 1999 ROWS FETCH FIRST 1 ROW ONLY",Long.class,host.id());
        if(!cutoff.isEmpty())jdbc.update("DELETE FROM server_console_logs WHERE host_id=? AND id<?",host.id(),cutoff.getFirst());
        var receipt=request.receipt();
        if(receipt!=null){Command job=find(receipt.id());check(job!=null&&job.hostId().equals(host.id())&&job.runId().equals(request.runId()),"回执不属于此执行端");
            check(Set.of("DELIVERED","UNCERTAIN",receipt.status()).contains(job.status()),"操作不能接收此回执");
            if(!job.status().equals(receipt.status())){
                check(!receipt.status().equals("SUBMITTED")||job.action().equals("COMMAND"),"启停操作需要完成回执");
                check(!receipt.status().equals("SUCCEEDED")||!job.action().equals("COMMAND"),"游戏命令只确认写入控制台，结果见日志");
                jdbc.update("UPDATE server_console_commands SET status=?,completed_at=?,message=? WHERE id=?",receipt.status(),now(),redact(receipt.message()),job.id());
            }
        }
        Command next=null;
        if(!request.state().equals("DISCONNECTED")&&jdbc.queryForObject("SELECT COUNT(*) FROM server_console_commands WHERE host_id=? AND status='DELIVERED'",Integer.class,host.id())==0){
            var pending=jdbc.query("SELECT * FROM server_console_commands WHERE host_id=? AND run_id=? AND status='QUEUED' ORDER BY created_at LIMIT 1",this::row,host.id(),request.runId());
            if(!pending.isEmpty()){next=pending.getFirst();jdbc.update("UPDATE server_console_commands SET status='DELIVERED',delivered_at=? WHERE id=?",now(),next.id());next=find(next.id());}
        }
        return new Synced(host.serverId(),host.id(),request.runId(),next);
    }
}
