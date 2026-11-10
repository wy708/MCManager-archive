#include "plugin/RuntimeApi.h"
#include "plugin/FishingTracker.h"
#include "core/Platform.h"
#include "ll/api/memory/Hook.h"
#include "mc/world/actor/FishingHook.h"
#include "mc/world/actor/item/ItemActor.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/level/Level.h"
#include "mc/world/level/Spawner.h"
#include "plugin/GameTracker.h"
#include <atomic>
#include <deque>
#include <map>
#include <mutex>
#include <shared_mutex>
#include <unordered_set>

namespace mcarchive {
namespace {
using json = nlohmann::json;
struct Capture {
    virtual void submit(json) = 0;
    virtual ~Capture() = default;
};
std::shared_mutex lifetime;
Capture *capture = nullptr;
std::atomic<std::size_t> retrievals{0}, pulls{0}, catches{0}, gaps{0};
struct Scope;
thread_local Scope *current = nullptr;
struct Scope {
    Scope *previous = current;
    FishingHook *hook;
    bool valid = false, overflow = false;
    ActorUniqueID owner{-1};
    json identity;
    std::string dimension;
    std::unordered_set<std::int64_t> spawned;
    std::map<std::int64_t, std::pair<std::string, std::uint64_t>> pulled;
    explicit Scope(FishingHook *value) : hook(value) { current = this; }
    ~Scope() { current = previous; }
};
Scope *scopeFor(FishingHook *hook) {
    for (auto *scope = current; scope; scope = scope->previous)
        if (scope->hook == hook)
            return scope;
    return nullptr;
}
Player *ownerOf(FishingHook &hook) {
    auto *actor = hook.getLevel().MCARCHIVE_FETCH_ENTITY(hook.getSourceUniqueID(), false);
    if (!actor || !actor->isPlayer())
        return nullptr;
    auto *player = static_cast<Player *>(actor);
    return player->isPlayerInitialized() && !player->isDead() ? player : nullptr;
}
#if defined(MCARCHIVE_BDS_12661)
FishingHook* nativeFishingHook(Actor& actor) {
    // Native behavior also checks the entity type and resets a stale ID. Keep
    // that behavior instead of replacing this helper with fetchEntity alone.
    static_assert(offsetof(Actor, mFishingHookID) == 0x3c8);
    static_assert(offsetof(Actor, mLevel) == 0x200);
    using Fn = FishingHook* (*)(Actor*);
    static auto fn = reinterpret_cast<Fn>(ll::memory::SymbolView{"?fetchFishingHook@Actor@@QEAAPEAVFishingHook@@XZ"}.resolve());
    if (!fn) throw std::runtime_error("Native fishing hook lookup is unavailable");
    return fn(&actor);
}
#else
FishingHook* nativeFishingHook(Actor& actor) { return actor.fetchFishingHook(); }
#endif
LL_TYPE_INSTANCE_HOOK(ArchiveFishingSpawn, ll::memory::HookPriority::Lowest, Spawner, &Spawner::$spawnItem,
                      ItemActor *, BlockSource &region, ItemStack const &item, Actor *spawner,
                      Vec3 const &position, int throwTime) {
    auto *result = origin(region, item, spawner, position, throwTime);
    try {
        // Only a new entity returned by this hook's own native loot spawn is a
        // candidate. An old fishing-marked item hooked later is never new loot.
        for (auto *scope = current; scope; scope = scope->previous) {
            if (!scope->valid || scope->hook != spawner || !result)
                continue;
            if (scope->spawned.size() >= 256)
                scope->overflow = true;
            else
                scope->spawned.insert(result->getOrCreateUniqueID().rawID);
            break;
        }
    } catch (...) {
        if (current)
            current->overflow = true;
    }
    return result;
}
LL_TYPE_INSTANCE_HOOK(ArchiveFishingPull, ll::memory::HookPriority::Lowest, FishingHook,
                      &FishingHook::_pullCloser, void, Actor &actor, float speed) {
    auto before = actor.getPosDelta();
    origin(actor, speed);
    try {
        auto *scope = scopeFor(this);
        if (!scope || !scope->valid || !actor.hasCategory(ActorCategory::Item) || actor.mRemoved)
            return;
        auto after = actor.getPosDelta();
        if (before.x == after.x && before.y == after.y && before.z == after.z)
            return;
        auto &item = static_cast<ItemActor &>(actor).item();
        if (!item.mCount || item.getTypeName().empty())
            return;
        auto id = actor.getOrCreateUniqueID();
        if (getLevel().MCARCHIVE_FETCH_ENTITY(id, false) != &actor)
            return;
        if (scope->pulled.size() >= 256)
            scope->overflow = true;
        else
            scope->pulled.insert_or_assign(id.rawID,
                                           std::pair{item.getTypeName(), std::uint64_t(item.mCount)});
    } catch (...) {
        if (auto *scope = scopeFor(this))
            scope->overflow = true;
    }
}
LL_TYPE_INSTANCE_HOOK(ArchiveFishingRetrieve, ll::memory::HookPriority::Lowest, FishingHook,
                      &FishingHook::retrieve, int) {
    Scope scope(this);
    try {
        std::shared_lock alive(lifetime);
        auto *player = ownerOf(*this);
        if (capture && !mRemoved && player && nativeFishingHook(*player) == this) {
            scope.identity = playerIdentity(*player);
            scope.owner = player->getOrCreateUniqueID();
            scope.dimension = playerDimension(*player);
            scope.valid = true;
        }
    } catch (...) {
        ++gaps;
    }
    auto result = origin();
    try {
        std::shared_lock alive(lifetime);
        if (!capture || !scope.valid || !mRemoved)
            return result;
        auto *player = ownerOf(*this);
        if (!player || player->getOrCreateUniqueID() != scope.owner ||
            playerDimension(*player) != scope.dimension)
            return result;
        if (scope.overflow) {
            ++gaps;
            return result;
        }
        std::map<std::string, std::uint64_t> outputs, pulled;
        for (auto const &[id, item] : scope.pulled)
            pulled[item.first] += item.second;
        for (auto id : scope.spawned) {
            auto *actor = getLevel().MCARCHIVE_FETCH_ENTITY(ActorUniqueID{id}, false);
            if (!actor || actor->mRemoved || !actor->hasCategory(ActorCategory::Item))
                continue;
            auto &itemActor = static_cast<ItemActor &>(*actor);
            auto &item = itemActor.item();
            if (itemActor.isFromFishing() && item.mCount && !item.getTypeName().empty())
                outputs[item.getTypeName()] += std::uint64_t(item.mCount);
        }
        auto events = json::array();
        auto at = timestamp(nowMillis());
        auto event = [&](char const *metric, std::uint64_t count, std::string const &subject) {
            events.push_back({{"eventId", uuid()},
                              {"kind", "COUNTER"},
                              {"at", at},
                              {"player", scope.identity},
                              {"dimension", scope.dimension},
                              {"metric", metric},
                              {"value", count},
                              {"subject", subject}});
        };
        event("fishing.retrievals", 1, "minecraft:fishing_hook");
        if (!pulled.empty()) {
            event("fishing.item_pull_events", 1, pulled.begin()->first);
            for (auto const &[type, count] : pulled)
                event("fishing.items_pulled", count, type);
        }
        if (!outputs.empty()) {
            event("fishing.catch_events", 1, outputs.begin()->first);
            for (auto const &[type, count] : outputs)
                event("fishing.catches", count, type);
        }
        capture->submit(std::move(events));
        ++retrievals;
        if (!pulled.empty())
            ++pulls;
        if (!outputs.empty())
            ++catches;
    } catch (...) {
        ++gaps;
    }
    return result;
}
} // namespace
struct FishingTracker::Impl : Capture {
    Engine &engine;
    std::mutex mutex;
    std::deque<json> pending;
    std::size_t admitted = 0, events = 0, lost = 0;
    ll::memory::HookRegistrar<ArchiveFishingRetrieve, ArchiveFishingPull, ArchiveFishingSpawn> hooks;
    explicit Impl(Engine &value) : engine(value) {
        std::unique_lock alive(lifetime);
        if (capture)
            throw std::runtime_error("Fishing tracker already installed");
        retrievals = 0;
        pulls = 0;
        catches = 0;
        gaps = 0;
        capture = this;
    }
    void flush() {
        while (!pending.empty()) {
            auto count = pending.front().size();
            if (!engine.submitEvents(pending.front()))
                return;
            pending.pop_front();
            events -= count;
            admitted += count;
        }
    }
    void submit(json batch) override {
        std::lock_guard lock(mutex);
        flush();
        if (events + batch.size() <= 32768) {
            events += batch.size();
            pending.push_back(std::move(batch));
        } else {
            engine.recordCaptureGap();
            if (++lost == 1) engine.note("Fishing result backlog is full; capture gap detected");
        }
        flush();
    }
    ~Impl() {
        {
            std::unique_lock alive(lifetime);
            capture = nullptr;
        }
        std::lock_guard lock(mutex);
        flush();
        engine.recordCaptureGap(pending.size() + gaps.load());
        engine.note(
            "Fishing diagnostics: " + std::to_string(admitted) + " admitted, " + std::to_string(events) +
            " pending, " + std::to_string(lost) + " lost; retrievals=" + std::to_string(retrievals.load()) +
            " itemPulls=" + std::to_string(pulls.load()) + " catches=" + std::to_string(catches.load()) +
            " capacityGaps=" + std::to_string(gaps.load()));
    }
};
FishingTracker::FishingTracker(Engine &engine) : impl_(std::make_unique<Impl>(engine)) {}
FishingTracker::~FishingTracker() = default;
void FishingTracker::tick() {
    std::lock_guard lock(impl_->mutex);
    impl_->flush();
}
} // namespace mcarchive
