#pragma once
#include "core/Engine.h"
#include <memory>
class Level;
namespace mcarchive {
class GameAi {
public:
    explicit GameAi(EngineConfig const& config);
    ~GameAi();
    void tick(Level& level);
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
