package org.mcmanager.archive;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.TelemetryValidation.*;

@Service
class QqBindings {
    record CodeRequest(UUID requestId, String playerKey, String code) {}
    record CodeReceipt(UUID requestId, Instant expiresAt) {}
    record Claim(String qqId, String code) {}
    record Unbind(UUID bindingId) {}
    record Binding(UUID id, UUID serverId, String qqId, String playerKey, String playerName, Instant boundAt) {}
    record State(boolean bound, Binding binding) {}
    private record Code(UUID requestId, String playerKey, String hash, Instant expiresAt, String consumedQq) {}
    private final JdbcTemplate jdbc;
    private final AgentCredentials agents;
    private final CollectorCredentials collectors;
    QqBindings(JdbcTemplate jdbc, AgentCredentials agents, CollectorCredentials collectors) {
        this.jdbc = jdbc; this.agents = agents; this.collectors = collectors;
    }
    private static String hash(UUID server, String code) {
        check(code != null && code.matches("[0-9A-F]{8}"), "请输入游戏内提供的 8 位验证码");
        return CollectorCredentials.hash((server + ":" + code).getBytes(StandardCharsets.UTF_8));
    }
    private static void qq(String value) {
        check(value != null && value.matches("[1-9][0-9]{4,19}"), "QQ 账号格式无效");
    }
    @Transactional
    public CodeReceipt issue(CollectorCredentials.Identity identity, CodeRequest request) {
        agents.lock(); collectors.check(identity);
        check(request != null && request.requestId() != null, "绑定请求不能为空");
        String hash = hash(identity.serverId(), request.code());
        check(request.playerKey() != null && request.playerKey().length() <= 64
            && jdbc.queryForObject("SELECT COUNT(*) FROM player_servers WHERE server_id=? AND player_key=?", Integer.class,
                identity.serverId(), request.playerKey()) == 1, "请等玩家数据上传后再领取验证码");
        check("RECORDING".equals(jdbc.queryForObject("SELECT status FROM server_archives WHERE id=?", String.class, identity.serverId())), "该档案已封存");
        var previous = codes(identity.serverId(), "request_id", request.requestId());
        if (!previous.isEmpty()) {
            var saved = previous.getFirst();
            if (!saved.playerKey().equals(request.playerKey()) || !saved.hash().equals(hash)) throw conflict("绑定请求内容已变化");
            return new CodeReceipt(saved.requestId(), saved.expiresAt());
        }
        Instant now = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS), expires = now.plusSeconds(300);
        var recent = jdbc.queryForList("SELECT created_at FROM qq_binding_codes WHERE server_id=? AND player_key=? AND created_at>?",
            identity.serverId(), request.playerKey(), TelemetryService.time(now.minusSeconds(30)));
        if (!recent.isEmpty()) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "请等待 30 秒再领取");
        jdbc.update("DELETE FROM qq_binding_codes WHERE expires_at<?", TelemetryService.time(now.minusSeconds(86400)));
        check(codes(identity.serverId(), "code_hash", hash).isEmpty(), "验证码冲突，请重新领取");
        jdbc.update("UPDATE qq_binding_codes SET expires_at=? WHERE server_id=? AND player_key=? AND consumed_qq IS NULL AND expires_at>?",
            TelemetryService.time(now), identity.serverId(), request.playerKey(), TelemetryService.time(now));
        jdbc.update("INSERT INTO qq_binding_codes(server_id,request_id,player_key,code_hash,created_at,expires_at) VALUES (?,?,?,?,?,?)",
            identity.serverId(), request.requestId(), request.playerKey(), hash, TelemetryService.time(now), TelemetryService.time(expires));
        return new CodeReceipt(request.requestId(), expires);
    }
    private List<Code> codes(UUID server, String column, Object value) {
        return jdbc.query("SELECT * FROM qq_binding_codes WHERE server_id=? AND " + column + "=?",
            (rs,i) -> new Code(rs.getObject("request_id", UUID.class), rs.getString("player_key"), rs.getString("code_hash"),
                TelemetryQueries.instant(rs,"expires_at"), rs.getString("consumed_qq")), server, value);
    }
    private State state(UUID server, String qqId) {
        var rows = jdbc.query("""
            SELECT b.*, COALESCE((SELECT n.name FROM player_server_names n WHERE n.server_id=b.server_id
                AND n.player_key=b.player_key ORDER BY n.last_seen_at DESC,n.name LIMIT 1),b.player_key) AS player_name
            FROM qq_player_bindings b WHERE b.server_id=? AND b.qq_id=?
            """, (rs,i) -> new Binding(rs.getObject("id",UUID.class), server, qqId, rs.getString("player_key"),
                rs.getString("player_name"), TelemetryQueries.instant(rs,"bound_at")), server, qqId);
        return rows.isEmpty() ? new State(false,null) : new State(true,rows.getFirst());
    }
    @Transactional(readOnly=true)
    public State get(AgentCredentials.Identity identity, UUID server, String qqId) {
        agents.require(identity,server,AgentCredentials.Scope.QQ_BIND); qq(qqId);
        return state(server,qqId);
    }
    @Transactional(noRollbackFor=ResponseStatusException.class)
    public State bind(AgentCredentials.Identity identity, UUID server, Claim request) {
        agents.lock(); agents.require(identity,server,AgentCredentials.Scope.QQ_BIND);
        check(request != null, "绑定请求不能为空"); qq(request.qqId());
        String hash = hash(server,request.code());
        Instant now = Instant.now();
        var attempts = jdbc.queryForList("SELECT attempts FROM qq_binding_attempts WHERE agent_id=? AND server_id=? AND window_at>?",
            Integer.class,identity.agentId(),server,TelemetryService.time(now.minusSeconds(60)));
        if (!attempts.isEmpty() && attempts.getFirst() >= 30)
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"绑定请求过多，请稍后重试");
        if (attempts.isEmpty()) {
            jdbc.update("DELETE FROM qq_binding_attempts WHERE agent_id=? AND server_id=?",identity.agentId(),server);
            jdbc.update("INSERT INTO qq_binding_attempts(agent_id,server_id,window_at,attempts) VALUES (?,?,?,1)",
                identity.agentId(),server,TelemetryService.time(now));
        } else jdbc.update("UPDATE qq_binding_attempts SET attempts=attempts+1 WHERE agent_id=? AND server_id=?",identity.agentId(),server);
        var codes = codes(server,"code_hash",hash);
        if (codes.isEmpty()) throw bad("验证码无效或已过期，请在游戏内重新领取");
        var code = codes.getFirst();
        var current = state(server,request.qqId());
        if (code.consumedQq() != null) {
            if (code.consumedQq().equals(request.qqId()) && current.bound() && current.binding().playerKey().equals(code.playerKey())) return current;
            throw bad("验证码已使用，请在游戏内重新领取");
        }
        if (!code.expiresAt().isAfter(now)) throw bad("验证码无效或已过期，请在游戏内重新领取");
        if (current.bound() && !current.binding().playerKey().equals(code.playerKey())) throw conflict("此 QQ 已绑定其他角色，请先解绑");
        if (!current.bound()) {
            if (jdbc.queryForObject("SELECT COUNT(*) FROM qq_player_bindings WHERE server_id=? AND player_key=?",Integer.class,server,code.playerKey()) != 0)
                throw conflict("此角色已绑定其他 QQ，请先解绑");
            jdbc.update("INSERT INTO qq_player_bindings(id,server_id,qq_id,player_key,bound_at,agent_id) VALUES (?,?,?,?,?,?)",
                UUID.randomUUID(),server,request.qqId(),code.playerKey(),TelemetryService.time(now),identity.agentId());
        }
        jdbc.update("UPDATE qq_binding_codes SET consumed_qq=? WHERE server_id=? AND request_id=?",request.qqId(),server,code.requestId());
        return state(server,request.qqId());
    }
    @Transactional
    public State unbind(AgentCredentials.Identity identity, UUID server, String qqId, Unbind request) {
        agents.lock(); agents.require(identity,server,AgentCredentials.Scope.QQ_BIND); qq(qqId);
        check(request != null && request.bindingId() != null,"请先查看绑定并提供原绑定编号");
        var current = state(server,qqId);
        if (current.bound() && !current.binding().id().equals(request.bindingId())) throw conflict("绑定已变化，请重新确认");
        jdbc.update("DELETE FROM qq_player_bindings WHERE server_id=? AND qq_id=? AND id=?",server,qqId,request.bindingId());
        var expiredAt=TelemetryService.time(Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS));
        if (current.bound()) jdbc.update("UPDATE qq_binding_codes SET expires_at=? WHERE server_id=? AND player_key=?",
            expiredAt,server,current.binding().playerKey());
        jdbc.update("UPDATE qq_binding_codes SET expires_at=?,consumed_qq=NULL WHERE server_id=? AND consumed_qq=?",expiredAt,server,qqId);
        return new State(false,null);
    }
}
