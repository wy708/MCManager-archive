#pragma once
#include "core/Engine.h"
#include <memory>
class Level;
class BlockSource;
class BlockPos;
namespace mcarchive {
// Called after a successful native block write; only queues a small coordinate.
void markProjectModelDirty(BlockSource& region,BlockPos const& pos) noexcept;
class ProjectModels {
public:
    ProjectModels(EngineConfig const& config,Engine& engine);
    ~ProjectModels();
    void tick(Level& level);
private:
    friend void markProjectModelDirty(BlockSource&,BlockPos const&) noexcept;
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
