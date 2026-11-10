package org.mcmanager.archive;
import java.time.Instant;
import java.util.UUID;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
@RestController
class ConstructionHistoryController {
    private final ConstructionHistory history;
    ConstructionHistoryController(ConstructionHistory history){this.history=history;}
    @GetMapping("/api/public/projects/{id}/phases/{revision}/scene/history")
    ResponseEntity<ConstructionHistory.Frames> list(@PathVariable UUID id,@PathVariable int revision,@RequestParam(required=false) Instant before){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(history.list(id,revision,before));}
}
