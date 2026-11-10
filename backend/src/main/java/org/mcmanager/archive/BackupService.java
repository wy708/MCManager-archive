package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.*;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@Service
class BackupService {
    record Backup(UUID id, UUID serverId, UUID sourceBackupId, String kind, String status, String note, boolean permanent,
                  String expectedBytes, String receivedBytes, String archiveBytes, String sourceBytes, Integer fileCount,
                  String sha256, String failureCode, Instant snapshotAt, Instant createdAt, Instant updatedAt,
                  JsonNode summary, boolean worldRuntimeVerified, boolean interrupted) {}
    record Page(List<Backup> items, long total, int page, int size, String maxUploadBytes) {}
    record Download(InputStream stream, long bytes, String sha256) {}
    record Volume(String totalBytes, String usableBytes) {}
    record Storage(long readyCount, String readyArchiveBytes, String maxUploadBytes, Volume volume) {}
    record Group(UUID serverId, long total, long readyCount, String archiveBytes, Instant latestReadyAt) {}
    private record Stored(Backup view, UUID requestId, UUID attemptId, Instant leaseAt) {}
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ObjectMapper json;
    private final ArchiveRepository archives;
    private final Path configuredRoot, verifier;
    private final String node;
    private final long maxUploadBytes, expandedLimit;
    private final int verifierSeconds;
    private final Semaphore uploads = new Semaphore(1);
    private volatile Path root;

    BackupService(JdbcTemplate jdbc, TransactionTemplate transaction, ObjectMapper json, ArchiveRepository archives,
                  @Value("${mcmanager.backup-directory:./data/backups}") String directory,
                  @Value("${mcmanager.backup-node:node}") String node,
                  @Value("${mcmanager.backup-verifier:../backup/src/verify-upload.mjs}") String verifier,
                  @Value("${mcmanager.backup-max-upload-bytes:17179869184}") long maxUploadBytes,
                  @Value("${mcmanager.backup-expanded-limit:137438953472}") long expandedLimit,
                  @Value("${mcmanager.backup-verifier-seconds:600}") int verifierSeconds) {
        this.jdbc = jdbc; this.transaction = transaction; this.json = json; this.archives = archives;
        this.configuredRoot = Path.of(directory).toAbsolutePath().normalize(); this.node = node;
        this.verifier = Path.of(verifier).toAbsolutePath().normalize();
        this.maxUploadBytes = maxUploadBytes; this.expandedLimit = expandedLimit; this.verifierSeconds = verifierSeconds;
        if (maxUploadBytes < 1 || expandedLimit < 1 || verifierSeconds < 1) throw new IllegalArgumentException("Invalid backup storage limits");
    }
    private static ResponseStatusException error(HttpStatus status, String message) { return new ResponseStatusException(status, message); }
    private static OffsetDateTime now() { return OffsetDateTime.now(ZoneOffset.UTC); }
    private JsonNode parse(String value) {
        if (value == null) return null;
        try { return json.readTree(value); } catch (IOException ex) { throw error(HttpStatus.SERVICE_UNAVAILABLE, "备份记录暂时无法读取"); }
    }
    private static Instant instant(ResultSet rs, String name) throws SQLException {
        OffsetDateTime value = rs.getObject(name, OffsetDateTime.class); return value == null ? null : value.toInstant();
    }
    private static String number(ResultSet rs, String name) throws SQLException { Object value = rs.getObject(name); return value == null ? null : value.toString(); }
    private Stored row(ResultSet rs, int index) throws SQLException {
        return new Stored(new Backup(rs.getObject("id", UUID.class), rs.getObject("server_id", UUID.class), rs.getObject("source_backup_id", UUID.class),
                rs.getString("kind"), rs.getString("status"), rs.getString("note"), rs.getBoolean("permanent"),
                number(rs, "expected_bytes"), number(rs, "received_bytes"), number(rs, "archive_bytes"), number(rs, "source_bytes"),
                rs.getObject("file_count", Integer.class), rs.getString("sha256"), rs.getString("failure_code"),
                instant(rs, "snapshot_at"), instant(rs, "created_at"), instant(rs, "updated_at"), parse(rs.getString("summary_json")), false,
                Set.of("RECEIVING", "VERIFYING").contains(rs.getString("status")) && expired(instant(rs, "lease_at"))),
                rs.getObject("request_id", UUID.class), rs.getObject("attempt_id", UUID.class), instant(rs, "lease_at"));
    }
    private static boolean expired(Instant lease) { return lease == null || lease.isBefore(Instant.now().minus(Duration.ofMinutes(15))); }
    private Stored stored(UUID id, boolean lock) {
        return jdbc.query("SELECT * FROM game_backups WHERE id = ?" + (lock ? " FOR UPDATE" : ""), this::row, id).stream().findFirst()
                .orElseThrow(() -> error(HttpStatus.NOT_FOUND, "备份记录不存在"));
    }
    Backup find(UUID id) { return stored(id, false).view(); }
    Backup lockForRestore(UUID id) {
        Backup value=stored(id,true).view();
        if(!value.status().equals("READY") || value.sourceBackupId()==null || value.sha256()==null || value.fileCount()==null || value.summary()==null)
            throw error(HttpStatus.CONFLICT,"只能恢复已经校验且可用的完整归档");
        return value;
    }
    Page list(UUID serverId, int page, int size) {
        return list(serverId, page, size, null, null, null, null);
    }
    List<Group> groups() {
        return jdbc.query("SELECT server_id,COUNT(*) AS total,SUM(CASE WHEN status='READY' THEN 1 ELSE 0 END) AS ready,"
                + "COALESCE(SUM(CASE WHEN status='READY' THEN archive_bytes ELSE 0 END),0) AS bytes,"
                + "MAX(CASE WHEN status='READY' THEN COALESCE(snapshot_at,created_at) END) AS latest FROM game_backups WHERE status<>'DELETED' GROUP BY server_id",
                (rs,n)->new Group(rs.getObject("server_id",UUID.class),rs.getLong("total"),rs.getLong("ready"),rs.getBigDecimal("bytes").toBigIntegerExact().toString(),instant(rs,"latest")));
    }
    Page list(UUID serverId, int page, int size, String state, String kind, Instant from, Instant to) {
        if (page < 0 || page > 100000 || size < 1 || size > 100) throw error(HttpStatus.BAD_REQUEST, "分页范围无效");
        if (serverId != null && archives.find(serverId).isEmpty()) throw error(HttpStatus.NOT_FOUND, "服务器档案不存在");
        String where = " WHERE status <> 'DELETED'" + (serverId == null ? "" : " AND server_id = ?");
        var values = new ArrayList<Object>(); if(serverId!=null)values.add(serverId);
        if(state!=null && !state.isBlank()) where += switch(state) {
            case "READY" -> " AND status='READY'";
            case "PENDING" -> " AND status IN ('AWAITING_UPLOAD','RECEIVING','VERIFYING')";
            case "ATTENTION" -> " AND status IN ('FAILED','MISSING','DELETING')";
            default -> throw error(HttpStatus.BAD_REQUEST,"备份状态筛选无效");
        };
        if(kind!=null && !kind.isBlank()) {
            if(!Set.of("MANUAL","AUTOMATIC","FINAL").contains(kind))throw error(HttpStatus.BAD_REQUEST,"备份类型筛选无效");
            where+=" AND kind=?";values.add(kind);
        }
        if(from!=null&&to!=null&&!from.isBefore(to))throw error(HttpStatus.BAD_REQUEST,"结束日期应不早于开始日期");
        if(from!=null){where+=" AND COALESCE(snapshot_at,created_at)>=?";values.add(from.atOffset(ZoneOffset.UTC));}
        if(to!=null){where+=" AND COALESCE(snapshot_at,created_at)<?";values.add(to.atOffset(ZoneOffset.UTC));}
        Object[] countArgs=values.toArray();values.add(size);values.add(page*size);Object[] pageArgs=values.toArray();
        return new Page(jdbc.query("SELECT * FROM game_backups" + where + " ORDER BY created_at DESC, id LIMIT ? OFFSET ?", this::row, pageArgs).stream().map(Stored::view).toList(),
                jdbc.queryForObject("SELECT COUNT(*) FROM game_backups" + where, Long.class, countArgs), page, size, Long.toString(maxUploadBytes));
    }
    long readyCount(UUID serverId) {
        if (serverId != null && archives.find(serverId).isEmpty()) throw error(HttpStatus.NOT_FOUND, "服务器档案不存在");
        return serverId == null
                ? jdbc.queryForObject("SELECT COUNT(*) FROM game_backups WHERE status='READY'", Long.class)
                : jdbc.queryForObject("SELECT COUNT(*) FROM game_backups WHERE status='READY' AND server_id=?", Long.class, serverId);
    }
    Storage storageStatus() {
        Volume volume;
        try {
            FileStore store = Files.getFileStore(storage());
            volume = new Volume(Long.toString(store.getTotalSpace()), Long.toString(store.getUsableSpace()));
        } catch (IOException | SecurityException ex) { volume = null; }
        Volume available = volume;
        return jdbc.queryForObject("SELECT COUNT(*) AS ready, COALESCE(SUM(archive_bytes), 0) AS bytes FROM game_backups WHERE status = 'READY'",
                (rs, i) -> new Storage(rs.getLong("ready"), rs.getBigDecimal("bytes").toBigIntegerExact().toString(), Long.toString(maxUploadBytes), available));
    }
    Backup reserve(UUID serverId, BackupController.Reservation request) {
        long bytes;
        try { bytes = Long.parseLong(request.expectedBytes()); } catch (NumberFormatException ex) { throw error(HttpStatus.BAD_REQUEST, "备份大小无效"); }
        if (bytes < 1 || bytes > maxUploadBytes) throw error(HttpStatus.PAYLOAD_TOO_LARGE, "备份超过当前上传容量限制");
        if (request.note().codePoints().anyMatch(c -> c < 32 && c != 9 && c != 10 && c != 13)) throw error(HttpStatus.BAD_REQUEST, "备注包含不支持的字符");
        try {
            return transaction.execute(tx -> {
                if (archives.lock(serverId).isEmpty()) throw error(HttpStatus.NOT_FOUND, "服务器档案不存在");
                var existing = jdbc.query("SELECT * FROM game_backups WHERE request_id = ?", this::row, request.requestId());
                if (!existing.isEmpty()) {
                    Backup previous = existing.getFirst().view();
                    if (!previous.serverId().equals(serverId) || !previous.kind().equals(request.kind()) || !previous.expectedBytes().equals(request.expectedBytes()))
                        throw error(HttpStatus.CONFLICT, "此上传请求已经用于另一份备份");
                    return previous;
                }
                UUID id = UUID.randomUUID();
                jdbc.update("INSERT INTO game_backups(id, server_id, request_id, kind, status, note, permanent, expected_bytes) VALUES (?, ?, ?, ?, 'AWAITING_UPLOAD', ?, ?, ?)",
                        id, serverId, request.requestId(), request.kind(), request.note().strip(), request.permanent() || request.kind().equals("FINAL"), bytes);
                return find(id);
            });
        } catch (DuplicateKeyException ex) { throw error(HttpStatus.CONFLICT, "此上传请求已被使用，请刷新备份列表"); }
    }
    private synchronized Path storage() throws IOException {
        if (root == null) {
            Files.createDirectories(configuredRoot);
            if (Files.isSymbolicLink(configuredRoot) || !Files.isDirectory(configuredRoot, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Invalid backup directory");
            root = configuredRoot.toRealPath();
        }
        for (String name : List.of("uploads", "objects")) {
            Path child = root.resolve(name);
            try { Files.createDirectory(child); } catch (FileAlreadyExistsException ignored) {}
            if (!Files.isDirectory(child, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(child) || !child.toRealPath().getParent().equals(root)) throw new IOException("Invalid storage child");
        }
        return root;
    }
    private Path owned(String directory, UUID id, UUID attempt, String suffix) throws IOException {
        if (attempt == null) throw new IOException("Missing upload attempt");
        Path parent = storage().resolve(directory), file = parent.resolve(id + "-" + attempt + suffix);
        if (!file.getParent().equals(parent) || !parent.toRealPath().getParent().equals(root)) throw new IOException("Invalid storage boundary");
        return file;
    }
    private JsonNode verify(Path file, UUID serverId, Path result) throws IOException, InterruptedException {
        if (!Files.isRegularFile(verifier)) throw error(HttpStatus.SERVICE_UNAVAILABLE, "备份校验服务未安装，请检查服务器配置");
        ProcessBuilder builder = new ProcessBuilder(node, "--max-old-space-size=384", verifier.toString(), file.toString(), serverId.toString(), result.toString(), Long.toString(expandedLimit));
        builder.environment().keySet().removeIf(key -> !Set.of("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP").contains(key.toUpperCase(Locale.ROOT)));
        builder.redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD);
        Process process;
        try { process = builder.start(); } catch (IOException ex) { throw error(HttpStatus.SERVICE_UNAVAILABLE, "备份校验运行环境不可用"); }
        try {
            if (!process.waitFor(verifierSeconds, TimeUnit.SECONDS)) throw error(HttpStatus.UNPROCESSABLE_ENTITY, "备份校验超时，请检查归档大小和完整性");
            if (!Files.isRegularFile(result, LinkOption.NOFOLLOW_LINKS) || Files.size(result) > 524288) throw error(HttpStatus.UNPROCESSABLE_ENTITY, "归档校验未完成");
            JsonNode proof = json.readTree(Files.readString(result));
            if (!proof.path("valid").asBoolean(false)) {
                if (proof.path("code").asText().equals("ARCHIVE_WRONG_SERVER")) throw error(HttpStatus.CONFLICT, "备份属于另一服务器，请选择对应的档案");
                throw error(HttpStatus.UNPROCESSABLE_ENTITY, "归档无效、已损坏或超过展开容量限制");
            }
            if (process.exitValue() != 0) throw error(HttpStatus.UNPROCESSABLE_ENTITY, "归档校验进程未正常完成");
            return proof;
        } finally { if (process.isAlive()) { process.destroyForcibly(); process.waitFor(10, TimeUnit.SECONDS); } }
    }
    interface UploadGuard { void verify(JsonNode proof); }
    Backup upload(UUID id, InputStream input, long contentLength) { return upload(id, input, contentLength, proof -> {
        if (jdbc.queryForObject("SELECT COUNT(*) FROM backup_jobs WHERE backup_id=?", Integer.class, id) > 0)
            throw error(HttpStatus.CONFLICT, "此备份由执行端任务上传，请查看任务状态");
    }); }
    Backup upload(UUID id, InputStream input, long contentLength, UploadGuard guard) {
        if (!uploads.tryAcquire()) throw error(HttpStatus.TOO_MANY_REQUESTS, "另一个备份正在上传或校验，请稍后重试");
        UUID attempt = UUID.randomUUID(); Path temporary = null, object = null, result = null; boolean committed = false, claimed = false;
        AtomicReference<UUID> previousAttempt = new AtomicReference<>();
        try {
            Stored active = transaction.execute(tx -> {
                guard.verify(null);
                Stored row = stored(id, true); String state = row.view().status();
                if (state.equals("READY")) return row;
                boolean stale = Set.of("RECEIVING", "VERIFYING").contains(state) && expired(row.leaseAt());
                if (!Set.of("AWAITING_UPLOAD", "FAILED").contains(state) && !stale) throw error(HttpStatus.CONFLICT, "当前备份状态不允许上传");
                if (contentLength >= 0 && contentLength != Long.parseLong(row.view().expectedBytes())) throw error(HttpStatus.BAD_REQUEST, "上传大小与选定文件不一致");
                previousAttempt.set(row.attemptId());
                jdbc.update("UPDATE game_backups SET status='RECEIVING', attempt_id=?, received_bytes=0, failure_code=NULL, updated_at=?, lease_at=? WHERE id=?", attempt, now(), now(), id);
                return stored(id, false);
            });
            if (active.view().status().equals("READY")) return active.view();
            claimed = true;
            if (previousAttempt.get() != null) {
                cleanup(owned("uploads", id, previousAttempt.get(), ".partial"));
                cleanup(owned("uploads", id, previousAttempt.get(), ".verification.json"));
                cleanup(owned("objects", id, previousAttempt.get(), ".tar.gz"));
            }
            long expected = Long.parseLong(active.view().expectedBytes());
            temporary = owned("uploads", id, attempt, ".partial"); object = owned("objects", id, attempt, ".tar.gz"); result = owned("uploads", id, attempt, ".verification.json");
            if (Files.getFileStore(temporary.getParent()).getUsableSpace() < expected + 268435456L) throw error(HttpStatus.INSUFFICIENT_STORAGE, "备份存储空间不足，请先释放空间");
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[262144]; long received = 0, progressAt = System.nanoTime();
            try (FileChannel output = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                if (Files.getFileStore(temporary).supportsFileAttributeView("posix")) Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------"));
                int count;
                while ((count = input.read(buffer)) != -1) {
                    received += count;
                    if (received > expected || received > maxUploadBytes) throw error(HttpStatus.PAYLOAD_TOO_LARGE, "上传内容超过选定文件大小");
                    digest.update(buffer, 0, count); ByteBuffer bytes = ByteBuffer.wrap(buffer, 0, count); while (bytes.hasRemaining()) output.write(bytes);
                    if (System.nanoTime() - progressAt > TimeUnit.SECONDS.toNanos(1)) {
                        transaction.executeWithoutResult(tx -> guard.verify(null));
                        if (jdbc.update("UPDATE game_backups SET received_bytes=?, updated_at=?, lease_at=? WHERE id=? AND attempt_id=? AND status='RECEIVING'", received, now(), now(), id, attempt) != 1)
                            throw error(HttpStatus.CONFLICT, "上传任务已发生变化，请刷新列表");
                        progressAt = System.nanoTime();
                    }
                }
                if (received != expected) throw error(HttpStatus.BAD_REQUEST, "上传未完成，文件大小不一致");
                output.force(true);
            }
            if (jdbc.update("UPDATE game_backups SET status='VERIFYING', received_bytes=?, updated_at=?, lease_at=? WHERE id=? AND attempt_id=? AND status='RECEIVING'", received, now(), now(), id, attempt) != 1)
                throw error(HttpStatus.CONFLICT, "上传任务已发生变化");
            JsonNode proof = verify(temporary, active.view().serverId(), result);
            String sha256 = HexFormat.of().formatHex(digest.digest());
            if (!proof.path("sha256").asText().equals(sha256) || !proof.path("archiveBytes").asText().equals(Long.toString(received)))
                throw error(HttpStatus.UNPROCESSABLE_ENTITY, "校验期间归档发生变化");
            UUID sourceId = UUID.fromString(proof.path("backupId").asText());
            long sourceBytes = Long.parseLong(proof.path("sourceBytes").asText());
            OffsetDateTime snapshot = OffsetDateTime.parse(proof.path("snapshotStartedAt").asText());
            Path temp = temporary, published = object;
            transaction.executeWithoutResult(tx -> {
                guard.verify(proof);
                Stored row = stored(id, true);
                if (!attempt.equals(row.attemptId()) || !row.view().status().equals("VERIFYING")) throw error(HttpStatus.CONFLICT, "备份任务已经改变");
                if (jdbc.queryForObject("SELECT COUNT(*) FROM game_backups WHERE server_id=? AND source_backup_id=? AND id<>?", Long.class, row.view().serverId(), sourceId, id) > 0)
                    throw error(HttpStatus.CONFLICT, "此归档已保存，请使用列表中的现有备份");
                try {
                    if (Files.exists(published, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Object already exists");
                    Files.move(temp, published, StandardCopyOption.ATOMIC_MOVE);
                } catch (IOException ex) { throw error(HttpStatus.SERVICE_UNAVAILABLE, "无法发布备份文件，请检查存储"); }
                jdbc.update("UPDATE game_backups SET status='READY', source_backup_id=?, archive_bytes=?, source_bytes=?, file_count=?, sha256=?, summary_json=?, snapshot_at=?, failure_code=NULL, lease_at=NULL, updated_at=? WHERE id=? AND attempt_id=?",
                        sourceId, expected, sourceBytes, proof.path("fileCount").asInt(), sha256, proof.toString(), snapshot, now(), id, attempt);
            });
            committed = true; return find(id);
        } catch (ResponseStatusException ex) {
            if (claimed) failed(id, attempt, ex.getReason() != null && ex.getReason().contains("另一服务器") ? "ARCHIVE_WRONG_SERVER" : "UPLOAD_OR_VERIFICATION_FAILED"); throw ex;
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt(); if (claimed) failed(id, attempt, "VERIFICATION_INTERRUPTED"); throw error(HttpStatus.SERVICE_UNAVAILABLE, "备份校验被中断，可重新上传");
        } catch (Exception ex) {
            if (claimed) failed(id, attempt, "STORAGE_OR_VERIFICATION_ERROR"); throw error(HttpStatus.SERVICE_UNAVAILABLE, "备份未完成，请检查存储或重新上传");
        } finally {
            // Only individual UUID-named files created by this attempt are removed.
            cleanup(temporary); cleanup(result);
            if (!committed && object != null) {
                try { Stored current = stored(id, false); if (!current.view().status().equals("READY") || !attempt.equals(current.attemptId())) cleanup(object); }
                catch (RuntimeException ignored) { /* Preserve a potentially committed object if database state is unknown. */ }
            }
            uploads.release();
        }
    }
    private void cleanup(Path file) {
        if (file == null) return;
        try {
            Path parent = file.getParent();
            if (root != null && (parent.equals(root.resolve("uploads")) || parent.equals(root.resolve("objects")))
                    && parent.toRealPath().getParent().equals(root)) Files.deleteIfExists(file);
        } catch (IOException ignored) { /* A failed cleanup remains outside the published catalog. */ }
    }
    private void failed(UUID id, UUID attempt, String code) {
        try { jdbc.update("UPDATE game_backups SET status='FAILED', failure_code=?, lease_at=NULL, updated_at=? WHERE id=? AND attempt_id=? AND status IN ('RECEIVING','VERIFYING')", code, now(), id, attempt); }
        catch (RuntimeException ignored) { /* Lease expires; the attempt ID prevents another upload from being overwritten. */ }
    }
    Backup edit(UUID id, BackupController.Metadata request) {
        if (request.note().codePoints().anyMatch(c -> c < 32 && c != 9 && c != 10 && c != 13)) throw error(HttpStatus.BAD_REQUEST, "备注包含不支持的字符");
        return transaction.execute(tx -> {
            Stored row = stored(id, true);
            if (Set.of("DELETED", "DELETING").contains(row.view().status())) throw error(HttpStatus.CONFLICT, "该备份已进入删除流程");
            jdbc.update("UPDATE game_backups SET note=?, permanent=?, updated_at=? WHERE id=?", request.note().strip(), request.permanent(), now(), id);
            return find(id);
        });
    }
    void delete(UUID id) { delete(id, () -> {}, value -> {}); }
    void deleteAutomatic(UUID id, Runnable authorize, java.util.function.Consumer<Backup> journal) {
        delete(id, authorize, value -> {
            if (!value.kind().equals("AUTOMATIC") || !value.status().equals("READY"))
                throw error(HttpStatus.CONFLICT, "自动轮换只处理已校验的普通自动备份");
            journal.accept(value);
        });
    }
    private void delete(UUID id, Runnable authorize, java.util.function.Consumer<Backup> journal) {
        Stored active = transaction.execute(tx -> {
            authorize.run();
            Stored row = stored(id, true); Backup value = row.view();
            if (value.status().equals("DELETED")) return row;
            if (value.permanent()) throw error(HttpStatus.CONFLICT, "此备份已永久保留，请先取消保留再删除");
            if(jdbc.queryForObject("SELECT COUNT(*) FROM restore_jobs WHERE backup_id=? AND status IN ('QUEUED','CLAIMED','RUNNING','UNCERTAIN')",Integer.class,id)>0)
                throw error(HttpStatus.CONFLICT,"此归档正用于恢复任务，核实并结束该任务后才能删除");
            if (Set.of("RECEIVING", "VERIFYING").contains(value.status()) && !expired(row.leaseAt()))
                throw error(HttpStatus.CONFLICT, "备份正在处理，请稍后再删除");
            journal.accept(value);
            jdbc.update("UPDATE game_backups SET status='DELETING', updated_at=? WHERE id=?", now(), id); return row;
        });
        if (active.view().status().equals("DELETED")) return;
        try {
            if (active.attemptId() != null) {
                Files.deleteIfExists(owned("objects", id, active.attemptId(), ".tar.gz"));
                Files.deleteIfExists(owned("uploads", id, active.attemptId(), ".partial"));
                Files.deleteIfExists(owned("uploads", id, active.attemptId(), ".verification.json"));
            }
            jdbc.update("UPDATE game_backups SET status='DELETED', source_backup_id=NULL, deleted_at=?, updated_at=? WHERE id=? AND status='DELETING'", now(), now(), id);
        } catch (IOException ex) { throw error(HttpStatus.SERVICE_UNAVAILABLE, "备份文件暂时无法删除，请稍后重试"); }
    }
    Download download(UUID id) throws IOException {
        Stored row = stored(id, false); Backup value = row.view();
        if (!value.status().equals("READY")) throw error(HttpStatus.CONFLICT, "备份尚未完成文件校验或已不可用");
        FileChannel channel = null;
        try {
            Path file = owned("objects", id, row.attemptId(), ".tar.gz");
            channel = FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || channel.size() != Long.parseLong(value.archiveBytes())) throw new IOException("Invalid stored object");
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); ByteBuffer buffer = ByteBuffer.allocate(262144);
            while (channel.read(buffer) != -1) { buffer.flip(); digest.update(buffer); buffer.clear(); }
            if (!HexFormat.of().formatHex(digest.digest()).equals(value.sha256())) throw new IOException("Damaged stored object");
            channel.position(0); return new Download(Channels.newInputStream(channel), channel.size(), value.sha256());
        } catch (Exception ex) {
            if (channel != null) channel.close();
            jdbc.update("UPDATE game_backups SET status='MISSING', failure_code='STORED_FILE_UNAVAILABLE', updated_at=? WHERE id=? AND status='READY'", now(), id);
            throw error(HttpStatus.CONFLICT, "备份文件缺失或校验不一致，已停止下载，请检查存储");
        }
    }
}
