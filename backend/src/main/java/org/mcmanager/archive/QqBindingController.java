package org.mcmanager.archive;

import java.util.UUID;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
class QqBindingController {
    private final QqBindings bindings;
    private final AgentQueries queries;
    QqBindingController(QqBindings bindings, AgentQueries queries) { this.bindings=bindings; this.queries=queries; }
    @PostMapping("/api/ingest/v1/qq-binding-codes")
    QqBindings.CodeReceipt issue(@AuthenticationPrincipal CollectorCredentials.Identity identity, @RequestBody QqBindings.CodeRequest request) {
        return bindings.issue(identity,request);
    }
    @GetMapping("/api/agent/servers/{server}/qq-bindings/{qqId}")
    QqBindings.State get(@AuthenticationPrincipal AgentCredentials.Identity identity, @PathVariable UUID server, @PathVariable String qqId) {
        return bindings.get(identity,server,qqId);
    }
    @PostMapping("/api/agent/servers/{server}/qq-bindings")
    QqBindings.State bind(@AuthenticationPrincipal AgentCredentials.Identity identity, @PathVariable UUID server, @RequestBody QqBindings.Claim request) {
        return bindings.bind(identity,server,request);
    }
    @PostMapping("/api/agent/servers/{server}/qq-bindings/{qqId}/unbind")
    QqBindings.State unbind(@AuthenticationPrincipal AgentCredentials.Identity identity, @PathVariable UUID server,
            @PathVariable String qqId, @RequestBody QqBindings.Unbind request) {
        return bindings.unbind(identity,server,qqId,request);
    }
    @GetMapping("/api/agent/servers/{server}/qq-bindings/{qqId}/context")
    AgentQueries.Context context(@AuthenticationPrincipal AgentCredentials.Identity identity, @PathVariable UUID server, @PathVariable String qqId) {
        var state=bindings.get(identity,server,qqId);
        TelemetryValidation.check(state.bound(),"该 QQ 尚未绑定游戏角色");
        return queries.context(identity,server,state.binding().playerKey());
    }
}
