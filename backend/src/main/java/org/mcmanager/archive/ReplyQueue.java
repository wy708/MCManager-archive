package org.mcmanager.archive;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.*;
import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.AgentCredentials.*;
import static org.mcmanager.archive.TelemetryValidation.*;

@Service
class ReplyQueue {
    record Request(UUID requestId, UUID replyTo, String targetPlayerKey, String text, int ttlSeconds) {}
    record Reply(UUID id, UUID serverId, UUID requestId, UUID replyTo, String targetPlayerKey, String agentName,
                 String text, String status, Instant createdAt, Instant expiresAt, Instant startedAt, Instant completedAt, String errorCode) {}
    record Lease(Reply reply, UUID leaseId, UUID bootId, Instant leaseUntil) {}
    record Begin(boolean executionAuthorized, Lease lease) {}
    record Acknowledgement(UUID leaseId, UUID bootId, String outcome, Instant sentAt, String errorCode) {}
    private record Stored(Reply reply, UUID agentId, String hash, UUID leaseId, UUID bootId, Instant leaseUntil) {
        Lease lease() { return new Lease(reply, leaseId, bootId, leaseUntil); }
    }
    private final JdbcTemplate jdbc;
    private final AgentCredentials agents;
    private final CollectorCredentials collectors;
    private final ActivityFeed activity;
    private final ObjectMapper mapper;
    ReplyQueue(JdbcTemplate jdbc, AgentCredentials agents, CollectorCredentials collectors, ActivityFeed activity, ObjectMapper mapper) {
        this.jdbc = jdbc; this.agents = agents; this.collectors = collectors; this.activity = activity; this.mapper = mapper;
    }
    private Stored row(ResultSet rs, int i) throws SQLException {
        return new Stored(new Reply(rs.getObject("id", UUID.class), rs.getObject("server_id", UUID.class), rs.getObject("request_id", UUID.class),
                rs.getObject("reply_to", UUID.class), rs.getString("target_player_key"), rs.getString("agent_name"), rs.getString("message_text"), rs.getString("status"),
                TelemetryQueries.instant(rs, "created_at"), TelemetryQueries.instant(rs, "expires_at"), TelemetryQueries.instant(rs, "started_at"), TelemetryQueries.instant(rs, "completed_at"), rs.getString("error_code")),
                rs.getObject("agent_id", UUID.class), rs.getString("request_hash"), rs.getObject("lease_id", UUID.class), rs.getObject("boot_id", UUID.class), TelemetryQueries.instant(rs, "lease_until"));
    }
    private Stored stored(UUID id) {
        var rows = jdbc.query("SELECT * FROM server_commands WHERE id = ?", this::row, id);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "回复不存在");
        return rows.getFirst();
    }
    private void recording(UUID server) {
        collectors.lockServer(server);
        if (!"RECORDING".equals(jdbc.queryForObject("SELECT status FROM server_archives WHERE id = ?", String.class, server))) throw conflict("服务器已封存，不能发送消息");
    }
    private void sweep(UUID server) {
        // An execution which may already have sent is never automatically put back into the queue.
        jdbc.update("UPDATE server_commands SET status = 'UNCERTAIN', error_code = 'EXECUTION_INTERRUPTED' WHERE server_id = ? AND status = 'EXECUTING' AND (lease_until <= CURRENT_TIMESTAMP OR expires_at <= CURRENT_TIMESTAMP OR EXISTS(SELECT 1 FROM collector_state c WHERE c.server_id = server_commands.server_id AND c.boot_id <> server_commands.boot_id) OR EXISTS(SELECT 1 FROM server_archives a WHERE a.id = server_commands.server_id AND a.status <> 'RECORDING'))", server);
        jdbc.update("UPDATE server_commands SET status = 'EXPIRED', error_code = 'TTL_EXPIRED' WHERE server_id = ? AND status IN ('PENDING', 'LEASED') AND expires_at <= CURRENT_TIMESTAMP", server);
        jdbc.update("UPDATE server_commands SET status = 'CANCELLED', error_code = 'SERVER_ARCHIVED' WHERE server_id = ? AND status IN ('PENDING', 'LEASED') AND EXISTS(SELECT 1 FROM server_archives a WHERE a.id = server_id AND a.status <> 'RECORDING')", server);
        jdbc.update("UPDATE server_commands SET status = 'PENDING', lease_id = NULL, boot_id = NULL, lease_until = NULL WHERE server_id = ? AND status = 'LEASED' AND (lease_until <= CURRENT_TIMESTAMP OR EXISTS(SELECT 1 FROM collector_state c WHERE c.server_id = server_commands.server_id AND c.boot_id <> server_commands.boot_id))", server);
    }
    @Transactional
    public Reply enqueue(Identity identity, UUID server, Request request) {
        check(request.requestId() != null && request.text() != null && !request.text().isBlank() && request.text().length() <= 512
                && request.text().codePoints().noneMatch(c -> Character.isISOControl(c) || Character.getType(c) == Character.SURROGATE || c == 0x00a7 || c == 0x2028 || c == 0x2029), "回复须为 1-512 字符的纯文本，不能含控制字符、无效 Unicode 或游戏格式代码");
        check(request.ttlSeconds() >= 10 && request.ttlSeconds() <= 300, "回复有效期须为 10-300 秒");
        check(request.targetPlayerKey() == null || request.targetPlayerKey().length() <= 64, "目标玩家无效");
        agents.lock(); agents.require(identity, server, Scope.CHAT_SEND);
        String hash;
        try { hash = CollectorCredentials.hash(mapper.writeValueAsBytes(new Object[]{server, request})); }
        catch (java.io.IOException ex) { throw new IllegalStateException(ex); }
        var existing = jdbc.query("SELECT * FROM server_commands WHERE agent_id = ? AND request_id = ?", this::row, identity.agentId(), request.requestId());
        if (!existing.isEmpty()) {
            if (!existing.getFirst().hash().equals(hash)) throw conflict("requestId 已被不同内容使用");
            sweep(server); return stored(existing.getFirst().reply().id()).reply();
        }
        recording(server); sweep(server);
        if (request.replyTo() != null) {
            agents.require(identity, server, Scope.CHAT_READ);
            var messages = jdbc.queryForList("SELECT player_key FROM activity_feed WHERE server_id = ? AND event_id = ? AND source = 'PLAYER' AND kind = 'CHAT' AND received_at >= ?", String.class,
                    server, request.replyTo(), activity.retainedSince());
            check(!messages.isEmpty(), "关联的玩家公开聊天不存在或已超过保留期");
            check(request.targetPlayerKey() == null || request.targetPlayerKey().equals(messages.getFirst()), "定向回复必须发给关联消息的玩家");
            if (jdbc.queryForObject("SELECT COUNT(*) FROM server_commands WHERE agent_id = ? AND server_id = ? AND reply_to = ?", Integer.class, identity.agentId(), server, request.replyTo()) > 0) throw conflict("此 Agent 已回复该消息，请查询原回复状态");
        }
        if (request.targetPlayerKey() != null) check(jdbc.queryForObject("SELECT COUNT(*) FROM player_servers WHERE server_id = ? AND player_key = ?", Integer.class, server, request.targetPlayerKey()) == 1, "该服务器没有目标玩家的记录");
        if (jdbc.queryForObject("SELECT COUNT(*) FROM server_commands WHERE agent_id = ? AND server_id = ? AND created_at >= ?", Integer.class,
                identity.agentId(), server, TelemetryService.time(Instant.now().minusSeconds(60))) >= 10) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "每 Agent / 服务器每分钟最多 10 条回复");
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO server_commands(id, agent_id, server_id, request_id, request_hash, reply_to, target_player_key, agent_name, message_text, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', CURRENT_TIMESTAMP, ?)",
                id, identity.agentId(), server, request.requestId(), hash, request.replyTo(), request.targetPlayerKey(), agents.account(identity.agentId()).name(), request.text(), TelemetryService.time(Instant.now().plusSeconds(request.ttlSeconds())));
        return stored(id).reply();
    }
    @Transactional
    public Reply status(Identity identity, UUID id) {
        agents.lock(); agents.verify(identity); Stored value = stored(id);
        if (!value.agentId().equals(identity.agentId())) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "回复不存在");
        agents.require(identity, value.reply().serverId(), Scope.CHAT_SEND);
        sweep(value.reply().serverId()); return stored(id).reply();
    }
    private void collector(CollectorCredentials.Identity identity) { agents.lock(); collectors.lockServer(identity.serverId()); collectors.check(identity); }
    private void boot(UUID server, UUID boot) {
        check(boot != null, "必须提供采集器启动身份");
        if (jdbc.queryForObject("SELECT COUNT(*) FROM collector_state WHERE server_id = ? AND boot_id = ? AND last_seen_at >= ?", Integer.class,
                server, boot, TelemetryService.time(Instant.now().minusSeconds(120))) != 1) throw conflict("采集器启动身份不匹配或心跳已过期");
    }
    @Transactional
    public List<Lease> claim(CollectorCredentials.Identity identity, UUID bootId) {
        collector(identity); sweep(identity.serverId()); recording(identity.serverId()); boot(identity.serverId(), bootId);
        // Recover a lost claim response under the same boot; only one outstanding command is issued.
        var active = jdbc.query("SELECT * FROM server_commands WHERE server_id = ? AND boot_id = ? AND status IN ('LEASED', 'EXECUTING') ORDER BY created_at, id LIMIT 1", this::row, identity.serverId(), bootId);
        if (!active.isEmpty()) return List.of(active.getFirst().lease());
        var next = jdbc.query("SELECT * FROM server_commands WHERE server_id = ? AND status = 'PENDING' ORDER BY created_at, id LIMIT 1", this::row, identity.serverId());
        if (next.isEmpty()) return List.of();
        Stored value = next.getFirst();
        if (jdbc.queryForObject("SELECT COUNT(*) FROM agent_accounts a JOIN agent_server_access g ON a.id = g.agent_id WHERE a.id = ? AND a.revoked = FALSE AND g.server_id = ? AND g.scope = 'CHAT_SEND'", Integer.class, value.agentId(), identity.serverId()) == 0) throw conflict("Agent 发言权限已撤销");
        jdbc.update("UPDATE server_commands SET status = 'LEASED', lease_id = ?, boot_id = ?, lease_until = ? WHERE id = ?", UUID.randomUUID(), bootId, TelemetryService.time(Instant.now().plusSeconds(30)), value.reply().id());
        return List.of(stored(value.reply().id()).lease());
    }
    private Stored owned(CollectorCredentials.Identity identity, UUID id, UUID lease, UUID boot) {
        Stored value = stored(id);
        if (!value.reply().serverId().equals(identity.serverId())) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "回复不存在");
        if (lease == null || boot == null || !lease.equals(value.leaseId()) || !boot.equals(value.bootId())) throw conflict("回复租约不匹配");
        return value;
    }
    @Transactional
    public Begin begin(CollectorCredentials.Identity identity, UUID id, UUID lease, UUID bootId) {
        collector(identity); sweep(identity.serverId()); recording(identity.serverId()); boot(identity.serverId(), bootId);
        Stored value = owned(identity, id, lease, bootId);
        if (!Set.of("LEASED", "EXECUTING").contains(value.reply().status())) throw conflict("回复不再允许执行");
        if (jdbc.queryForObject("SELECT COUNT(*) FROM agent_accounts a JOIN agent_server_access g ON a.id = g.agent_id WHERE a.id = ? AND a.revoked = FALSE AND g.server_id = ? AND g.scope = 'CHAT_SEND'", Integer.class, value.agentId(), identity.serverId()) == 0) throw conflict("Agent 发言权限已撤销");
        if (value.reply().status().equals("LEASED")) jdbc.update("UPDATE server_commands SET status = 'EXECUTING', started_at = CURRENT_TIMESTAMP, lease_until = ? WHERE id = ?", TelemetryService.time(Instant.now().plusSeconds(30)), id);
        return new Begin(true, stored(id).lease());
    }
    @Transactional
    public Reply acknowledge(CollectorCredentials.Identity identity, UUID id, Acknowledgement acknowledgement) {
        collector(identity); sweep(identity.serverId());
        Stored value = owned(identity, id, acknowledgement.leaseId(), acknowledgement.bootId());
        String outcome = acknowledgement.outcome();
        check(outcome != null && Set.of("DELIVERED", "FAILED", "UNCERTAIN").contains(outcome), "回执状态无效");
        if (outcome.equals("DELIVERED")) {
            millis(acknowledgement.sentAt());
            check(acknowledgement.errorCode() == null && value.reply().startedAt() != null
                    && !acknowledgement.sentAt().isBefore(value.reply().startedAt().truncatedTo(java.time.temporal.ChronoUnit.MILLIS))
                    && !acknowledgement.sentAt().isAfter(Instant.now().plusSeconds(30)), "实际发送时间或回执字段无效");
        } else check(acknowledgement.sentAt() == null && acknowledgement.errorCode() != null
                && Set.of("PLAYER_OFFLINE", "SEND_FAILED", "LOCAL_STATE_UNCERTAIN").contains(acknowledgement.errorCode()), "失败回执必须提供明确错误码");
        if (value.reply().status().equals(outcome)) {
            if (!Objects.equals(value.reply().completedAt(), outcome.equals("DELIVERED") ? acknowledgement.sentAt() : value.reply().completedAt())
                    || !Objects.equals(value.reply().errorCode(), acknowledgement.errorCode())) throw conflict("回执内容与已有结果不同");
            return value.reply();
        }
        if (!Set.of("EXECUTING", "UNCERTAIN").contains(value.reply().status()) || value.reply().startedAt() == null) throw conflict("回复尚未执行或已经有最终结果");
        jdbc.update("UPDATE server_commands SET status = ?, completed_at = ?, error_code = ? WHERE id = ?", outcome,
                outcome.equals("DELIVERED") ? TelemetryService.time(acknowledgement.sentAt()) : TelemetryService.time(Instant.now()), acknowledgement.errorCode(), id);
        if (outcome.equals("DELIVERED")) activity.append(identity.serverId(), id, "AGENT", "CHAT", acknowledgement.sentAt(), value.reply().targetPlayerKey(), value.reply().agentName(), null, null, null, null, null, value.reply().text());
        return stored(id).reply();
    }
}
