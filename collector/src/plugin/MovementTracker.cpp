#include "plugin/RuntimeApi.h"
#include "plugin/MovementTracker.h"
#include "core/ActionIntervals.h"
#include "core/Platform.h"
#include "ll/api/event/EventBus.h"
#include "ll/api/event/player/PlayerDisconnectEvent.h"
#include "ll/api/memory/Hook.h"
#include "mc/entity/components/MoveInputComponent.h"
#include "mc/server/ServerPlayer.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/level/Level.h"
#include "plugin/GameTracker.h"
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <map>
#include <mutex>
#include <shared_mutex>
#include <string_view>
#include <unordered_map>

namespace mcarchive {
namespace {
using json = nlohmann::json;
constexpr char activityMetric[] = "activity.millis";

struct Observer {
    virtual void boundary(Actor &, bool) = 0;
    virtual void disconnect(Player const &) = 0;
    virtual void signal(json const &, bool, bool) = 0;
    virtual ~Observer() = default;
};
std::shared_mutex lifetime;
Observer *observer = nullptr;

void boundary(Actor &actor, bool newLife = false) noexcept {
    try {
        std::shared_lock lock(lifetime);
        if (observer)
            observer->boundary(actor, newLife);
    } catch (...) {
    }
}

LL_TYPE_INSTANCE_HOOK(ArchiveMovementPlayerTeleport, ll::memory::HookPriority::Lowest, Player,
                      &Player::$teleportTo, void, Vec3 const &position, bool stopRiding, int cause,
                      int sourceType, bool keepVelocity) {
    origin(position, stopRiding, cause, sourceType, keepVelocity);
    boundary(*this);
}
LL_TYPE_INSTANCE_HOOK(ArchiveMovementMobTeleport, ll::memory::HookPriority::Lowest, Mob, &Mob::$teleportTo,
                      void, Vec3 const &position, bool stopRiding, int cause, int sourceType,
                      bool keepVelocity) {
    origin(position, stopRiding, cause, sourceType, keepVelocity);
    boundary(*this);
}
LL_TYPE_INSTANCE_HOOK(ArchiveMovementActorTeleport, ll::memory::HookPriority::Lowest, Actor,
                      &Actor::$teleportTo, void, Vec3 const &position, bool stopRiding, int cause,
                      int sourceType, bool keepVelocity) {
    origin(position, stopRiding, cause, sourceType, keepVelocity);
    boundary(*this);
}
LL_TYPE_INSTANCE_HOOK(ArchiveMovementRespawn, ll::memory::HookPriority::Lowest, ServerPlayer,
                      MCARCHIVE_NATIVE_SYMBOL("?$respawn@ServerPlayer@@QEAAXXZ", &ServerPlayer::$respawn), void) {
    origin();
    boundary(*this, true);
}

bool activityCounter(std::string_view metric) {
    constexpr std::array<std::string_view, 13> signals{
        "blocks.mined",          "blocks.placed",    "crops.planted",
        "crops.harvested",       "crops.interacted", "items.used",
        "actions.jumps",         "actions.swings",   "actions.sneak_starts",
        "actions.sprint_starts", "crafting.crafts",  "villager.trades",
        "fishing.retrievals"};
    return std::find(signals.begin(), signals.end(), metric) != signals.end();
}

void observeEvent(json const &event) noexcept {
    try {
        auto const &kind = event.at("kind").get_ref<std::string const &>();
        std::string_view metric;
        if (kind == "COUNTER")
            metric = event.at("metric").get_ref<std::string const &>();
        bool dimensionBoundary = metric == "dimension.visits";
        bool death = kind == "DEATH";
        if (!dimensionBoundary && !death && kind != "CHAT" && !activityCounter(metric))
            return;
        std::shared_lock lock(lifetime);
        if (observer)
            observer->signal(event, dimensionBoundary, death);
    } catch (...) {
    }
}

// Input is the collector's own UTC timestamp, before serialization to the outbox.
std::int64_t eventMillis(std::string const &time) {
    int year, month, day, hour, minute, second, millis;
    if (time.size() != 24 || sscanf_s(time.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d.%3dZ", &year, &month, &day,
                                      &hour, &minute, &second, &millis) != 7)
        return 0;
    std::tm utc{};
    utc.tm_year = year - 1900;
    utc.tm_mon = month - 1;
    utc.tm_mday = day;
    utc.tm_hour = hour;
    utc.tm_min = minute;
    utc.tm_sec = second;
    return _mkgmtime64(&utc) * 1000 + millis;
}

TravelMode mode(Player const &player, Actor const *vehicle) {
    if (vehicle)
        return TravelMode::Vehicle;
    if (player.isGliding())
        return TravelMode::Glide;
    if (player.isFlying())
        return TravelMode::Fly;
    if (player.isSwimming() || (player.isInWater() && !player.isOnGround()))
        return TravelMode::Swim;
    return TravelMode::Walk;
}

bool hasMotionInput(Player &player) {
    auto input = player.getEntityContext().tryGetComponent<MoveInputComponent>();
    if (!input)
        return false;
    using Flag = MoveInputComponent::Flag;
    auto flag = [&](Flag value) { return input->mFlagValues->test(static_cast<std::size_t>(value)); };
    return std::hypot(input->mMove->x, input->mMove->y) >= 0.01 || flag(Flag::WantUp) ||
           flag(Flag::WantDown) || (*input->mIsPaddling)[0] || (*input->mIsPaddling)[1];
}
} // namespace

struct MovementTracker::Impl : Observer {
    struct State {
        json identity;
        std::string dimension;
        std::int64_t actorId = 0, lifeAt = 0, lastSeen = 0, activityAt = 0, activeUntil = 0;
        std::int64_t lastSignal = 0, lastBoundary = 0;
        std::optional<MotionPoint> previous;
    };
    struct BucketKey {
        std::string player, dimension, metric, subject;
        std::int64_t minute;
        auto operator<=>(BucketKey const &) const = default;
    };
    struct Bucket {
        json identity;
        std::int64_t at, value;
    };
    Engine &engine;
    std::int64_t const idleMillis;
    std::int64_t const anchorWall = nowMillis();
    std::chrono::steady_clock::time_point const anchorSteady = std::chrono::steady_clock::now();
    std::int64_t nextSample = 0, nextFlush = 0;
    std::mutex mutex;
    std::unordered_map<std::string, State> players;
    std::map<BucketKey, Bucket> buckets;
    std::size_t emitted = 0, gaps = 0, segments = 0, excluded = 0, signals = 0, teleports = 0;
    ll::event::ListenerPtr disconnected;
    ll::memory::HookRegistrar<ArchiveMovementPlayerTeleport, ArchiveMovementMobTeleport,
                              ArchiveMovementActorTeleport, ArchiveMovementRespawn>
        hooks;

    Impl(Engine &value, int idleSeconds) : engine(value), idleMillis(std::int64_t(idleSeconds) * 1000) {
        auto &bus = ll::event::EventBus::getInstance();
        std::unique_lock guard(lifetime);
        if (observer)
            throw std::runtime_error("Movement tracker already installed");
        disconnected = bus.emplaceListener<ll::event::PlayerDisconnectEvent>([](auto &event) {
            try {
                std::shared_lock lock(lifetime);
                if (observer)
                    observer->disconnect(event.self());
            } catch (...) {
            }
        });
        if (!disconnected)
            throw std::runtime_error("Movement disconnect listener unavailable");
        observer = this;
        engine.setEventObserver(observeEvent);
    }
    ~Impl() {
        engine.setEventObserver(nullptr);
        {
            std::unique_lock guard(lifetime);
            observer = nullptr;
        }
        ll::event::EventBus::getInstance().removeListener(disconnected);
        std::lock_guard lock(mutex);
        flush();
        engine.recordCaptureGap(buckets.size());
        engine.note("Movement diagnostics: " + std::to_string(emitted) + " admitted, " +
                    std::to_string(buckets.size()) + " pending, " + std::to_string(gaps) +
                    " gaps; segments=" + std::to_string(segments) + " excluded=" + std::to_string(excluded) +
                    " activitySignals=" + std::to_string(signals) +
                    " teleportBoundaries=" + std::to_string(teleports));
    }
    std::int64_t now() const {
        return anchorWall + std::chrono::duration_cast<std::chrono::milliseconds>(
                                std::chrono::steady_clock::now() - anchorSteady)
                                .count();
    }
    void add(std::string const &key, State const &state, char const *metric, std::string const &subject,
             std::int64_t at, std::int64_t value) {
        BucketKey bucketKey{key, state.dimension, metric, subject, at / 60'000};
        auto found = buckets.find(bucketKey);
        if (found != buckets.end()) {
            found->second.at = std::max(found->second.at, at);
            found->second.value += value;
        } else if (buckets.size() < 32768) {
            buckets.emplace(std::move(bucketKey), Bucket{state.identity, at, value});
        } else {
            engine.recordCaptureGap();
            if (++gaps == 1) engine.note("Movement aggregation backlog is full; capture gap detected");
        }
    }
    void flush() {
        while (!buckets.empty()) {
            auto events = json::array();
            auto end = buckets.begin();
            for (; end != buckets.end() && events.size() < 64; ++end) {
                auto const &[key, data] = *end;
                events.push_back({{"eventId", uuid()},
                                  {"kind", "COUNTER"},
                                  {"at", timestamp(data.at)},
                                  {"player", data.identity},
                                  {"dimension", key.dimension},
                                  {"metric", key.metric},
                                  {"subject", key.subject},
                                  {"value", data.value}});
            }
            auto size = events.size();
            if (!engine.submitEvents(std::move(events)))
                return;
            buckets.erase(buckets.begin(), end);
            emitted += size;
        }
    }
    void advanceActivity(std::string const &key, State &state, std::int64_t at) {
        auto start = state.activityAt;
        if (at < start)
            return;
        state.activityAt = at;
        if (!start || at - start > maxSampleGap)
            return;
        auto elapsed = std::min(at, state.activeUntil) - start;
        if (elapsed <= 0)
            return;
        for (auto const &part : actionIntervals(start, elapsed))
            add(key, state, activityMetric, "archive:active", part.at, part.millis);
    }
    void refreshActivity(State &state, std::int64_t at) {
        if (at <= state.lastSignal)
            return;
        state.lastSignal = at;
        state.activeUntil = at + idleMillis;
        ++signals;
    }
    void disconnect(Player const &player) override {
        auto key = stablePlayerKey(player);
        std::lock_guard lock(mutex);
        players.erase(key);
    }
    void boundary(Actor &actor, bool newLife) override {
        auto id = actor.getOrCreateUniqueID().rawID;
        auto at = now();
        std::lock_guard lock(mutex);
        for (auto &[key, state] : players) {
            if (state.actorId != id && (!state.previous || state.previous->carrier != id))
                continue;
            state.previous.reset();
            if (newLife) {
                state.lifeAt = at;
                state.activityAt = state.activeUntil = state.lastSignal = 0;
            } else
                ++teleports;
        }
    }
    void signal(json const &event, bool dimensionBoundary, bool death) override {
        auto const &identity = event.at("player");
        auto key = std::string(identity.at("identityType") == "XUID" ? "xuid:" : "uuid:") +
                   identity.at("identity").get_ref<std::string const &>();
        auto at = eventMillis(event.at("at").get_ref<std::string const &>());
        auto observedAt = now();
        if (at <= 0 || at > observedAt + maxSampleGap)
            return;
        at = std::min(at, observedAt);
        std::lock_guard lock(mutex);
        auto found = players.find(key);
        if (found == players.end())
            return;
        auto &state = found->second;
        if (at < state.lifeAt)
            return;
        if (dimensionBoundary || death) {
            if (at <= state.lastBoundary)
                return;
            state.lastBoundary = at;
            state.previous.reset();
            state.activityAt = 0;
            if (death) {
                state.activeUntil = state.lastSignal = 0;
                state.lifeAt = at;
            }
            return;
        }
        if (!state.activityAt || at <= state.lastSignal || at <= state.lastBoundary ||
            event.at("dimension") != state.dimension || at < observedAt - maxSampleGap)
            return;
        advanceActivity(key, state, at);
        refreshActivity(state, at);
    }
    void sample(Player &player, std::int64_t at) {
        auto key = stablePlayerKey(player);
        if (!player.isPlayerInitialized() || player.isDead() || player.isSpectator() || player.isSleeping()) {
            players.erase(key);
            return;
        }
        auto id = player.getOrCreateUniqueID().rawID;
        auto dimension = playerDimension(player);
        auto &state = players[key];
        if (state.actorId != id || !state.lifeAt) {
            state = {};
            state.identity = playerIdentity(player);
            state.actorId = id;
            state.lifeAt = at;
        }
        if (state.dimension != dimension) {
            state.previous.reset();
            state.activityAt = 0;
            state.dimension = std::move(dimension);
        }
        state.lastSeen = at;
        advanceActivity(key, state, at);
        auto *vehicle = player.getVehicle();
        auto movementMode = mode(player, vehicle);
        auto const &position = vehicle ? vehicle->getPosition() : player.getPosition();
        MotionPoint point{position.x,
                          position.y,
                          position.z,
                          at,
                          movementMode,
                          static_cast<int>(player.getDimensionId()),
                          vehicle ? vehicle->getOrCreateUniqueID().rawID : 0};
        if (state.previous) {
            auto distance = travelMillimeters(*state.previous, point);
            if (!distance)
                ++excluded;
            else if (*distance > 0) {
                ++segments;
                auto subject = vehicle ? vehicle->getTypeName() : "minecraft:player";
                add(key, state, travelMetrics[static_cast<unsigned>(movementMode)], subject, at - 1,
                    *distance);
                if (*distance >= 50 && hasMotionInput(player))
                    refreshActivity(state, at);
            }
        }
        state.previous = point;
    }
    void tick(Level &level) {
        auto at = now();
        if (at < nextSample)
            return;
        nextSample = at + 100;
        std::lock_guard lock(mutex);
        level.forEachPlayer([&](Player &player) {
            try {
                sample(player, at);
            } catch (...) {
                ++gaps;
                engine.recordCaptureGap();
            }
            return true;
        });
        for (auto it = players.begin(); it != players.end();) {
            auto &state = it->second;
            if (at - state.lastSeen >= 10'000) {
                it = players.erase(it);
                continue;
            }
            if (state.lastSeen != at) {
                state.previous.reset();
                state.activityAt = 0;
            }
            ++it;
        }
        if (at >= nextFlush) {
            nextFlush = at + 2000;
            flush();
        }
    }
};
MovementTracker::MovementTracker(Engine &engine, int idleSeconds)
    : impl_(std::make_unique<Impl>(engine, idleSeconds)) {}
MovementTracker::~MovementTracker() = default;
void MovementTracker::tick(Level &level) { impl_->tick(level); }
} // namespace mcarchive
