#pragma once
#include <memory>
#include <functional>
#include <nlohmann/json_fwd.hpp>

namespace mcarchive {
// Console-only snapshot leases and the active collector's checkpoint.
class BackupControl {
public:
    explicit BackupControl(std::function<nlohmann::json()> outboxCheckpoint);
    ~BackupControl();
    bool releaseAndStop();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
