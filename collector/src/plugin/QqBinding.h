#pragma once
#include "core/Engine.h"
#include <memory>
class Level;

namespace mcarchive {
class QqBinding {
public:
    explicit QqBinding(EngineConfig const& config);
    ~QqBinding();
    void tick(Level& level);
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
