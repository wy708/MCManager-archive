#pragma once
#include "core/Engine.h"
#include <memory>
namespace mcarchive {
class CraftTracker {
  public:
    explicit CraftTracker(Engine &engine);
    ~CraftTracker();
    void tick();
    CraftTracker(CraftTracker const &) = delete;
    CraftTracker &operator=(CraftTracker const &) = delete;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace mcarchive
