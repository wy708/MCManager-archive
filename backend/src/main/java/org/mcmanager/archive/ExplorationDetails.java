package org.mcmanager.archive;

import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import static org.mcmanager.archive.TelemetryValidation.check;

/** Additional charts are fetched only when opened, not in the ingestion path. */
@Service
class ExplorationDetails {
    record Key(UUID server,LocalDate from,LocalDate to,ZoneId zone) {}
    record Snapshot(Instant generatedAt,LocalDate from,LocalDate to,String zone,String serverName,
        List<Map<String,Object>> daily,List<Map<String,Object>> players,List<Map<String,Object>> runtime,
        List<Map<String,Object>> milestones,List<String> notices) {}
    private final NamedParameterJdbcTemplate jdbc;
    private final TelemetryQueries queries;
    private final TransactionTemplate reads;
    private final LinkedHashMap<Key,Snapshot> cache=new LinkedHashMap<>();
    ExplorationDetails(JdbcTemplate source,TelemetryQueries queries,PlatformTransactionManager transactions){
        var read=new JdbcTemplate(Objects.requireNonNull(source.getDataSource()));read.setQueryTimeout(8);
        jdbc=new NamedParameterJdbcTemplate(read);this.queries=queries;reads=new TransactionTemplate(transactions);reads.setReadOnly(true);reads.setTimeout(60);
    }
    public synchronized Snapshot get(UUID server,LocalDate from,LocalDate to){
        check(server!=null,"请选择一个服务器");to=to==null?LocalDate.now(queries.zone()):to;from=from==null?to.minusDays(6):from;
        check(from.getYear()>=1970&&to.getYear()<9999&&!from.isAfter(to)&&ChronoUnit.DAYS.between(from,to)<31,"每次请选择 1 至 31 天");
        queries.scope(new TelemetryQueries.Filter(server,null,from,to,null));var key=new Key(server,from,to,queries.zone());var saved=cache.get(key);
        if(saved!=null&&saved.generatedAt().isAfter(Instant.now().minusSeconds(120)))return saved;
        return reads.execute(status->{var result=build(key);cache.put(key,result);while(cache.size()>8)cache.remove(cache.keySet().iterator().next());return result;});
    }
    private Snapshot build(Key key){
        var zone=key.zone();var p=new HashMap<String,Object>();p.put("server",key.server());p.put("from",key.from());p.put("to",key.to());p.put("zone",zone.getId());
        p.put("start",TelemetryService.time(key.from().atStartOfDay(zone).toInstant()));p.put("end",TelemetryService.time(key.to().plusDays(1).atStartOfDay(zone).toInstant()));
        var notes=new ArrayList<String>();
        var daily=jdbc.queryForList("SELECT statistic_day AS stat_day,metric,SUM(statistic_value) AS amount FROM daily_statistics WHERE server_id=:server AND statistic_day>=:from AND statistic_day<=:to AND (metric IN ('blocks.placed','blocks.mined','crops.planted','crops.harvested','chat.messages') OR metric LIKE 'travel.%') GROUP BY statistic_day,metric ORDER BY statistic_day,metric",p);
        for(var row:daily)row.put("day",row.remove("stat_day"));
        String summed="SUM(CASE WHEN d.metric='%s' THEN d.statistic_value ELSE 0 END) AS %s";
        var expressions=new ArrayList<String>();for(var pair:List.of(new String[]{"online.millis","online"},new String[]{"blocks.placed","placed"},new String[]{"blocks.mined","mined"},new String[]{"crops.planted","planted"},new String[]{"crops.harvested","harvested"},new String[]{"chat.messages","chat"}))expressions.add(summed.formatted(pair[0],pair[1]));
        expressions.add("SUM(CASE WHEN d.metric LIKE 'travel.%' THEN d.statistic_value ELSE 0 END) AS travel");
        var players=jdbc.queryForList("SELECT d.player_key AS player,MAX(p.current_name) AS name,"+String.join(",",expressions)+" FROM daily_statistics d JOIN players p ON p.player_key=d.player_key WHERE d.server_id=:server AND d.statistic_day>=:from AND d.statistic_day<=:to AND (d.metric IN ('online.millis','blocks.placed','blocks.mined','crops.planted','crops.harvested','chat.messages') OR d.metric LIKE 'travel.%') GROUP BY d.player_key ORDER BY online DESC,d.player_key LIMIT 501",p);
        if(players.size()>500){notes.add("玩家对比仅显示在线时长最高的 500 位；分数以这批玩家为比较范围。");players=new ArrayList<>(players.subList(0,500));}
        var runtime=new ArrayList<Map<String,Object>>();
        for(var entry:Map.of("host_cpu","host_cpu_percent","host_memory","CASE WHEN host_memory_total_bytes>0 AND host_memory_available_bytes IS NOT NULL THEN (host_memory_total_bytes-host_memory_available_bytes)*100.0/host_memory_total_bytes ELSE NULL END","tps","LEAST(20.0,ticks*1000.0/window_millis)","cpu","cpu_percent","memory","working_set_bytes/1048576.0","interval","max_tick_interval").entrySet()){
            String value=entry.getValue();
            var rows=jdbc.queryForList("SELECT stat_day,COUNT("+value+") AS samples,MIN("+value+") AS minimum,PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY "+value+") AS q1,PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "+value+") AS median,PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY "+value+") AS q3,MAX("+value+") AS maximum FROM (SELECT *,CAST(observed_at AT TIME ZONE :zone AS DATE) AS stat_day FROM server_runtime_samples WHERE server_id=:server AND observed_at>=:start AND observed_at<:end AND stopped=FALSE AND window_millis>0) samples_by_day GROUP BY stat_day ORDER BY stat_day",p);
            for(var row:rows)if(((Number)row.get("samples")).longValue()>0){row.put("day",row.remove("stat_day"));row.put("metric",entry.getKey());runtime.add(row);}
        }
        String events="SELECT 'PROJECT_START' AS kind,p.name AS name,f.started_at AS at,p.id AS project,f.revision AS revision FROM construction_phases f JOIN construction_projects p ON p.id=f.project_id WHERE p.server_id=:server UNION ALL SELECT 'PROJECT_END',p.name,f.ended_at,p.id,f.revision FROM construction_phases f JOIN construction_projects p ON p.id=f.project_id WHERE p.server_id=:server AND f.ended_at IS NOT NULL UNION ALL SELECT 'BACKUP','世界备份',COALESCE(snapshot_at,created_at),NULL,0 FROM game_backups WHERE server_id=:server AND status IN ('READY','DELETED','MISSING')";
        var milestones=jdbc.queryForList("SELECT * FROM ("+events+") events WHERE at>=:start AND at<:end ORDER BY at DESC,kind,name LIMIT 301",p);
        if(milestones.size()>300){notes.add("事件轴展示所选日期最近 300 项工程及备份记录；缩短日期范围可查看其余记录。");milestones=new ArrayList<>(milestones.subList(0,300));}
        var archive=jdbc.queryForMap("SELECT name,start_date FROM server_archives WHERE id=:server",p);var start=LocalDate.parse(archive.get("start_date").toString());
        if(!start.isBefore(key.from())&&!start.isAfter(key.to()))milestones.add(new LinkedHashMap<>(Map.of("kind","SERVER_START","name",archive.get("name"),"at",TelemetryService.time(start.atStartOfDay(zone).toInstant()),"revision",0)));
        notes.add("扩展图表使用已有每日汇总、工程/备份记录和运行采样，按需读取并共享两分钟缓存，不增加游戏上传频率。");
        notes.add("河流和雷达按页面说明换算强弱，不代表时间占比、职业或能力；没有记录不代表没有行为。移动距离为估算值，种植/收获可能同时计入放置/挖掘。");
        notes.add("运行采样约每 10 秒一次，明细保留 30 天。箱体为第 25/50/75 百分位，须线为观测最小/最大值；不代表所有游戏帧。帧间隔不是 MSPT，断联时段不能当成零。登记开服日期不是实测开机时间。");
        return new Snapshot(Instant.now(),key.from(),key.to(),zone.getId(),archive.get("name").toString(),daily,players,runtime,milestones,notes);
    }
}
