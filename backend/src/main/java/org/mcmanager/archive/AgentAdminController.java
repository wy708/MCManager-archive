package org.mcmanager.archive;

import java.util.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/agents")
class AgentAdminController {
    record Create(String name, List<AgentCredentials.Grant> grants) {}
    record Grants(List<AgentCredentials.Grant> grants) {}
    private final AgentCredentials agents;
    AgentAdminController(AgentCredentials agents) { this.agents = agents; }
    @GetMapping List<AgentCredentials.Account> list() { return agents.list(); }
    @PostMapping AgentCredentials.Issued create(@RequestBody Create request) { return agents.create(request.name(), request.grants()); }
    @PutMapping("/{id}/grants") AgentCredentials.Account grants(@PathVariable UUID id, @RequestBody Grants request) { return agents.update(id, request.grants()); }
    @PostMapping("/{id}/rotate") AgentCredentials.Issued rotate(@PathVariable UUID id) { return agents.rotate(id); }
    @DeleteMapping("/{id}") ResponseEntity<Void> revoke(@PathVariable UUID id) { agents.revoke(id); return ResponseEntity.noContent().build(); }
}
