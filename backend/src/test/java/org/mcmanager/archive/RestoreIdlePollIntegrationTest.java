package org.mcmanager.archive;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.LocalDate;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.support.TransactionTemplate;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties={
        "spring.datasource.url=jdbc:h2:mem:restore_idle_test;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "mcmanager.admin-password=test-admin-password-2026", "MCM_IDLE_POLL_SECONDS=8"})
@AutoConfigureMockMvc
class RestoreIdlePollIntegrationTest {
    @TempDir static Path directory;
    @DynamicPropertySource static void storage(DynamicPropertyRegistry registry) {
        registry.add("mcmanager.backup-directory",()->directory.resolve("store").toString());
    }
    @Autowired ArchiveRepository archives;
    @Autowired BackupHosts hosts;
    @Autowired BackupService backups;
    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate transaction;
    @Autowired ObjectMapper json;
    @Autowired MockMvc mvc;
    record Owner(UUID server,BackupHosts.Issued issued,BackupHosts.Identity identity,UUID run) {}

    Owner owner() {
        UUID server=archives.create("Restore idle fixture","HTTP polling fixture",LocalDate.of(2020,1,1)).id();
        var issued=hosts.create(server,"Restore idle host");
        var identity=hosts.authenticate("Bearer "+issued.token());
        UUID run=UUID.randomUUID();
        hosts.heartbeat(identity,new HostController.Heartbeat(run,"RUNNING","0.7.1",true));
        return new Owner(server,issued,identity,run);
    }
    HostController.ClaimRequest request(Owner owner) {
        return new HostController.ClaimRequest(owner.run(),UUID.randomUUID());
    }
    MvcResult claim(Owner owner,String kind,HostController.ClaimRequest request) throws Exception {
        return mvc.perform(post("/api/host/v1/"+kind+"/claim")
                .header("Authorization","Bearer "+owner.issued().token())
                .contentType("application/json").content(json.writeValueAsBytes(request))).andReturn();
    }
    MvcResult pending(Owner owner,String kind) throws Exception {
        var result=claim(owner,kind,request(owner));
        assertThat(result.getRequest().isAsyncStarted()).isTrue();
        return result;
    }
    void completed(MvcResult result,int status) throws Exception {
        result.getAsyncResult(2500);
        mvc.perform(asyncDispatch(result)).andExpect(status().is(status));
    }
    BackupService.Backup backup(Owner owner) throws Exception {
        Path folder=Files.createDirectory(directory.resolve(UUID.randomUUID().toString()));
        Path file=folder.resolve("fixture.tar.gz");
        Process child=new ProcessBuilder("node",Path.of("../backup/qa/create-upload-fixture.mjs").toAbsolutePath().normalize().toString(),
                folder.toString(),owner.server().toString(),file.toString()).redirectErrorStream(true).start();
        assertThat(child.waitFor(40,TimeUnit.SECONDS)).isTrue();
        assertThat(child.exitValue()).describedAs(new String(child.getInputStream().readAllBytes())).isZero();
        byte[] bytes=Files.readAllBytes(file);
        var reservation=backups.reserve(owner.server(),new BackupController.Reservation(UUID.randomUUID(),"MANUAL","Polling fixture",false,Integer.toString(bytes.length)));
        return backups.upload(reservation.id(),new ByteArrayInputStream(bytes),bytes.length);
    }
    UUID createRestore(Owner owner,BackupService.Backup backup) throws Exception {
        var request=new RestoreController.Request(UUID.randomUUID(),owner.issued().host().id(),"DISABLED","restore_"+UUID.randomUUID(),"",null,null);
        var result=mvc.perform(post("/api/backups/"+backup.id()+"/restores").with(user("admin").roles("ADMIN")).with(csrf())
                .contentType("application/json").content(json.writeValueAsBytes(request))).andExpect(status().isCreated()).andReturn();
        return UUID.fromString(json.readTree(result.getResponse().getContentAsByteArray()).path("id").asText());
    }

    @Test void emptyRestorePollCapsWaitAtFourSecondsAndReleasesDatabaseLock() throws Exception {
        Owner owner=owner();long started=System.nanoTime();var waiting=pending(owner,"restores");
        assertTimeoutPreemptively(Duration.ofSeconds(2),()->transaction.execute(ignored->
                jdbc.queryForObject("SELECT id FROM ingestion_mutex WHERE id=1 FOR UPDATE",Integer.class)));
        waiting.getAsyncResult(6000);
        long elapsed=TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started);
        assertThat(elapsed).isBetween(3500L,7500L);
        mvc.perform(asyncDispatch(waiting)).andExpect(status().isNoContent());
    }

    @Test void newRestoreWakesBothSequentialQueuesAndKeepsClaimRetryIdempotent() throws Exception {
        Owner owner=owner();var backup=backup(owner);var request=request(owner);
        var restoreWait=claim(owner,"restores",request);assertThat(restoreWait.getRequest().isAsyncStarted()).isTrue();
        var backupWait=pending(owner,"jobs");UUID job=createRestore(owner,backup);
        restoreWait.getAsyncResult(2500);
        var response=mvc.perform(asyncDispatch(restoreWait)).andExpect(status().isOk())
                .andExpect(jsonPath("$.job.id").value(job.toString())).andExpect(jsonPath("$.active").value(true)).andReturn();
        completed(backupWait,204);
        var retry=claim(owner,"restores",request);
        assertThat(retry.getRequest().isAsyncStarted()).isFalse();
        assertThat(json.readTree(retry.getResponse().getContentAsByteArray()).path("attemptId"))
                .isEqualTo(json.readTree(response.getResponse().getContentAsByteArray()).path("attemptId"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM restore_attempts WHERE job_id=?",Integer.class,job)).isEqualTo(1);
    }

    @Test void newBackupWakesRestorePollWithoutWaitingForItsTimeout() throws Exception {
        Owner owner=owner();var waiting=pending(owner,"restores");
        var request=new HostController.JobRequest(UUID.randomUUID(),owner.issued().host().id(),"MANUAL","",false);
        mvc.perform(post("/api/servers/"+owner.server()+"/backup-jobs").with(user("admin").roles("ADMIN")).with(csrf())
                .contentType("application/json").content(json.writeValueAsBytes(request))).andExpect(status().isCreated());
        completed(waiting,204);
        var ready=claim(owner,"jobs",request(owner));
        assertThat(ready.getRequest().isAsyncStarted()).isFalse();
        assertThat(ready.getResponse().getStatus()).isEqualTo(200);
    }

    @Test void revocationWhileWaitingIsRecheckedOnAsyncResponse() throws Exception {
        Owner owner=owner();var waiting=pending(owner,"restores");hosts.revoke(owner.issued().host().id());
        waiting.getAsyncResult(6000);
        mvc.perform(asyncDispatch(waiting)).andExpect(status().isUnauthorized());
    }

    @Test void changedRunnerCannotClaimNewRestoreAfterWake() throws Exception {
        Owner owner=owner();var backup=backup(owner);
        hosts.heartbeat(owner.identity(),new HostController.Heartbeat(owner.run(),"STOPPED","0.7.1",true));
        var waiting=pending(owner,"restores");UUID nextRun=UUID.randomUUID();
        hosts.heartbeat(owner.identity(),new HostController.Heartbeat(nextRun,"RUNNING","0.7.1",true));
        UUID job=createRestore(owner,backup);completed(waiting,409);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM restore_attempts WHERE job_id=?",Integer.class,job)).isZero();
        var next=claim(owner,"restores",new HostController.ClaimRequest(nextRun,UUID.randomUUID()));
        assertThat(next.getResponse().getStatus()).isEqualTo(200);
    }
}
