package org.mcmanager.archive;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import static org.mcmanager.archive.TelemetryValidation.*;
import static org.mcmanager.archive.TelemetryService.time;

@Service
class ServerRuntime {
    static final String NOTICE="约每 10 秒采样，明细保留 30 天；曲线按时间段汇总，空缺不是零。流畅度来自游戏 tick 间隔，最多显示 20 TPS，不是单帧执行耗时 MSPT。CPU 为游戏进程占整机全部逻辑核心的比例，内存为游戏进程工作集。断联、长帧和重启是观察结果，不能单凭这些认定崩溃或卡顿原因。区块数、实体数暂未采集。整机 CPU、物理内存和固定磁盘空间来自 Windows 系统接口；网络为已启用物理网卡的收发总速率，虚拟/VPN 网卡不重复相加。整机采样随游戏采集插件运行，停服后不继续监控。磁盘显示空间，不是读写速度。";
    record Sample(UUID bootId,long sequence,Instant at,Instant receivedAt,long windowMillis,long uptimeMillis,long ticks,int players,Instant lastTickAt,double maxTickIntervalMillis,Double cpuPercent,Long workingSetBytes,Long privateBytes,Long hostMemoryTotalBytes,Long hostMemoryAvailableBytes,boolean stopped,Double tps,Double hostCpuPercent,Integer hostLogicalProcessors,Double hostNetworkReceiveBps,Double hostNetworkSendBps,List<TelemetryPayload.HostDisk> hostDisks){}
    record Point(Instant at,long samples,Double tps,Double cpuPercent,Double memoryMiB,Integer players,double maxTickIntervalMillis,Double hostCpuPercent,Double hostMemoryUsedPercent,Double hostNetworkReceiveBps,Double hostNetworkSendBps){}
    record Event(Instant at,String type,String message){}
    record Report(UUID serverId,String serverName,String state,Instant generatedAt,Instant from,Instant to,int bucketSeconds,Sample latest,List<Point> points,List<Event> events,boolean eventsTruncated,String notice){}
    private final JdbcTemplate jdbc;private final ObjectMapper json;
    ServerRuntime(JdbcTemplate jdbc,ObjectMapper json){this.jdbc=jdbc;this.json=json;}
    void store(UUID server,TelemetryPayload.Collector collector){
        var s=collector.runtime();if(s==null||s.at().isBefore(Instant.now().minus(Duration.ofDays(30))))return;
        String hash;try{hash=CollectorCredentials.hash(json.writeValueAsBytes(s));}catch(Exception e){throw new IllegalStateException(e);}
        var prior=jdbc.queryForList("SELECT payload_hash FROM server_runtime_samples WHERE server_id=? AND boot_id=? AND sequence_number=?",String.class,server,collector.bootId(),s.sequence());
        if(!prior.isEmpty()){if(!hash.equals(prior.getFirst()))throw conflict("同一运行采样序号被不同内容使用");return;}
        jdbc.update("INSERT INTO server_runtime_samples(server_id,boot_id,sequence_number,observed_at,window_millis,uptime_millis,ticks,players,last_tick_at,max_tick_interval,cpu_percent,working_set_bytes,private_bytes,host_memory_total_bytes,host_memory_available_bytes,stopped,payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            server,collector.bootId(),s.sequence(),time(s.at()),s.windowMillis(),s.uptimeMillis(),s.ticks(),s.players(),s.lastTickAt()==null?null:time(s.lastTickAt()),s.maxTickIntervalMillis(),s.cpuPercent(),s.workingSetBytes(),s.privateBytes(),s.hostMemoryTotalBytes(),s.hostMemoryAvailableBytes(),s.stopped(),hash);
        if(s.hostCpuPercent()!=null||s.hostLogicalProcessors()!=null||s.hostNetworkReceiveBps()!=null||s.hostNetworkSendBps()!=null||s.hostDisks()!=null){
            String disks;try{disks=s.hostDisks()==null?null:json.writeValueAsString(s.hostDisks());}catch(Exception e){throw new IllegalStateException(e);}
            jdbc.update("UPDATE server_runtime_samples SET host_cpu_percent=?,host_logical_processors=?,host_network_receive_bps=?,host_network_send_bps=?,host_disks_json=? WHERE server_id=? AND boot_id=? AND sequence_number=?",s.hostCpuPercent(),s.hostLogicalProcessors(),s.hostNetworkReceiveBps(),s.hostNetworkSendBps(),disks,server,collector.bootId(),s.sequence());
        }
    }
    static Instant instant(java.sql.ResultSet r,String name)throws java.sql.SQLException{var t=r.getObject(name,OffsetDateTime.class);return t==null?null:t.toInstant();}
    private static Double nullableDouble(java.sql.ResultSet r,String name)throws java.sql.SQLException{double value=r.getDouble(name);return r.wasNull()?null:value;}
    private Sample sample(java.sql.ResultSet r,int i)throws java.sql.SQLException{
        long ticks=r.getLong("ticks"),window=r.getLong("window_millis");boolean stopped=r.getBoolean("stopped");
        return new Sample(r.getObject("boot_id",UUID.class),r.getLong("sequence_number"),instant(r,"observed_at"),instant(r,"received_at"),window,r.getLong("uptime_millis"),ticks,r.getInt("players"),instant(r,"last_tick_at"),r.getDouble("max_tick_interval"),r.getObject("cpu_percent",Double.class),r.getObject("working_set_bytes",Long.class),r.getObject("private_bytes",Long.class),r.getObject("host_memory_total_bytes",Long.class),r.getObject("host_memory_available_bytes",Long.class),stopped,stopped?null:Math.min(20.0,ticks*1000.0/window),nullableDouble(r,"host_cpu_percent"),r.getObject("host_logical_processors",Integer.class),nullableDouble(r,"host_network_receive_bps"),nullableDouble(r,"host_network_send_bps"),disks(r.getString("host_disks_json")));
    }
    private List<TelemetryPayload.HostDisk> disks(String value){if(value==null)return null;try{return Arrays.asList(json.readValue(value,TelemetryPayload.HostDisk[].class));}catch(Exception e){throw new IllegalStateException("Invalid stored host disk sample",e);}}
    Report read(UUID server,int hours){
        check(hours>=1&&hours<=168,"时间范围须为 1–168 小时");
        var names=jdbc.queryForList("SELECT name FROM server_archives WHERE id=?",String.class,server);if(names.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"服务器档案不存在");
        Instant now=Instant.now(),from=now.minus(Duration.ofHours(hours));int bucket=hours<=6?10:hours<=24?60:600;
        var last=jdbc.query("SELECT * FROM server_runtime_samples WHERE server_id=? ORDER BY observed_at DESC,received_at DESC,sequence_number DESC LIMIT 1",this::sample,server);Sample latest=last.isEmpty()?null:last.getFirst();
        String state=latest==null?"NO_DATA":latest.stopped()?"STOPPED":latest.at().isBefore(now.minusSeconds(45))?"STALE":latest.lastTickAt()==null||latest.lastTickAt().isBefore(latest.at().minusSeconds(5))?"TICK_STALLED":latest.tps()<18?"SLOW":"HEALTHY";
        var points=jdbc.query("SELECT FLOOR(EXTRACT(EPOCH FROM observed_at)/?) AS bucket,COUNT(*) AS samples,SUM(ticks)*1000.0/SUM(window_millis) AS tps,AVG(cpu_percent) AS cpu,AVG(working_set_bytes/1048576.0) AS memory,MAX(players) AS players,MAX(max_tick_interval) AS longest,AVG(host_cpu_percent) AS host_cpu,AVG(CASE WHEN host_memory_total_bytes>0 AND host_memory_available_bytes IS NOT NULL THEN (host_memory_total_bytes-host_memory_available_bytes)*100.0/host_memory_total_bytes ELSE NULL END) AS host_memory,AVG(host_network_receive_bps) AS host_rx,AVG(host_network_send_bps) AS host_tx FROM server_runtime_samples WHERE server_id=? AND observed_at>=? AND observed_at<=? AND stopped=FALSE GROUP BY bucket ORDER BY bucket",
            (r,i)->new Point(Instant.ofEpochSecond(r.getLong("bucket")*bucket),r.getLong("samples"),Math.min(20.0,r.getDouble("tps")),nullableDouble(r,"cpu"),nullableDouble(r,"memory"),r.getInt("players"),r.getDouble("longest"),nullableDouble(r,"host_cpu"),nullableDouble(r,"host_memory"),nullableDouble(r,"host_rx"),nullableDouble(r,"host_tx")),bucket,server,time(from),time(now));
        // Bound the result in SQL, retaining predecessor information for gap/restart detection.
        var events=jdbc.query("SELECT * FROM (SELECT observed_at,boot_id,stopped,ticks,window_millis,max_tick_interval,LAG(observed_at) OVER (ORDER BY observed_at,received_at,sequence_number) AS previous_at,LAG(boot_id) OVER (ORDER BY observed_at,received_at,sequence_number) AS previous_boot FROM server_runtime_samples WHERE server_id=? AND observed_at>=? AND observed_at<=?) s WHERE stopped=TRUE OR ticks*1000.0/window_millis<18 OR max_tick_interval>=250 OR (previous_at IS NOT NULL AND observed_at>previous_at+INTERVAL '45' SECOND) OR (previous_boot IS NOT NULL AND previous_boot<>boot_id) ORDER BY observed_at DESC LIMIT 101",
            (r,i)->{
                Instant at=instant(r,"observed_at"),previous=instant(r,"previous_at");String type,message;
                if(r.getBoolean("stopped")){type="STOPPED";message="采集插件正常停止（不代表游戏进程已经退出）";}
                else if(r.getObject("previous_boot")!=null&&!r.getObject("previous_boot").equals(r.getObject("boot_id"))){type="RESTART";message="检测到新的采集启动，可能是游戏重启或插件重新加载";}
                else if(previous!=null&&Duration.between(previous,at).toSeconds()>45){type="GAP";message="此前运行数据中断，原因可能是停服、网络或采集异常";}
                else {type="LAG";message="记录到流畅度下降或较长的游戏帧间隔";}
                return new Event(at,type,message);
            },server,time(from.minusSeconds(60)),time(now)).stream().filter(e->!e.at().isBefore(from)).toList();
        return new Report(server,names.getFirst(),state,now,from,now,bucket,latest,points,events.stream().limit(100).toList(),events.size()>100,NOTICE);
    }
    @Scheduled(initialDelay=3600000,fixedDelay=3600000)
    void cleanup(){jdbc.update("DELETE FROM server_runtime_samples WHERE observed_at<?",time(Instant.now().minus(Duration.ofDays(30))));}
}
