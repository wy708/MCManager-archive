package org.mcmanager.archive;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

final class TelemetryPayload {
    enum Kind { COUNTER, SESSION, DEATH, CHAT, CONTAINER }
    enum CapabilityState { ACTIVE, DISABLED, UNSUPPORTED, ERROR }
    enum Quality { EXACT, ESTIMATED, OBSERVED }
    enum IdentityType { XUID, UUID }
    enum SessionStart { JOIN, OBSERVED }
    enum SessionEnd { CAPTURE_STOPPED }
    record Player(@NotNull IdentityType identityType, @NotBlank @Size(max = 36) String identity,
                  @NotBlank @Size(max = 80) String name) {
        String key() { return identityType.name().toLowerCase(java.util.Locale.ROOT) + ":" + identity; }
    }
    record Collector(@NotBlank @Size(max = 64) String version, @NotBlank @Size(max = 64) String bdsVersion,
                     @NotBlank @Size(max = 64) String leviLaminaVersion, @NotNull UUID bootId,
                     @Min(0) long pendingEvents, @Valid CollectorDiagnostics diagnostics, @Valid RuntimeSample runtime) {
        Collector(String version,String bdsVersion,String leviLaminaVersion,UUID bootId,long pendingEvents,CollectorDiagnostics diagnostics){this(version,bdsVersion,leviLaminaVersion,bootId,pendingEvents,diagnostics,null);}
    }
    record RuntimeSample(@NotNull @Min(1) Long sequence,@NotNull Instant at,
        @NotNull @Min(1) @Max(604800000) Long windowMillis,@NotNull @Min(0) Long uptimeMillis,
        @NotNull @Min(0) @Max(20000000) Long ticks,@NotNull @Min(0) @Max(100000) Integer players,
        Instant lastTickAt,@NotNull @DecimalMin("0") @DecimalMax("604800000") Double maxTickIntervalMillis,
        @DecimalMin("0") @DecimalMax("100") Double cpuPercent,
        @Min(0) Long workingSetBytes,@Min(0) Long privateBytes,@Min(1) Long hostMemoryTotalBytes,@Min(0) Long hostMemoryAvailableBytes,
        @NotNull Boolean stopped,
        @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) @DecimalMin("0") @DecimalMax("100") Double hostCpuPercent,
        @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) @Min(1) @Max(65536) Integer hostLogicalProcessors,
        @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) @DecimalMin("0") Double hostNetworkReceiveBps,
        @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) @DecimalMin("0") Double hostNetworkSendBps,
        @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL) @Size(max=26) List<@NotNull @Valid HostDisk> hostDisks) {}
    record HostDisk(@NotNull @Pattern(regexp="[A-Z]:") String drive,@NotNull @Min(1) Long totalBytes,@NotNull @Min(0) Long availableBytes) {}
    record CollectorDiagnostics(@NotNull @Min(1) Long sequence, @NotNull @Min(0) @Max(32768) Integer queuedEvents,
                                @NotNull @Min(0) Long rejectedSubmissions, @NotNull @Min(0) Long captureGaps,
                                @NotNull Boolean diskError, @NotNull @Min(0) Long diskFaults,
                                @com.fasterxml.jackson.annotation.JsonProperty("final") @NotNull Boolean finalReport) {}
    record Capability(@NotBlank @Size(max = 64) String metric, @NotNull CapabilityState state,
                      Quality quality, @Size(max = 64) String algorithmVersion, @NotNull Boolean dimensionAware) {}
    record Event(@NotNull UUID eventId, @NotNull Kind kind, @NotNull Instant at,
                 @Valid Player player, @Size(max = 64) String metric, Long value,
                 @Size(max = 80) String dimension, @Size(max = 128) String subject,
                 UUID sessionId, Instant startedAt, Long sequence, Long onlineMillis, Boolean ended,
                 @Size(max = 80) String cause, @Size(max = 128) String killerType,
                 @Size(max = 1024) String text, SessionStart sessionStart, SessionEnd sessionEnd,
                 Instant playerObservedAt, @Valid ContainerAudit.Payload container, @Valid ConstructionProjects.Position position) {}
    record Batch(@Min(1) @Max(1) int protocolVersion, @NotNull UUID batchId, @NotNull Instant reportedAt,
                 @NotNull @Valid Collector collector,
                 @NotNull @Size(max = 64) List<@NotNull @Valid Capability> capabilities,
                 @NotNull @Size(max = 1000) List<@NotNull @Valid Event> events) {}
    record Receipt(UUID batchId, int acceptedEvents, int duplicateEvents, boolean duplicateBatch) {}
    private TelemetryPayload() {}
}
