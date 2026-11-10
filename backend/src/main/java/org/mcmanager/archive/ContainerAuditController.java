package org.mcmanager.archive;

import java.time.Instant;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
class ContainerAuditController {
    private final AgentCredentials agents;
    private final ContainerAudit audit;
    ContainerAuditController(AgentCredentials agents, ContainerAudit audit) { this.agents=agents; this.audit=audit; }
    @GetMapping("/api/agent/servers/{server}/container-history")
    ContainerAudit.History history(@AuthenticationPrincipal AgentCredentials.Identity identity, @PathVariable UUID server,
            @RequestParam String dimension, @RequestParam int x, @RequestParam int y, @RequestParam int z,
            @RequestParam(defaultValue="0") int radius,
            @RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(required=false) Long before, @RequestParam(defaultValue="50") int limit,
            @RequestParam(required=false) String playerKey) {
        agents.require(identity,server,AgentCredentials.Scope.WORLD_READ);
        var result=audit.read(server,dimension,x,y,z,radius,from,to,before,limit,playerKey);
        agents.require(identity,server,AgentCredentials.Scope.WORLD_READ);
        return result;
    }
}
