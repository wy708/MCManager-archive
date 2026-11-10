#pragma once
#include "core/Engine.h"
#include <memory>
#include <string>
class Level;
class Player;
class BlockPos;
namespace mcarchive {
// Called only after the existing placement/mining tracker confirms a change.
void auditContainerBlock(Player const&, BlockPos const&, std::string const& type, bool placed) noexcept;
class ContainerAuditTracker {
    struct Impl;
    std::unique_ptr<Impl> impl_;
public:
    explicit ContainerAuditTracker(Engine&);
    ~ContainerAuditTracker();
    void tick(Level&);
};
}
