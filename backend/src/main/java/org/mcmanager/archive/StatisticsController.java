package org.mcmanager.archive;

import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;
import static org.mcmanager.archive.TelemetryQueries.*;

@RestController
class StatisticsController {
    private final TelemetryQueries queries;
    StatisticsController(TelemetryQueries queries) { this.queries = queries; }
    @GetMapping("/api/metrics") Collection<MetricCatalog.Metric> metrics() { return MetricCatalog.ALL.values(); }
    @GetMapping("/api/statistics/summary") Summary summary(@ModelAttribute Filter filter) { return queries.summary(filter); }
    @GetMapping("/api/statistics/daily") List<DailyPoint> daily(@ModelAttribute Filter filter) { return queries.daily(filter); }
    @GetMapping("/api/statistics/servers") List<Contribution> contributions(@ModelAttribute Filter filter) { return queries.contributions(filter); }
    @GetMapping("/api/statistics/dimensions") List<DimensionPoint> dimensions(@ModelAttribute Filter filter,
            @RequestParam(defaultValue = "online.millis") String metric) { return queries.dimensions(filter, metric); }
    @GetMapping("/api/statistics/breakdown") Page<Breakdown> breakdown(@ModelAttribute Filter filter, @RequestParam String metric,
            @RequestParam(required = false) String category, @RequestParam(defaultValue = "1") int page, @RequestParam(defaultValue = "25") int pageSize) {
        return queries.breakdown(filter, metric, category, page, pageSize);
    }
    @GetMapping("/api/players") Page<PlayerRow> players(@ModelAttribute Filter filter, @RequestParam(required = false) String search,
            @RequestParam(defaultValue = "1") int page, @RequestParam(defaultValue = "25") int pageSize) { return queries.players(filter, search, page, pageSize); }
    @GetMapping("/api/players/{key}") PlayerProfile profile(@PathVariable String key) { return queries.profile(key); }
    @GetMapping("/api/deaths") Page<Death> deaths(@ModelAttribute Filter filter, @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "25") int pageSize) { return queries.deaths(filter, page, pageSize); }
    @GetMapping("/api/collectors") List<CollectorStatus> collectors(@RequestParam(required = false) UUID serverId) { return queries.collectors(serverId); }
    @GetMapping("/api/sessions") Page<Session> sessions(@ModelAttribute Filter filter, @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "25") int pageSize) { return queries.sessions(filter, page, pageSize); }
}
