#pragma once
#include "core/Engine.h"
#include <memory>
class Level;
namespace mcarchive {
class ProjectCommands {
    struct Impl;std::unique_ptr<Impl> impl_;
public:
    explicit ProjectCommands(EngineConfig const& config);
    ~ProjectCommands();
    void tick(Level& level);
};
}
