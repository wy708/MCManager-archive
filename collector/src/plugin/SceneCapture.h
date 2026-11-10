#pragma once
#include <nlohmann/json.hpp>
#include <cstdint>
#include <vector>
class BlockSource;
class BlockPos;
namespace mcarchive {
// Public scene data only. Never serialize a whole actor/container into the public archive.
nlohmann::json captureSceneBlock(BlockSource& region,BlockPos const& pos);
struct SceneEntityScan {
    bool initialized=false,complete=true;
    std::size_t cursor=0,bytes=0,nodes=0;
    std::vector<std::int64_t> ids;
    nlohmann::json entities=nlohmann::json::array();
};
// Retains IDs, never Actor pointers, across ticks. False means continue next tick.
bool captureSceneEntities(SceneEntityScan& scan,BlockSource& region,int x,int y,int z,int minX,int maxX,int minZ,int maxZ);
}
