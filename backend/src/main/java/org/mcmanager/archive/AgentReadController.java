package org.mcmanager.archive;

import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.AgentCredentials.*;
import static org.mcmanager.archive.TelemetryValidation.*;

@RestController
@RequestMapping("/api/agent")
class AgentReadController {
    private final AgentCredentials agents;
    private final AgentQueries queries;
    private final ActivityFeed feed;
    private final ActivitySignal signal;
    AgentReadController(AgentCredentials agents, AgentQueries queries, ActivityFeed feed, ActivitySignal signal) {
        this.agents = agents; this.queries = queries; this.feed = feed; this.signal = signal;
    }
    @GetMapping("/servers") List<AgentQueries.AllowedServer> servers(@AuthenticationPrincipal Identity identity) { return queries.servers(identity); }
    @GetMapping("/servers/{server}/status") TelemetryQueries.CollectorStatus status(@AuthenticationPrincipal Identity identity, @PathVariable UUID server) { return queries.status(identity, server); }
    @GetMapping("/servers/{server}/players") TelemetryQueries.Page<AgentQueries.ScopedPlayer> players(@AuthenticationPrincipal Identity identity, @PathVariable UUID server,
            @RequestParam(defaultValue = "1") int page, @RequestParam(defaultValue = "25") int pageSize) { return queries.players(identity, server, page, pageSize); }
    @GetMapping("/servers/{server}/players/{key}/context") AgentQueries.Context context(@AuthenticationPrincipal Identity identity, @PathVariable UUID server, @PathVariable String key) { return queries.context(identity, server, key); }
    @GetMapping("/servers/{server}/statistics") Object statistics(@AuthenticationPrincipal Identity identity, @PathVariable UUID server,
            @RequestParam(required = false) String playerKey,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate fromDate,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate toDate,
            @RequestParam(required = false) String dimension, @RequestParam(defaultValue = "false") boolean daily) {
        var filter = new TelemetryQueries.Filter(server, playerKey, fromDate, toDate, dimension);
        return daily ? queries.daily(identity, filter) : queries.summary(identity, filter);
    }
    @GetMapping("/servers/{server}/statistics/{view:breakdown|ranking}") Object statisticDetails(@AuthenticationPrincipal Identity identity,
            @PathVariable UUID server, @PathVariable String view, @RequestParam String metric,
            @RequestParam(required = false) String playerKey,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate fromDate,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate toDate,
            @RequestParam(required = false) String dimension, @RequestParam(required = false) String category,
            @RequestParam(defaultValue = "1") int page, @RequestParam(defaultValue = "25") int pageSize) {
        var filter = new TelemetryQueries.Filter(server, playerKey, fromDate, toDate, dimension);
        return view.equals("ranking") ? queries.ranking(identity, filter, metric, category, page, pageSize)
                : queries.breakdown(identity, filter, metric, category, page, pageSize);
    }
    @GetMapping("/servers/{server}/activity") ActivityFeed.Page activity(@AuthenticationPrincipal Identity identity, @PathVariable UUID server,
            @RequestParam(defaultValue = "0") long after, @RequestParam(defaultValue = "100") int limit,
            @RequestParam(defaultValue = "false") boolean chat, @RequestParam(defaultValue = "false") boolean includeAgents,
            @RequestParam(defaultValue = "0") int waitSeconds, @RequestParam(required = false) String playerKey) {
        check(waitSeconds >= 0 && waitSeconds <= 25, "等待时间须为 0-25 秒");
        Scope scope = chat ? Scope.CHAT_READ : Scope.STATS_READ;
        Instant until = Instant.now().plusSeconds(waitSeconds);
        while (true) {
            long revision = signal.revision();
            agents.require(identity, server, scope);
            var page = feed.read(server, after, limit, chat, includeAgents, playerKey);
            agents.require(identity, server, scope);
            if (!page.items().isEmpty() || !Instant.now().isBefore(until)) return page;
            after = Long.parseLong(page.nextCursor());
            try { signal.await(revision, Duration.between(Instant.now(), until)); }
            catch (InterruptedException ex) { Thread.currentThread().interrupt(); throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "等待已中断"); }
        }
    }
}
