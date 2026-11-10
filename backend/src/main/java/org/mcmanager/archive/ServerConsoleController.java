package org.mcmanager.archive;

import java.security.Principal;
import java.time.Instant;
import java.util.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
class ServerConsoleController {
    record Request(@NotNull UUID requestId, @NotNull UUID hostId, @NotNull UUID runId,
        @NotNull @Pattern(regexp="COMMAND|START|STOP|RESTART") String action,
        @NotNull @Size(max=1000) String command) {}
    record Line(@Min(1) long sequence, @NotNull Instant observedAt, @NotNull @Size(max=2000) String line) {}
    record Receipt(@NotNull UUID id, @NotNull @Pattern(regexp="SUBMITTED|SUCCEEDED|FAILED|UNCERTAIN") String status,
        @NotNull @Size(max=250) String message) {}
    record Sync(@NotNull UUID runId, @NotNull @Pattern(regexp="STARTING|RUNNING|STOPPING|STOPPED|ERROR|DISCONNECTED") String state,
        @Positive Long pid, @NotNull @Size(max=100) List<@NotNull @Valid Line> lines, @Valid Receipt receipt) {}
    private final ServerConsoles consoles;
    private final IdlePolls polls;
    ServerConsoleController(ServerConsoles consoles,IdlePolls polls) { this.consoles=consoles;this.polls=polls; }
    @GetMapping("/api/servers/{server}/console") Object view(@PathVariable UUID server, @RequestParam(defaultValue="0") long after) {
        return consoles.view(server,after);
    }
    @PostMapping("/api/servers/{server}/console/commands") Object command(@PathVariable UUID server, @Valid @RequestBody Request request, Principal principal) {
        var result=consoles.enqueue(server,request,principal.getName());polls.wake("console:"+request.hostId());return result;
    }
    @PostMapping("/api/host/v1/console/sync") Object sync(@AuthenticationPrincipal BackupHosts.Identity identity, @Valid @RequestBody Sync request) {
        return polls.poll("console:"+identity.hostId(),()->consoles.sync(identity,request),value->value.command()==null&&request.lines().isEmpty()&&request.receipt()==null&&Set.of("RUNNING","STOPPED").contains(request.state()),4);
    }
}
