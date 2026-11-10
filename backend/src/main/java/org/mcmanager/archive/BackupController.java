package org.mcmanager.archive;

import java.io.IOException;
import java.util.UUID;
import java.time.Instant;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.core.io.InputStreamResource;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
class BackupController {
    record Reservation(@NotNull UUID requestId, @NotNull @Pattern(regexp = "MANUAL|AUTOMATIC|FINAL") String kind,
                       @NotNull @Size(max = 1000) String note, boolean permanent,
                       @NotNull @Pattern(regexp = "[1-9][0-9]{0,12}") String expectedBytes) {}
    record Metadata(@NotNull @Size(max = 1000) String note, @NotNull Boolean permanent) {}
    private final BackupService backups;
    BackupController(BackupService backups) { this.backups = backups; }

    @GetMapping("/backups")
    Object list(@RequestParam(required = false) UUID serverId, @RequestParam(defaultValue = "0") int page,
                @RequestParam(defaultValue = "20") int size, @RequestParam(required = false) String state,
                @RequestParam(required = false) String kind, @RequestParam(required = false) Instant from,
                @RequestParam(required = false) Instant to) { return backups.list(serverId, page, size, state, kind, from, to); }
    @GetMapping("/backups/groups") Object groups() { return backups.groups(); }

    @GetMapping("/backups/{id}") Object get(@PathVariable UUID id) { return backups.find(id); }

    @PostMapping("/servers/{serverId}/backups")
    ResponseEntity<?> reserve(@PathVariable UUID serverId, @Valid @RequestBody Reservation request) {
        return ResponseEntity.status(201).body(backups.reserve(serverId, request));
    }
    record Summary(long readyCount) {}
    @GetMapping("/backups/summary")
    Summary summary(@RequestParam(required = false) UUID serverId) { return new Summary(backups.readyCount(serverId)); }
    @GetMapping("/backups/storage")
    BackupService.Storage storage() { return backups.storageStatus(); }
    @PutMapping(value = "/backups/{id}/content", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    Object upload(@PathVariable UUID id, HttpServletRequest request) throws IOException {
        return backups.upload(id, request.getInputStream(), request.getContentLengthLong());
    }
    @PutMapping("/backups/{id}")
    Object edit(@PathVariable UUID id, @Valid @RequestBody Metadata request) { return backups.edit(id, request); }

    @DeleteMapping("/backups/{id}")
    ResponseEntity<?> delete(@PathVariable UUID id) { backups.delete(id); return ResponseEntity.noContent().build(); }

    @GetMapping("/backups/{id}/content")
    ResponseEntity<InputStreamResource> download(@PathVariable UUID id) throws IOException {
        var download = backups.download(id);
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_OCTET_STREAM).contentLength(download.bytes())
                .cacheControl(CacheControl.noStore())
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"mcmanager-" + id + ".tar.gz\"")
                .header("X-Archive-SHA256", download.sha256())
                .body(new InputStreamResource(download.stream()));
    }
}
