package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.*;
import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.TelemetryValidation.*;

@Service
class WorldQueries {
    enum Kind { WORLD, PLAYER, BLOCK, CONTAINER, NEARBY }
    record Request(UUID requestId, Kind kind, String playerKey, String dimension, Integer x, Integer y, Integer z,
                   Integer radius, String blockType) {}
    record Cached(Instant observedAt, JsonNode data) {}
    record Query(UUID id, UUID serverId, String status, Request request, Instant createdAt, Instant expiresAt,
                 Instant observedAt, JsonNode data, Cached lastKnown) {}
    record Lease(UUID id, UUID leaseId, UUID bootId, Request request, Instant expiresAt) {}
    record Observation(UUID leaseId, UUID bootId, Instant observedAt, String status, JsonNode data) {}
    record PlayerSnapshot(String playerKey, Instant observedAt, JsonNode data) {}
    record Snapshots(UUID bootId, List<PlayerSnapshot> players) {}
    private record Stored(Query query, UUID agentId, String hash, UUID leaseId, UUID bootId, Instant leaseUntil) {}
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final AgentCredentials agents;
    private final CollectorCredentials collectors;
    private final ActivitySignal signal;
    WorldQueries(JdbcTemplate jdbc, ObjectMapper mapper, AgentCredentials agents, CollectorCredentials collectors, ActivitySignal signal) {
        this.jdbc=jdbc; this.mapper=mapper; this.agents=agents; this.collectors=collectors; this.signal=signal;
    }
    private String json(Object value) {
        try { return mapper.writeValueAsString(value); } catch(java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    private JsonNode parse(String value) {
        try { return value==null?null:mapper.readTree(value); } catch(java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    private Request request(String encoded) {
        try { return mapper.readValue(encoded,Request.class); } catch(java.io.IOException ex) { throw new IllegalStateException(ex); }
    }
    private static void playerKey(String key) {
        check(key!=null && key.matches("(uuid:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|xuid:[1-9][0-9]{0,19})"),"玩家身份无效");
    }
    private String target(Request request) {
        return CollectorCredentials.hash(json(Arrays.asList(request.kind(),request.playerKey(),request.dimension(),
            request.x(),request.y(),request.z(),request.radius(),request.blockType())).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
    private void validate(Request value) {
        check(value!=null && value.requestId()!=null && value.kind()!=null,"世界查询参数不完整");
        boolean coordinates=Set.of(Kind.BLOCK,Kind.CONTAINER,Kind.NEARBY).contains(value.kind());
        if(coordinates) {
            check(value.dimension()!=null && Set.of("minecraft:overworld","minecraft:nether","minecraft:the_end").contains(value.dimension()),"维度无效");
            check(value.playerKey()==null && value.x()!=null && value.y()!=null && value.z()!=null
                && Math.abs((long)value.x())<=30000000 && Math.abs((long)value.z())<=30000000
                && value.y()>=-2048 && value.y()<=4095,"坐标无效");
        } else {
            check(value.dimension()==null && value.x()==null && value.y()==null && value.z()==null,"该查询不接受坐标");
            if(value.kind()==Kind.PLAYER) playerKey(value.playerKey()); else check(value.playerKey()==null,"该查询不接受玩家参数");
        }
        if(value.kind()==Kind.NEARBY) {
            check(value.radius()!=null && value.radius()>=1 && value.radius()<=8,"查询半径须为 1-8 格");
            check(value.blockType()==null || value.blockType().length()<=128 && resource(value.blockType()),"方块类型无效");
        } else check(value.radius()==null && value.blockType()==null,"该查询不接受范围参数");
    }
    private Cached cached(UUID server,String hash) {
        var rows=jdbc.query("SELECT * FROM world_state_cache WHERE server_id=? AND target_hash=?",
            (rs,i)->new Cached(TelemetryQueries.instant(rs,"observed_at"),parse(rs.getString("data_json"))),server,hash);
        return rows.isEmpty()?null:rows.getFirst();
    }
    private Stored row(ResultSet rs,int index) throws SQLException {
        UUID server=rs.getObject("server_id",UUID.class);
        String hash=rs.getString("target_hash");
        var query=new Query(rs.getObject("id",UUID.class),server,rs.getString("status"),request(rs.getString("request_json")),
            TelemetryQueries.instant(rs,"created_at"),TelemetryQueries.instant(rs,"expires_at"),TelemetryQueries.instant(rs,"observed_at"),
            parse(rs.getString("result_json")),cached(server,hash));
        return new Stored(query,rs.getObject("agent_id",UUID.class),hash,rs.getObject("lease_id",UUID.class),
            rs.getObject("boot_id",UUID.class),TelemetryQueries.instant(rs,"lease_until"));
    }
    private Stored stored(UUID id) {
        var rows=jdbc.query("SELECT * FROM world_queries WHERE id=?",this::row,id);
        if(rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND,"世界查询不存在");
        return rows.getFirst();
    }
    private void sweep(UUID server) {
        jdbc.update("UPDATE world_queries SET status='EXPIRED' WHERE server_id=? AND status IN ('PENDING','LEASED') AND expires_at<=CURRENT_TIMESTAMP",server);
        jdbc.update("""
            UPDATE world_queries SET status='PENDING',lease_id=NULL,boot_id=NULL,lease_until=NULL
            WHERE server_id=? AND status='LEASED' AND (lease_until<=CURRENT_TIMESTAMP OR
                EXISTS(SELECT 1 FROM collector_state c WHERE c.server_id=world_queries.server_id AND c.boot_id<>world_queries.boot_id))
            """,server);
    }
    @Transactional
    public Query create(AgentCredentials.Identity identity,UUID server,Request request) {
        validate(request); agents.lock(); agents.require(identity,server,AgentCredentials.Scope.WORLD_READ);
        var old=jdbc.query("SELECT * FROM world_queries WHERE agent_id=? AND request_id=?",this::row,identity.agentId(),request.requestId());
        if(!old.isEmpty()) {
            if(!old.getFirst().query().serverId().equals(server) || !old.getFirst().hash().equals(target(request))) throw conflict("查询编号内容已变化");
            sweep(server); return stored(old.getFirst().query().id()).query();
        }
        sweep(server);
        if(jdbc.queryForObject("SELECT COUNT(*) FROM world_queries WHERE agent_id=? AND created_at>=?",Integer.class,
            identity.agentId(),TelemetryService.time(Instant.now().minusSeconds(60)))>=30)
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"每分钟最多 30 次世界查询");
        check(jdbc.queryForObject("SELECT COUNT(*) FROM world_queries WHERE server_id=? AND status IN ('PENDING','LEASED')",
            Integer.class,server)<16,"世界查询繁忙，请稍后重试");
        UUID id=UUID.randomUUID(); Instant now=Instant.now();
        String status="RECORDING".equals(jdbc.queryForObject("SELECT status FROM server_archives WHERE id=?",String.class,server))?"PENDING":"UNAVAILABLE";
        jdbc.update("DELETE FROM world_queries WHERE status NOT IN ('PENDING','LEASED') AND expires_at<?",TelemetryService.time(now.minusSeconds(86400)));
        jdbc.update("INSERT INTO world_queries(id,agent_id,server_id,request_id,target_hash,request_json,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
            id,identity.agentId(),server,request.requestId(),target(request),json(request),status,TelemetryService.time(now),TelemetryService.time(now.plusSeconds(30)));
        return stored(id).query();
    }
    @Transactional
    public Query get(AgentCredentials.Identity identity,UUID id) {
        agents.lock(); agents.verify(identity); var stored=stored(id);
        if(!stored.agentId().equals(identity.agentId())) throw new ResponseStatusException(HttpStatus.NOT_FOUND,"世界查询不存在");
        agents.require(identity,stored.query().serverId(),AgentCredentials.Scope.WORLD_READ);
        sweep(stored.query().serverId()); return stored(id).query();
    }
    private void collector(CollectorCredentials.Identity identity,UUID boot) {
        collectors.check(identity);
        check("RECORDING".equals(jdbc.queryForObject("SELECT status FROM server_archives WHERE id=?",String.class,identity.serverId())),"服务器已封存");
        check(boot!=null && jdbc.queryForObject("SELECT COUNT(*) FROM collector_state WHERE server_id=? AND boot_id=? AND last_seen_at>?",
            Integer.class,identity.serverId(),boot,TelemetryService.time(Instant.now().minusSeconds(120)))==1,"采集器启动身份尚未确认");
    }
    @Transactional
    public List<Lease> claim(CollectorCredentials.Identity identity,UUID boot) {
        agents.lock(); collector(identity,boot); UUID server=identity.serverId(); sweep(server);
        var rows=jdbc.query("""
            SELECT q.* FROM world_queries q WHERE q.server_id=? AND q.status='PENDING'
            AND EXISTS(SELECT 1 FROM agent_accounts a WHERE a.id=q.agent_id AND a.revoked=FALSE)
            AND EXISTS(SELECT 1 FROM agent_server_access g WHERE g.agent_id=q.agent_id AND g.server_id=q.server_id AND g.scope='WORLD_READ')
            ORDER BY q.created_at,q.id LIMIT 1
            """,this::row,server);
        if(rows.isEmpty()) return List.of();
        var query=rows.getFirst().query(); UUID lease=UUID.randomUUID();
        jdbc.update("UPDATE world_queries SET status='LEASED',lease_id=?,boot_id=?,lease_until=? WHERE id=?",
            lease,boot,TelemetryService.time(Instant.now().plusSeconds(10)),query.id());
        return List.of(new Lease(query.id(),lease,boot,query.request(),query.expiresAt()));
    }
    private void observation(Instant time,JsonNode data) {
        millis(time); check(!time.isAfter(Instant.now().plusSeconds(30)),"观测时间超前");
        check(data!=null && data.isObject() && json(data).length()<=65536,"世界状态结果超出限制");
    }
    private void cache(UUID server,String hash,Instant time,JsonNode data,Request request) {
        var old=cached(server,hash);
        if(old!=null && !time.isAfter(old.observedAt())) return;
        if(old==null) {
            if(jdbc.queryForObject("SELECT COUNT(*) FROM world_state_cache WHERE server_id=?",Integer.class,server)>=10000)
                jdbc.update("""
                    DELETE FROM world_state_cache WHERE server_id=? AND target_hash IN
                    (SELECT target_hash FROM world_state_cache WHERE server_id=? ORDER BY observed_at,target_hash LIMIT 1)
                    """,server,server);
            jdbc.update("INSERT INTO world_state_cache(server_id,target_hash,observed_at,data_json) VALUES (?,?,?,?)",
                server,hash,TelemetryService.time(time),json(data));
        }
        else jdbc.update("UPDATE world_state_cache SET observed_at=?,data_json=? WHERE server_id=? AND target_hash=?",
            TelemetryService.time(time),json(data),server,hash);
        if(Set.of(Kind.BLOCK,Kind.CONTAINER,Kind.NEARBY).contains(request.kind()))
            jdbc.update("UPDATE world_state_cache SET target_kind=?,dimension=?,pos_x=?,pos_y=?,pos_z=? WHERE server_id=? AND target_hash=?",
                request.kind().name(),request.dimension(),request.x(),request.y(),request.z(),server,hash);
    }
    @Transactional
    public Query complete(CollectorCredentials.Identity identity,UUID id,Observation result) {
        check(result!=null && result.leaseId()!=null,"查询回执不完整");
        agents.lock(); collector(identity,result.bootId()); var saved=stored(id);
        if(!saved.query().serverId().equals(identity.serverId()) || !result.leaseId().equals(saved.leaseId()) || !result.bootId().equals(saved.bootId()))
            throw conflict("世界查询租约已变化");
        if(jdbc.queryForObject("""
            SELECT COUNT(*) FROM agent_server_access g JOIN agent_accounts a ON a.id=g.agent_id
            WHERE g.agent_id=? AND g.server_id=? AND g.scope='WORLD_READ' AND a.revoked=FALSE
            """,Integer.class,saved.agentId(),identity.serverId())!=1)
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,"世界查询授权已撤销");
        observation(result.observedAt(),result.data());
        check(!result.observedAt().isBefore(saved.query().createdAt().minusSeconds(30)),"观测早于查询时间");
        check(result.status()!=null && Set.of("READY","PLAYER_OFFLINE","CHUNK_UNLOADED","UNAVAILABLE","OUT_OF_BOUNDS").contains(result.status()),"查询结果状态无效");
        if("READY".equals(result.status()) && saved.query().request().kind()==Kind.PLAYER)
            check(saved.query().request().playerKey().equals(result.data().path("playerKey").asText()),"玩家状态身份不匹配");
        var request=saved.query().request();
        if("READY".equals(result.status()) && Set.of(Kind.BLOCK,Kind.CONTAINER,Kind.NEARBY).contains(request.kind())) {
            var coordinates=request.kind()==Kind.NEARBY?result.data().path("center"):result.data();
            check(request.dimension().equals(result.data().path("dimension").asText())
                && coordinates.path("x").isIntegralNumber() && coordinates.path("x").asInt()==request.x()
                && coordinates.path("y").isIntegralNumber() && coordinates.path("y").asInt()==request.y()
                && coordinates.path("z").isIntegralNumber() && coordinates.path("z").asInt()==request.z(),"世界状态坐标不匹配");
        }
        if(!Set.of("PENDING","LEASED").contains(saved.query().status())) return saved.query();
        if(!saved.query().expiresAt().isAfter(Instant.now())) { sweep(identity.serverId()); return stored(id).query(); }
        jdbc.update("UPDATE world_queries SET status=?,result_json=?,observed_at=? WHERE id=?",result.status(),json(result.data()),
            TelemetryService.time(result.observedAt()),id);
        if("READY".equals(result.status())) cache(identity.serverId(),saved.hash(),result.observedAt(),result.data(),request);
        signal.publishOnCommit(); return stored(id).query();
    }
    @Transactional
    public void snapshots(CollectorCredentials.Identity identity,Snapshots snapshots) {
        check(snapshots!=null && snapshots.players()!=null && snapshots.players().size()<=8,"玩家状态批次无效");
        agents.lock(); collector(identity,snapshots.bootId());
        for(var player:snapshots.players()) {
            check(player!=null,"玩家状态不能为空"); playerKey(player.playerKey()); observation(player.observedAt(),player.data());
            check(player.playerKey().equals(player.data().path("playerKey").asText()),"玩家快照身份不匹配");
            var request=new Request(null,Kind.PLAYER,player.playerKey(),null,null,null,null,null,null);
            cache(identity.serverId(),target(request),player.observedAt(),player.data(),request);
        }
    }
    @Transactional(readOnly=true)
    public Cached lastPlayer(AgentCredentials.Identity identity,UUID server,String key) {
        agents.require(identity,server,AgentCredentials.Scope.WORLD_READ); playerKey(key);
        return cached(server,target(new Request(null,Kind.PLAYER,key,null,null,null,null,null,null)));
    }
}
