#pragma once
#include "core/Engine.h"
#include <memory>
class Level;
namespace mcarchive {
class ActionTracker {
public:
    explicit ActionTracker(Engine& engine);
    ~ActionTracker();
    void tick(Level& level);
    ActionTracker(ActionTracker const&) = delete;
    ActionTracker& operator=(ActionTracker const&) = delete;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
