package org.mcmanager.archive;

import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/activity")
class ActivityController {
    private final ActivityFeed feed;
    private final CollectorCredentials servers;
    private final boolean automaticCleanupEnabled;
    ActivityController(ActivityFeed feed, CollectorCredentials servers,
                       @Value("${mcmanager.activity-retention-worker-enabled:true}") String workerEnabled) {
        this.feed = feed; this.servers = servers;
        this.automaticCleanupEnabled = Boolean.parseBoolean(workerEnabled);
    }
    @GetMapping
    ActivityFeed.Page read(@RequestParam UUID serverId, @RequestParam(defaultValue = "0") long after,
                          @RequestParam(defaultValue = "100") int limit, @RequestParam(defaultValue = "false") boolean chat,
                          @RequestParam(defaultValue = "false") boolean includeAgents, @RequestParam(required = false) String playerKey) {
        servers.status(serverId);
        return feed.read(serverId, after, limit, chat, includeAgents, playerKey);
    }
    @GetMapping("/sessions/{sessionId}/chat")
    ActivityFeed.SessionChat sessionChat(@PathVariable UUID sessionId, @RequestParam UUID serverId,
                                         @RequestParam(defaultValue = "0") long after,
                                         @RequestParam(defaultValue = "50") int limit) {
        return feed.sessionChat(serverId, sessionId, after, limit);
    }
    record Retention(int days, Integer expectedDays) {}
    record RetentionPolicy(int retentionDays, boolean automaticCleanupEnabled) {}
    @GetMapping("/retention")
    RetentionPolicy retention() { return new RetentionPolicy(feed.retentionDays(), automaticCleanupEnabled); }
    @GetMapping("/retention-preview")
    ActivityFeed.RetentionPreview preview(@RequestParam int days) { return feed.preview(days); }
    @PutMapping("/retention")
    ActivityFeed.RetentionResult retention(@RequestBody Retention request) { return feed.retention(request.days(), request.expectedDays()); }
}
