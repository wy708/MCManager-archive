package org.mcmanager.archive;

import java.time.Instant;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;

@Configuration
@EnableScheduling
@ConditionalOnProperty(name="mcmanager.backup-policy-worker-enabled",havingValue="true",matchIfMissing=true)
class BackupPolicyWorker {
    private final BackupPolicies policies;
    BackupPolicyWorker(BackupPolicies policies) { this.policies=policies; }
    @Scheduled(initialDelayString="${mcmanager.backup-policy-tick-ms:15000}",fixedDelayString="${mcmanager.backup-policy-tick-ms:15000}")
    void tick() {
        try { policies.run(Instant.now()); }
        catch(RuntimeException ex) { LoggerFactory.getLogger(BackupPolicyWorker.class).error("Backup policy worker could not complete its state check ({})",ex.getClass().getSimpleName()); }
    }
}
