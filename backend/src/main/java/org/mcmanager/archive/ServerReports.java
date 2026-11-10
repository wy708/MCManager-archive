package org.mcmanager.archive;

import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
class ServerReports {
    private final JdbcTemplate jdbc;private final AgentCredentials agents;private final ZoneId zone;
    ServerReports(JdbcTemplate jdbc,AgentCredentials agents,@Value("${mcmanager.statistics-zone:Asia/Hong_Kong}") String zone){this.jdbc=jdbc;this.agents=agents;this.zone=ZoneId.of(zone);}
    @GetMapping("/api/agent/servers/{server}/daily-report")
    Object agent(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID server,@RequestParam(required=false) LocalDate date){agents.require(identity,server,AgentCredentials.Scope.STATS_READ);return report(server,date);}
    @GetMapping("/api/servers/{server}/daily-report")
    Object report(@PathVariable UUID server,@RequestParam(required=false) LocalDate date){
        if(date==null)date=LocalDate.now(zone).minusDays(1);
        TelemetryValidation.check(!date.isAfter(LocalDate.now(zone)) && date.getYear()>=2000,"日期无效");
        var names=jdbc.queryForList("SELECT name FROM server_archives WHERE id=?",String.class,server);
        if(names.isEmpty())throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND,"服务器不存在");
        var totals=jdbc.query("SELECT metric,quality,algorithm_version,SUM(statistic_value) AS total FROM daily_statistics WHERE server_id=? AND statistic_day=? AND metric IN ('online.millis','activity.millis','blocks.placed','blocks.mined','items.used','chat.messages','deaths') GROUP BY metric,quality,algorithm_version ORDER BY metric,quality,algorithm_version",(rs,i)->Map.of("metric",rs.getString("metric"),"quality",rs.getString("quality"),"algorithm",rs.getString("algorithm_version"),"value",rs.getBigDecimal("total").toPlainString()),server,date);
        var materials=jdbc.query("SELECT subject,metric,SUM(statistic_value) AS total FROM daily_statistics WHERE server_id=? AND statistic_day=? AND metric IN ('blocks.placed','blocks.mined') GROUP BY subject,metric ORDER BY SUM(statistic_value) DESC,subject,metric LIMIT 30",(rs,i)->Map.of("block",rs.getString("subject"),"metric",rs.getString("metric"),"value",rs.getBigDecimal("total").toPlainString()),server,date);
        var trend=jdbc.query("SELECT statistic_day,metric,SUM(statistic_value) AS total FROM daily_statistics WHERE server_id=? AND statistic_day BETWEEN ? AND ? AND metric IN ('blocks.placed','blocks.mined','online.millis') GROUP BY statistic_day,metric ORDER BY statistic_day,metric",(rs,i)->Map.of("date",rs.getDate("statistic_day").toLocalDate().toString(),"metric",rs.getString("metric"),"value",rs.getBigDecimal("total").toPlainString()),server,date.minusDays(6),date);
        var players=jdbc.queryForObject("SELECT COUNT(DISTINCT player_key) FROM daily_statistics WHERE server_id=? AND statistic_day=?",Integer.class,server,date);
        var projects=jdbc.query("SELECT p.id,p.name,r.revision,r.started_at,r.ended_at FROM construction_phases r JOIN construction_projects p ON p.id=r.project_id WHERE p.server_id=? AND (r.started_at>=? AND r.started_at<? OR r.ended_at>=? AND r.ended_at<?) ORDER BY r.started_at",(rs,i)->Map.of("id",rs.getObject("id").toString(),"name",rs.getString("name"),"revision",rs.getInt("revision"),"startedAt",TelemetryQueries.instant(rs,"started_at").toString(),"endedAt",Objects.toString(TelemetryQueries.instant(rs,"ended_at"),"")),server,TelemetryService.time(date.atStartOfDay(zone).toInstant()),TelemetryService.time(date.plusDays(1).atStartOfDay(zone).toInstant()),TelemetryService.time(date.atStartOfDay(zone).toInstant()),TelemetryService.time(date.plusDays(1).atStartOfDay(zone).toInstant()));
        return Map.of("serverId",server,"serverName",names.getFirst(),"date",date,"timezone",zone.toString(),"recordedPlayers",players,"totals",totals,"materials",materials,"trend",trend,"projects",projects,"notice","日报按平台统计时区汇总已收到的数据。无记录不代表零行为；今天和补传数据会继续变化。施工工程有重叠时，服务器总量只计一次。未自动发送到 QQ。");
    }
}
