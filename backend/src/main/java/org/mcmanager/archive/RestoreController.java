package org.mcmanager.archive;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.io.IOException;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController @RequestMapping("/api")
class RestoreController {
    record Request(@NotNull UUID requestId,@NotNull UUID hostId,@NotNull @Pattern(regexp="DISABLED|CONTINUE|FORK") String mode,
                   @NotBlank @Size(max=64) String destinationName,@NotNull @Size(max=1000) String note,@Size(max=64) String forkName,LocalDate forkStartDate) {}
    record Report(@NotNull UUID runId,@NotNull UUID attemptId,@NotNull @Pattern(regexp="FAILED|UNCERTAIN|CANCELLED") String outcome,
                  @NotNull @Pattern(regexp="DOWNLOAD_FAILED|ARCHIVE_INVALID|DESTINATION_EXISTS|RESTORE_FAILED|EXECUTION_INTERRUPTED|COLLECTOR_REJECTED|OPERATOR_CANCELLED") String code) {}
    record Credential(@NotNull UUID runId,@NotNull UUID attemptId,@NotNull @Size(max=128) String collectorToken) {}
    record Ready(@NotNull UUID runId,@NotNull UUID attemptId,@NotNull UUID restorationId,@NotNull UUID sourceBackupId,@NotNull UUID targetServerId,
                 @NotNull @Pattern(regexp="DISABLED|CONTINUE|FORK") String mode,@NotNull @Size(max=64) String destinationName,@NotNull @Pattern(regexp="[a-f0-9]{64}") String sha256,@Min(1) int fileCount) {}
    private final RestoreJobs jobs;
    RestoreController(RestoreJobs jobs){this.jobs=jobs;}
    @GetMapping("/restores") Object list(@RequestParam(required=false) UUID serverId,@RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="20") int size){return jobs.list(serverId,page,size);}
    @GetMapping("/restores/{id}") Object find(@PathVariable UUID id){return jobs.find(id);}
    @PostMapping("/backups/{id}/restores") ResponseEntity<?> create(@PathVariable UUID id,@Valid @RequestBody Request request){return ResponseEntity.status(201).body(jobs.create(id,request));}
    @PostMapping("/restores/{id}/cancel") Object cancel(@PathVariable UUID id){return jobs.cancel(id);}
    @PostMapping("/restores/{id}/resolve") Object resolve(@PathVariable UUID id,@Valid @RequestBody HostController.Resolution request){return jobs.resolve(id,request);}
    @PostMapping("/host/v1/restores/claim") ResponseEntity<?> claim(@AuthenticationPrincipal BackupHosts.Identity identity,@Valid @RequestBody HostController.ClaimRequest request){var value=jobs.claim(identity,request);return value==null?ResponseEntity.noContent().build():ResponseEntity.ok(value);}
    @GetMapping("/host/v1/restores/{id}") Object own(@AuthenticationPrincipal BackupHosts.Identity identity,@PathVariable UUID id){return jobs.own(identity,id);}
    @PostMapping("/host/v1/restores/{id}/start") Object start(@AuthenticationPrincipal BackupHosts.Identity identity,@PathVariable UUID id,@Valid @RequestBody HostController.Lease request){return jobs.start(identity,id,request);}
    @PostMapping("/host/v1/restores/{id}/renew") Object renew(@AuthenticationPrincipal BackupHosts.Identity identity,@PathVariable UUID id,@Valid @RequestBody HostController.Lease request){return jobs.renew(identity,id,request);}
    @PostMapping("/host/v1/restores/{id}/report") Object report(@AuthenticationPrincipal BackupHosts.Identity identity,@PathVariable UUID id,@Valid @RequestBody Report request){return jobs.report(identity,id,request);}
    @PostMapping("/host/v1/restores/{id}/collector") Object collector(@AuthenticationPrincipal BackupHosts.Identity identity,@PathVariable UUID id,@Valid @RequestBody Credential request){return jobs.collector(identity,id,request);}
    @PostMapping("/host/v1/restores/{id}/ready") Object ready(@AuthenticationPrincipal BackupHosts.Identity identity,@PathVariable UUID id,@Valid @RequestBody Ready request){return jobs.ready(identity,id,request,false);}
    @PostMapping("/host/v1/restores/{id}/recover") Object recover(@AuthenticationPrincipal BackupHosts.Identity identity,@PathVariable UUID id,@Valid @RequestBody Ready request){return jobs.ready(identity,id,request,true);}
    @GetMapping("/host/v1/restores/{id}/content") ResponseEntity<?> content(@AuthenticationPrincipal BackupHosts.Identity identity,@PathVariable UUID id,@RequestHeader("X-Host-Run") UUID runId,@RequestHeader("X-Restore-Attempt") UUID attemptId) throws IOException {
        var value=jobs.content(identity,id,new HostController.Lease(runId,attemptId));
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_OCTET_STREAM).contentLength(value.bytes()).header("Cache-Control","no-store")
                .header("Content-Disposition","attachment; filename=\"restore-"+id+".tar.gz\"").header("X-Archive-SHA256",value.sha256()).body(new InputStreamResource(value.stream()));
    }
}
