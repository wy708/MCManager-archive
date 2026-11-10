package org.mcmanager.archive;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.List;
import java.util.ArrayList;
import java.nio.charset.StandardCharsets;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
class TelemetryController {
    private final CollectorCredentials credentials;
    private final TelemetryService service;
    private final ObjectMapper mapper;
    TelemetryController(CollectorCredentials credentials, TelemetryService service, ObjectMapper mapper) {
        this.credentials = credentials; this.service = service; this.mapper = mapper;
    }
    @GetMapping("/api/servers/{serverId}/collector-credential")
    Map<String, Object> credentialStatus(@PathVariable UUID serverId) { return credentials.status(serverId); }
    @PostMapping("/api/servers/{serverId}/collector-credential")
    CollectorCredentials.Issued rotate(@PathVariable UUID serverId) { return credentials.rotate(serverId); }
    @DeleteMapping("/api/servers/{serverId}/collector-credential")
    ResponseEntity<Void> revoke(@PathVariable UUID serverId) { credentials.revoke(serverId); return ResponseEntity.noContent().build(); }
    @PostMapping(value = "/api/ingest/v1/batches", consumes = "application/json")
    TelemetryPayload.Receipt ingest(@AuthenticationPrincipal CollectorCredentials.Identity identity, HttpServletRequest request) throws IOException {
        byte[] bytes = request.getInputStream().readNBytes(1_048_577);
        if (bytes.length > 1_048_576) throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "批次不能超过 1 MiB");
        TelemetryPayload.Batch batch;
        try { batch = mapper.readValue(bytes, TelemetryPayload.Batch.class); }
        catch (JsonProcessingException ex) { throw TelemetryValidation.bad("采集 JSON 格式或字段无效"); }
        TelemetryValidation.check(batch != null, "采集批次不能为空");
        return service.ingest(identity, batch, bytes);
    }

    record Bulk(List<String> batches) {}
    @PostMapping(value = "/api/ingest/v1/batches/bulk", consumes = "application/json")
    List<TelemetryPayload.Receipt> bulk(@AuthenticationPrincipal CollectorCredentials.Identity identity, HttpServletRequest request) throws IOException {
        byte[] bytes = request.getInputStream().readNBytes(1_048_577);
        if (bytes.length > 1_048_576) throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "补传请求不能超过 1 MiB");
        Bulk input;
        try { input = mapper.readValue(bytes, Bulk.class); }
        catch (JsonProcessingException ex) { throw TelemetryValidation.bad("补传 JSON 格式无效"); }
        TelemetryValidation.check(input != null && input.batches() != null && !input.batches().isEmpty() && input.batches().size() <= 16, "每次补传需要 1 至 16 个原始批次");
        var bodies = new ArrayList<byte[]>();
        var batches = new ArrayList<TelemetryPayload.Batch>();
        int events = 0;
        for (String body : input.batches()) {
            TelemetryValidation.check(body != null, "原始批次不能为空");
            // Original UTF-8 JSON is carried as a string, preserving its byte hash.
            byte[] original = body.getBytes(StandardCharsets.UTF_8);
            TelemetryPayload.Batch batch;
            try { batch = mapper.readValue(original, TelemetryPayload.Batch.class); }
            catch (JsonProcessingException ex) { throw TelemetryValidation.bad("原始批次 JSON 格式无效"); }
            TelemetryValidation.check(batch != null && batch.events() != null, "原始批次不能为空");
            events += batch.events().size();
            TelemetryValidation.check(events <= 512, "每次补传最多 512 条事件");
            bodies.add(original); batches.add(batch);
        }
        // One bounded transaction; a failure rolls back this group. Collector 0.35
        // safely falls back to original single-batch delivery when a group fails.
        return service.ingestBulk(identity, batches, bodies);
    }
}
