#pragma once
#include "core/Engine.h"
#include <memory>
class Player;
namespace mcarchive {
void noteBlockInteraction(Player const& player) noexcept;
class ItemBehavior {
public:
    explicit ItemBehavior(Engine& engine);
    ~ItemBehavior();
    void tick();
    ItemBehavior(ItemBehavior const&) = delete;
    ItemBehavior& operator=(ItemBehavior const&) = delete;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
