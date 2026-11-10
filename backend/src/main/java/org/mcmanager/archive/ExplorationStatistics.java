package org.mcmanager.archive;

import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import static org.mcmanager.archive.TelemetryValidation.check;

/** Read-only, bounded date windows and shared snapshots; never added to the ingest transaction. */
@Service
class ExplorationStatistics {
    record Key(UUID server,LocalDate from,LocalDate to,String zone) {}
    record Snapshot(Instant generatedAt,LocalDate from,LocalDate to,String zone,List<Map<String,Object>> hours,
        List<Map<String,Object>> contributions,List<Map<String,Object>> hotspots,List<Map<String,Object>> heights,
        List<Map<String,Object>> ranking,Map<String,Object> coverage,List<String> notices) {}
    private final NamedParameterJdbcTemplate jdbc;
    private final TelemetryQueries queries;
    private final TransactionTemplate reads;
    private final LinkedHashMap<Key,Snapshot> cache=new LinkedHashMap<>();
    ExplorationStatistics(JdbcTemplate source,TelemetryQueries queries,PlatformTransactionManager transactions){
        var read=new JdbcTemplate(Objects.requireNonNull(source.getDataSource()));read.setQueryTimeout(8);read.setFetchSize(512);
        jdbc=new NamedParameterJdbcTemplate(read);this.queries=queries;
        reads=new TransactionTemplate(transactions);reads.setReadOnly(true);reads.setTimeout(60);
    }
    // A single builder prevents concurrent viewers from repeating the same expensive aggregation.
    public synchronized Snapshot get(UUID server,LocalDate from,LocalDate to){
        check(server!=null,"请选择一个服务器");var zone=queries.zone();var today=LocalDate.now(zone);
        to=to==null?today:to;from=from==null?to.minusDays(6):from;
        check(from.getYear()>=1970&&to.getYear()<9999&&!from.isAfter(to)&&ChronoUnit.DAYS.between(from,to)<31,"每次请选择 1 至 31 天");
        queries.scope(new TelemetryQueries.Filter(server,null,from,to,null));
        var key=new Key(server,from,to,zone.getId());var saved=cache.get(key);
        if(saved!=null&&saved.generatedAt().isAfter(Instant.now().minusSeconds(120)))return saved;
        // Open the read transaction only after the cache/build lock is acquired.
        // Other viewers waiting for this snapshot must not reserve pool connections.
        return reads.execute(status->build(key));
    }
    private Snapshot build(Key key){
        var server=key.server();var from=key.from();var to=key.to();var zone=ZoneId.of(key.zone());
        var p=new HashMap<String,Object>();p.put("server",server);p.put("from",from);p.put("to",to);p.put("zone",zone.getId());
        var start=from.atStartOfDay(zone).toInstant();var end=to.plusDays(1).atStartOfDay(zone).toInstant();
        p.put("start",TelemetryService.time(start));p.put("end",TelemetryService.time(end));
        var notes=new ArrayList<String>();
        notes.add("图表共用两分钟汇总缓存，不会增加游戏采集频率；空白表示没有记录，不代表没有活动。");
        var contributions=rows("SELECT e.project_id AS project,p.name AS project_name,e.player_key AS player,MAX(e.player_name) AS player_name,e.operation,e.block,COUNT(*) AS amount FROM construction_events e JOIN construction_projects p ON p.id=e.project_id WHERE p.server_id=:server AND e.occurred_at>=:start AND e.occurred_at<:end GROUP BY e.project_id,p.name,e.player_key,e.operation,e.block ORDER BY amount DESC,e.project_id,e.player_key,e.operation,e.block",p,4000,"工程贡献",notes);
        String where=" FROM activity_feed WHERE server_id=:server AND occurred_at>=:start AND occurred_at<:end AND metric IN ('blocks.placed','blocks.mined')";
        String day="CAST(occurred_at AT TIME ZONE :zone AS DATE)";
        var hotspots=rows("SELECT stat_day,dimension,x,z,metric,SUM(event_value) AS amount FROM (SELECT "+day+" AS stat_day,dimension,FLOOR(block_x/32.0)*32 AS x,FLOOR(block_z/32.0)*32 AS z,metric,event_value"+where+" AND block_x IS NOT NULL AND block_y IS NOT NULL AND block_z IS NOT NULL) located GROUP BY stat_day,dimension,x,z,metric ORDER BY amount DESC,stat_day,dimension,x,z,metric",p,8000,"建设热点",notes);
        var heights=rows("SELECT stat_day,dimension,y,metric,SUM(event_value) AS amount FROM (SELECT "+day+" AS stat_day,dimension,FLOOR(block_y/8.0)*8 AS y,metric,event_value"+where+" AND block_x IS NOT NULL AND block_y IS NOT NULL AND block_z IS NOT NULL) located GROUP BY stat_day,dimension,y,metric ORDER BY amount DESC,stat_day,dimension,y,metric",p,4000,"施工高度",notes);
        var ranking=rows("SELECT d.statistic_day AS stat_day,d.player_key AS player,MAX(p.current_name) AS player_name,SUM(d.statistic_value) AS amount FROM daily_statistics d JOIN players p ON p.player_key=d.player_key WHERE d.server_id=:server AND d.statistic_day>=:from AND d.statistic_day<=:to AND d.metric='blocks.placed' GROUP BY d.statistic_day,d.player_key ORDER BY amount DESC,stat_day,player",p,8000,"每日建设榜",notes);
        var coverage=jdbc.queryForMap("SELECT COUNT(*) AS recorded_events,COALESCE(SUM(event_value),0) AS recorded_blocks,COALESCE(SUM(CASE WHEN block_x IS NOT NULL AND block_y IS NOT NULL AND block_z IS NOT NULL THEN event_value ELSE 0 END),0) AS positioned_blocks"+where,p);
        var retention=jdbc.queryForMap("SELECT retention_days,purge_before FROM activity_stream WHERE id=1",Map.of());coverage.putAll(retention);
        notes.add("热点与高度图仅使用仍保留且带坐标的行为记录；旧数据或已清理的明细不能还原坐标。工程贡献是放置/拆除次数，不是当前存量，也不证明材料来源。重叠工程会各自计入贡献。");
        double[][] hours=new double[7][24];
        jdbc.query("SELECT started_at,checkpoint_at,online_millis FROM player_sessions WHERE server_id=:server AND started_at<:end AND checkpoint_at>:start",p,(RowCallbackHandler)rs->{
            var a=TelemetryQueries.instant(rs,"started_at");var b=TelemetryQueries.instant(rs,"checkpoint_at");if(!b.isAfter(a))return;
            double ratio=Math.min(1,Math.max(0,rs.getLong("online_millis")/(double)Duration.between(a,b).toMillis()));
            var cursor=a.isBefore(start)?start:a;var limit=b.isAfter(end)?end:b;
            while(cursor.isBefore(limit)){var local=cursor.atZone(zone);var next=local.truncatedTo(ChronoUnit.HOURS).plusHours(1).toInstant();if(next.isAfter(limit))next=limit;
                hours[local.getDayOfWeek().getValue()-1][local.getHour()]+=Duration.between(cursor,next).toMillis()*ratio;cursor=next;}
        });
        var hourRows=new ArrayList<Map<String,Object>>();for(int d=0;d<7;d++)for(int h=0;h<24;h++)if(hours[d][h]>0)hourRows.add(Map.of("weekday",d,"hour",h,"millis",Math.round(hours[d][h])));
        notes.add("作息图将会话已记录在线时长按观察区间分摊到小时，是估算人时，不能据此断言某一分钟一定在线。排行榜按所选起始日累计。");
        var result=new Snapshot(Instant.now(),from,to,zone.getId(),hourRows,contributions,hotspots,heights,ranking,coverage,notes);
        cache.put(key,result);while(cache.size()>8)cache.remove(cache.keySet().iterator().next());return result;
    }
    private List<Map<String,Object>> rows(String sql,Map<String,Object> p,int limit,String label,List<String> notes){
        var result=jdbc.queryForList(sql+" LIMIT "+(limit+1),p);for(var row:result){if(row.containsKey("amount"))row.put("value",row.remove("amount"));if(row.containsKey("stat_day"))row.put("day",row.remove("stat_day"));}if(result.size()>limit){notes.add(label+"数据较多：仅展示数量最高的 "+limit+" 组，请缩短日期范围查看其余记录。");return List.copyOf(result.subList(0,limit));}return result;
    }
}
