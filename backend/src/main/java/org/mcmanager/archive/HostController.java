package org.mcmanager.archive;

import java.io.IOException;
import java.util.UUID;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
class HostController {
    record Create(@NotNull UUID serverId, @NotBlank @Size(max=64) String name) {}
    record Heartbeat(@NotNull UUID runId, @NotNull @Pattern(regexp="STARTING|RUNNING|STOPPED|ERROR") String state,
                     @NotNull @Pattern(regexp="[0-9A-Za-z.+-]{1,64}") String version, boolean restoreEnabled) {
        Heartbeat(UUID runId,String state,String version) { this(runId,state,version,false); }
    }
    record JobRequest(@NotNull UUID requestId, @NotNull UUID hostId, @NotNull @Pattern(regexp="MANUAL|AUTOMATIC|FINAL") String kind,
                      @NotNull @Size(max=1000) String note, boolean permanent) {}
    record ClaimRequest(@NotNull UUID runId, @NotNull UUID requestId) {}
    record Lease(@NotNull UUID runId, @NotNull UUID attemptId) {}
    record Artifact(@NotNull UUID runId, @NotNull UUID attemptId, @NotNull UUID sourceBackupId,
                    @NotNull @Pattern(regexp="[a-f0-9]{64}") String sha256, @NotNull @Pattern(regexp="[1-9][0-9]{0,12}") String bytes) {}
    record Report(@NotNull UUID runId, @NotNull UUID attemptId,
                  @NotNull @Pattern(regexp="FAILED|UNCERTAIN|CANCELLED") String outcome,
                  @NotNull @Pattern(regexp="CAPTURE_FAILED|UPLOAD_FAILED|EXECUTION_INTERRUPTED|LOCAL_ARCHIVE_INVALID|OPERATOR_CANCELLED") String code) {}
    record Resolution(@NotNull @Pattern(regexp="FAILED|CANCELLED") String outcome, @NotBlank @Size(max=1000) String note) {}
    private final BackupHosts hosts;
    private final IdlePolls polls;
    HostController(BackupHosts hosts,IdlePolls polls) { this.hosts = hosts;this.polls=polls; }

    @GetMapping("/backup-hosts") Object hosts(@RequestParam(required=false) UUID serverId) { return hosts.hosts(serverId); }
    @PostMapping("/backup-hosts") ResponseEntity<?> create(@Valid @RequestBody Create request) { return ResponseEntity.status(201).body(hosts.create(request.serverId(), request.name())); }
    @PostMapping("/backup-hosts/{id}/rotate") Object rotate(@PathVariable UUID id) { return hosts.rotate(id); }
    @DeleteMapping("/backup-hosts/{id}") ResponseEntity<?> revoke(@PathVariable UUID id) { hosts.revoke(id); return ResponseEntity.noContent().build(); }
    @GetMapping("/backup-jobs") Object jobs(@RequestParam(required=false) UUID serverId, @RequestParam(defaultValue="0") int page,
                                           @RequestParam(defaultValue="20") int size) { return hosts.jobs(serverId, page, size); }
    @GetMapping("/backup-jobs/{id}") Object job(@PathVariable UUID id) { return hosts.find(id); }
    @PostMapping("/servers/{id}/backup-jobs") ResponseEntity<?> enqueue(@PathVariable UUID id, @Valid @RequestBody JobRequest request) {
        var job=hosts.enqueue(id, request);polls.wake("backup:"+request.hostId());return ResponseEntity.status(201).body(job);
    }
    @PostMapping("/backup-jobs/{id}/cancel") Object cancel(@PathVariable UUID id) { return hosts.cancel(id); }
    @PostMapping("/backup-jobs/{id}/resolve") Object resolve(@PathVariable UUID id, @Valid @RequestBody Resolution request) { return hosts.resolve(id, request); }

    @PostMapping("/host/v1/heartbeat") Object heartbeat(@AuthenticationPrincipal BackupHosts.Identity identity, @Valid @RequestBody Heartbeat request) {
        return hosts.heartbeat(identity, request);
    }
    @GetMapping("/host/v1/jobs/{id}") Object own(@AuthenticationPrincipal BackupHosts.Identity identity, @PathVariable UUID id) { return hosts.own(identity, id); }
    @PostMapping("/host/v1/jobs/claim") Object claim(@AuthenticationPrincipal BackupHosts.Identity identity, @Valid @RequestBody ClaimRequest request) {
        return polls.poll("backup:"+identity.hostId(),()->{var value=hosts.claim(identity,request);return value==null?ResponseEntity.noContent().build():ResponseEntity.ok(value);},value->value.getStatusCode().value()==204,4);
    }
    @PostMapping("/host/v1/jobs/{id}/start") Object start(@AuthenticationPrincipal BackupHosts.Identity identity, @PathVariable UUID id, @Valid @RequestBody Lease request) {
        return hosts.start(identity, id, request);
    }
    @PostMapping("/host/v1/jobs/{id}/renew") Object renew(@AuthenticationPrincipal BackupHosts.Identity identity, @PathVariable UUID id, @Valid @RequestBody Lease request) {
        return hosts.renew(identity, id, request);
    }
    @PostMapping("/host/v1/jobs/{id}/report") Object report(@AuthenticationPrincipal BackupHosts.Identity identity, @PathVariable UUID id, @Valid @RequestBody Report request) {
        return hosts.report(identity, id, request);
    }
    @PostMapping("/host/v1/jobs/{id}/artifact") Object artifact(@AuthenticationPrincipal BackupHosts.Identity identity, @PathVariable UUID id, @Valid @RequestBody Artifact request) {
        return hosts.prepare(identity, id, request, false);
    }
    @PostMapping("/host/v1/jobs/{id}/recover") Object recover(@AuthenticationPrincipal BackupHosts.Identity identity, @PathVariable UUID id, @Valid @RequestBody Artifact request) {
        return hosts.prepare(identity, id, request, true);
    }
    @PutMapping(value="/host/v1/jobs/{id}/content", consumes=MediaType.APPLICATION_OCTET_STREAM_VALUE)
    Object upload(@AuthenticationPrincipal BackupHosts.Identity identity, @PathVariable UUID id, @RequestHeader("X-Host-Run") UUID runId,
                  @RequestHeader("X-Backup-Attempt") UUID attemptId, HttpServletRequest request) throws IOException {
        return hosts.upload(identity, id, runId, attemptId, request.getInputStream(), request.getContentLengthLong());
    }
}
