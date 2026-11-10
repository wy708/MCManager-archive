#pragma once
#include "core/MovementRules.h"
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

namespace mcarchive {
std::int64_t nowMillis();
std::string timestamp(std::int64_t millis);
struct EngineConfig {
    std::string serverId;
    std::string token;
    std::string endpoint;
    std::filesystem::path dataDirectory;
    int activityIdleSeconds = defaultIdleSeconds;
};
struct EngineStatus { std::size_t queuedEvents; std::size_t pendingEvents; std::size_t rejectedEvents; bool diskError; };
class Engine {
public:
    using Log = std::function<void(std::string const&)>;
    using EventObserver = void (*)(nlohmann::json const&) noexcept;
    Engine(EngineConfig config, Log log);
    ~Engine();
    Engine(Engine const&) = delete;
    Engine& operator=(Engine const&) = delete;
    bool submit(nlohmann::json event);
    bool submitEvents(nlohmann::json events);
    void setEventObserver(EventObserver observer) noexcept;
    void recordCaptureGap(std::size_t count = 1) noexcept;
    void observeTick(int onlinePlayers) noexcept;
    void stop();
    EngineStatus status() const;
    nlohmann::json backupOutboxCheckpoint() const;
    std::string const& bootId() const;
    void note(std::string const& message) const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
