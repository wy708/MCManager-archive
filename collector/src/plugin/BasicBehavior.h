#pragma once
#include "core/Engine.h"
#include <memory>

namespace mcarchive {
class BasicBehavior {
public:
    explicit BasicBehavior(Engine& engine);
    ~BasicBehavior();
    void tick();
    BasicBehavior(BasicBehavior const&) = delete;
    BasicBehavior& operator=(BasicBehavior const&) = delete;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
