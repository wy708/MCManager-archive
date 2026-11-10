#pragma once
#include "core/Engine.h"
#include <memory>

class Level;

namespace mcarchive {
class MovementTracker {
  public:
    MovementTracker(Engine &engine, int idleSeconds);
    ~MovementTracker();
    void tick(Level &level);
    MovementTracker(MovementTracker const &) = delete;
    MovementTracker &operator=(MovementTracker const &) = delete;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace mcarchive
