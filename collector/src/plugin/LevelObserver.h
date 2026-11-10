#pragma once
#include "core/Engine.h"
#include <memory>

class Level;
namespace mcarchive {
class LevelObserver {
public:
    explicit LevelObserver(Engine& engine);
    ~LevelObserver();
    void tick(Level& level);
    LevelObserver(LevelObserver const&) = delete;
    LevelObserver& operator=(LevelObserver const&) = delete;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
