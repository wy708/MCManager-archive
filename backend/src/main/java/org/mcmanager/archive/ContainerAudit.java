package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import static org.mcmanager.archive.TelemetryValidation.*;

/** Historical evidence only: opening a container does not establish theft. */
@Service
class ContainerAudit {
    enum Operation { OPEN, TRANSFER, PLACE, BREAK, CHANGE }
    enum Evidence { OBSERVED_OPEN, COMMITTED_TRANSACTION, CONFIRMED_PLACE, CONFIRMED_BREAK, OBSERVED_CHANGE }
    record Position(@NotNull @Min(-30000000) @Max(30000000) Integer x,
                    @NotNull @Min(-2048) @Max(2048) Integer y,
                    @NotNull @Min(-30000000) @Max(30000000) Integer z) {}
    record Item(@NotBlank @Size(max=128) String type, @Min(1) @Max(255) int count) {}
    record Change(@Min(0) @Max(255) int slot, @Valid Item before, @Valid Item after) {}
    record Payload(@NotNull Operation operation, @NotNull Evidence evidence,
                   @NotBlank @Size(max=128) String block,
                   @NotNull @Size(min=1,max=2) List<@NotNull @Valid Position> positions,
                   @NotNull @Size(max=256) List<@NotNull @Valid Change> changes) {}
    record Entry(String id, UUID eventId, Instant occurredAt, Instant receivedAt, String dimension,
                 String playerKey, String playerName, String attribution, Operation operation,
                 Evidence evidence, JsonNode container, String collectorVersion) {}
    record History(List<Entry> items, String nextBefore, boolean hasMore, Instant from, Instant to,
                   String order, String dataNotice) {}
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    ContainerAudit(JdbcTemplate jdbc, ObjectMapper mapper) { this.jdbc=jdbc; this.mapper=mapper; }

    static void validate(TelemetryPayload.Event event) {
        var data=event.container();
        check(data!=null && resource(event.dimension()), "容器审计必须包含维度与详情");
        check(resource(data.block()), "容器类型须为命名空间标识");
        check(event.metric()==null && event.value()==null && event.subject()==null && event.sessionId()==null
                && event.startedAt()==null && event.sequence()==null && event.onlineMillis()==null && event.ended()==null
                && event.cause()==null && event.killerType()==null && event.text()==null && event.sessionStart()==null
                && event.sessionEnd()==null && event.playerObservedAt()==null, "容器事件包含不适用字段");
        Evidence expected=switch(data.operation()) {
            case OPEN -> Evidence.OBSERVED_OPEN; case TRANSFER -> Evidence.COMMITTED_TRANSACTION;
            case PLACE -> Evidence.CONFIRMED_PLACE; case BREAK -> Evidence.CONFIRMED_BREAK;
            case CHANGE -> Evidence.OBSERVED_CHANGE;
        };
        check(data.evidence()==expected, "容器操作与证据类型不匹配");
        check((event.player()==null)==(data.operation()==Operation.CHANGE), "未归属变化不得指定玩家，玩家操作必须包含身份");
        check(new HashSet<>(data.positions()).size()==data.positions().size(), "容器位置不能重复");
        if(data.positions().size()==2) {
            var a=data.positions().get(0); var b=data.positions().get(1);
            check(a.y().equals(b.y()) && Math.abs((long)a.x()-b.x())+Math.abs((long)a.z()-b.z())==1,
                    "双箱位置必须相邻");
            check(Set.of("minecraft:chest","minecraft:trapped_chest").contains(data.block()), "只有双箱允许两个位置");
        }
        boolean changed=data.operation()==Operation.TRANSFER || data.operation()==Operation.CHANGE;
        check(changed!=data.changes().isEmpty(), "物品变化须包含明细，打开和放置破坏不包含物品转移明细");
        Set<Integer> slots=new HashSet<>();
        for(var delta:data.changes()) {
            check(slots.add(delta.slot()) && !Objects.equals(delta.before(),delta.after()), "物品槽位重复或未变化");
            for(var item:Arrays.asList(delta.before(),delta.after()))
                if(item!=null) check(resource(item.type()) && !item.type().equals("minecraft:air"), "物品类型无效，空槽使用 null");
        }
    }
    void store(UUID server, TelemetryPayload.Event event, String hash, TelemetryPayload.Collector collector) {
        var data=event.container(); var player=event.player();
        String payload;
        try { payload=mapper.writeValueAsString(data); } catch(java.io.IOException ex) { throw new IllegalStateException(ex); }
        jdbc.update("""
                INSERT INTO container_audit(server_id,event_id,payload_hash,occurred_at,dimension,player_key,player_name,
                    operation,evidence,container_type,payload,collector_version,boot_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,server,event.eventId(),hash,TelemetryService.time(event.at()),event.dimension(),
                player==null?null:player.key(),player==null?null:player.name(),data.operation().name(),data.evidence().name(),
                data.block(),payload,collector.version(),collector.bootId());
        Long id=jdbc.queryForObject("SELECT id FROM container_audit WHERE server_id=? AND event_id=?",Long.class,server,event.eventId());
        for(var p:data.positions()) jdbc.update("INSERT INTO container_audit_locations(audit_id,server_id,dimension,x,y,z) VALUES (?,?,?,?,?,?)",
                id,server,event.dimension(),p.x(),p.y(),p.z());
    }
    History read(UUID server, String dimension, int x, int y, int z, int radius, Instant from, Instant to,
                 Long before, int limit, String playerKey) {
        check(resource(dimension) && dimension.length()<=80, "维度无效");
        check(Math.abs((long)x)<=30000000 && Math.abs((long)z)<=30000000 && y>=-2048 && y<=2048, "坐标超出范围");
        check(radius>=0 && radius<=16 && limit>=1 && limit<=100 && (before==null || before>0), "查询范围或分页无效");
        Instant end=to==null?Instant.now():to;
        Instant start=from==null?end.minus(Duration.ofDays(7)):from;
        check(!start.isAfter(end) && Duration.between(start,end).compareTo(Duration.ofDays(31))<=0, "单次查询最多 31 天");
        check(playerKey==null || playerKey.length()<=80 && playerKey.matches("(xuid:[1-9][0-9]{0,19}|uuid:[0-9a-f-]{36})"), "玩家标识无效");
        List<Object> args=new ArrayList<>(List.of(server,dimension,TelemetryService.time(start),TelemetryService.time(end),
                before==null?Long.MAX_VALUE:before,server,dimension,x-radius,x+radius,y-radius,y+radius,z-radius,z+radius));
        String where="""
                a.server_id=? AND a.dimension=? AND a.occurred_at>=? AND a.occurred_at<=? AND a.id<? AND EXISTS
                (SELECT 1 FROM container_audit_locations l WHERE l.audit_id=a.id AND l.server_id=? AND l.dimension=?
                AND l.x BETWEEN ? AND ? AND l.y BETWEEN ? AND ? AND l.z BETWEEN ? AND ?)
                """;
        if(playerKey!=null) { where+=" AND a.player_key=?"; args.add(playerKey); }
        args.add(limit+1);
        var rows=jdbc.query("SELECT a.* FROM container_audit a WHERE "+where+" ORDER BY a.id DESC LIMIT ?", (rs,i)-> {
            JsonNode payload;
            try { payload=mapper.readTree(rs.getString("payload")); } catch(java.io.IOException ex) { throw new IllegalStateException(ex); }
            var actor=rs.getString("player_key");
            return new Entry(Long.toString(rs.getLong("id")),rs.getObject("event_id",UUID.class),
                    rs.getObject("occurred_at",OffsetDateTime.class).toInstant(),rs.getObject("received_at",OffsetDateTime.class).toInstant(),
                    rs.getString("dimension"),actor,rs.getString("player_name"),actor==null?"UNATTRIBUTED":"PLAYER",
                    Operation.valueOf(rs.getString("operation")),Evidence.valueOf(rs.getString("evidence")),payload,rs.getString("collector_version"));
        },args.toArray());
        boolean more=rows.size()>limit;
        if(more) rows=new ArrayList<>(rows.subList(0,limit));
        return new History(rows,rows.isEmpty()?null:rows.getLast().id(),more,start,end,"RECEIVED_DESC",
                "仅包含启用新版采集后实际保存的记录，不能追溯安装前操作；无记录不代表无人操作。OPEN 只证明打开。TRANSFER 是成功提交时容器槽位的前后变化，并不证明物品最终进入玩家背包或构成盗窃；同类型同数量的附魔/名称变化暂不记录。CHANGE 无法确定操作者，不得归因附近玩家；自动搬运未全覆盖。双箱可按任一半坐标查询。按入库顺序倒序，实际发生时间看 occurredAt；补传可能较晚入库。");
    }
}
