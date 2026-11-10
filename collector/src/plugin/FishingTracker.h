#pragma once
#include "core/Engine.h"
#include <memory>
namespace mcarchive {
class FishingTracker {
  public:
    explicit FishingTracker(Engine &engine);
    ~FishingTracker();
    void tick();
    FishingTracker(FishingTracker const &) = delete;
    FishingTracker &operator=(FishingTracker const &) = delete;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace mcarchive
