package org.mcmanager.archive;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;

@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "mcmanager.activity-retention-worker-enabled", havingValue = "true", matchIfMissing = true)
class ActivityRetentionWorker {
    private final ActivityFeed feed;
    ActivityRetentionWorker(ActivityFeed feed) { this.feed = feed; }

    @Scheduled(initialDelayString = "${mcmanager.activity-retention-tick-ms:15000}",
               fixedDelayString = "${mcmanager.activity-retention-tick-ms:15000}")
    void tick() { feed.pruneExpired(); }
}
