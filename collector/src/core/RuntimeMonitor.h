#pragma once
#include <chrono>
#include <cstdint>
#include <mutex>
#include <map>
#include <utility>
#include <nlohmann/json.hpp>

namespace mcarchive {
// Tick callbacks only update counters. OS/process sampling runs on the sender.
class RuntimeMonitor {
    using Clock=std::chrono::steady_clock;
    std::mutex mutex;
    Clock::time_point started=Clock::now(),window=started,lastTick{};
    std::int64_t lastTickAt=0;
    std::uint64_t ticks=0,sequence=0,previousCpu=0;
    double maxInterval=0;
    int players=0;
    bool hasCpu=false,hasHostCpu=false;
    std::uint64_t hostIdle=0,hostTotal=0;
    std::map<std::uint64_t,std::pair<std::uint64_t,std::uint64_t>> interfaces;
public:
    void tick(int onlinePlayers) noexcept;
    nlohmann::json sample(bool stopped=false);
};
}
