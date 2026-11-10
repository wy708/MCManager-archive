package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.nio.file.*;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.test.context.support.WithAnonymousUser;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestBuilders.formLogin;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:backup_test;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "mcmanager.admin-password=test-admin-password-2026", "mcmanager.backup-max-upload-bytes=10485760"
})
@AutoConfigureMockMvc
@WithMockUser(roles = "ADMIN")
class BackupIntegrationTest {
    @TempDir static Path sandbox;
    @DynamicPropertySource static void storage(DynamicPropertyRegistry registry) {
        registry.add("mcmanager.backup-directory", () -> sandbox.resolve("store").toString());
    }
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired BackupService backups;
    @Autowired ArchiveRepository archives;
    @Autowired TransactionTemplate transaction;
    @BeforeEach void clear() {
        for (String table : List.of("game_backups", "agent_server_access", "agent_accounts", "collector_credentials", "telemetry_batches", "daily_statistics", "players", "server_archives")) jdbc.update("DELETE FROM " + table);
    }
    UUID server() throws Exception {
        return UUID.fromString(json.readTree(mvc.perform(post("/api/servers").with(csrf()).contentType("application/json")
                .content("{\"name\":\"备份协议测试\",\"description\":\"Synthetic fixture, not gameplay\",\"startDate\":\"2020-01-01\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).path("id").asText());
    }
    byte[] fixture(UUID serverId) throws Exception {
        return fixture(serverId, false);
    }
    byte[] fixture(UUID serverId, boolean worldOnly) throws Exception {
        Path folder = Files.createDirectory(sandbox.resolve(UUID.randomUUID().toString())), output = folder.resolve("fixture.tar.gz");
        var command = new ArrayList<>(List.of("node", Path.of("../backup/qa/create-upload-fixture.mjs").toAbsolutePath().normalize().toString(),
                folder.toString(), serverId.toString(), output.toString()));
        if (worldOnly) command.addAll(List.of("--online", "--world"));
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        assertThat(process.waitFor(40, TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).describedAs(new String(process.getInputStream().readAllBytes())).isZero();
        return Files.readAllBytes(output);
    }
    JsonNode reserve(UUID serverId, UUID requestId, int size, String kind) throws Exception {
        return json.readTree(mvc.perform(post("/api/servers/" + serverId + "/backups").with(csrf()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("requestId", requestId, "kind", kind, "note", "中文备注", "permanent", false, "expectedBytes", Integer.toString(size)))))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString());
    }
    UUID reserve(UUID serverId, byte[] data) throws Exception { return UUID.fromString(reserve(serverId, UUID.randomUUID(), data.length, "MANUAL").path("id").asText()); }
    JsonNode ready(UUID id, byte[] bytes) throws Exception {
        return json.readTree(mvc.perform(put("/api/backups/" + id + "/content").with(csrf()).contentType("application/octet-stream").content(bytes))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("READY")).andExpect(jsonPath("$.worldRuntimeVerified").value(false))
                .andReturn().getResponse().getContentAsString());
    }
    @Test void worldOnlyArchiveIsVerifiedLabelledAndDownloadedWithoutClaimingCollectorHistory() throws Exception {
        UUID server = server(); byte[] archive = fixture(server, true); UUID id = reserve(server, archive);
        JsonNode value = ready(id, archive);
        assertThat(value.path("summary").path("archiveScope").asText()).isEqualTo("WORLD");
        assertThat(value.path("summary").path("worldDirectory").asText()).isEqualTo("worlds/上传夹具");
        assertThat(value.path("summary").path("statistics").path("cacheIntegrity").asText()).isEqualTo("NOT_INCLUDED");
        assertThat(value.path("summary").path("runtime").isNull()).isTrue();
        mvc.perform(get("/api/backups/" + id + "/content")).andExpect(status().isOk()).andExpect(content().bytes(archive));
        assertThat(RestoreJobs.supportsWorldBackup("0.6.0")).isFalse();
        assertThat(RestoreJobs.supportsWorldBackup(null)).isFalse();
        assertThat(RestoreJobs.supportsWorldBackup("0.7.0")).isTrue();
        assertThat(RestoreJobs.supportsWorldBackup("1.0.0")).isTrue();
    }
    @Test @WithAnonymousUser void anonymousCannotReadUploadOrDownload() throws Exception {
        UUID id = UUID.randomUUID();
        mvc.perform(get("/api/backups")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/backups/groups")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/backups/summary")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/backups/" + id + "/content")).andExpect(status().isUnauthorized());
        mvc.perform(put("/api/backups/" + id + "/content").with(csrf()).contentType("application/octet-stream").content("bad")).andExpect(status().isUnauthorized());
    }
    @Test void serverGroupsAndFiltersPageAcrossTheWholeCatalogWithoutMixingServers() throws Exception {
        UUID first=server(),second=server();
        for(int i=0;i<24;i++) {
            var row=backups.reserve(first,new BackupController.Reservation(UUID.randomUUID(),i%2==0?"AUTOMATIC":"MANUAL","fixture",false,"100"));
            var time=OffsetDateTime.parse("2026-11-01T16:00:00Z").plusDays(i);
            jdbc.update("UPDATE game_backups SET status=?,archive_bytes=100,created_at=?,snapshot_at=? WHERE id=?",i==23?"FAILED":"READY",time,time,row.id());
        }
        var other=backups.reserve(second,new BackupController.Reservation(UUID.randomUUID(),"MANUAL","other",false,"100"));
        jdbc.update("UPDATE game_backups SET status='READY',archive_bytes=500 WHERE id=?",other.id());
        var groups=backups.groups();assertThat(groups).hasSize(2);
        var group=groups.stream().filter(g->g.serverId().equals(first)).findFirst().orElseThrow();
        assertThat(group.total()).isEqualTo(24);assertThat(group.readyCount()).isEqualTo(23);assertThat(group.archiveBytes()).isEqualTo("2300");
        var page1=backups.list(first,0,10,"READY",null,null,null);var page2=backups.list(first,1,10,"READY",null,null,null);
        assertThat(page1.total()).isEqualTo(23);assertThat(page1.items()).hasSize(10);assertThat(page2.items()).hasSize(10);
        assertThat(page2.items().stream().map(BackupService.Backup::id)).doesNotContainAnyElementsOf(page1.items().stream().map(BackupService.Backup::id).toList());
        assertThat(page2.items()).allMatch(b->b.serverId().equals(first));
        mvc.perform(get("/api/backups").param("serverId",first.toString()).param("state","READY").param("kind","AUTOMATIC")
                .param("from","2026-11-01T16:00:00Z").param("to","2026-11-04T16:00:00Z").param("size","1"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(2)).andExpect(jsonPath("$.items.length()").value(1));
        mvc.perform(get("/api/backups").param("state","INVALID")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/backups").param("from","2026-11-03T00:00:00Z").param("to","2026-11-01T00:00:00Z")).andExpect(status().isBadRequest());
    }
    @Test @WithMockUser(roles = "AGENT") void agentRoleCannotAccessGameArchives() throws Exception {
        mvc.perform(get("/api/backups")).andExpect(status().isForbidden());
        mvc.perform(get("/api/backups/summary")).andExpect(status().isForbidden());
        mvc.perform(get("/api/backups/" + UUID.randomUUID() + "/content")).andExpect(status().isForbidden());
    }
    @Test void overviewCountIncludesOnlyReadyFilesWithinTheSelectedArchive() throws Exception {
        UUID own = server(), other = server(), empty = server();
        mvc.perform(get("/api/backups/summary")).andExpect(status().isOk()).andExpect(jsonPath("$.readyCount").value(0));
        byte[] first = fixture(own), second = fixture(other);
        UUID ownBackup = reserve(own, first), otherBackup = reserve(other, second);
        ready(ownBackup, first); ready(otherBackup, second);
        reserve(own, UUID.randomUUID(), 10, "MANUAL");
        mvc.perform(get("/api/backups/summary")).andExpect(status().isOk()).andExpect(jsonPath("$.readyCount").value(2));
        mvc.perform(get("/api/backups/summary").param("serverId", own.toString())).andExpect(status().isOk()).andExpect(jsonPath("$.readyCount").value(1));
        mvc.perform(get("/api/backups/summary").param("serverId", empty.toString())).andExpect(status().isOk()).andExpect(jsonPath("$.readyCount").value(0));
        mvc.perform(delete("/api/backups/" + ownBackup).with(csrf())).andExpect(status().isNoContent());
        mvc.perform(get("/api/backups/summary")).andExpect(status().isOk()).andExpect(jsonPath("$.readyCount").value(1));
        mvc.perform(get("/api/backups/summary").param("serverId", own.toString())).andExpect(status().isOk()).andExpect(jsonPath("$.readyCount").value(0));
        mvc.perform(get("/api/backups/summary").param("serverId", UUID.randomUUID().toString())).andExpect(status().isNotFound());
    }
    @Test @WithAnonymousUser void bearerRequestsNeverRotateOrReplaceAnExistingAdministratorSession() throws Exception {
        org.springframework.security.test.context.TestSecurityContextHolder.clearContext();
        MockHttpSession session = (MockHttpSession) mvc.perform(formLogin("/api/auth/login").user("admin").password("test-admin-password-2026"))
                .andExpect(status().isNoContent()).andReturn().getRequest().getSession(false);
        assertThat(session).isNotNull(); String originalId = session.getId();
        UUID serverId = UUID.fromString(json.readTree(mvc.perform(post("/api/servers").session(session).with(csrf()).contentType("application/json")
                .content("{\"name\":\"会话隔离\",\"description\":\"\",\"startDate\":\"2020-01-01\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).path("id").asText());
        String token = json.readTree(mvc.perform(post("/api/agents").session(session).with(csrf()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("name", "独立凭据", "grants", List.of(Map.of("serverId", serverId, "scopes", List.of("STATS_READ")))))))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString()).path("token").asText();
        mvc.perform(get("/api/agent/servers").session(session).header("Authorization", "Bearer " + token)).andExpect(status().isOk());
        assertThat(session.getId()).isEqualTo(originalId);
        mvc.perform(get("/api/agent/servers/" + UUID.randomUUID() + "/statistics").session(session).header("Authorization", "Bearer " + token)).andExpect(status().isForbidden());
        assertThat(session.getId()).isEqualTo(originalId);
        mvc.perform(get("/api/agent/servers").session(session)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/agent/servers").session(session).header("Authorization", "Bearer invalid")).andExpect(status().isUnauthorized());
        String collector = json.readTree(mvc.perform(post("/api/servers/" + serverId + "/collector-credential").session(session).with(csrf()))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString()).path("token").asText();
        mvc.perform(post("/api/ingest/v1/batches").session(session).header("Authorization", "Bearer " + collector).contentType("application/json").content("{}"))
                .andExpect(status().isBadRequest());
        assertThat(session.getId()).isEqualTo(originalId);
        mvc.perform(get("/api/backups").session(session)).andExpect(status().isOk());
    }
    @Test void adminMutationsRequireCsrfAndValidateBounds() throws Exception {
        UUID server = server();
        mvc.perform(post("/api/servers/" + server + "/backups").contentType("application/json").content("{}" )).andExpect(status().isForbidden());
        mvc.perform(put("/api/backups/" + UUID.randomUUID() + "/content").contentType("application/octet-stream").content("bad")).andExpect(status().isForbidden());
        mvc.perform(get("/api/backups?size=101")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/backups?serverId=" + UUID.randomUUID())).andExpect(status().isNotFound());
        mvc.perform(post("/api/servers/" + server + "/backups").with(csrf()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("requestId", UUID.randomUUID(), "kind", "MANUAL", "note", "", "expectedBytes", "10485761"))))
                .andExpect(status().isPayloadTooLarge());
    }
    @Test void fullLifecycleIsIdempotentProtectedAndDoesNotDeleteStatistics() throws Exception {
        UUID server = server(), request = UUID.randomUUID(); byte[] archive = fixture(server);
        JsonNode reserved = reserve(server, request, archive.length, "FINAL"); UUID id = UUID.fromString(reserved.path("id").asText());
        assertThat(reserved.path("permanent").asBoolean()).isTrue();
        assertThat(reserve(server, request, archive.length, "FINAL").path("id").asText()).isEqualTo(id.toString());
        JsonNode completed = ready(id, archive); String hash = completed.path("sha256").asText();
        assertThat(hash).matches("[0-9a-f]{64}"); assertThat(completed.path("summary").path("statistics").path("pendingEvents").asText()).isEqualTo("0");
        ready(id, archive);
        mvc.perform(get("/api/backups/" + id + "/content")).andExpect(status().isOk()).andExpect(header().string("X-Archive-SHA256", hash))
                .andExpect(header().string("Cache-Control", "no-store")).andExpect(content().bytes(archive));
        mvc.perform(delete("/api/backups/" + id).with(csrf())).andExpect(status().isConflict());
        mvc.perform(put("/api/backups/" + id).with(csrf()).contentType("application/json").content("{\"note\":\"保留玩家历史\",\"permanent\":false}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.note").value("保留玩家历史"));
        jdbc.update("INSERT INTO telemetry_batches(server_id,batch_id,payload_hash,event_count,received_at) VALUES (?,?,?,7,CURRENT_TIMESTAMP)", server, UUID.randomUUID(), "0".repeat(64));
        mvc.perform(delete("/api/backups/" + id).with(csrf())).andExpect(status().isNoContent());
        mvc.perform(delete("/api/backups/" + id).with(csrf())).andExpect(status().isNoContent());
        mvc.perform(get("/api/backups")).andExpect(jsonPath("$.total").value(0));
        assertThat(jdbc.queryForObject("SELECT event_count FROM telemetry_batches WHERE server_id=?", Integer.class, server)).isEqualTo(7);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM server_archives WHERE id=?", Long.class, server)).isEqualTo(1);
        UUID again = reserve(server, archive); ready(again, archive);
    }
    @Test void wrongServerDuplicateAndDamagedArchivesNeverBecomeAvailable() throws Exception {
        UUID server = server(), other = server(); byte[] archive = fixture(server);
        UUID wrong = reserve(other, archive);
        mvc.perform(put("/api/backups/" + wrong + "/content").with(csrf()).contentType("application/octet-stream").content(archive)).andExpect(status().isConflict());
        mvc.perform(get("/api/backups/" + wrong)).andExpect(jsonPath("$.status").value("FAILED")).andExpect(jsonPath("$.failureCode").value("ARCHIVE_WRONG_SERVER"));
        UUID first = reserve(server, archive); ready(first, archive); UUID duplicate = reserve(server, archive);
        mvc.perform(put("/api/backups/" + duplicate + "/content").with(csrf()).contentType("application/octet-stream").content(archive)).andExpect(status().isConflict());
        mvc.perform(get("/api/backups/" + first + "/content")).andExpect(content().bytes(archive));
        byte[] broken = archive.clone(); broken[broken.length / 2] ^= 127; UUID damaged = reserve(server, broken);
        mvc.perform(put("/api/backups/" + damaged + "/content").with(csrf()).contentType("application/octet-stream").content(broken)).andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/api/backups/" + damaged + "/content")).andExpect(status().isConflict());
        mvc.perform(get("/api/backups?serverId=" + other)).andExpect(jsonPath("$.total").value(1));
    }
    @Test void interruptedUploadCanRetryAndExpiredAttemptCannotBlockForever() throws Exception {
        UUID server = server(); byte[] archive = fixture(server); UUID id = reserve(server, archive);
        assertThatThrownBy(() -> backups.upload(id, new ByteArrayInputStream(Arrays.copyOf(archive, 50)), -1))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("文件大小不一致");
        assertThat(backups.find(id).status()).isEqualTo("FAILED");
        UUID oldAttempt = UUID.randomUUID();
        jdbc.update("UPDATE game_backups SET status='VERIFYING', attempt_id=?, lease_at=? WHERE id=?", oldAttempt, OffsetDateTime.now().minusMinutes(20), id);
        Path interrupted = sandbox.resolve("store/uploads").resolve(id + "-" + oldAttempt + ".partial"); Files.writeString(interrupted, "interrupted bytes");
        mvc.perform(put("/api/backups/" + id).with(csrf()).contentType("application/json").content("{\"note\":\"编辑不续租\",\"permanent\":false}"))
                .andExpect(jsonPath("$.interrupted").value(true));
        ready(id, archive);
        assertThat(interrupted).doesNotExist();
        mvc.perform(post("/api/servers/" + server + "/backups").with(csrf()).contentType("application/json")
                .content(json.writeValueAsString(Map.of("requestId", UUID.randomUUID(), "kind", "MANUAL", "note", "", "expectedBytes", "0"))))
                .andExpect(status().isBadRequest());
    }
    @Test void activeUploadIsExclusiveAndCannotBeDeletedOrReplaced() throws Exception {
        UUID server = server(); byte[] archive = fixture(server); UUID id = reserve(server, archive);
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        InputStream blocked = new FilterInputStream(new ByteArrayInputStream(archive)) {
            @Override public int read(byte[] b, int off, int len) throws IOException {
                started.countDown(); try { if (!release.await(10, TimeUnit.SECONDS)) throw new IOException("Test latch timeout"); }
                catch (InterruptedException ex) { Thread.currentThread().interrupt(); throw new IOException(ex); }
                return super.read(b, off, len);
            }
        };
        try (ExecutorService worker = Executors.newSingleThreadExecutor()) {
            Future<BackupService.Backup> task = worker.submit(() -> backups.upload(id, blocked, archive.length));
            try {
                assertThat(started.await(10, TimeUnit.SECONDS)).isTrue();
                mvc.perform(put("/api/backups/" + id + "/content").with(csrf()).contentType("application/octet-stream").content(archive)).andExpect(status().isTooManyRequests());
                mvc.perform(delete("/api/backups/" + id).with(csrf())).andExpect(status().isConflict());
            } finally { release.countDown(); }
            assertThat(task.get(30, TimeUnit.SECONDS).status()).isEqualTo("READY");
        }
    }
    @Test void storedFileTamperingStopsDownloadAndVerifierFailureCanBeRetried() throws Exception {
        UUID server = server(); byte[] archive = fixture(server); UUID id = reserve(server, archive);
        BackupService unavailable = new BackupService(jdbc, transaction, json, archives, sandbox.resolve("store").toString(), "does-not-exist-mcm-node",
                "../backup/src/verify-upload.mjs", 10485760, 137438953472L, 30);
        assertThatThrownBy(() -> unavailable.upload(id, new ByteArrayInputStream(archive), archive.length)).isInstanceOf(ResponseStatusException.class).hasMessageContaining("运行环境不可用");
        ready(id, archive);
        UUID attempt = jdbc.queryForObject("SELECT attempt_id FROM game_backups WHERE id=?", UUID.class, id);
        Path object = sandbox.resolve("store/objects").resolve(id + "-" + attempt + ".tar.gz");
        byte[] damaged = archive.clone(); damaged[20] ^= 1; Files.write(object, damaged);
        mvc.perform(get("/api/backups/" + id + "/content")).andExpect(status().isConflict());
        mvc.perform(get("/api/backups/" + id)).andExpect(jsonPath("$.status").value("MISSING"));
    }
}
