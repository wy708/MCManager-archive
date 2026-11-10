#include "plugin/RuntimeApi.h"
#include "plugin/LevelObserver.h"
#include "plugin/GameTracker.h"
#include "core/Platform.h"
#include "ll/api/memory/Hook.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/attribute/AttributeInstance.h"
#include "mc/world/attribute/AttributeInstanceConstRef.h"
#include "mc/world/level/Level.h"
#include <chrono>
#include <cmath>
#include <mutex>
#include <shared_mutex>
#include <unordered_map>
#include <unordered_set>

namespace mcarchive {
namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
struct Observer { virtual void sample(Player const&) = 0; virtual ~Observer() = default; };
std::shared_mutex lifetime;
Observer* observer = nullptr;
void sample(Player const& player) noexcept {
    try { std::shared_lock lock(lifetime); if (observer) observer->sample(player); } catch (...) {}
}
// Observe the actual attribute around execution, never the requested level or XP.
// These hooks also retain short-lived levels changed again before the next tick.
LL_TYPE_INSTANCE_HOOK(ArchiveObservedExperienceLevel, ll::memory::HookPriority::Lowest,
    Player, &Player::$addExperience, void, int amount) {
    sample(*this); origin(amount); sample(*this);
}
LL_TYPE_INSTANCE_HOOK(ArchiveObservedAddedLevel, ll::memory::HookPriority::Lowest,
    Player, MCARCHIVE_NATIVE_SYMBOL("?$addLevels@Player@@QEAAXH@Z", &Player::$addLevels), void, int amount) {
    sample(*this); origin(amount); sample(*this);
}
}
struct LevelObserver::Impl : Observer {
    struct Sample { std::int64_t value; std::string dimension; Clock::time_point published; };
    Engine& engine;
    std::mutex mutex;
    std::unordered_map<std::string, Sample> previous;
    Clock::time_point nextScan{};
    std::size_t observations = 0;
    ll::memory::HookRegistrar<ArchiveObservedExperienceLevel, ArchiveObservedAddedLevel> hooks;
    explicit Impl(Engine& value) : engine(value) {
        std::unique_lock lock(lifetime);
        if (observer) throw std::runtime_error("Level observer already installed");
        observer = this;
    }
    ~Impl() {
        { std::unique_lock lock(lifetime); observer = nullptr; }
        engine.note("Level diagnostics: " + std::to_string(observations) + " accepted observations; quality=OBSERVED");
    }
    void sample(Player const& player) override {
        if (!player.isPlayerInitialized()) return;
        auto attribute = player.getAttribute(Player::LEVEL());
        if (!attribute.mPtr) return;
        double value = attribute.mPtr->mCurrentValue;
        if (!std::isfinite(value) || value < 0 || value > 1'000'000'000 || std::floor(value) != value) return;
        auto key = stablePlayerKey(player), dimension = playerDimension(player);
        auto now = Clock::now();
        std::lock_guard lock(mutex);
        auto found = previous.find(key);
        // Republish unchanged observations each minute so date-filtered MAX has
        // samples on later days too. A dimension change always gets its own sample.
        if (found != previous.end() && found->second.value == value && found->second.dimension == dimension
            && now - found->second.published < 60s) return;
        nlohmann::json event = {{"eventId", uuid()}, {"kind", "COUNTER"}, {"at", timestamp(nowMillis())},
            {"player", playerIdentity(player)}, {"dimension", dimension}, {"metric", "level.max"},
            {"value", static_cast<std::int64_t>(value)}};
        if (engine.submit(std::move(event))) {
            previous.insert_or_assign(std::move(key), Sample{static_cast<std::int64_t>(value), std::move(dimension), now});
            ++observations;
        }
    }
    void tick(Level& level) {
        auto now = Clock::now();
        if (now < nextScan) return;
        nextScan = now + 1s;
        std::unordered_set<std::string> present;
        level.forEachPlayer([&](Player& player) {
            try { if (player.isPlayerInitialized()) { present.insert(stablePlayerKey(player)); sample(player); } } catch (...) {}
            return true;
        });
        std::lock_guard lock(mutex);
        std::erase_if(previous, [&](auto const& entry) { return !present.contains(entry.first); });
    }
};
LevelObserver::LevelObserver(Engine& engine) : impl_(std::make_unique<Impl>(engine)) {}
LevelObserver::~LevelObserver() = default;
void LevelObserver::tick(Level& level) { impl_->tick(level); }
}
