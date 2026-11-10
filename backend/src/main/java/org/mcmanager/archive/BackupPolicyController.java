package org.mcmanager.archive;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.Instant;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
class BackupPolicyController {
    record Settings(@Min(0) long revision,@NotNull UUID hostId,boolean enabled,@Min(1) @Max(43200) int intervalMinutes,
                    Instant firstRunAt,boolean retentionEnabled,@Min(1) @Max(1000) Integer keepCount,@Min(1) @Max(3650) Integer maxAgeDays,
                    @Pattern(regexp="(?:[01][0-9]|2[0-3]):[0-5][0-9]") String dailyTime) {
        Settings(long revision,UUID hostId,boolean enabled,int intervalMinutes,Instant firstRunAt,boolean retentionEnabled,Integer keepCount,Integer maxAgeDays) {
            this(revision,hostId,enabled,intervalMinutes,firstRunAt,retentionEnabled,keepCount,maxAgeDays,null);
        }
    }
    private final BackupPolicies policies;
    BackupPolicyController(BackupPolicies policies) { this.policies=policies; }
    @GetMapping("/backup-policies") Object list(@RequestParam(required=false) UUID serverId) { return policies.list(serverId); }
    @PutMapping("/servers/{id}/backup-policy") Object save(@PathVariable UUID id,@Valid @RequestBody Settings request) { return policies.save(id,request); }
    @GetMapping("/servers/{id}/backup-policy/retention-preview") Object preview(@PathVariable UUID id,@RequestParam(required=false) Integer keepCount,@RequestParam(required=false) Integer maxAgeDays) {
        return policies.previewSummary(id,keepCount,maxAgeDays,Instant.now());
    }
}
