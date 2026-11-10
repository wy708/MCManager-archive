package org.mcmanager.archive;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.transaction.annotation.Transactional;

@RestController
@RequestMapping("/api/servers")
class ArchiveController {
    private final ArchiveRepository repository;
    private final TelemetryQueries queries;
    ArchiveController(ArchiveRepository repository, TelemetryQueries queries) { this.repository = repository; this.queries = queries; }

    record ArchiveInput(@NotBlank @Size(max = 80) String name,
                        @NotNull @Size(max = 2000) String description, @NotNull LocalDate startDate) {}
    record SealInput(@NotNull LocalDate endDate) {}

    @GetMapping
    List<ServerArchive> list() { return repository.list(); }

    @GetMapping("/{id}")
    ServerArchive get(@PathVariable UUID id) {
        return repository.find(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "服务器档案不存在"));
    }

    @PostMapping
    ResponseEntity<ServerArchive> create(@Valid @RequestBody ArchiveInput input) {
        ServerArchive archive = repository.create(input.name().strip(), input.description().strip(), input.startDate());
        return ResponseEntity.created(URI.create("/api/servers/" + archive.id())).body(archive);
    }

    @PutMapping("/{id}")
    @Transactional
    ServerArchive edit(@PathVariable UUID id, @Valid @RequestBody ArchiveInput input) {
        ServerArchive current = repository.lock(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "服务器档案不存在"));
        if (!current.startDate().equals(input.startDate()) && repository.hasTelemetry(id)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "已有采集数据的开服日期不能修改，避免改变历史归档范围");
        }
        if (repository.edit(id, input.name().strip(), input.description().strip(), input.startDate()) != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "开服日期不能晚于封存日期，请刷新后重试");
        }
        return get(id);
    }

    @PostMapping("/{id}/archive")
    @Transactional
    ServerArchive archive(@PathVariable UUID id, @Valid @RequestBody SealInput input) {
        ServerArchive existing = repository.lock(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "服务器档案不存在"));
        if (input.endDate().isBefore(existing.startDate())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "封存日期不能早于开服日期");
        }
        java.time.Instant latest = repository.latestTelemetry(id);
        if (latest != null && latest.isAfter(java.time.Instant.now())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "存在时间超前的数据，请同步采集端时钟并等待该时间后再封存");
        }
        if (latest != null && input.endDate().isBefore(latest.atZone(queries.zone()).toLocalDate())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "封存日期不能早于已经记录的数据");
        }
        if (repository.archive(id, input.endDate()) != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "档案已封存或日期已变更，请刷新后重试");
        }
        return get(id);
    }
}
