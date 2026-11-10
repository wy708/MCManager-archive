package org.mcmanager.archive;

import java.util.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;

@RestController
class SeedMapController {
    private final SeedMapQueries queries;private final AgentCredentials agents;
    SeedMapController(SeedMapQueries queries,AgentCredentials agents){this.queries=queries;this.agents=agents;}
    @PostMapping("/api/agent/servers/{id}/structure-predictions")
    Map<String,Object> structures(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID id,@RequestBody SeedMapQueries.Structures request){
        agents.require(identity,id,AgentCredentials.Scope.WORLD_READ);var result=queries.structures(id,request);agents.require(identity,id,AgentCredentials.Scope.WORLD_READ);return result;
    }
    @GetMapping("/api/agent/servers/{id}/chunk-info")
    Map<String,Object> chunks(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID id,@RequestParam String dimension,@RequestParam int x,@RequestParam int z,@RequestParam(defaultValue="2") int radius){
        agents.require(identity,id,AgentCredentials.Scope.WORLD_READ);var result=queries.chunks(id,dimension,x,z,radius);agents.require(identity,id,AgentCredentials.Scope.WORLD_READ);return result;
    }
}
