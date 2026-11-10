#include "plugin/RuntimeApi.h"
#include "plugin/ActionTracker.h"
#include "plugin/GameTracker.h"
#include "core/ActionIntervals.h"
#include "core/Platform.h"
#include "ll/api/event/EventBus.h"
#include "ll/api/event/player/PlayerJumpEvent.h"
#include "ll/api/event/player/PlayerSwingEvent.h"
#include "ll/api/event/player/PlayerDisconnectEvent.h"
#include "ll/api/memory/Hook.h"
#include "mc/world/actor/Mob.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/actor/ActorDamageSource.h"
#include "mc/world/level/Level.h"
#include "mc/world/actor/provider/SynchedActorDataAccess.h"
#include "mc/deps/ecs/gamerefs_entity/EntityContext.h"
#include "mc/deps/ecs/gamerefs_entity/GameRefsEntity.h"
#include <chrono>
#include <deque>
#include <mutex>
#include <shared_mutex>
#include <unordered_map>
#include <unordered_set>

namespace mcarchive {
namespace {
using json = nlohmann::json;
struct Observer {
    virtual void sample(Player const&) = 0;
    virtual void finish(Player const&) = 0;
    virtual void jump(Player const&) = 0;
    virtual ~Observer() = default;
};
std::shared_mutex lifetime;
Observer* observer = nullptr;
void sample(Actor const& actor) noexcept {
    try { if (actor.isPlayer()) { std::shared_lock lock(lifetime); if (observer) observer->sample(static_cast<Player const&>(actor)); } } catch (...) {}
}
void finish(Player const& player) noexcept {
    try { std::shared_lock lock(lifetime); if (observer) observer->finish(player); } catch (...) {}
}
LL_STATIC_HOOK(ArchiveSynchedActionFlag, ll::memory::HookPriority::Lowest, &SynchedActorDataAccess::setActorFlag,
    void, EntityContext& entity, ActorFlags flag, bool value) {
    bool action = flag == ActorFlags::Sneaking || flag == ActorFlags::Sprinting;
    if (action) if (auto actor = Actor::tryGetFromEntity(entity, false)) sample(*actor);
    origin(entity, flag, value);
    if (action) if (auto actor = Actor::tryGetFromEntity(entity, false)) sample(*actor);
}
LL_TYPE_INSTANCE_HOOK(ArchiveJumpPublication, ll::memory::HookPriority::Lowest, ll::event::EventBus,
    static_cast<void(ll::event::EventBus::*)(ll::event::Event&, ll::event::EventIdView const&)>(&ll::event::EventBus::publish),
    void, ll::event::Event& event, ll::event::EventIdView const& id) {
    origin(event, id);
    if (id == ll::event::getEventId<ll::event::PlayerJumpEvent>) {
        auto& jump = static_cast<ll::event::PlayerJumpEvent&>(event);
        if (!jump.isCancelled()) try { std::shared_lock guard(lifetime); if (observer) observer->jump(jump.self()); } catch (...) {}
    }
}
LL_TYPE_INSTANCE_HOOK(ArchiveSneakState, ll::memory::HookPriority::Lowest, Actor,
    MCARCHIVE_NATIVE_SYMBOL("?$setSneaking@Actor@@QEAAX_N@Z", &Actor::$setSneaking), void, bool value) { sample(*this); origin(value); sample(*this); }
LL_TYPE_INSTANCE_HOOK(ArchiveSprintState, ll::memory::HookPriority::Lowest, Mob,
    &Mob::$setSprinting, void, bool value) { sample(*this); origin(value); sample(*this); }
LL_TYPE_INSTANCE_HOOK(ArchiveActionDeath, ll::memory::HookPriority::Lowest, Player,
    &Player::$die, void, ActorDamageSource const& source) {
    sample(*this); origin(source); if (isDead()) finish(*this);
}
}
struct ActionTracker::Impl : Observer {
    struct State {
        json identity;
        std::string dimension;
        bool sneak, sprint;
        std::int64_t cursor, lastSeen;
    };
    Engine& engine;
    const std::int64_t anchorWall = nowMillis();
    const std::chrono::steady_clock::time_point anchorSteady = std::chrono::steady_clock::now();
    std::mutex mutex;
    std::unordered_map<std::string, State> players;
    std::deque<json> pending;
    std::vector<ll::event::ListenerPtr> listeners;
    std::size_t admitted = 0, lost = 0;
    ll::memory::HookRegistrar<ArchiveSneakState, ArchiveSprintState, ArchiveActionDeath, ArchiveSynchedActionFlag, ArchiveJumpPublication> hooks;
    std::int64_t now() const { return anchorWall + std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - anchorSteady).count(); }
    void enqueue(json event) {
        if (pending.size() < 32768) pending.push_back(std::move(event));
        else {
            engine.recordCaptureGap();
            if (++lost == 1) engine.note("Action observation backlog is full; capture gap detected");
        }
    }
    void counter(State const& state, char const* metric, std::int64_t value, std::int64_t at) {
        if (value <= 0) return;
        enqueue({{"eventId", uuid()}, {"kind", "COUNTER"}, {"at", timestamp(at)}, {"player", state.identity},
            {"dimension", state.dimension}, {"metric", metric}, {"value", value}});
    }
    void elapsed(State& state, std::int64_t at) {
        for (auto const& part : actionIntervals(state.cursor, std::max<std::int64_t>(0, at - state.cursor))) {
            if (state.sneak) counter(state, "actions.sneak_millis", part.millis, part.at);
            if (state.sprint) counter(state, "actions.sprint_millis", part.millis, part.at);
        }
        state.cursor = at;
    }
    void flush() {
        while (!pending.empty()) {
            auto group = json::array(); auto count = std::min<std::size_t>(64, pending.size());
            for (std::size_t i = 0; i < count; ++i) group.push_back(pending[i]);
            if (!engine.submitEvents(std::move(group))) return;
            for (std::size_t i = 0; i < count; ++i) pending.pop_front();
            admitted += count;
        }
    }
    explicit Impl(Engine& value) : engine(value) {
        auto& bus = ll::event::EventBus::getInstance();
        try {
            // Keep the emitter enabled, but count only after every listener has
            // returned so even a later listener at the same priority can cancel.
            listeners.push_back(bus.emplaceListener<ll::event::PlayerJumpEvent>([](auto&) {}, ll::event::EventPriority::Lowest));
            listeners.push_back(bus.emplaceListener<ll::event::PlayerSwingEvent>([this](auto& event) {
                std::shared_lock guard(lifetime); if (observer != this || !event.self().isPlayerInitialized() || event.self().isDead()) return;
                std::lock_guard lock(mutex);
                State state{playerIdentity(event.self()), playerDimension(event.self()), false, false, 0, 0};
                counter(state, "actions.swings", 1, now()); flush();
            }, ll::event::EventPriority::Lowest));
            listeners.push_back(bus.emplaceListener<ll::event::PlayerDisconnectEvent>([this](auto& event) {
                std::shared_lock guard(lifetime); if (observer == this) finish(event.self());
            }, ll::event::EventPriority::Lowest));
            for (auto const& listener : listeners) if (!listener) throw std::runtime_error("Action listener unavailable");
            std::unique_lock guard(lifetime);
            if (observer) throw std::runtime_error("Action observer already installed");
            observer = this;
        } catch (...) { for (auto const& listener : listeners) if (listener) bus.removeListener(listener); throw; }
    }
    ~Impl() {
        { std::unique_lock guard(lifetime); observer = nullptr; }
        for (auto const& listener : listeners) ll::event::EventBus::getInstance().removeListener(listener);
        std::lock_guard lock(mutex); auto at = now();
        for (auto& [key, state] : players) elapsed(state, at);
        flush();
        engine.recordCaptureGap(pending.size());
        engine.note("Action diagnostics: " + std::to_string(admitted) + " admitted events, " + std::to_string(pending.size()) + " unadmitted events, " + std::to_string(lost) + " lost observations");
    }
    void sample(Player const& player) override {
        if (!player.isPlayerInitialized()) return;
        auto key = stablePlayerKey(player); auto at = now();
        std::lock_guard lock(mutex);
        auto found = players.find(key);
        if (player.isDead()) {
            if (found != players.end()) { elapsed(found->second, at); players.erase(found); }
            flush(); return;
        }
        bool sneak = player.isSneaking(), sprint = player.isSprinting();
        auto dimension = playerDimension(player); auto identity = playerIdentity(player);
        if (found == players.end()) {
            // Starting collection while a flag is already true does not invent a start.
            players.emplace(std::move(key), State{std::move(identity), std::move(dimension), sneak, sprint, at, at}); return;
        }
        auto& state = found->second; state.lastSeen = at;
        bool changed = sneak != state.sneak || sprint != state.sprint || dimension != state.dimension;
        if (changed || at - state.cursor >= 5000) {
            elapsed(state, at);
            auto next = State{std::move(identity), std::move(dimension), sneak, sprint, at, at};
            if (sneak && !state.sneak) counter(next, "actions.sneak_starts", 1, at);
            if (sprint && !state.sprint) counter(next, "actions.sprint_starts", 1, at);
            state = std::move(next);
        }
        flush();
    }
    void jump(Player const& player) override {
        if (!player.isPlayerInitialized() || player.isDead()) return;
        std::lock_guard lock(mutex);
        State state{playerIdentity(player), playerDimension(player), false, false, 0, 0};
        counter(state, "actions.jumps", 1, now()); flush();
    }
    void finish(Player const& player) override {
        std::lock_guard lock(mutex); auto found = players.find(stablePlayerKey(player));
        if (found != players.end()) { elapsed(found->second, now()); players.erase(found); }
        flush();
    }
    void tick(Level& level) {
        std::unordered_set<std::string> present;
        level.forEachPlayer([&](Player& player) {
            try { present.insert(stablePlayerKey(player)); sample(player); } catch (...) {}
            return true;
        });
        std::lock_guard lock(mutex);
        for (auto it = players.begin(); it != players.end();) {
            if (!present.contains(it->first)) { elapsed(it->second, it->second.lastSeen); it = players.erase(it); }
            else ++it;
        }
        flush();
    }
};
ActionTracker::ActionTracker(Engine& engine) : impl_(std::make_unique<Impl>(engine)) {}
ActionTracker::~ActionTracker() = default;
void ActionTracker::tick(Level& level) { impl_->tick(level); }
}
