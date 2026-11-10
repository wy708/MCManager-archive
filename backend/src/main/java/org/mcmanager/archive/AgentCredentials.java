package org.mcmanager.archive;

import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.Instant;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.TelemetryValidation.*;

@Service
class AgentCredentials {
    enum Scope { STATS_READ, CHAT_READ, CHAT_SEND, QQ_BIND, WORLD_READ, PROJECT_WRITE }
    record Identity(UUID agentId, String tokenHash) {}
    record Grant(UUID serverId, Set<Scope> scopes) {}
    record Account(UUID id, String name, boolean revoked, Instant createdAt, List<Grant> grants) {}
    record Issued(Account account, String token) {}
    private final JdbcTemplate jdbc;
    private final ActivitySignal signal;
    AgentCredentials(JdbcTemplate jdbc, ActivitySignal signal) { this.jdbc = jdbc; this.signal = signal; }
    void lock() { jdbc.queryForObject("SELECT id FROM ingestion_mutex WHERE id = 1 FOR UPDATE", Integer.class); }
    Identity authenticate(String authorization) {
        if (authorization == null || !authorization.matches("Bearer mcmagent\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}")) throw unauthorized();
        try {
            String token = authorization.substring(7);
            var identity = new Identity(UUID.fromString(token.substring(9, 45)), CollectorCredentials.hash(token.getBytes(StandardCharsets.UTF_8)));
            verify(identity); return identity;
        } catch (IllegalArgumentException ex) { throw unauthorized(); }
    }
    void verify(Identity identity) {
        var hashes = jdbc.queryForList("SELECT token_hash FROM agent_accounts WHERE id = ? AND revoked = FALSE", String.class, identity.agentId());
        if (hashes.isEmpty() || !MessageDigest.isEqual(hashes.getFirst().getBytes(StandardCharsets.US_ASCII), identity.tokenHash().getBytes(StandardCharsets.US_ASCII))) throw unauthorized();
    }
    void require(Identity identity, UUID server, Scope scope) {
        verify(identity);
        if (jdbc.queryForObject("SELECT COUNT(*) FROM agent_server_access WHERE agent_id = ? AND server_id = ? AND scope = ?", Integer.class,
                identity.agentId(), server, scope.name()) == 0) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Agent 没有该服务器的所需权限");
    }
    private ResponseStatusException unauthorized() { return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Agent 凭据无效或已撤销"); }
    Account account(UUID id) {
        var rows = jdbc.query("SELECT id, name, revoked, created_at FROM agent_accounts WHERE id = ?", (rs, i) -> new Account(id, rs.getString("name"), rs.getBoolean("revoked"), TelemetryQueries.instant(rs, "created_at"), grants(id)), id);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Agent 不存在");
        return rows.getFirst();
    }
    List<Grant> grants(UUID id) {
        Map<UUID, Set<Scope>> grants = new LinkedHashMap<>();
        jdbc.query("SELECT server_id, scope FROM agent_server_access WHERE agent_id = ? ORDER BY server_id, scope", rs -> {
            UUID server = rs.getObject("server_id", UUID.class);
            grants.computeIfAbsent(server, key -> EnumSet.noneOf(Scope.class)).add(Scope.valueOf(rs.getString("scope")));
        }, id);
        return grants.entrySet().stream().map(entry -> new Grant(entry.getKey(), Set.copyOf(entry.getValue()))).toList();
    }
    List<Account> list() { return jdbc.queryForList("SELECT id FROM agent_accounts ORDER BY created_at, id", UUID.class).stream().map(this::account).toList(); }
    private String newToken(UUID id) {
        byte[] random = new byte[32]; new SecureRandom().nextBytes(random);
        return "mcmagent." + id + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(random);
    }
    @Transactional
    public Issued create(String name, List<Grant> grants) {
        check(name != null && !name.isBlank() && name.equals(name.strip()) && name.length() <= 64 && name.codePoints().noneMatch(c -> Character.isISOControl(c) || Character.getType(c) == Character.SURROGATE || c == 0x00a7), "Agent 名称无效");
        lock(); UUID id = UUID.randomUUID(); String token = newToken(id);
        jdbc.update("INSERT INTO agent_accounts(id, name, token_hash, revoked, created_at) VALUES (?, ?, ?, FALSE, CURRENT_TIMESTAMP)", id, name, CollectorCredentials.hash(token.getBytes(StandardCharsets.UTF_8)));
        replaceGrants(id, grants);
        return new Issued(account(id), token);
    }
    private void replaceGrants(UUID id, List<Grant> grants) {
        check(grants != null && grants.size() <= 64 && grants.stream().noneMatch(Objects::isNull), "服务器授权无效");
        Set<UUID> servers = new HashSet<>();
        for (Grant grant : grants) {
            check(grant.serverId() != null && servers.add(grant.serverId()) && grant.scopes() != null && !grant.scopes().isEmpty() && grant.scopes().stream().noneMatch(Objects::isNull), "服务器授权重复或权限为空");
            check(jdbc.queryForObject("SELECT COUNT(*) FROM server_archives WHERE id = ?", Integer.class, grant.serverId()) == 1, "授权服务器不存在");
        }
        jdbc.update("DELETE FROM agent_server_access WHERE agent_id = ?", id);
        for (Grant grant : grants) for (Scope scope : grant.scopes()) jdbc.update("INSERT INTO agent_server_access(agent_id, server_id, scope) VALUES (?, ?, ?)", id, grant.serverId(), scope.name());
    }
    @Transactional
    public Account update(UUID id, List<Grant> grants) {
        lock(); account(id); replaceGrants(id, grants); cancelUnsent(id);
        signal.publishOnCommit();
        return account(id);
    }
    @Transactional
    public Issued rotate(UUID id) {
        lock(); account(id); String token = newToken(id);
        jdbc.update("UPDATE agent_accounts SET token_hash = ?, revoked = FALSE WHERE id = ?", CollectorCredentials.hash(token.getBytes(StandardCharsets.UTF_8)), id);
        signal.publishOnCommit();
        return new Issued(account(id), token);
    }
    @Transactional
    public void revoke(UUID id) {
        lock(); account(id); jdbc.update("UPDATE agent_accounts SET revoked = TRUE WHERE id = ?", id); cancelUnsent(id);
        signal.publishOnCommit();
    }
    private void cancelUnsent(UUID id) {
        jdbc.update("UPDATE server_commands SET status = CASE WHEN status = 'EXECUTING' THEN 'UNCERTAIN' ELSE 'CANCELLED' END, error_code = 'ACCESS_CHANGED' WHERE agent_id = ? AND status IN ('PENDING', 'LEASED', 'EXECUTING') AND (EXISTS(SELECT 1 FROM agent_accounts a WHERE a.id = agent_id AND a.revoked = TRUE) OR NOT EXISTS(SELECT 1 FROM agent_server_access g WHERE g.agent_id = server_commands.agent_id AND g.server_id = server_commands.server_id AND g.scope = 'CHAT_SEND'))", id);
    }
}
