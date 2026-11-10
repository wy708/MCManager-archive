package org.mcmanager.archive;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
class CollectorCredentials {
    record Identity(UUID serverId, String tokenHash) {}
    record Issued(UUID serverId, String token, Instant createdAt) {}
    private final JdbcTemplate jdbc;
    CollectorCredentials(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    static String hash(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }
    private boolean valid(Identity identity) {
        List<String> hashes = jdbc.queryForList("SELECT token_hash FROM collector_credentials WHERE server_id = ?", String.class, identity.serverId());
        return !hashes.isEmpty() && MessageDigest.isEqual(hashes.getFirst().getBytes(StandardCharsets.US_ASCII), identity.tokenHash().getBytes(StandardCharsets.US_ASCII));
    }
    Identity authenticate(String authorization) {
        if (authorization == null || !authorization.matches("Bearer [0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}")) throw unauthorized();
        try {
            String token = authorization.substring(7);
            Identity identity = new Identity(UUID.fromString(token.substring(0, 36)), hash(token.getBytes(StandardCharsets.UTF_8)));
            check(identity);
            return identity;
        } catch (IllegalArgumentException ex) { throw unauthorized(); }
    }
    void check(Identity identity) { if (!valid(identity)) throw unauthorized(); }
    private ResponseStatusException unauthorized() { return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "采集凭据无效或已撤销"); }
    @Transactional
    public Issued rotate(UUID serverId) {
        lockServer(serverId);
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        String token = serverId + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        jdbc.update("DELETE FROM collector_credentials WHERE server_id = ?", serverId);
        jdbc.update("INSERT INTO collector_credentials(server_id, token_hash, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)", serverId, hash(token.getBytes(StandardCharsets.UTF_8)));
        return new Issued(serverId, token, Instant.now());
    }
    @Transactional
    public void revoke(UUID serverId) { lockServer(serverId); jdbc.update("DELETE FROM collector_credentials WHERE server_id = ?", serverId); }
    void lockServer(UUID serverId) {
        if (jdbc.queryForList("SELECT id FROM server_archives WHERE id = ? FOR UPDATE", UUID.class, serverId).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "服务器档案不存在");
        }
    }
    Map<String, Object> status(UUID serverId) {
        if (jdbc.queryForObject("SELECT COUNT(*) FROM server_archives WHERE id = ?", Integer.class, serverId) == 0) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "服务器档案不存在");
        var rows = jdbc.query("SELECT created_at FROM collector_credentials WHERE server_id = ?", (rs, i) -> rs.getObject("created_at", java.time.OffsetDateTime.class).toInstant(), serverId);
        return rows.isEmpty() ? Map.of("configured", false) : Map.of("configured", true, "createdAt", rows.getFirst());
    }
}
