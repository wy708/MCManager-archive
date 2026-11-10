#pragma once
#include "core/Engine.h"
#include <memory>
class Level;
namespace mcarchive {
class BreedTracker {
  public:
    explicit BreedTracker(Engine &engine);
    ~BreedTracker();
    void tick(Level &level);
    BreedTracker(BreedTracker const &) = delete;
    BreedTracker &operator=(BreedTracker const &) = delete;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace mcarchive
