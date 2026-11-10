package org.mcmanager.archive;

import java.util.*;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
class ConstructionController {
    private final ConstructionProjects projects; private final AgentCredentials agents;
    ConstructionController(ConstructionProjects projects,AgentCredentials agents){this.projects=projects;this.agents=agents;}
    record CollectorRequest(String playerKey,ConstructionProjects.Request operation){}
    record AgentRequest(String qqId,ConstructionProjects.Request operation){}
    @PostMapping("/api/ingest/v1/projects")
    ConstructionProjects.Receipt collector(@AuthenticationPrincipal CollectorCredentials.Identity identity,@RequestBody CollectorRequest request){return projects.collector(identity,request.playerKey(),request.operation());}
    @PostMapping("/api/agent/servers/{server}/projects")
    ConstructionProjects.Receipt agent(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID server,@RequestBody AgentRequest request){return projects.agent(identity,server,request.qqId(),request.operation());}
    @GetMapping("/api/agent/servers/{server}/projects")
    List<ConstructionProjects.Project> agentList(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID server,@RequestParam(required=false) String name){agents.require(identity,server,AgentCredentials.Scope.WORLD_READ);return projects.list(server,name);}
    @GetMapping("/api/agent/servers/{server}/projects/{id}")
    ConstructionProjects.Detail agentDetail(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID server,@PathVariable UUID id,@RequestParam(required=false) Integer revision){
        agents.require(identity,server,AgentCredentials.Scope.WORLD_READ);TelemetryValidation.check(projects.project(id).serverId().equals(server),"工程不属于此服务器");return projects.detail(id,revision);
    }
    @GetMapping("/api/servers/{server}/projects")
    List<ConstructionProjects.Project> list(@PathVariable UUID server){return projects.list(server);}
    @PostMapping("/api/servers/{server}/projects")
    ConstructionProjects.Receipt admin(@PathVariable UUID server,@RequestBody ConstructionProjects.Request request){return projects.admin(server,request);}
    @DeleteMapping("/api/servers/{server}/projects/{id}")
    ResponseEntity<Void> delete(@PathVariable UUID server,@PathVariable UUID id){projects.delete(server,id);return ResponseEntity.noContent().build();}
    @GetMapping("/api/public/projects/{id}")
    ConstructionProjects.Detail detail(@PathVariable UUID id,@RequestParam(required=false) Integer revision){return projects.detail(id,revision);}
    @GetMapping("/api/public/projects/{id}/phases/{revision}/map.png")
    ResponseEntity<byte[]> image(@PathVariable UUID id,@PathVariable int revision){return ResponseEntity.ok().contentType(MediaType.IMAGE_PNG).cacheControl(CacheControl.noStore()).body(projects.image(id,revision));}
}
