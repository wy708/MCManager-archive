#include "plugin/RuntimeApi.h"
#include "plugin/BreedTracker.h"
#include "core/Platform.h"
#include "ll/api/memory/Hook.h"
#include "mc/deps/ecs/WeakEntityRef.h"
#include "mc/deps/game_refs/OwnerPtr.h"
#include "mc/entity/components_json_legacy/BreedableComponent.h"
#include "mc/world/actor/Actor.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/gamemode/InteractionResult.h"
#include "mc/world/level/BlockSource.h"
#include "mc/world/level/Level.h"
#include "plugin/GameTracker.h"
#include <algorithm>
#include <atomic>
#include <deque>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace mcarchive {
namespace {
using json = nlohmann::json;
struct Person {
    json identity;
    std::string key;
    ActorUniqueID actor;
    bool cached = false;
};
struct Capture {
    virtual void submit(json) = 0;
    virtual ~Capture() = default;
};
std::shared_mutex lifetime;
Capture *capture = nullptr;
std::mutex state;
std::unordered_map<ActorUniqueID, Person> feeders;
std::unordered_set<ActorUniqueID> observed;
std::atomic<std::size_t> births{0}, duplicates{0}, unassigned{0}, ambiguous{0}, invalidResults{0},
    capacityGaps{0}, cachedCredits{0};
struct Love {
    ActorUniqueID cause;
    int timer;
};
std::optional<Love> love(Actor const &actor) noexcept {
    try {
        auto component = actor.getEntityContext().tryGetComponent<BreedableComponent>();
        if (component)
            return Love{component->mLoveCause, int(component->mLoveTimer)};
    } catch (...) {
    }
    return {};
}
std::optional<Person> feeder(Actor const &parent) noexcept {
    try {
        auto current = love(parent);
        if (!current || current->timer <= 0)
            return {};
        auto actor = parent.getLevel().MCARCHIVE_FETCH_ENTITY(current->cause, false);
        if (actor && actor->isPlayer()) {
            auto &player = static_cast<Player &>(*actor);
            if (player.isPlayerInitialized())
                return Person{playerIdentity(player), stablePlayerKey(player), current->cause};
        }
        std::shared_lock alive(lifetime);
        if (!capture)
            return {};
        std::lock_guard lock(state);
        auto found = feeders.find(parent.getOrCreateUniqueID());
        if (found != feeders.end() && found->second.actor == current->cause) {
            auto person = found->second;
            person.cached = true;
            return person;
        }
    } catch (...) {
    }
    return {};
}
void rememberFeeding(Player const &player, Actor const &parent, std::optional<Love> before) noexcept {
    try {
        auto after = love(parent);
        auto playerId = player.getOrCreateUniqueID();
        if (!player.isPlayerInitialized() || !after || after->timer <= 0 || after->cause != playerId ||
            (before && before->cause == after->cause && after->timer <= before->timer))
            return;
        Person person{playerIdentity(player), stablePlayerKey(player), playerId};
        std::shared_lock alive(lifetime);
        if (!capture)
            return;
        std::lock_guard lock(state);
        auto id = parent.getOrCreateUniqueID();
        if (feeders.size() < 32768 || feeders.contains(id))
            feeders.insert_or_assign(id, std::move(person));
        else
            ++capacityGaps;
    } catch (...) {
    }
}
struct MatingScope;
thread_local MatingScope *mating = nullptr;
struct MatingScope {
    MatingScope *previous;
    std::vector<ActorUniqueID> added;
    MatingScope() : previous(mating) { mating = this; }
    ~MatingScope() { mating = previous; }
};
LL_TYPE_INSTANCE_HOOK(ArchiveBreedingAddedEntity, ll::memory::HookPriority::Lowest, Level, &Level::$addEntity,
                      Actor *, BlockSource &region, OwnerPtr<EntityContext> entity) {
    auto actor = origin(region, std::move(entity));
    try {
        if (actor && mating && actor->hasUniqueID()) {
            auto id = actor->getOrCreateUniqueID();
            for (auto scope = mating; scope; scope = scope->previous) {
                if (scope->added.size() < 256)
                    scope->added.push_back(id);
                else
                    ++capacityGaps;
            }
        }
    } catch (...) {
    }
    return actor;
}
LL_TYPE_INSTANCE_HOOK(ArchiveBreedingFeed, ll::memory::HookPriority::Lowest, Player, &Player::interact,
                      InteractionResult, Actor &actor, Vec3 const &location MCARCHIVE_INTERACT_HAND_PARAMETER) {
    auto before = love(actor);
    auto result = origin(actor, location MCARCHIVE_INTERACT_HAND_ARGUMENT);
    rememberFeeding(*this, actor, before);
    return result;
}
LL_TYPE_INSTANCE_HOOK(ArchiveBreedingResult, ll::memory::HookPriority::Highest, BreedableComponent,
                      &BreedableComponent::mate, std::vector<WeakEntityRef>, Actor &owner, Actor &partner) {
    auto first = feeder(owner), second = feeder(partner);
    bool different = first && second && first->key != second->key;
    std::optional<Person> person;
    if (first && second && !different) {
        person = std::move(first);
        person->cached = person->cached || second->cached;
    }
    MatingScope scope;
    auto result = origin(owner, partner);
    try {
        for (auto const &weak : result) {
            auto locked = weak.lock();
            auto actor = locked.tryUnwrap();
            if (!actor || actor->isDead() || !actor->hasCategory(ActorCategory::Mob) ||
                actor.as_ptr() == &owner || actor.as_ptr() == &partner) {
                ++invalidResults;
                continue;
            }
            auto id = actor->getOrCreateUniqueID();
            if (std::find(scope.added.begin(), scope.added.end(), id) == scope.added.end() ||
                owner.getLevel().MCARCHIVE_FETCH_ENTITY(id, false) != actor.as_ptr()) {
                ++invalidResults;
                continue;
            }
            std::shared_lock alive(lifetime);
            if (!capture)
                continue;
            {
                std::lock_guard lock(state);
                if (observed.contains(id)) {
                    ++duplicates;
                    continue;
                }
                if (observed.size() >= 32768) {
                    ++capacityGaps;
                    continue;
                }
                observed.insert(id);
            }
            ++births;
            if (!person) {
                ++unassigned;
                if (different)
                    ++ambiguous;
                continue;
            }
            int dimension = static_cast<int>(actor->getDimensionId());
            std::string name = dimension == 0   ? "minecraft:overworld"
                               : dimension == 1 ? "minecraft:nether"
                               : dimension == 2 ? "minecraft:the_end"
                                                : "bedrock:dimension_" + std::to_string(dimension);
            capture->submit({{"eventId", uuid()},
                             {"kind", "COUNTER"},
                             {"at", timestamp(nowMillis())},
                             {"player", person->identity},
                             {"dimension", name},
                             {"metric", "breeding.offspring"},
                             {"value", 1},
                             {"subject", actor->getTypeName()}});
            if (person->cached)
                ++cachedCredits;
        }
    } catch (...) {
    }
    return result;
}
} // namespace
struct BreedTracker::Impl : Capture {
    Engine &engine;
    std::mutex mutex;
    std::deque<json> pending;
    std::size_t admitted = 0, lost = 0, ticks = 0;
    ll::memory::HookRegistrar<ArchiveBreedingAddedEntity, ArchiveBreedingFeed, ArchiveBreedingResult> hooks;
    explicit Impl(Engine &engine) : engine(engine) {
        std::unique_lock alive(lifetime);
        if (capture)
            throw std::runtime_error("Breeding tracker already installed");
        std::lock_guard lock(state);
        feeders.clear();
        observed.clear();
        births = 0;
        duplicates = 0;
        unassigned = 0;
        ambiguous = 0;
        invalidResults = 0;
        capacityGaps = 0;
        cachedCredits = 0;
        capture = this;
    }
    void flush() {
        while (!pending.empty()) {
            json batch = json::array();
            auto count = std::min<std::size_t>(64, pending.size());
            for (std::size_t i = 0; i < count; ++i)
                batch.push_back(pending[i]);
            if (!engine.submitEvents(std::move(batch)))
                return;
            for (std::size_t i = 0; i < count; ++i)
                pending.pop_front();
            admitted += count;
        }
    }
    void submit(json event) override {
        std::lock_guard lock(mutex);
        flush();
        if (pending.size() < 32768)
            pending.push_back(std::move(event));
        else {
            engine.recordCaptureGap();
            if (++lost == 1) engine.note("Breeding backlog is full; capture gap detected");
        }
        flush();
    }
    void tick(Level &level) {
        {
            std::lock_guard lock(mutex);
            flush();
        }
        if (++ticks % 20)
            return;
        std::lock_guard lock(state);
        std::erase_if(feeders, [&](auto const &item) {
            auto actor = level.MCARCHIVE_FETCH_ENTITY(item.first, false);
            if (!actor || actor->isDead())
                return true;
            auto current = love(*actor);
            return !current || current->timer <= 0 || current->cause != item.second.actor;
        });
        std::erase_if(observed, [&](auto id) {
            auto actor = level.MCARCHIVE_FETCH_ENTITY(id, false);
            return !actor || actor->isDead();
        });
    }
    ~Impl() {
        {
            std::unique_lock alive(lifetime);
            capture = nullptr;
        }
        std::lock_guard lock(mutex);
        flush();
        engine.recordCaptureGap(pending.size());
        engine.note("Breeding diagnostics: " + std::to_string(admitted) + " admitted, " +
                    std::to_string(pending.size()) + " pending, " + std::to_string(lost) + " lost; births=" +
                    std::to_string(births.load()) + " duplicates=" + std::to_string(duplicates.load()) +
                    " unassigned=" + std::to_string(unassigned.load()) +
                    " ambiguous=" + std::to_string(ambiguous.load()) +
                    " invalidResults=" + std::to_string(invalidResults.load()) +
                    " capacityGaps=" + std::to_string(capacityGaps.load()) +
                    " cachedFeedCredits=" + std::to_string(cachedCredits.load()));
        std::lock_guard stateLock(state);
        feeders.clear();
        observed.clear();
    }
};
BreedTracker::BreedTracker(Engine &engine) : impl_(std::make_unique<Impl>(engine)) {}
BreedTracker::~BreedTracker() = default;
void BreedTracker::tick(Level &level) { impl_->tick(level); }
} // namespace mcarchive
