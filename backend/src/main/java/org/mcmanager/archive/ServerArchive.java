package org.mcmanager.archive;

import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

record ServerArchive(UUID id, String name, String description, LocalDate startDate,
                     LocalDate endDate, String status, Instant createdAt, Instant updatedAt) {}
