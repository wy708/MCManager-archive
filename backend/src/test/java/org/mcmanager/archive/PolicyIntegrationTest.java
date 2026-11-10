package org.mcmanager.archive;

import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.springframework.security.test.context.support.*;
import org.springframework.test.context.*;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:policy_test;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "mcmanager.admin-password=test-admin-password-2026","mcmanager.backup-policy-worker-enabled=false"})
@AutoConfigureMockMvc @WithMockUser(roles="ADMIN")
class PolicyIntegrationTest {
    @TempDir static Path directory;
    @DynamicPropertySource static void storage(DynamicPropertyRegistry r) { r.add("mcmanager.backup-directory",()->directory.resolve("store").toString()); }
    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate transaction;
    @Autowired ArchiveRepository archives;
    @Autowired BackupHosts hosts;
    @Autowired BackupPolicies policies;
    @Autowired BackupService backups;
    @Autowired ObjectMapper json;
    @Autowired MockMvc mvc;
    record Owner(UUID server,BackupHosts.Issued issued,BackupHosts.Identity identity,UUID run) {}
    @BeforeEach void clear() {
        for(String table:List.of("backup_retention_events","backup_job_attempts","backup_jobs","backup_policies","backup_hosts","game_backups","server_archives")) jdbc.update("DELETE FROM "+table);
    }
    Owner owner() {
        UUID server=archives.create("自动备份协议夹具","not gameplay",LocalDate.of(2020,1,1)).id(); var issued=hosts.create(server,"策略测试主机");
        return new Owner(server,issued,hosts.authenticate("Bearer "+issued.token()),UUID.randomUUID());
    }
    BackupPolicyController.Settings settings(Owner o,long revision,boolean enabled,Integer count,Integer days) {
        return new BackupPolicyController.Settings(revision,o.issued().host().id(),enabled,60,null,count!=null||days!=null,count,days);
    }
    BackupPolicies.Policy due(Owner o) {
        var p=policies.save(o.server(),settings(o,0,true,null,null));
        jdbc.update("UPDATE backup_policies SET next_run_at=? WHERE server_id=?",OffsetDateTime.now().minusDays(2),o.server()); return p;
    }
    @Test void dailyWallClockScheduleUsesUtc8AndCoalescesMissedDays() throws Exception {
        assertThat(BackupPolicies.nextDaily(Instant.parse("2026-11-08T17:00:00Z"),"03:30")).isEqualTo(Instant.parse("2026-11-08T19:30:00Z"));
        assertThat(BackupPolicies.nextDaily(Instant.parse("2026-11-08T19:30:00Z"),"03:30")).isEqualTo(Instant.parse("2026-11-09T19:30:00Z"));
        assertThat(BackupPolicies.nextDaily(Instant.parse("2026-12-31T15:59:59Z"),"00:00")).isEqualTo(Instant.parse("2026-12-31T16:00:00Z"));
        Owner o=owner();
        var request=new BackupPolicyController.Settings(0,o.issued().host().id(),true,1440,null,false,null,null,"03:30");
        mvc.perform(put("/api/servers/"+o.server()+"/backup-policy").with(csrf()).contentType("application/json").content(json.writeValueAsString(request)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.dailyTime").value("03:30"));
        var invalid=new BackupPolicyController.Settings(1,o.issued().host().id(),true,1440,null,false,null,null,"25:10");
        mvc.perform(put("/api/servers/"+o.server()+"/backup-policy").with(csrf()).contentType("application/json").content(json.writeValueAsString(invalid))).andExpect(status().isBadRequest());
        jdbc.update("UPDATE backup_policies SET next_run_at=? WHERE server_id=?",OffsetDateTime.parse("2026-11-05T19:30:00Z"),o.server());
        Instant now=Instant.parse("2026-11-09T01:00:00Z");policies.dispatch(o.server(),now);policies.dispatch(o.server(),now);
        assertThat(hosts.jobs(o.server(),0,100).total()).isEqualTo(1);
        assertThat(policies.list(o.server()).getFirst().nextRunAt()).isEqualTo(Instant.parse("2026-11-09T19:30:00Z"));
        Instant stillOffline=Instant.parse("2026-11-12T01:00:00Z");policies.dispatch(o.server(),stillOffline);
        assertThat(hosts.jobs(o.server(),0,100).total()).isEqualTo(1);
        assertThat(policies.list(o.server()).getFirst().nextRunAt()).isEqualTo(Instant.parse("2026-11-12T19:30:00Z"));
        var updated=policies.save(o.server(),new BackupPolicyController.Settings(1,o.issued().host().id(),true,1440,null,false,null,null,"04:45"));
        assertThat(updated.dailyTime()).isEqualTo("04:45");
        assertThat(updated.nextRunAt().atOffset(ZoneOffset.ofHours(8)).toLocalTime()).isEqualTo(LocalTime.of(4,45));
        assertThat(hosts.jobs(o.server(),0,100).items().getFirst().status()).isEqualTo("CANCELLED");
        var disabled=policies.save(o.server(),new BackupPolicyController.Settings(2,o.issued().host().id(),false,1440,null,false,null,null,"04:45"));
        assertThat(disabled.nextRunAt()).isNull();assertThat(disabled.dailyTime()).isEqualTo("04:45");
    }
    BackupService.Backup ready(Owner o,String kind,boolean permanent,int daysAgo) throws Exception {
        Path folder=Files.createDirectory(directory.resolve(UUID.randomUUID().toString())),file=folder.resolve("fixture.tar.gz");
        Process child=new ProcessBuilder("node",Path.of("../backup/qa/create-upload-fixture.mjs").toAbsolutePath().normalize().toString(),folder.toString(),o.server().toString(),file.toString()).redirectErrorStream(true).start();
        assertThat(child.waitFor(40,TimeUnit.SECONDS)).isTrue(); assertThat(child.exitValue()).describedAs(new String(child.getInputStream().readAllBytes())).isZero();
        byte[] bytes=Files.readAllBytes(file);
        var reservation=backups.reserve(o.server(),new BackupController.Reservation(UUID.randomUUID(),kind,"真实校验器协议文件",permanent,Integer.toString(bytes.length)));
        var result=backups.upload(reservation.id(),new ByteArrayInputStream(bytes),bytes.length);
        jdbc.update("UPDATE game_backups SET created_at=? WHERE id=?",OffsetDateTime.now().minusDays(daysAgo),result.id()); return backups.find(result.id());
    }
    Path object(UUID id) throws Exception {
        return directory.resolve("store/objects").resolve(id+"-"+jdbc.queryForObject("SELECT attempt_id FROM game_backups WHERE id=?",UUID.class,id)+".tar.gz");
    }
    @Test void disabledByDefaultAndSettingsAreVersionedAndValidated() throws Exception {
        Owner o=owner(); assertThat(policies.list(o.server())).isEmpty();
        var first=policies.save(o.server(),settings(o,0,false,7,null)); assertThat(first.enabled()).isFalse(); assertThat(first.nextRunAt()).isNull();
        assertThatThrownBy(()->policies.save(o.server(),settings(o,0,true,7,null))).isInstanceOf(ResponseStatusException.class).hasMessageContaining("策略已变更");
        Owner other=owner(); assertThatThrownBy(()->policies.save(o.server(),settings(other,1,true,null,null))).isInstanceOf(ResponseStatusException.class).hasMessageContaining("不属于");
        var invalid=new BackupPolicyController.Settings(1,o.issued().host().id(),true,0,null,false,null,null);
        mvc.perform(put("/api/servers/"+o.server()+"/backup-policy").with(csrf()).contentType("application/json").content(json.writeValueAsString(invalid))).andExpect(status().isBadRequest());
        assertThatThrownBy(()->policies.preview(o.server(),0,null,Instant.now())).isInstanceOf(ResponseStatusException.class);
        assertThat(policies.save(o.server(),settings(o,1,true,7,null)).revision()).isEqualTo(2);
    }
    @Test void concurrentDispatchCoalescesMissedSlotsAndQueuesOnlyOneOfflineTask() throws Exception {
        Owner o=owner(); due(o); Instant now=Instant.now(); var pool=Executors.newFixedThreadPool(6);
        try {
            var tasks=new ArrayList<Callable<Void>>(); for(int i=0;i<12;i++) tasks.add(()->{policies.dispatch(o.server(),now);return null;});
            for(var future:pool.invokeAll(tasks)) future.get(10,TimeUnit.SECONDS);
        } finally {pool.shutdownNow();}
        var jobs=hosts.jobs(o.server(),0,100); assertThat(jobs.total()).isEqualTo(1); assertThat(jobs.items().getFirst().kind()).isEqualTo("AUTOMATIC");
        assertThat(policies.list(o.server()).getFirst().nextRunAt()).isAfter(now);
        assertThat(policies.list(o.server()).getFirst().lastOutcome()).isEqualTo("QUEUED_OFFLINE");
        policies.dispatch(o.server(),now.plus(Duration.ofDays(7))); assertThat(hosts.jobs(o.server(),0,100).total()).isEqualTo(1);
        assertThat(policies.list(o.server()).getFirst().lastOutcome()).isEqualTo("WAITING_TASK");
        var reconstructed=new BackupPolicies(jdbc,transaction,archives,hosts,backups); reconstructed.dispatch(o.server(),now.plus(Duration.ofDays(8)));
        assertThat(hosts.jobs(o.server(),0,100).total()).isEqualTo(1);
    }
    @Test void uncertaintyBlocksNewWorkUntilExplicitResolution() {
        Owner o=owner(); due(o); Instant now=Instant.now(); policies.dispatch(o.server(),now);
        hosts.heartbeat(o.identity(),new HostController.Heartbeat(o.run(),"RUNNING","qa-1"));
        var claim=hosts.claim(o.identity(),new HostController.ClaimRequest(o.run(),UUID.randomUUID()));
        var lease=new HostController.Lease(o.run(),claim.attemptId()); hosts.start(o.identity(),claim.job().id(),lease);
        hosts.report(o.identity(),claim.job().id(),new HostController.Report(o.run(),claim.attemptId(),"UNCERTAIN","EXECUTION_INTERRUPTED"));
        policies.dispatch(o.server(),now.plus(Duration.ofDays(2))); assertThat(hosts.jobs(o.server(),0,100).total()).isEqualTo(1);
        hosts.resolve(claim.job().id(),new HostController.Resolution("FAILED","已核对原文件"));
        policies.dispatch(o.server(),now.plus(Duration.ofDays(2))); assertThat(hosts.jobs(o.server(),0,100).total()).isEqualTo(2);
        assertThat(hosts.find(claim.job().id()).status()).isEqualTo("FAILED");
    }
    @Test void disablingCancelsUnstartedPolicyTasksAndPreservesManualTasks() {
        Owner o=owner(); due(o); policies.dispatch(o.server(),Instant.now()); var generated=hosts.jobs(o.server(),0,100).items().getFirst();
        var manual=hosts.enqueue(o.server(),new HostController.JobRequest(UUID.randomUUID(),o.issued().host().id(),"MANUAL","维护前",false));
        policies.save(o.server(),settings(o,1,false,null,null));
        assertThat(hosts.find(generated.id()).status()).isEqualTo("CANCELLED"); assertThat(hosts.find(manual.id()).status()).isEqualTo("QUEUED");
        policies.dispatch(o.server(),Instant.now().plus(Duration.ofDays(30))); assertThat(hosts.jobs(o.server(),0,100).total()).isEqualTo(2);
    }
    @Test void sealingAfterClaimPreventsStartAndCancelsOnlyUnstartedAutomaticWork() {
        Owner o=owner(); due(o); policies.dispatch(o.server(),Instant.now());
        hosts.heartbeat(o.identity(),new HostController.Heartbeat(o.run(),"RUNNING","qa-1"));
        var claim=hosts.claim(o.identity(),new HostController.ClaimRequest(o.run(),UUID.randomUUID())); archives.archive(o.server(),LocalDate.now());
        assertThatThrownBy(()->hosts.start(o.identity(),claim.job().id(),new HostController.Lease(o.run(),claim.attemptId()))).isInstanceOf(ResponseStatusException.class).hasMessageContaining("已封存");
        policies.dispatch(o.server(),Instant.now()); assertThat(hosts.find(claim.job().id()).status()).isEqualTo("CANCELLED");
        assertThat(policies.list(o.server()).getFirst().enabled()).isFalse();
        assertThatThrownBy(()->policies.save(o.server(),settings(o,1,true,null,null))).isInstanceOf(ResponseStatusException.class);
    }
    @Test void revokedHostDoesNotCreateWorkAndExplicitFirstRunIsPreservedForDueCheck() {
        Owner o=owner(); Instant first=Instant.now().plusSeconds(30);
        var settings=new BackupPolicyController.Settings(0,o.issued().host().id(),true,1,first,false,null,null);
        policies.save(o.server(),settings); policies.dispatch(o.server(),first.minusSeconds(1)); assertThat(hosts.jobs(o.server(),0,100).total()).isZero();
        hosts.revoke(o.issued().host().id()); policies.dispatch(o.server(),first.plusSeconds(1)); assertThat(hosts.jobs(o.server(),0,100).total()).isZero();
        assertThat(policies.list(o.server()).getFirst().lastOutcome()).isEqualTo("HOST_REVOKED");
    }
    @Test void countRotationDeletesActualAutomaticFilesAndPreservesProtectedFinalManualAndOtherServers() throws Exception {
        Owner o=owner(),other=owner(); var oldest=ready(o,"AUTOMATIC",false,20); var keep=ready(o,"AUTOMATIC",false,2);
        BackupService.Backup protectedBackup=ready(o,"AUTOMATIC",true,30),manual=ready(o,"MANUAL",false,40),finalBackup=ready(o,"FINAL",false,50),foreign=ready(other,"AUTOMATIC",false,60);
        backups.edit(finalBackup.id(),new BackupController.Metadata("最终封存不参与轮换",false));
        var pending=backups.reserve(o.server(),new BackupController.Reservation(UUID.randomUUID(),"AUTOMATIC","未成功不能轮换",false,"8"));
        policies.save(o.server(),settings(o,0,false,1,null)); var preview=policies.preview(o.server(),1,null,Instant.now());
        assertThat(preview).extracting(BackupPolicies.Candidate::id).containsExactly(oldest.id());
        policies.run(Instant.now()); assertThat(backups.find(oldest.id()).status()).isEqualTo("DELETED"); assertThat(Files.exists(object(oldest.id()))).isFalse();
        for(var value:List.of(keep,protectedBackup,manual,finalBackup,foreign)) {assertThat(backups.find(value.id()).status()).isEqualTo("READY");assertThat(Files.exists(object(value.id()))).isTrue();}
        assertThat(backups.find(pending.id()).status()).isEqualTo("AWAITING_UPLOAD"); assertThat(policies.list(o.server()).getFirst().prunedCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT state FROM backup_retention_events WHERE backup_id=?",String.class,oldest.id())).isEqualTo("DELETED");
        policies.run(Instant.now()); assertThat(policies.list(o.server()).getFirst().prunedCount()).isEqualTo(1);
    }
    @Test void ageOnlyAlwaysPreservesNewestAndRechecksProtectionAndChangedPolicy() throws Exception {
        Owner o=owner(); BackupService.Backup old=ready(o,"AUTOMATIC",false,50),newest=ready(o,"AUTOMATIC",false,20);
        policies.save(o.server(),settings(o,0,false,null,7)); var selected=policies.preview(o.server(),null,7,Instant.now()).getFirst();
        assertThat(selected.id()).isEqualTo(old.id()); backups.edit(old.id(),new BackupController.Metadata("刚标记永久",true));
        policies.prune(o.server(),selected,Instant.now()); assertThat(backups.find(old.id()).status()).isEqualTo("READY");
        backups.edit(old.id(),new BackupController.Metadata("取消永久",false)); policies.save(o.server(),settings(o,1,false,null,null));
        policies.prune(o.server(),selected,Instant.now()); assertThat(backups.find(old.id()).status()).isEqualTo("READY");
        policies.save(o.server(),settings(o,2,false,null,7)); policies.run(Instant.now()); assertThat(backups.find(old.id()).status()).isEqualTo("DELETED");
        assertThat(backups.find(newest.id()).status()).isEqualTo("READY");
    }
    @Test void deletionIntentSurvivesFailureAndNewServiceFinishesWithoutTouchingOtherFiles() throws Exception {
        Owner o=owner(); var old=ready(o,"AUTOMATIC",false,10); ready(o,"AUTOMATIC",false,0); policies.save(o.server(),settings(o,0,false,1,null));
        Path file=object(old.id()),saved=file.resolveSibling(file.getFileName()+".qa-saved"); Files.move(file,saved); Files.createDirectory(file); Files.writeString(file.resolve("hold"),"fixture obstruction");
        policies.run(Instant.now()); assertThat(backups.find(old.id()).status()).isEqualTo("DELETING"); assertThat(policies.list(o.server()).getFirst().cleanupError()).isEqualTo("FILE_DELETE_FAILED");
        Files.delete(file.resolve("hold")); Files.delete(file); Files.move(saved,file);
        var reconstructed=new BackupPolicies(jdbc,transaction,archives,hosts,backups); policies.save(o.server(),settings(o,1,false,null,null));
        reconstructed.run(Instant.now()); assertThat(backups.find(old.id()).status()).isEqualTo("DELETED"); assertThat(Files.exists(file)).isFalse();
        assertThat(policies.list(o.server()).getFirst().cleanupError()).isNull(); assertThat(policies.list(o.server()).getFirst().prunedCount()).isEqualTo(1);
    }
    @Test @WithAnonymousUser void anonymousCannotReadPoliciesOrPreview() throws Exception {
        mvc.perform(get("/api/backup-policies")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/servers/"+UUID.randomUUID()+"/backup-policy/retention-preview")).andExpect(status().isUnauthorized());
    }
}
