package org.mcmanager.archive;

import java.time.*;
import java.util.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

@RestController
class WorldQueryController {
    record Boot(UUID bootId) {}
    private final WorldQueries queries;
    private final ActivitySignal signal;
    private final IdlePolls polls;
    WorldQueryController(WorldQueries queries,ActivitySignal signal,IdlePolls polls) { this.queries=queries; this.signal=signal;this.polls=polls; }
    @PostMapping("/api/agent/servers/{server}/world-queries")
    WorldQueries.Query create(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID server,@RequestBody WorldQueries.Request request) {
        var query=queries.create(identity,server,request);
        polls.wake("world:"+server);return waitFor(identity,query.id(),20);
    }
    @GetMapping("/api/agent/world-queries/{id}")
    WorldQueries.Query get(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID id,
            @RequestParam(defaultValue="0") int waitSeconds) {
        TelemetryValidation.check(waitSeconds>=0 && waitSeconds<=25,"等待时间无效");
        return waitFor(identity,id,waitSeconds);
    }
    private WorldQueries.Query waitFor(AgentCredentials.Identity identity,UUID id,int seconds) {
        Instant until=Instant.now().plusSeconds(seconds);
        for(;;) {
            long revision=signal.revision(); var query=queries.get(identity,id);
            if(!Set.of("PENDING","LEASED").contains(query.status()) || !Instant.now().isBefore(until)) return query;
            try { signal.await(revision,Duration.between(Instant.now(),until)); }
            catch(InterruptedException ex) { Thread.currentThread().interrupt(); throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"查询已中断"); }
        }
    }
    @PostMapping("/api/ingest/v1/world-queries/claim")
    Object claim(@AuthenticationPrincipal CollectorCredentials.Identity identity,@RequestBody Boot boot) {
        return polls.poll("world:"+identity.serverId(),()->queries.claim(identity,boot.bootId()),List::isEmpty);
    }
    @GetMapping("/api/agent/servers/{server}/players/{key}/world-snapshot")
    Map<String,Object> lastPlayer(@AuthenticationPrincipal AgentCredentials.Identity identity,@PathVariable UUID server,@PathVariable String key) {
        var snapshot=queries.lastPlayer(identity,server,key);
        return snapshot==null?Map.of("status","NO_RECORD"):Map.of("status","HISTORY","snapshot",snapshot);
    }
    @PostMapping("/api/ingest/v1/world-queries/{id}/complete")
    WorldQueries.Query complete(@AuthenticationPrincipal CollectorCredentials.Identity identity,@PathVariable UUID id,
            @RequestBody WorldQueries.Observation result) { return queries.complete(identity,id,result); }
    @PostMapping("/api/ingest/v1/world-queries/player-snapshots")
    Map<String,Boolean> snapshots(@AuthenticationPrincipal CollectorCredentials.Identity identity,@RequestBody WorldQueries.Snapshots snapshots) {
        queries.snapshots(identity,snapshots); return Map.of("accepted",true);
    }
}
