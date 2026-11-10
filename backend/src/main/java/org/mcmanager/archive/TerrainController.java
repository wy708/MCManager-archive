package org.mcmanager.archive;

import java.util.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;

@RestController
class TerrainController {
    private final TerrainQueries terrain;
    private final AgentCredentials agents;
    TerrainController(TerrainQueries terrain,AgentCredentials agents){this.terrain=terrain;this.agents=agents;}
    @GetMapping("/api/servers/{id}/terrain-profile")
    Map<String,Object> settings(@PathVariable UUID id){return terrain.settings(id);}
    @PutMapping("/api/servers/{id}/terrain-profile")
    Map<String,Object> save(@PathVariable UUID id,@RequestBody TerrainQueries.Input input){return terrain.save(id,input);}
    @PostMapping("/api/agent/servers/{id}/terrain-prediction")
    Map<String,Object> direct(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID id,
        @RequestBody TerrainQueries.PredictionRequest request) {
        agents.require(identity,id,AgentCredentials.Scope.WORLD_READ);
        var result=terrain.predict(id,request);
        agents.require(identity,id,AgentCredentials.Scope.WORLD_READ);
        return result;
    }
    @GetMapping({"/api/agent/servers/{id}/terrain-prediction","/api/servers/{id}/terrain-prediction"})
    Map<String,Object> predict(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID id,
        @RequestParam String dimension,@RequestParam int x,@RequestParam(defaultValue="64") int y,@RequestParam int z,
        @RequestParam(defaultValue="64") int radius,@RequestParam(defaultValue="16") int step,
        jakarta.servlet.http.HttpServletRequest request) {
        boolean agent=request.getRequestURI().startsWith("/api/agent/");
        if(agent) agents.require(identity,id,AgentCredentials.Scope.WORLD_READ);
        var result=terrain.predict(id,new TerrainQueries.Coordinates(dimension,x,y,z,radius,step));
        if(agent) agents.require(identity,id,AgentCredentials.Scope.WORLD_READ);
        return result;
    }
    @GetMapping({"/api/agent/servers/{id}/recorded-environment","/api/servers/{id}/recorded-environment"})
    Map<String,Object> recorded(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID id,
        @RequestParam String dimension,@RequestParam int x,@RequestParam int y,@RequestParam int z,
        @RequestParam(defaultValue="32") int radius,jakarta.servlet.http.HttpServletRequest request) {
        boolean agent=request.getRequestURI().startsWith("/api/agent/");
        if(agent) agents.require(identity,id,AgentCredentials.Scope.WORLD_READ);
        var result=terrain.recorded(id,dimension,x,y,z,radius);
        if(agent) agents.require(identity,id,AgentCredentials.Scope.WORLD_READ);
        return result;
    }
}
