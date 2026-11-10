package org.mcmanager.archive;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
@RestController
class ServerRuntimeController {
    private final ServerRuntime runtime;private final AgentCredentials agents;
    ServerRuntimeController(ServerRuntime runtime,AgentCredentials agents){this.runtime=runtime;this.agents=agents;}
    @GetMapping("/api/servers/{server}/runtime")
    ServerRuntime.Report admin(@PathVariable UUID server,@RequestParam(defaultValue="24") int hours){return runtime.read(server,hours);}
    @GetMapping("/api/agent/servers/{server}/runtime")
    ServerRuntime.Report agent(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID server,@RequestParam(defaultValue="24") int hours){agents.require(identity,server,AgentCredentials.Scope.STATS_READ);return runtime.read(server,hours);}
}
