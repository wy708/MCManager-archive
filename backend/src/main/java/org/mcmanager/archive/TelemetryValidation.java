package org.mcmanager.archive;

import jakarta.validation.Validator;
import java.math.BigInteger;
import java.time.Instant;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.TelemetryPayload.*;

@Component
class TelemetryValidation {
    private final Validator validator;
    TelemetryValidation(Validator validator) { this.validator = validator; }
    static ResponseStatusException bad(String message) { return new ResponseStatusException(HttpStatus.BAD_REQUEST, message); }
    static ResponseStatusException conflict(String message) { return new ResponseStatusException(HttpStatus.CONFLICT, message); }
    static void check(boolean condition, String message) { if (!condition) throw bad(message); }
    static boolean resource(String value) { return value != null && value.matches("[a-z0-9_][a-z0-9_.-]*:[a-z0-9_./-]+"); }
    static String metric(Event event) {
        return switch (event.kind()) { case SESSION -> "online.millis"; case DEATH -> "deaths"; case CHAT -> "chat.contents"; case COUNTER -> event.metric(); case CONTAINER -> "container.audit"; };
    }
    static void millis(Instant value) { check(value != null && !value.isBefore(Instant.EPOCH) && value.getNano() % 1_000_000 == 0, "时间戳须为 1970 年后的毫秒精度 UTC 时间"); }
    Map<String, Capability> validate(Batch batch) {
        check(validator.validate(batch).isEmpty(), "采集字段、数量或长度无效");
        millis(batch.reportedAt());
        check(!batch.reportedAt().isAfter(Instant.now().plusSeconds(30)), "采集端时间超前，请同步系统时钟");
        var runtime=batch.collector().runtime();
        if(runtime!=null){
            millis(runtime.at());check(!runtime.at().isAfter(batch.reportedAt()),"运行采样时间晚于批次时间");
            if(runtime.lastTickAt()!=null){millis(runtime.lastTickAt());check(!runtime.lastTickAt().isAfter(runtime.at()),"游戏时刻晚于运行采样");}
            check(Double.isFinite(runtime.maxTickIntervalMillis())&&(runtime.cpuPercent()==null||Double.isFinite(runtime.cpuPercent())),"运行指标必须为有限数值");
            check(runtime.hostMemoryAvailableBytes()==null||runtime.hostMemoryTotalBytes()!=null&&runtime.hostMemoryAvailableBytes()<=runtime.hostMemoryTotalBytes(),"主机内存值无效");
            for(Double number:Arrays.asList(runtime.hostCpuPercent(),runtime.hostNetworkReceiveBps(),runtime.hostNetworkSendBps()))check(number==null||Double.isFinite(number),"主机指标必须为有限数值");
            if(runtime.hostDisks()!=null){var drives=new HashSet<String>();for(var disk:runtime.hostDisks())check(disk.availableBytes()<=disk.totalBytes()&&drives.add(disk.drive()),"主机磁盘值无效或盘符重复");}
        }
        var diagnostics = batch.collector().diagnostics();
        if (diagnostics != null) {
            check(!diagnostics.diskError() || diagnostics.diskFaults() > 0, "写盘故障状态必须包含故障次数");
            check(!diagnostics.finalReport() || batch.events().isEmpty() && diagnostics.queuedEvents() == 0 && !diagnostics.diskError(),
                    "停止诊断只能在无内存积压时随空批次上报");
        }
        Map<String, Capability> capabilities = new LinkedHashMap<>();
        for (Capability cap : batch.capabilities()) {
            MetricCatalog.Metric metric = MetricCatalog.require(cap.metric());
            check(capabilities.put(cap.metric(), cap) == null, "能力声明中指标重复");
            if (cap.state() == CapabilityState.ACTIVE) {
                check(cap.quality() != null && cap.algorithmVersion() != null && cap.algorithmVersion().matches("[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"), "启用指标必须声明质量与算法版本");
                check(metric.estimatedOnly() ? cap.quality() == Quality.ESTIMATED
                        : cap.quality() == Quality.EXACT || (metric.key().equals("level.max") && cap.quality() == Quality.OBSERVED), "指标质量与统计口径不匹配");
            }
        }
        Set<UUID> ids = new HashSet<>();
        for (Event event : batch.events()) {
            check(ids.add(event.eventId()), "同一批次不能重复包含事件 ID");
            millis(event.at());
            check(!event.at().isAfter(batch.reportedAt()), "事件时间不能晚于批次时间");
            Player player = event.player();
            check(event.position()==null || event.kind()==Kind.COUNTER && ("blocks.placed".equals(event.metric()) || "blocks.mined".equals(event.metric()))
                    && Long.valueOf(1).equals(event.value()),"位置明细仅用于逐次放置或拆除方块");
            check(event.kind() == Kind.CONTAINER || event.container() == null, "只有容器审计允许包含容器详情");
            if (event.kind() == Kind.CONTAINER) ContainerAudit.validate(event);
            check(player != null || event.kind() == Kind.CONTAINER, "事件缺少玩家身份");
            if (player != null) {
            check(player.name().equals(player.name().strip()), "玩家名字不能包含首尾空白");
            check(player.name().codePoints().noneMatch(c -> Character.isISOControl(c) || Character.getType(c) == Character.SURROGATE), "玩家名字不能包含控制字符或无效 Unicode");
            if (player.identityType() == IdentityType.XUID) {
                check(player.identity().matches("[1-9][0-9]{0,19}")
                        && new BigInteger(player.identity()).compareTo(new BigInteger("18446744073709551615")) <= 0, "XUID 必须是非零无符号 64 位十进制字符串");
            } else {
                try { check(UUID.fromString(player.identity()).toString().equals(player.identity()), "玩家 UUID 必须使用规范小写格式"); }
                catch (IllegalArgumentException ex) { throw bad("玩家 UUID 格式无效"); }
            }
            }
            if (event.kind() == Kind.CONTAINER) continue;
            Capability cap = capabilities.get(metric(event));
            check(cap != null && cap.state() == CapabilityState.ACTIVE, "事件的指标未声明为启用");
            check(cap.dimensionAware() ? resource(event.dimension()) : event.dimension() == null, "事件维度字段与能力声明不一致");
            check(event.dimension() == null || resource(event.dimension()), "维度必须是命名空间标识");
            check(event.kind() == Kind.CHAT || event.text() == null, "只有聊天事件允许包含正文");
            check(event.sessionStart() == null || event.kind() == Kind.SESSION && Long.valueOf(0).equals(event.sequence()),
                    "会话起因只能写入起始检查点");
            check(event.sessionEnd() == null || event.kind() == Kind.SESSION && Boolean.TRUE.equals(event.ended())
                    && event.sequence() != null && event.sequence() > 0, "会话结束原因只能写入结束检查点");
            if (event.playerObservedAt() != null) {
                millis(event.playerObservedAt());
                check(event.kind() == Kind.COUNTER && ("kills.mobs".equals(event.metric()) || "kills.players".equals(event.metric()))
                        && !event.playerObservedAt().isAfter(event.at()), "击杀归属的玩家观测时间无效");
            }
            switch (event.kind()) {
                case COUNTER -> {
                    MetricCatalog.Metric metric = MetricCatalog.require(event.metric());
                    check(!Set.of("online.millis", "deaths", "chat.contents").contains(event.metric()), "在线、死亡和聊天正文须使用对应事件类型");
                    check(event.value() != null && event.value() >= (metric.aggregation() == MetricCatalog.Aggregation.MAX ? 0 : 1)
                            && event.value() <= 1_000_000_000L, "指标值超出允许范围");
                    check(event.subject() == null || resource(event.subject()), "分类对象必须是命名空间标识");
                    if (event.metric().startsWith("blocks.")) check(event.subject() != null, "方块事件必须包含方块类型");
                    check(event.sessionId() == null && event.startedAt() == null && event.sequence() == null
                            && event.onlineMillis() == null && event.ended() == null && event.cause() == null && event.killerType() == null, "计数事件包含不适用字段");
                }
                case SESSION -> {
                    check(event.sessionId() != null && event.startedAt() != null && event.sequence() != null
                            && event.sequence() >= 0 && event.onlineMillis() != null && event.onlineMillis() >= 0
                            && event.ended() != null && resource(event.dimension()), "会话检查点字段不完整");
                    millis(event.startedAt());
                    check(!event.startedAt().isAfter(event.at()), "会话开始时间不能晚于检查点");
                    check(event.metric() == null && event.value() == null && event.subject() == null
                            && event.cause() == null && event.killerType() == null, "会话事件包含不适用字段");
                }
                case DEATH -> {
                    check(event.cause() != null && event.cause().matches("[a-z0-9_.:-]+") && resource(event.dimension()), "死亡事件必须包含死因和维度");
                    check(event.killerType() == null || resource(event.killerType()), "击杀来源类型必须是命名空间标识");
                    check(event.metric() == null && event.value() == null && event.subject() == null && event.sessionId() == null
                            && event.startedAt() == null && event.sequence() == null && event.onlineMillis() == null && event.ended() == null, "死亡事件包含不适用字段");
                }
                case CHAT -> {
                    check(event.text() != null && !event.text().isBlank()
                            && event.text().codePoints().noneMatch(c -> Character.isISOControl(c) || Character.getType(c) == Character.SURROGATE || c == 0x2028 || c == 0x2029), "聊天正文不能为空或包含控制字符及无效 Unicode");
                    Capability count = capabilities.get("chat.messages");
                    check(count != null && count.state() == CapabilityState.ACTIVE && count.dimensionAware().equals(cap.dimensionAware()), "聊天正文须同时启用同维度口径的聊天计数");
                    check(event.metric() == null && event.value() == null && event.subject() == null && event.sessionId() == null
                            && event.startedAt() == null && event.sequence() == null && event.onlineMillis() == null && event.ended() == null
                            && event.cause() == null && event.killerType() == null, "聊天事件包含不适用字段");
                }
            }
        }
        return capabilities;
    }
}
