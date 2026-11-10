#pragma once
#include "core/Engine.h"
#include <memory>
class Level;
namespace mcarchive {
class WorldState {
public:
    WorldState(EngineConfig const& config, Engine& engine);
    ~WorldState();
    void tick(Level& level);
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
