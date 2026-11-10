#include "plugin/AgricultureRules.h"
#include "mc/world/level/block/Block.h"
#include "mc/world/level/block/VanillaStates.h"
#include <array>

namespace mcarchive {
bool berryVine(std::string_view type) {
    return type == "minecraft:cave_vines_head_with_berries" || type == "minecraft:cave_vines_body_with_berries";
}
std::optional<std::string> plantedCrop(std::string_view item, std::string_view before, Block const& after) {
    auto const& type = after.getTypeName();
    if (before == type) return {};
    static constexpr std::pair<std::string_view, std::string_view> seeds[] = {
        {"minecraft:wheat_seeds", "minecraft:wheat"}, {"minecraft:carrot", "minecraft:carrots"},
        {"minecraft:potato", "minecraft:potatoes"}, {"minecraft:beetroot_seeds", "minecraft:beetroot"},
        {"minecraft:nether_wart", "minecraft:nether_wart"}, {"minecraft:cocoa_beans", "minecraft:cocoa"},
        {"minecraft:pumpkin_seeds", "minecraft:pumpkin_stem"}, {"minecraft:melon_seeds", "minecraft:melon_stem"},
        {"minecraft:torchflower_seeds", "minecraft:torchflower_crop"}, {"minecraft:pitcher_pod", "minecraft:pitcher_crop"},
        {"minecraft:sweet_berries", "minecraft:sweet_berry_bush"},
    };
    for (auto const& [seed, crop] : seeds) if (item == seed && type == crop) return std::string(crop);
    if (item == "minecraft:glow_berries" && !before.starts_with("minecraft:cave_vines")
        && (type == "minecraft:cave_vines" || berryVine(type))) return "minecraft:cave_vines";
    return {};
}
std::optional<std::string> matureCrop(Block const& block) {
    auto const& type = block.getTypeName();
    auto growth = block.getState<int>(VanillaStates::Growth());
    auto age = block.getState<int>(VanillaStates::Age());
    if ((type == "minecraft:wheat" || type == "minecraft:carrots" || type == "minecraft:potatoes" || type == "minecraft:beetroot") && growth == 7) return type;
    if (type == "minecraft:nether_wart" && age == 3) return type;
    if (type == "minecraft:cocoa" && age == 2) return type;
    if (type == "minecraft:pitcher_crop" && growth == 4) return type;
    if (type == "minecraft:sweet_berry_bush" && growth == 3) return type;
    if (type == "minecraft:melon_block" || type == "minecraft:pumpkin" || type == "minecraft:torchflower") return type;
    if (berryVine(type)) return "minecraft:cave_vines";
    return {};
}
}
