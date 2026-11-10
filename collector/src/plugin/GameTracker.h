#pragma once
#include "core/Engine.h"
#include <memory>
class Level;
class Player;

namespace mcarchive {
class GameTracker {
public:
    explicit GameTracker(Engine& engine, std::function<void(Level&)> gameActions = {});
    ~GameTracker();
    GameTracker(GameTracker const&) = delete;
    GameTracker& operator=(GameTracker const&) = delete;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
std::string stablePlayerKey(Player const& player);
nlohmann::json playerIdentity(Player const& player);
std::string playerDimension(Player const& player);
}
