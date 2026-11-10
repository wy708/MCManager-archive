package org.mcmanager.archive;

import java.util.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
class ReplyController {
    record Claim(UUID bootId) {}
    record Begin(UUID leaseId, UUID bootId) {}
    private final ReplyQueue queue;
    private final IdlePolls polls;
    ReplyController(ReplyQueue queue,IdlePolls polls) { this.queue = queue;this.polls=polls; }
    @PostMapping("/api/agent/servers/{server}/replies") ReplyQueue.Reply send(@AuthenticationPrincipal AgentCredentials.Identity identity,
            @PathVariable UUID server, @RequestBody ReplyQueue.Request request) { var reply=queue.enqueue(identity, server, request);polls.wake("reply:"+server);return reply; }
    @GetMapping("/api/agent/replies/{id}") ReplyQueue.Reply status(@AuthenticationPrincipal AgentCredentials.Identity identity, @PathVariable UUID id) { return queue.status(identity, id); }
    @PostMapping("/api/ingest/v1/commands/claim") Object claim(@AuthenticationPrincipal CollectorCredentials.Identity identity, @RequestBody Claim request) { return polls.poll("reply:"+identity.serverId(),()->queue.claim(identity, request.bootId()),List::isEmpty); }
    @PostMapping("/api/ingest/v1/commands/{id}/begin") ReplyQueue.Begin begin(@AuthenticationPrincipal CollectorCredentials.Identity identity,
            @PathVariable UUID id, @RequestBody Begin request) { return queue.begin(identity, id, request.leaseId(), request.bootId()); }
    @PostMapping("/api/ingest/v1/commands/{id}/ack") ReplyQueue.Reply ack(@AuthenticationPrincipal CollectorCredentials.Identity identity,
            @PathVariable UUID id, @RequestBody ReplyQueue.Acknowledgement request) { return queue.acknowledge(identity, id, request); }
}
