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
import org.springframework.web.server.ResponseStatusException;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:restore_test;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1","mcmanager.admin-password=test-admin-password-2026"})
@AutoConfigureMockMvc @WithMockUser(roles="ADMIN")
class RestoreIntegrationTest {
    @TempDir static Path directory;
    @DynamicPropertySource static void storage(DynamicPropertyRegistry r){r.add("mcmanager.backup-directory",()->directory.resolve("store").toString());}
    @Autowired JdbcTemplate jdbc;
    @Autowired ArchiveRepository archives;
    @Autowired BackupHosts hosts;
    @Autowired BackupService backups;
    @Autowired BackupPolicies policies;
    @Autowired CollectorCredentials collectors;
    @Autowired RestoreJobs restores;
    @Autowired ObjectMapper json;
    @Autowired MockMvc mvc;
    record Owner(UUID server,BackupHosts.Issued issued,BackupHosts.Identity identity,UUID run,BackupService.Backup backup,byte[] bytes){}
    @BeforeEach void clear(){for(String table:List.of("restore_attempts","restore_jobs","backup_retention_events","backup_job_attempts","backup_jobs","backup_policies","backup_hosts","game_backups","collector_credentials","server_archives"))jdbc.update("DELETE FROM "+table);}
    byte[] archive(UUID server) throws Exception {
        Path folder=Files.createDirectory(directory.resolve(UUID.randomUUID().toString())),file=folder.resolve("fixture.tar.gz");
        Process child=new ProcessBuilder("node",Path.of("../backup/qa/create-upload-fixture.mjs").toAbsolutePath().normalize().toString(),folder.toString(),server.toString(),file.toString(),"--large").redirectErrorStream(true).start();
        assertThat(child.waitFor(40,TimeUnit.SECONDS)).isTrue();assertThat(child.exitValue()).describedAs(new String(child.getInputStream().readAllBytes())).isZero();return Files.readAllBytes(file);
    }
    BackupService.Backup upload(UUID server,byte[] bytes){var reservation=backups.reserve(server,new BackupController.Reservation(UUID.randomUUID(),"AUTOMATIC","恢复协议文件，不是游戏验收",false,Integer.toString(bytes.length)));return backups.upload(reservation.id(),new ByteArrayInputStream(bytes),bytes.length);}
    Owner owner() throws Exception {
        UUID server=archives.create("恢复协议夹具","not gameplay",LocalDate.of(2020,1,1)).id();var issued=hosts.create(server,"恢复测试主机");var identity=hosts.authenticate("Bearer "+issued.token());UUID run=UUID.randomUUID();
        hosts.heartbeat(identity,new HostController.Heartbeat(run,"RUNNING","0.4.0-qa",true));byte[] bytes=archive(server);return new Owner(server,issued,identity,run,upload(server,bytes),bytes);
    }
    RestoreController.Request request(Owner o,String mode,String folder){return new RestoreController.Request(UUID.randomUUID(),o.issued().host().id(),mode,folder,"核对恢复",mode.equals("FORK")?"新的周目":null,mode.equals("FORK")?LocalDate.now():null);}
    RestoreJobs.Job create(Owner o,String mode,String folder){return restores.create(o.backup().id(),request(o,mode,folder));}
    RestoreJobs.Claim claim(Owner o){return restores.claim(o.identity(),new HostController.ClaimRequest(o.run(),UUID.randomUUID()));}
    HostController.Lease lease(Owner o,RestoreJobs.Claim c){return new HostController.Lease(o.run(),c.attemptId());}
    RestoreController.Ready receipt(Owner o,RestoreJobs.Claim c){var j=c.job();return new RestoreController.Ready(o.run(),c.attemptId(),UUID.randomUUID(),j.sourceBackupId(),j.targetServerId(),j.mode(),j.destinationName(),j.archiveSha256(),j.fileCount());}
    void expire(RestoreJobs.Claim c){jdbc.update("UPDATE restore_attempts SET lease_until=? WHERE id=?",OffsetDateTime.now().minusMinutes(5),c.attemptId());}
    @Test void worldRestoreRequiresCapableHostAndNeverCreatesCollectorFork() throws Exception {
        Owner o=owner();
        var summary=(com.fasterxml.jackson.databind.node.ObjectNode)o.backup().summary().deepCopy(); summary.put("archiveScope","WORLD");
        jdbc.update("UPDATE game_backups SET summary_json=? WHERE id=?",summary.toString(),o.backup().id());
        assertThatThrownBy(()->create(o,"DISABLED","old_host")).isInstanceOf(ResponseStatusException.class).hasMessageContaining("0.7.0");
        hosts.heartbeat(o.identity(),new HostController.Heartbeat(o.run(),"RUNNING","0.7.0",true));
        assertThatThrownBy(()->create(o,"FORK","no_fork")).isInstanceOf(ResponseStatusException.class).hasMessageContaining("世界存档");
        assertThatThrownBy(()->create(o,"CONTINUE","no_continue")).isInstanceOf(ResponseStatusException.class).hasMessageContaining("世界存档");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM server_archives",Integer.class)).isEqualTo(1);
        create(o,"DISABLED","world_only");
        hosts.heartbeat(o.identity(),new HostController.Heartbeat(o.run(),"RUNNING","0.6.0",true));
        assertThat(claim(o)).isNull();
        hosts.heartbeat(o.identity(),new HostController.Heartbeat(o.run(),"RUNNING","0.7.0",true));
        assertThat(claim(o)).isNotNull();
    }
    String token(UUID server){byte[] bytes=new byte[32];new java.security.SecureRandom().nextBytes(bytes);return server+"."+Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);}
    @Test void concurrentForkRetryCreatesOneTargetAndDirectoryRequestIsImmutable() throws Exception {
        Owner o=owner();var request=request(o,"FORK","新一期检查");var pool=Executors.newFixedThreadPool(5);var ids=new HashSet<UUID>();
        try{var work=new ArrayList<Callable<RestoreJobs.Job>>();for(int i=0;i<8;i++)work.add(()->restores.create(o.backup().id(),request));for(var future:pool.invokeAll(work))ids.add(future.get(10,TimeUnit.SECONDS).targetServerId());}finally{pool.shutdownNow();}
        assertThat(ids).hasSize(1).doesNotContain(o.server());assertThat(archives.list()).hasSize(2);assertThat(restores.list(o.server(),0,20).total()).isEqualTo(1);
        var changed=new RestoreController.Request(request.requestId(),request.hostId(),"FORK","另一个目录",request.note(),request.forkName(),request.forkStartDate());
        assertThatThrownBy(()->restores.create(o.backup().id(),changed)).isInstanceOf(ResponseStatusException.class).hasMessageContaining("另一恢复任务");
        hosts.revoke(o.issued().host().id());assertThat(restores.create(o.backup().id(),request).status()).isEqualTo("CANCELLED");
    }
    @Test void directoryNamesAreSinglePortableSegmentsAndCannotReuseEarlierTargets() throws Exception {
        Owner o=owner();for(String invalid:List.of("../old","C:\\world","/root","CON","aux","a.","a b","e\u0301"))assertThatThrownBy(()->create(o,"DISABLED",invalid)).isInstanceOf(ResponseStatusException.class);
        create(o,"DISABLED","Restore_A");assertThatThrownBy(()->create(o,"DISABLED","restore_a")).isInstanceOf(ResponseStatusException.class).hasMessageContaining("已被使用");
        assertThatThrownBy(()->restores.create(o.backup().id(),new RestoreController.Request(UUID.randomUUID(),o.issued().host().id(),"DISABLED","other","", "不能改名",LocalDate.now()))).isInstanceOf(ResponseStatusException.class);
    }
    @Test void legacyHostIsNotAllowedToRestoreButCanStillExecuteBackups() throws Exception {
        Owner o=owner();create(o,"DISABLED","等待升级");hosts.heartbeat(o.identity(),new HostController.Heartbeat(o.run(),"RUNNING","0.3.0"));
        assertThat(claim(o)).isNull();assertThatThrownBy(()->create(o,"DISABLED","不支持")).isInstanceOf(ResponseStatusException.class);
        hosts.enqueue(o.server(),new HostController.JobRequest(UUID.randomUUID(),o.issued().host().id(),"MANUAL","旧宿主回归",false));
        assertThat(hosts.claim(o.identity(),new HostController.ClaimRequest(o.run(),UUID.randomUUID()))).isNotNull();
    }
    @Test void restorePinsRealArchiveAgainstManualAndAutomaticDeletion() throws Exception {
        Owner o=owner();jdbc.update("UPDATE game_backups SET created_at=? WHERE id=?",OffsetDateTime.now().minusDays(10),o.backup().id());upload(o.server(),archive(o.server()));
        var j=create(o,"DISABLED","占用保护");assertThatThrownBy(()->backups.delete(o.backup().id())).isInstanceOf(ResponseStatusException.class).hasMessageContaining("用于恢复");
        policies.save(o.server(),new BackupPolicyController.Settings(0,o.issued().host().id(),false,60,null,true,1,null));policies.run(Instant.now());assertThat(backups.find(o.backup().id()).status()).isEqualTo("READY");
        restores.cancel(j.id());policies.run(Instant.now());assertThat(backups.find(o.backup().id()).status()).isEqualTo("DELETED");assertThat(restores.find(j.id()).archiveSha256()).isEqualTo(o.backup().sha256());
    }
    @Test void claimedAndStartedExpiryHaveDifferentRecoverySemantics() throws Exception {
        Owner o=owner();var j=create(o,"DISABLED","恢复中断");UUID request=UUID.randomUUID();var first=restores.claim(o.identity(),new HostController.ClaimRequest(o.run(),request));
        expire(first);assertThat(restores.find(j.id()).status()).isEqualTo("QUEUED");assertThat(restores.claim(o.identity(),new HostController.ClaimRequest(o.run(),request)).active()).isFalse();
        var next=claim(o);assertThat(next.attemptId()).isNotEqualTo(first.attemptId());restores.start(o.identity(),j.id(),lease(o,next));expire(next);
        assertThat(restores.find(j.id()).status()).isEqualTo("UNCERTAIN");assertThat(claim(o)).isNull();assertThatThrownBy(()->backups.delete(o.backup().id())).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(()->restores.ready(o.identity(),j.id(),receipt(o,next),false)).isInstanceOf(ResponseStatusException.class);
        var recovered=restores.ready(o.identity(),j.id(),receipt(o,next),true);assertThat(recovered.status()).isEqualTo("READY");assertThat(recovered.worldRuntimeVerified()).isFalse();
    }
    @Test void backupAndRestoreAttemptsExcludeEachOtherAndCancellationIsNotInstantCompletion() throws Exception {
        Owner o=owner();var j=create(o,"DISABLED","互斥任务");var b=hosts.enqueue(o.server(),new HostController.JobRequest(UUID.randomUUID(),o.issued().host().id(),"MANUAL","维护备份",false));
        var c=claim(o);assertThat(hosts.claim(o.identity(),new HostController.ClaimRequest(o.run(),UUID.randomUUID()))).isNull();restores.start(o.identity(),j.id(),lease(o,c));
        assertThat(restores.cancel(j.id()).status()).isEqualTo("RUNNING");assertThat(restores.find(j.id()).cancelRequested()).isTrue();
        restores.report(o.identity(),j.id(),new RestoreController.Report(o.run(),c.attemptId(),"CANCELLED","OPERATOR_CANCELLED"));
        var backupClaim=hosts.claim(o.identity(),new HostController.ClaimRequest(o.run(),UUID.randomUUID()));assertThat(backupClaim.job().id()).isEqualTo(b.id());
        create(o,"DISABLED","第二个任务");assertThat(claim(o)).isNull();
    }
    @Test void contentIsScopedAndRevocationDuringReadStopsFurtherBytes() throws Exception {
        Owner o=owner(),other=owner();var j=create(o,"DISABLED","读取围栏");var c=claim(o);
        assertThatThrownBy(()->restores.own(other.identity(),j.id())).isInstanceOf(ResponseStatusException.class).hasMessageContaining("不存在");
        assertThatThrownBy(()->restores.content(o.identity(),j.id(),lease(o,c))).isInstanceOf(ResponseStatusException.class);
        restores.start(o.identity(),j.id(),lease(o,c));
        try(var stream=restores.content(o.identity(),j.id(),lease(o,c)).stream()) {
            assertThat(stream.readNBytes(1048576)).hasSize(1048576);hosts.revoke(o.issued().host().id());
            assertThatThrownBy(()->stream.read()).isInstanceOf(ResponseStatusException.class);
        }
        assertThat(restores.find(j.id()).status()).isEqualTo("UNCERTAIN");assertThat(backups.find(o.backup().id()).status()).isEqualTo("READY");
    }
    @Test void receiptIsImmutableAndReadinessDoesNotClaimGameValidation() throws Exception {
        Owner o=owner();var j=create(o,"DISABLED","已准备");var c=claim(o);restores.start(o.identity(),j.id(),lease(o,c));var receipt=receipt(o,c);
        var wrong=new RestoreController.Ready(o.run(),c.attemptId(),receipt.restorationId(),j.sourceBackupId(),j.targetServerId(),j.mode(),"wrong",j.archiveSha256(),j.fileCount());
        assertThatThrownBy(()->restores.ready(o.identity(),j.id(),wrong,false)).isInstanceOf(ResponseStatusException.class);
        assertThat(restores.ready(o.identity(),j.id(),receipt,false).worldRuntimeVerified()).isFalse();backups.delete(o.backup().id());assertThat(restores.ready(o.identity(),j.id(),receipt,false).status()).isEqualTo("READY");
        assertThatThrownBy(()->restores.ready(o.identity(),j.id(),receipt(o,c),false)).isInstanceOf(ResponseStatusException.class);
    }
    @Test void fastTransferCannotBypassAuthorizationChecksAfterOneChunk() throws Exception {
        Owner o=owner();var j=create(o,"DISABLED","传输中撤销");var c=claim(o);restores.start(o.identity(),j.id(),lease(o,c));long[] written={0};
        try(var stream=restores.content(o.identity(),j.id(),lease(o,c)).stream()) {
            OutputStream sink=new OutputStream(){
                @Override public void write(int value){throw new AssertionError("bulk writes expected");}
                @Override public void write(byte[] bytes,int offset,int length){written[0]+=length;if(written[0]>=1048576)hosts.revoke(o.issued().host().id());}
            };
            assertThatThrownBy(()->stream.transferTo(sink)).isInstanceOf(ResponseStatusException.class);assertThat(written[0]).isEqualTo(1048576);
        }
    }
    @Test void continueRequiresSameActiveArchiveStoppedRuntimeAndCurrentCredential() throws Exception {
        Owner o=owner();var credential=collectors.rotate(o.server());var j=create(o,"CONTINUE","继续原期");assertThat(claim(o)).isNull();
        hosts.heartbeat(o.identity(),new HostController.Heartbeat(o.run(),"STOPPED","0.4.0-qa",true));var c=claim(o);restores.start(o.identity(),j.id(),lease(o,c));
        assertThatThrownBy(()->restores.ready(o.identity(),j.id(),receipt(o,c),false)).isInstanceOf(ResponseStatusException.class).hasMessageContaining("采集凭据");
        restores.collector(o.identity(),j.id(),new RestoreController.Credential(o.run(),c.attemptId(),credential.token()));
        var result=restores.ready(o.identity(),j.id(),receipt(o,c),false);assertThat(result.targetServerId()).isEqualTo(o.server());assertThat(result.statisticsPolicy()).contains("PRESERVE_CENTRAL_HISTORY");
        archives.archive(o.server(),LocalDate.now());assertThatThrownBy(()->create(o,"CONTINUE","不能继续")).isInstanceOf(ResponseStatusException.class);
    }
    @Test void continueCredentialRotationAndUnexpectedRunningStateFenceReadiness() throws Exception {
        Owner o=owner();var credential=collectors.rotate(o.server());create(o,"CONTINUE","变化围栏");hosts.heartbeat(o.identity(),new HostController.Heartbeat(o.run(),"STOPPED","0.4.0-qa",true));var c=claim(o);restores.start(o.identity(),c.job().id(),lease(o,c));
        restores.collector(o.identity(),c.job().id(),new RestoreController.Credential(o.run(),c.attemptId(),credential.token()));collectors.rotate(o.server());
        assertThatThrownBy(()->restores.ready(o.identity(),c.job().id(),receipt(o,c),false)).isInstanceOf(ResponseStatusException.class).hasMessageContaining("采集凭据");
        hosts.heartbeat(o.identity(),new HostController.Heartbeat(o.run(),"RUNNING","0.4.0-qa",true));assertThatThrownBy(()->restores.content(o.identity(),c.job().id(),lease(o,c))).isInstanceOf(ResponseStatusException.class);
    }
    @Test void forkCredentialIsBoundToNewTargetAndNeverReturnedOrStoredInPlaintext() throws Exception {
        Owner o=owner();var j=create(o,"FORK","凭据隔离");var c=claim(o);restores.start(o.identity(),j.id(),lease(o,c));String token=token(j.targetServerId());
        restores.collector(o.identity(),j.id(),new RestoreController.Credential(o.run(),c.attemptId(),token));restores.collector(o.identity(),j.id(),new RestoreController.Credential(o.run(),c.attemptId(),token));
        assertThat(collectors.authenticate("Bearer "+token).serverId()).isEqualTo(j.targetServerId());assertThat(json.writeValueAsString(restores.list(null,0,20))).doesNotContain(token);
        assertThat(jdbc.queryForObject("SELECT collector_hash FROM restore_jobs WHERE id=?",String.class,j.id())).isEqualTo(CollectorCredentials.hash(token.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        assertThatThrownBy(()->restores.collector(o.identity(),j.id(),new RestoreController.Credential(o.run(),c.attemptId(),token(j.targetServerId())))).isInstanceOf(ResponseStatusException.class);
        restores.ready(o.identity(),j.id(),receipt(o,c),false);hosts.revoke(o.issued().host().id());assertThat(collectors.authenticate("Bearer "+token).serverId()).isEqualTo(j.targetServerId());
    }
    @Test void cancelledForkRevokesOnlyItsOwnProposedCredentialAndNeverAnAdminReplacement() throws Exception {
        Owner o=owner();var j=create(o,"FORK","取消新期");var c=claim(o);restores.start(o.identity(),j.id(),lease(o,c));String original=token(j.targetServerId());
        restores.collector(o.identity(),j.id(),new RestoreController.Credential(o.run(),c.attemptId(),original));restores.cancel(j.id());assertThatThrownBy(()->collectors.authenticate("Bearer "+original)).isInstanceOf(ResponseStatusException.class);
        restores.report(o.identity(),j.id(),new RestoreController.Report(o.run(),c.attemptId(),"CANCELLED","OPERATOR_CANCELLED"));
        var other=create(o,"FORK","管理员轮换");var d=claim(o);restores.start(o.identity(),other.id(),lease(o,d));restores.collector(o.identity(),other.id(),new RestoreController.Credential(o.run(),d.attemptId(),token(other.targetServerId())));
        var replacement=collectors.rotate(other.targetServerId());restores.cancel(other.id());assertThat(collectors.authenticate("Bearer "+replacement.token()).serverId()).isEqualTo(other.targetServerId());
    }
    @Test void rotationCannotClearPriorCancellationAndOperatorResolutionKeepsHistory() throws Exception {
        Owner o=owner();var j=create(o,"DISABLED","撤销后核对");var c=claim(o);restores.start(o.identity(),j.id(),lease(o,c));hosts.revoke(o.issued().host().id());var next=hosts.rotate(o.issued().host().id());
        var identity=hosts.authenticate("Bearer "+next.token());UUID run=UUID.randomUUID();hosts.heartbeat(identity,new HostController.Heartbeat(run,"STOPPED","0.4.0-qa",true));
        assertThat(restores.find(j.id()).cancelRequested()).isTrue();var original=receipt(o,c);var recovery=new RestoreController.Ready(run,c.attemptId(),original.restorationId(),j.sourceBackupId(),j.targetServerId(),j.mode(),j.destinationName(),j.archiveSha256(),j.fileCount());
        assertThatThrownBy(()->restores.ready(identity,j.id(),recovery,true)).isInstanceOf(ResponseStatusException.class);assertThat(restores.claim(identity,new HostController.ClaimRequest(run,UUID.randomUUID()))).isNull();
        assertThat(restores.resolve(j.id(),new HostController.Resolution("FAILED","已核对原目录，保留诊断")).resolutionNote()).contains("保留诊断");backups.delete(o.backup().id());assertThat(restores.find(j.id()).status()).isEqualTo("FAILED");
    }
    @Test @WithAnonymousUser void machineCannotUseAdminEndpointsAndContentUsesOnlyOriginalJob() throws Exception {
        Owner o=owner();var j=create(o,"DISABLED","实际HTTP");String bearer="Bearer "+o.issued().token();var c=claim(o);restores.start(o.identity(),j.id(),lease(o,c));
        mvc.perform(get("/api/restores").header("Authorization",bearer)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/backups/"+o.backup().id()+"/content").header("Authorization",bearer)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/host/v1/restores/"+j.id()+"/content").header("Authorization",bearer).header("X-Host-Run",o.run()).header("X-Restore-Attempt",c.attemptId()))
                .andExpect(status().isOk()).andExpect(content().bytes(o.bytes())).andExpect(header().string("X-Archive-SHA256",o.backup().sha256()));
        mvc.perform(get("/api/host/v1/restores/"+j.id()+"/content").header("Authorization",bearer).header("X-Host-Run",o.run()).header("X-Restore-Attempt",UUID.randomUUID())).andExpect(status().isConflict());
    }
    @Test void adminMutationRequiresCsrfAndInvalidFieldsDoNotCreateTargetArchives() throws Exception {
        Owner o=owner();var request=request(o,"FORK","测试目录");
        mvc.perform(post("/api/backups/"+o.backup().id()+"/restores").contentType("application/json").content(json.writeValueAsString(request))).andExpect(status().isForbidden());
        var invalid=new RestoreController.Request(UUID.randomUUID(),request.hostId(),request.mode(),request.destinationName(),request.note(),request.forkName(),null);
        mvc.perform(post("/api/backups/"+o.backup().id()+"/restores").with(csrf()).contentType("application/json").content(json.writeValueAsString(invalid))).andExpect(status().isBadRequest());assertThat(archives.list()).hasSize(1);
        mvc.perform(post("/api/backups/"+o.backup().id()+"/restores").with(csrf()).contentType("application/json").content(json.writeValueAsString(request))).andExpect(status().isCreated());
        assertThat(archives.list()).hasSize(2);
    }
    @Test void stoppedGameDoesNotAllowTakingOverAnActiveMaintenanceRestore() throws Exception {
        Owner o=owner();hosts.heartbeat(o.identity(),new HostController.Heartbeat(o.run(),"STOPPED","0.4.0-qa",true));var j=create(o,"DISABLED","维护互斥");var c=claim(o);restores.start(o.identity(),j.id(),lease(o,c));
        UUID other=UUID.randomUUID();assertThatThrownBy(()->hosts.heartbeat(o.identity(),new HostController.Heartbeat(other,"STOPPED","0.4.0-qa",true))).isInstanceOf(ResponseStatusException.class).hasMessageContaining("另一运行实例");
        restores.report(o.identity(),j.id(),new RestoreController.Report(o.run(),c.attemptId(),"FAILED","RESTORE_FAILED"));
        assertThat(hosts.heartbeat(o.identity(),new HostController.Heartbeat(other,"STOPPED","0.4.0-qa",true)).runnerId()).isEqualTo(other);
    }
    @Test void adminMayAssignIndependentCopyToAnotherHostWithoutGrantingUnrelatedAccess() throws Exception {
        Owner source=owner(),target=owner();var request=new RestoreController.Request(UUID.randomUUID(),target.issued().host().id(),"DISABLED","迁移检查","",null,null);
        var j=restores.create(source.backup().id(),request);var c=claim(target);assertThat(c.job().id()).isEqualTo(j.id());restores.start(target.identity(),j.id(),lease(target,c));
        try(var stream=restores.content(target.identity(),j.id(),lease(target,c)).stream()){assertThat(stream.readAllBytes()).isEqualTo(source.bytes());}
        assertThatThrownBy(()->restores.own(source.identity(),j.id())).isInstanceOf(ResponseStatusException.class).hasMessageContaining("不存在");
        var wrong=new RestoreController.Request(UUID.randomUUID(),target.issued().host().id(),"CONTINUE","错误绑定","",null,null);
        assertThatThrownBy(()->restores.create(source.backup().id(),wrong)).isInstanceOf(ResponseStatusException.class);
    }
}
