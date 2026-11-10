package org.mcmanager.archive;

import com.fasterxml.jackson.databind.*;
import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.test.context.support.*;
import org.springframework.security.test.context.TestSecurityContextHolder;
import org.springframework.test.context.*;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.server.ResponseStatusException;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestBuilders.formLogin;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:host_test;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "mcmanager.admin-password=test-admin-password-2026", "mcmanager.backup-max-upload-bytes=10485760"})
@AutoConfigureMockMvc
@WithMockUser(roles="ADMIN")
class HostIntegrationTest {
    @TempDir static Path directory;
    @DynamicPropertySource static void storage(DynamicPropertyRegistry registry) { registry.add("mcmanager.backup-directory", () -> directory.resolve("store").toString()); }
    @Autowired JdbcTemplate jdbc;
    @Autowired BackupHosts hosts;
    @Autowired ArchiveRepository archives;
    @Autowired BackupService backups;
    @Autowired ObjectMapper json;
    @Autowired MockMvc mvc;
    @Autowired AgentCredentials agents;
    @Autowired CollectorCredentials collectors;
    @BeforeEach void clear() {
        for (String table : List.of("backup_job_attempts", "backup_jobs", "backup_hosts", "game_backups", "agent_server_access", "agent_accounts", "collector_credentials", "server_archives")) jdbc.update("DELETE FROM " + table);
    }
    record Fixture(byte[] bytes, UUID id, String sha) {}
    record Owner(BackupHosts.Issued issued, BackupHosts.Identity identity, UUID run) {}
    Owner owner() {
        UUID server = archives.create("执行端协议夹具", "not gameplay", LocalDate.of(2020,1,1)).id();
        var issued = hosts.create(server, "Windows QA"); var identity = hosts.authenticate("Bearer " + issued.token()); UUID run = UUID.randomUUID();
        hosts.heartbeat(identity, new HostController.Heartbeat(run, "RUNNING", "0.3.0")); return new Owner(issued, identity, run);
    }
    BackupHosts.Job enqueue(Owner owner) { return hosts.enqueue(owner.issued().host().serverId(),
            new HostController.JobRequest(UUID.randomUUID(), owner.issued().host().id(), "MANUAL", "协议测试", false)); }
    HostController.Lease lease(Owner owner, BackupHosts.Claim claim) { return new HostController.Lease(owner.run(), claim.attemptId()); }
    BackupHosts.Claim claim(Owner owner) { return hosts.claim(owner.identity(), new HostController.ClaimRequest(owner.run(), UUID.randomUUID())); }
    Fixture fixture(UUID server) throws Exception {
        Path folder = Files.createDirectory(directory.resolve(UUID.randomUUID().toString())), file = folder.resolve("fixture.tar.gz");
        Process process = new ProcessBuilder("node", Path.of("../backup/qa/create-upload-fixture.mjs").toAbsolutePath().normalize().toString(),
                folder.toString(), server.toString(), file.toString(), "--online").redirectErrorStream(true).start();
        assertThat(process.waitFor(40, TimeUnit.SECONDS)).isTrue(); String output = new String(process.getInputStream().readAllBytes());
        assertThat(process.exitValue()).describedAs(output).isZero(); JsonNode result = json.readTree(output);
        return new Fixture(Files.readAllBytes(file), UUID.fromString(result.path("backupId").asText()), result.path("sha256").asText());
    }
    HostController.Artifact artifact(Owner o, BackupHosts.Claim c, Fixture f) { return new HostController.Artifact(o.run(), c.attemptId(), f.id(), f.sha(), Integer.toString(f.bytes().length)); }
    void expire(BackupHosts.Claim claim) { jdbc.update("UPDATE backup_job_attempts SET lease_until=? WHERE id=?", OffsetDateTime.now().minusMinutes(5), claim.attemptId()); }

    @Test void retryAfterRevocationReturnsOriginalTaskWithoutAllowingNewWork() {
        Owner o = owner(); UUID server = o.issued().host().serverId(), host = o.issued().host().id();
        var request = new HostController.JobRequest(UUID.randomUUID(), host, "MANUAL", "回执丢失", false);
        var original = hosts.enqueue(server, request);
        hosts.revoke(host);
        var retried = hosts.enqueue(server, request);
        assertThat(retried.id()).isEqualTo(original.id());
        assertThat(retried.status()).isEqualTo("CANCELLED");
        assertThatThrownBy(() -> hosts.enqueue(server, new HostController.JobRequest(UUID.randomUUID(), host, "MANUAL", "新任务", false)))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("凭据已撤销");
        assertThatThrownBy(() -> hosts.enqueue(server, new HostController.JobRequest(request.requestId(), host, "MANUAL", "不同内容", false)))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("另一任务");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM backup_jobs WHERE host_id=?", Integer.class, host)).isEqualTo(1);
    }
    @Test @WithAnonymousUser void independentCredentialCannotReadArchivesStatsOrUseAdminSessionAsHost() throws Exception {
        Owner o = owner(); String bearer = "Bearer " + o.issued().token();
        mvc.perform(post("/api/host/v1/heartbeat").header("Authorization", bearer).contentType("application/json")
                .content(json.writeValueAsString(new HostController.Heartbeat(o.run(), "RUNNING", "0.3.0")))).andExpect(status().isOk());
        for (String url : List.of("/api/backups", "/api/servers", "/api/agent/servers", "/api/backups/" + UUID.randomUUID() + "/content"))
            mvc.perform(get(url).header("Authorization", bearer)).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/host/v1/jobs/claim").contentType("application/json").content("{}")).andExpect(status().isUnauthorized());
        for (String token : List.of(agents.create("角色隔离",List.of()).token(), collectors.rotate(o.issued().host().serverId()).token()))
            mvc.perform(post("/api/host/v1/jobs/claim").header("Authorization","Bearer " + token).contentType("application/json").content("{}")).andExpect(status().isUnauthorized());
        TestSecurityContextHolder.clearContext();
        MockHttpSession session = (MockHttpSession)mvc.perform(formLogin("/api/auth/login").user("admin").password("test-admin-password-2026"))
                .andExpect(status().isNoContent()).andReturn().getRequest().getSession(false);
        String sessionId = session.getId();
        mvc.perform(post("/api/host/v1/heartbeat").session(session).header("Authorization", bearer).contentType("application/json")
                .content(json.writeValueAsString(new HostController.Heartbeat(o.run(), "RUNNING", "0.3.0")))).andExpect(status().isOk());
        assertThat(session.getId()).isEqualTo(sessionId);
        mvc.perform(post("/api/host/v1/heartbeat").session(session).contentType("application/json").content("{}" )).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/backups").session(session)).andExpect(status().isOk());
    }
    @Test void adminEndpointsRequireCsrfAndNeverListSecrets() throws Exception {
        Owner o = owner();
        mvc.perform(post("/api/backup-hosts/" + o.issued().host().id() + "/rotate")).andExpect(status().isForbidden());
        mvc.perform(get("/api/backup-hosts")).andExpect(status().isOk()).andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString(o.issued().token()))));
        mvc.perform(post("/api/servers/" + o.issued().host().serverId() + "/backup-jobs").with(csrf()).contentType("application/json").content("{}" )).andExpect(status().isBadRequest());
        assertThatThrownBy(() -> hosts.create(o.issued().host().serverId(), "duplicate")).isInstanceOf(ResponseStatusException.class);
    }
    @Test void jobAndClaimRetriesAreStableAndOnlyOneWorkerCanClaim() throws Exception {
        Owner o = owner(); var request = new HostController.JobRequest(UUID.randomUUID(), o.issued().host().id(), "FINAL", "最终归档", false);
        var job = hosts.enqueue(o.issued().host().serverId(), request);
        assertThat(hosts.enqueue(job.serverId(), request).id()).isEqualTo(job.id()); assertThat(job.permanent()).isTrue();
        var claimRequest = new HostController.ClaimRequest(o.run(), UUID.randomUUID()); var c = hosts.claim(o.identity(), claimRequest);
        assertThat(hosts.claim(o.identity(), claimRequest).attemptId()).isEqualTo(c.attemptId()); assertThat(claim(o)).isNull();
        assertThat(hosts.start(o.identity(), job.id(), lease(o,c)).status()).isEqualTo("RUNNING");
        assertThat(hosts.start(o.identity(), job.id(), lease(o,c)).status()).isEqualTo("RUNNING");
        hosts.renew(o.identity(), job.id(), lease(o,c));
    }
    @Test void parallelClaimsCannotStartTwoJobsOnTheSameHost() throws Exception {
        Owner o = owner(); enqueue(o); enqueue(o); var gate = new CountDownLatch(1); var pool = Executors.newFixedThreadPool(2);
        try {
            Callable<BackupHosts.Claim> action = () -> { assertThat(gate.await(10,TimeUnit.SECONDS)).isTrue(); return claim(o); };
            var first = pool.submit(action); var second = pool.submit(action); gate.countDown();
            var values = Arrays.asList(first.get(10,TimeUnit.SECONDS), second.get(10,TimeUnit.SECONDS));
            assertThat(values.stream().filter(Objects::nonNull).count()).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM backup_jobs WHERE status='CLAIMED'",Integer.class)).isEqualTo(1);
        } finally { pool.shutdownNow(); }
    }
    @Test void aStoppedGameCannotClaimOrStartLiveBackupWork() {
        Owner o = owner(); var job = enqueue(o);
        hosts.heartbeat(o.identity(), new HostController.Heartbeat(o.run(),"STOPPED","qa-1")); assertThat(claim(o)).isNull();
        hosts.heartbeat(o.identity(), new HostController.Heartbeat(o.run(),"RUNNING","qa-1")); var c = claim(o);
        hosts.heartbeat(o.identity(), new HostController.Heartbeat(o.run(),"ERROR","qa-1"));
        assertThatThrownBy(() -> hosts.start(o.identity(),job.id(),lease(o,c))).isInstanceOf(ResponseStatusException.class);
        assertThat(hosts.find(job.id()).status()).isEqualTo("CLAIMED");
    }
    @Test void aCleanlyStoppedWorkerCanHandOverWithoutWaitingForHeartbeatExpiry() {
        Owner o=owner();var job=enqueue(o);var old=claim(o);
        hosts.heartbeat(o.identity(),new HostController.Heartbeat(o.run(),"STOPPED","qa-1"));UUID replacement=UUID.randomUUID();
        assertThat(hosts.heartbeat(o.identity(),new HostController.Heartbeat(replacement,"RUNNING","qa-1")).runnerId()).isEqualTo(replacement);
        assertThat(hosts.find(job.id()).status()).isEqualTo("QUEUED");
        assertThatThrownBy(()->hosts.start(o.identity(),job.id(),lease(o,old))).isInstanceOf(ResponseStatusException.class);
    }
    @Test void unstartedExpiryCanRequeueButStartedExpiryNeedsReconciliation() {
        Owner o = owner(); var job = enqueue(o); var first = claim(o); expire(first);
        assertThat(hosts.find(job.id()).status()).isEqualTo("QUEUED"); var second = claim(o);
        assertThat(second.attemptId()).isNotEqualTo(first.attemptId());
        assertThatThrownBy(() -> hosts.start(o.identity(), job.id(), lease(o,first))).isInstanceOf(ResponseStatusException.class);
        hosts.start(o.identity(), job.id(), lease(o,second)); expire(second);
        assertThat(hosts.find(job.id()).status()).isEqualTo("UNCERTAIN"); enqueue(o); assertThat(claim(o)).isNull();
        hosts.resolve(job.id(), new HostController.Resolution("FAILED", "已核实旧执行进程停止，保留本地诊断"));
        assertThat(claim(o)).isNotNull();
        assertThatThrownBy(() -> hosts.renew(o.identity(), job.id(), lease(o,second))).isInstanceOf(ResponseStatusException.class);
    }
    @Test void crossHostStaleRunnerAndRotatedCredentialsCannotExecute() {
        Owner a = owner(), b = owner(); var job = enqueue(a); var c = claim(a);
        assertThatThrownBy(() -> hosts.start(b.identity(), job.id(), lease(b,c))).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> hosts.heartbeat(a.identity(), new HostController.Heartbeat(UUID.randomUUID(), "RUNNING", "0.3.0"))).isInstanceOf(ResponseStatusException.class);
        hosts.rotate(a.issued().host().id());
        assertThatThrownBy(() -> hosts.start(a.identity(), job.id(), lease(a,c))).isInstanceOf(ResponseStatusException.class);
        assertThat(hosts.find(job.id()).status()).isEqualTo("QUEUED");
    }
    @Test void uploadedBytesAndJobSuccessCommitTogetherAndCannotBeReplaced() throws Exception {
        Owner o = owner(); var job = enqueue(o); var c = claim(o); hosts.start(o.identity(), job.id(), lease(o,c));
        Fixture f = fixture(job.serverId()); var request = artifact(o,c,f); var record = hosts.prepare(o.identity(), job.id(), request, false);
        assertThat(hosts.prepare(o.identity(), job.id(), request, false).id()).isEqualTo(record.id());
        assertThatThrownBy(() -> backups.upload(record.id(), new ByteArrayInputStream(f.bytes()), f.bytes().length)).isInstanceOf(ResponseStatusException.class);
        var ready = hosts.upload(o.identity(), job.id(), o.run(), c.attemptId(), new ByteArrayInputStream(f.bytes()), f.bytes().length);
        assertThat(ready.status()).isEqualTo("READY"); assertThat(ready.worldRuntimeVerified()).isFalse();
        assertThat(hosts.own(o.identity(), job.id()).status()).isEqualTo("SUCCEEDED");
        assertThat(hosts.prepare(o.identity(), job.id(), request, false).id()).isEqualTo(record.id());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM game_backups", Integer.class)).isEqualTo(1);
    }
    @Test void revokedDuringUploadCannotPublishEvenAfterVerification() throws Exception {
        Owner o = owner(); var job = enqueue(o); var c = claim(o); hosts.start(o.identity(), job.id(), lease(o,c)); Fixture f = fixture(job.serverId());
        var record = hosts.prepare(o.identity(), job.id(), artifact(o,c,f), false);
        var input = new ByteArrayInputStream(f.bytes()) {
            boolean first = true;
            @Override public synchronized int read(byte[] bytes, int offset, int count) { if (first) { first=false; hosts.revoke(o.issued().host().id()); } return super.read(bytes,offset,count); }
        };
        assertThatThrownBy(() -> hosts.upload(o.identity(), job.id(), o.run(), c.attemptId(), input, f.bytes().length)).isInstanceOf(ResponseStatusException.class);
        assertThat(backups.find(record.id()).status()).isEqualTo("FAILED"); assertThat(hosts.find(job.id()).status()).isEqualTo("UNCERTAIN");
        assertThatThrownBy(() -> backups.download(record.id())).isInstanceOf(ResponseStatusException.class);
    }
    @Test void restartCanOnlyResumeTheSameArtifactAndCancellationFencesPublication() throws Exception {
        Owner o = owner(); var job = enqueue(o); var c = claim(o); hosts.start(o.identity(), job.id(), lease(o,c)); Fixture f = fixture(job.serverId());
        hosts.prepare(o.identity(), job.id(), artifact(o,c,f), false); expire(c);
        jdbc.update("UPDATE backup_hosts SET heartbeat_at=? WHERE id=?", OffsetDateTime.now().minusMinutes(5), o.issued().host().id());
        UUID newRun = UUID.randomUUID(); hosts.heartbeat(o.identity(), new HostController.Heartbeat(newRun, "RUNNING", "0.3.0"));
        var recovery = new HostController.Artifact(newRun, c.attemptId(), f.id(), f.sha(), Integer.toString(f.bytes().length));
        assertThat(hosts.prepare(o.identity(), job.id(), recovery, true).id()).isEqualTo(hosts.find(job.id()).backupId());
        assertThatThrownBy(() -> hosts.prepare(o.identity(), job.id(), new HostController.Artifact(newRun,c.attemptId(),UUID.randomUUID(),f.sha(),recovery.bytes()),true)).isInstanceOf(ResponseStatusException.class);
        hosts.cancel(job.id());
        assertThat(hosts.renew(o.identity(), job.id(), new HostController.Lease(newRun,c.attemptId())).cancelRequested()).isTrue();
        assertThatThrownBy(() -> hosts.upload(o.identity(), job.id(), newRun, c.attemptId(), new ByteArrayInputStream(f.bytes()),f.bytes().length)).isInstanceOf(ResponseStatusException.class);
        assertThat(hosts.report(o.identity(), job.id(), new HostController.Report(newRun,c.attemptId(),"CANCELLED","OPERATOR_CANCELLED")).status()).isEqualTo("CANCELLED");
    }
    @Test void aRecoveredOriginalArchiveCanFinishWithoutASecondBackupRecord() throws Exception {
        Owner o = owner(); var job = enqueue(o); var c = claim(o); hosts.start(o.identity(),job.id(),lease(o,c)); Fixture f = fixture(job.serverId());
        var original = hosts.prepare(o.identity(),job.id(),artifact(o,c,f),false); expire(c);
        assertThat(hosts.find(job.id()).status()).isEqualTo("UNCERTAIN");
        hosts.prepare(o.identity(),job.id(),artifact(o,c,f),true);
        assertThat(hosts.upload(o.identity(),job.id(),o.run(),c.attemptId(),new ByteArrayInputStream(f.bytes()),f.bytes().length).id()).isEqualTo(original.id());
        assertThat(hosts.find(job.id()).status()).isEqualTo("SUCCEEDED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM game_backups",Integer.class)).isEqualTo(1);
    }
}
