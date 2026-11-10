package org.mcmanager.archive;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
@RestController
class ExplorationController {
    private final ExplorationStatistics statistics;
    private final ExplorationDetails details;
    ExplorationController(ExplorationStatistics statistics,ExplorationDetails details){this.statistics=statistics;this.details=details;}
    @GetMapping("/api/statistics/exploration/extended")
    ResponseEntity<ExplorationDetails.Snapshot> extended(@RequestParam UUID serverId,
        @RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate from,
        @RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate to){
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(details.get(serverId,from,to));
    }
    @GetMapping("/api/statistics/exploration")
    ResponseEntity<ExplorationStatistics.Snapshot> get(@RequestParam UUID serverId,
        @RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate from,
        @RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate to){
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(statistics.get(serverId,from,to));
    }
}
