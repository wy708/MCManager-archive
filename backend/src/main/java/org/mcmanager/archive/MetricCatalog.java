package org.mcmanager.archive;

import java.util.*;

final class MetricCatalog {
    enum Aggregation { SUM, MAX }
    record Metric(String key, String label, String unit, Aggregation aggregation, boolean estimatedOnly) {}
    static final Map<String, Metric> ALL;
    static {
        Map<String, Metric> metrics = new LinkedHashMap<>();
        add(metrics, "online.millis", "在线时长", "ms");
        add(metrics, "blocks.mined", "挖掘方块", "blocks");
        add(metrics, "blocks.placed", "放置方块", "blocks");
        add(metrics, "deaths", "死亡", "count");
        add(metrics, "kills.mobs", "生物击杀", "count");
        add(metrics, "kills.players", "玩家击杀", "count");
        add(metrics, "experience.gained", "累计获得经验", "points");
        metrics.put("level.max", new Metric("level.max", "最高等级", "levels", Aggregation.MAX, false));
        add(metrics, "dimension.visits", "维度进入次数", "count");
        add(metrics, "items.picked_up", "实际拾取物品", "items");
        add(metrics, "items.use_requests", "物品使用请求", "count");
        add(metrics, "items.used", "成功使用物品", "count");
        add(metrics, "actions.jumps", "跳跃", "count");
        add(metrics, "actions.swings", "挥手", "count");
        add(metrics, "actions.sneak_starts", "开始潜行", "count");
        add(metrics, "actions.sneak_millis", "潜行时长", "ms");
        add(metrics, "actions.sprint_starts", "开始疾跑", "count");
        add(metrics, "actions.sprint_millis", "疾跑时长", "ms");
        add(metrics, "crops.planted", "种植", "blocks");
        add(metrics, "crops.harvested", "成熟作物采收", "blocks");
        add(metrics, "crops.interacted", "交互采收", "count");
        add(metrics, "fishing.retrievals", "收竿", "count");
        add(metrics, "fishing.item_pull_events", "拉回物品操作", "count");
        add(metrics, "fishing.items_pulled", "收竿拉回物品", "items");
        add(metrics, "fishing.catch_events", "成功钓获次数", "count");
        add(metrics, "fishing.catches", "钓获产物", "items");
        add(metrics, "breeding.offspring", "繁殖结果", "count");
        add(metrics, "villager.trades", "原版村民交易", "count");
        add(metrics, "villager.items", "村民交易产物", "items");
        add(metrics, "crafting.crafts", "手动合成", "count");
        add(metrics, "crafting.items", "合成产物", "items");
        add(metrics, "chat.messages", "聊天发言", "count");
        add(metrics, "chat.contents", "已记录聊天正文", "count");
        for (String mode : List.of("walk", "swim", "fly", "glide", "vehicle")) {
            String key = "travel." + mode + "_millimeters";
            metrics.put(key, new Metric(key, "估算移动距离 · " + mode, "mm", Aggregation.SUM, true));
        }
        metrics.put("activity.millis", new Metric("activity.millis", "估算活跃时长", "ms", Aggregation.SUM, true));
        ALL = Collections.unmodifiableMap(metrics);
    }
    private static void add(Map<String, Metric> map, String key, String label, String unit) {
        map.put(key, new Metric(key, label, unit, Aggregation.SUM, false));
    }
    static Metric require(String key) {
        Metric metric = ALL.get(key);
        if (metric == null) throw TelemetryValidation.bad("未知指标：" + key);
        return metric;
    }
    static String blockCategory(String subject) {
        if (subject == null || !subject.startsWith("minecraft:")) return "OTHER";
        String block = subject.substring(10);
        if (block.endsWith("_ore") || block.equals("ancient_debris")) return "ORE";
        if (block.endsWith("_log") || block.endsWith("_wood") || Set.of("log", "log2", "wood",
                "crimson_stem", "warped_stem", "stripped_crimson_stem", "stripped_warped_stem",
                "crimson_hyphae", "warped_hyphae", "stripped_crimson_hyphae", "stripped_warped_hyphae").contains(block)) return "WOOD";
        return "OTHER";
    }
    private MetricCatalog() {}
}
