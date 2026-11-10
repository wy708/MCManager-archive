#include "plugin/CraftTracker.h"
#include "core/Platform.h"
#include "ll/api/memory/Hook.h"
#include "mc/entity/components_json_legacy/EconomyTradeableComponent.h"
#include "mc/entity/components_json_legacy/LegacyTradeableComponent.h"
#include "mc/network/packet/ItemStackResponseContainerInfo.h"
#include "mc/world/inventory/network/ContainerScreenContext.h"
#include "mc/world/inventory/network/ItemStackRequestActionHandler.h"
#include "mc/world/inventory/network/crafting/CraftHandlerCrafting.h"
#include "mc/world/inventory/network/crafting/CraftHandlerTrade.h"
#include "mc/world/inventory/network/crafting/ItemStackRequestActionCraftBase.h"
#include "mc/world/inventory/network/crafting/ItemStackRequestActionCraftHandler.h"
#include "mc/world/item/ItemInstance.h"
#include "mc/world/level/Level.h"
#include "plugin/GameTracker.h"
#include <algorithm>
#include <atomic>
#include <deque>
#include <map>
#include <mutex>
#include <shared_mutex>
#include <unordered_map>

namespace mcarchive {
namespace {
using json = nlohmann::json;
using RequestEnd = std::tuple<ItemStackNetResult, std::vector<ItemStackResponseContainerInfo>>;
struct Capture {
    virtual void submit(json) = 0;
    virtual ~Capture() = default;
};
struct Request {
    enum class Kind { None, Crafting, Trade };
    Kind kind = Kind::None;
    bool invalid = false, tradePosted = false;
    unsigned postCrafts = 0;
    unsigned initializations = 0, crafts = 0;
    std::map<std::string, std::uint64_t> outputs;
    std::string primary;
};
std::shared_mutex lifetime;
Capture *capture = nullptr;
std::mutex state;
std::unordered_map<ItemStackRequestActionHandler *, Request> requests;
std::atomic<std::size_t> committed{0}, rolledBack{0}, invalid{0}, capacityGaps{0};
std::atomic<std::size_t> tradesCommitted{0}, tradesRolledBack{0}, tradesInvalid{0}, legacyTrades{0},
    modernTrades{0};

// State belongs to one server request, not to a recipe preview or to the screen.
LL_TYPE_INSTANCE_HOOK(ArchiveCraftBegin, ll::memory::HookPriority::Highest, ItemStackRequestActionHandler,
                      &ItemStackRequestActionHandler::beginRequest, void, ItemStackRequestId const &id,
                      ItemStackNetManagerScreen &screen) {
    try {
        std::shared_lock alive(lifetime);
        if (capture) {
            std::lock_guard lock(state);
            if (requests.size() < 32768 || requests.contains(this))
                requests.insert_or_assign(this, Request{});
            else
                ++capacityGaps;
        }
    } catch (...) {
        ++capacityGaps;
    }
    origin(id, screen);
}
LL_TYPE_INSTANCE_HOOK(ArchiveCraftRecipe, ll::memory::HookPriority::Highest, CraftHandlerCrafting,
                      &CraftHandlerCrafting::$_handleCraftAction, ItemStackNetResult,
                      ItemStackRequestActionCraftBase const &action) {
    auto *handler = &mCraftRequestHandler.mRequestActionHandler;
    try {
        std::shared_lock alive(lifetime);
        if (capture) {
            std::lock_guard lock(state);
            if (auto found = requests.find(handler); found != requests.end()) {
                bool supported = action.mActionType == ItemStackRequestActionType::CraftRecipe ||
                                 action.mActionType == ItemStackRequestActionType::CraftRecipeAuto;
                found->second.kind = supported ? Request::Kind::Crafting : Request::Kind::None;
                found->second.invalid |= !supported;
            }
        }
    } catch (...) {
        ++capacityGaps;
    }
    return origin(action);
}
LL_TYPE_INSTANCE_HOOK(ArchiveTradeRecipe, ll::memory::HookPriority::Highest, CraftHandlerTrade,
                      &CraftHandlerTrade::$_handleCraftAction, ItemStackNetResult,
                      ItemStackRequestActionCraftBase const &action) {
    auto *handler = &mCraftRequestHandler.mRequestActionHandler;
    try {
        auto &player = handler->mPlayer;
        auto owner = std::get_if<ActorUniqueID>(&mScreenContext.mOwner.get());
        auto actor = owner ? player.getLevel().$fetchEntity(*owner, false) : nullptr;
        bool known = false;
        if (actor && !actor->isDead()) {
            auto type = actor->getTypeName();
            known = (type == "minecraft:villager" || type == "minecraft:villager_v2" ||
                     type == "minecraft:wandering_trader") &&
                    (actor->getEntityContext().hasComponent<EconomyTradeableComponent>() ||
                     actor->getEntityContext().hasComponent<LegacyTradeableComponent>());
        }
        std::shared_lock alive(lifetime);
        if (capture) {
            std::lock_guard lock(state);
            if (auto found = requests.find(handler); found != requests.end()) {
                auto &request = found->second;
                request.kind = Request::Kind::Trade;
                request.invalid |=
                    !known || mScreenContext.mPlayer != &player ||
                    mScreenContext.mScreenContainerType != SharedTypes::Legacy::ContainerType::Trade;
            }
        }
    } catch (...) {
        ++capacityGaps;
    }
    return origin(action);
}
LL_TYPE_INSTANCE_HOOK(ArchiveTradePost, ll::memory::HookPriority::Highest, CraftHandlerTrade,
                      &CraftHandlerTrade::$_postCraftRequest, void, bool success) {
    auto count = int(mNumCrafts);
    auto index = mTradeIndex->has_value();
    auto modern = bool(mIsTrade2);
    origin(success);
    try {
        std::shared_lock alive(lifetime);
        if (capture) {
            std::lock_guard lock(state);
            auto found = requests.find(&mCraftRequestHandler.mRequestActionHandler);
            if (found != requests.end() && found->second.kind == Request::Kind::Trade) {
                auto &request = found->second;
                request.invalid |= request.tradePosted || !success || !index || count <= 0;
                request.tradePosted = true;
                request.postCrafts = count > 0 ? unsigned(count) : 0;
                request.crafts = request.postCrafts;
                if (success) {
                    if (modern)
                        ++modernTrades;
                    else
                        ++legacyTrades;
                }
            }
        }
    } catch (...) {
        ++capacityGaps;
    }
}
LL_TYPE_INSTANCE_HOOK(ArchiveCraftOutputs, ll::memory::HookPriority::Lowest,
                      ItemStackRequestActionCraftHandler,
                      &ItemStackRequestActionCraftHandler::_initCraftResults, ItemStackNetResult,
                      std::vector<ItemInstance> const &outputs, uchar count) {
    auto result = origin(outputs, count);
    try {
        std::shared_lock alive(lifetime);
        if (capture && result == ItemStackNetResult::Success) {
            std::lock_guard lock(state);
            auto found = requests.find(&mRequestActionHandler);
            if (found != requests.end() && found->second.kind != Request::Kind::None) {
                auto &request = found->second;
                if (++request.initializations != 1 || count == 0 || outputs.empty() || outputs.size() > 256) {
                    request.invalid = true;
                } else {
                    bool invalidOutput = request.invalid;
                    // Fail closed if snapshotting any output throws partway through.
                    request.invalid = true;
                    // Trade results are already aggregated by _initResultItem:
                    // its _initCraftResults multiplier is 1 even for a bulk trade.
                    // The native post callback supplies the actual trade count.
                    if (request.kind == Request::Kind::Trade)
                        invalidOutput |= count != 1;
                    else
                        request.crafts = count;
                    for (auto const &item : outputs) {
                        if (!item.mCount)
                            continue;
                        auto type = item.getTypeName();
                        if (type.empty() || type == "minecraft:air") {
                            invalidOutput = true;
                            continue;
                        }
                        if (request.primary.empty())
                            request.primary = type;
                        request.outputs[type] += std::uint64_t(item.mCount) * count;
                    }
                    request.invalid = invalidOutput;
                }
            }
        }
    } catch (...) {
        ++capacityGaps;
    }
    return result;
}
LL_TYPE_INSTANCE_HOOK(ArchiveCraftEnd, ll::memory::HookPriority::Highest, ItemStackRequestActionHandler,
                      &ItemStackRequestActionHandler::endRequest, RequestEnd, ItemStackNetResult current) {
    // The native outer handler commits predictive inventory only inside origin.
    auto result = origin(current);
    try {
        std::shared_lock alive(lifetime);
        if (!capture)
            return result;
        Request request;
        {
            std::lock_guard lock(state);
            auto found = requests.find(this);
            if (found == requests.end())
                return result;
            request = std::move(found->second);
            requests.erase(found);
        }
        if (request.kind == Request::Kind::None)
            return result;
        bool trade = request.kind == Request::Kind::Trade;
        if (current != ItemStackNetResult::Success || std::get<0>(result) != ItemStackNetResult::Success) {
            if (trade)
                ++tradesRolledBack;
            else
                ++rolledBack;
            return result;
        }
        if (request.invalid || request.initializations != 1 || !request.crafts || request.outputs.empty() ||
            !mPlayer.isPlayerInitialized() ||
            (trade && (!request.tradePosted || request.postCrafts != request.crafts))) {
            if (trade)
                ++tradesInvalid;
            else
                ++invalid;
            return result;
        }
        auto identity = playerIdentity(mPlayer);
        int dimension = static_cast<int>(mPlayer.getDimensionId());
        std::string dimensionName = dimension == 0   ? "minecraft:overworld"
                                    : dimension == 1 ? "minecraft:nether"
                                    : dimension == 2 ? "minecraft:the_end"
                                                     : "bedrock:dimension_" + std::to_string(dimension);
        auto at = timestamp(nowMillis());
        json events = json::array();
        auto event = [&](std::string const &metric, std::uint64_t count, std::string const &subject) {
            events.push_back({{"eventId", uuid()},
                              {"kind", "COUNTER"},
                              {"at", at},
                              {"player", identity},
                              {"dimension", dimensionName},
                              {"metric", metric},
                              {"value", count},
                              {"subject", subject}});
        };
        event(trade ? "villager.trades" : "crafting.crafts", request.crafts, request.primary);
        for (auto const &[type, count] : request.outputs)
            event(trade ? "villager.items" : "crafting.items", count, type);
        capture->submit(std::move(events));
        if (trade)
            ++tradesCommitted;
        else
            ++committed;
    } catch (...) {
        ++capacityGaps;
    }
    return result;
}
} // namespace
struct CraftTracker::Impl : Capture {
    Engine &engine;
    std::mutex mutex;
    std::deque<json> pending;
    std::size_t admitted = 0, lost = 0, events = 0;
    ll::memory::HookRegistrar<ArchiveCraftBegin, ArchiveCraftRecipe, ArchiveTradeRecipe, ArchiveTradePost,
                              ArchiveCraftOutputs, ArchiveCraftEnd>
        hooks;
    explicit Impl(Engine &engine) : engine(engine) {
        std::unique_lock alive(lifetime);
        if (capture)
            throw std::runtime_error("Crafting tracker already installed");
        std::lock_guard lock(state);
        requests.clear();
        committed = 0;
        rolledBack = 0;
        invalid = 0;
        capacityGaps = 0;
        tradesCommitted = 0;
        tradesRolledBack = 0;
        tradesInvalid = 0;
        legacyTrades = 0;
        modernTrades = 0;
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
            if (++lost == 1) engine.note("Inventory result backlog is full; capture gap detected");
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
        engine.recordCaptureGap(pending.size());
        engine.note("Inventory result diagnostics: " + std::to_string(admitted) + " admitted events, " +
                    std::to_string(events) + " pending events, " + std::to_string(lost) +
                    " lost requests; craftingCommitted=" + std::to_string(committed.load()) +
                    " craftingRolledBack=" + std::to_string(rolledBack.load()) + " craftingInvalid=" +
                    std::to_string(invalid.load()) + " capacityGaps=" + std::to_string(capacityGaps.load()));
        std::lock_guard lockState(state);
        engine.note("Trade diagnostics: committed=" + std::to_string(tradesCommitted.load()) +
                    " rolledBack=" + std::to_string(tradesRolledBack.load()) +
                    " invalid=" + std::to_string(tradesInvalid.load()) +
                    " modernPosts=" + std::to_string(modernTrades.load()) +
                    " legacyPosts=" + std::to_string(legacyTrades.load()));
        requests.clear();
    }
};
CraftTracker::CraftTracker(Engine &engine) : impl_(std::make_unique<Impl>(engine)) {}
CraftTracker::~CraftTracker() = default;
void CraftTracker::tick() {
    std::lock_guard lock(impl_->mutex);
    impl_->flush();
}
} // namespace mcarchive
