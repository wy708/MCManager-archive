#pragma once
#include "core/Engine.h"
#include <memory>
class Level;
namespace mcarchive {
class KillTracker {
public:
    explicit KillTracker(Engine& engine);
    ~KillTracker();
    void tick(Level& level);
    KillTracker(KillTracker const&) = delete;
    KillTracker& operator=(KillTracker const&) = delete;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Native world load/save begins before enable and finishes after disable.
class PetOwnerPersistence {
public:
    explicit PetOwnerPersistence(std::string const& archiveId);
    ~PetOwnerPersistence();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
