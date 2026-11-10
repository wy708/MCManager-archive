#pragma once
#include "core/Engine.h"
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>

namespace mcarchive {
struct SendOutcome { std::string outcome; std::string errorCode; };
class Commands {
public:
    Commands(EngineConfig config, Engine& engine);
    ~Commands();
    Commands(Commands const&) = delete;
    Commands& operator=(Commands const&) = delete;
    // Called only by the game thread. All journal and HTTP work stays on the command worker.
    void tick(std::function<SendOutcome(nlohmann::json const&)> const& execute);
    void stop();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
