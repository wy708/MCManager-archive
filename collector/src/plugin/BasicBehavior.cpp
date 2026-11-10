#include "plugin/RuntimeApi.h"
#if defined(MCARCHIVE_BDS_12661)
#include "plugin/DeathCause.h"
#endif
#include "plugin/BasicBehavior.h"
#include "plugin/ProjectModels.h"
#include "plugin/GameTracker.h"
#include "plugin/AgricultureRules.h"
#include "plugin/ItemBehavior.h"
#include "plugin/ContainerAuditTracker.h"
#include "core/Platform.h"
#include "ll/api/event/EventBus.h"
#include "ll/api/event/player/PlayerPlaceBlockEvent.h"
#include "ll/api/memory/Hook.h"
#include "mc/world/actor/ActorDamageSource.h"
#include "mc/world/actor/player/Player.h"
#include "mc/server/ServerPlayer.h"
#include "mc/network/ServerPlayerBlockUseHandler.h"
#include "mc/world/attribute/AttributeInstance.h"
#include "mc/world/attribute/AttributeInstanceConstRef.h"
#include "mc/world/gamemode/GameMode.h"
#include "mc/world/gamemode/InteractionResult.h"
#include "mc/world/level/BlockSource.h"
#include "mc/world/level/Level.h"
#include "mc/legacy/ActorUniqueID.h"
#include "mc/world/level/block/Block.h"
#include "mc/world/level/block/VanillaStates.h"
#include "mc/world/level/block/SweetBerryBushBlock.h"
#include "mc/world/level/block/CaveVinesBlock.h"
#include "mc/world/level/block/BlockChangeContext.h"
#include "mc/world/level/block/FoliageBlock.h"
#include "mc/world/level/block/block_events/BlockQueuedTickEvent.h"
#include "mc/world/item/ItemStack.h"
#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <vector>

namespace mcarchive {
namespace {
using json = nlohmann::json;
struct Observer { virtual void submit(json) = 0; virtual ~Observer() = default; };
Observer* observer = nullptr;
std::shared_mutex lifetime;
std::atomic<std::size_t> miningCalls{0}, usingCalls{0}, experienceCalls{0}, deathCalls{0}, placementOverflows{0};
void publish(json event) noexcept { try { std::shared_lock lock(lifetime); if (observer) observer->submit(std::move(event)); } catch (...) {} }
json event(Player const& player, char const* kind) {
    return {{"eventId", uuid()}, {"kind", kind}, {"at", timestamp(nowMillis())}, {"player", playerIdentity(player)}, {"dimension", playerDimension(player)}};
}
void counter(Player const& player, char const* metric, std::int64_t value, std::string subject = {}, BlockPos const* position = nullptr) {
    if (!player.isPlayerInitialized() || value <= 0) return;
    while (value > 0) {
        auto part = std::min<std::int64_t>(value, 1'000'000'000);
        auto result = event(player, "COUNTER"); result["metric"] = metric; result["value"] = part;
        if (!subject.empty()) result["subject"] = subject;
        if(position) result["position"] = {{"x",position->x},{"y",position->y},{"z",position->z}};
        publish(std::move(result)); value -= part;
    }
}
float attribute(Player const& player, Attribute const& type) {
    auto reference = player.getAttribute(type); auto ptr = reference.mPtr;
    return ptr ? ptr->mCurrentValue : -1;
}
std::optional<std::int64_t> experiencePoints(Player const& player) {
    double level = attribute(player, Player::LEVEL()), progress = attribute(player, Player::EXPERIENCE());
    // Vanilla level/progress attributes retain enough precision for integer XP in this range.
    // Outside it, do not invent an exact number from imprecise float attributes.
    if (!std::isfinite(level) || !std::isfinite(progress) || level < 0 || level > 100000 || std::floor(level) != level || progress < 0 || progress >= 1) return {};
    auto base = level <= 16 ? level * level + 6 * level : level <= 31 ? 2.5 * level * level - 40.5 * level + 360 : 4.5 * level * level - 162.5 * level + 2220;
    auto next = level <= 15 ? 2 * level + 7 : level <= 30 ? 5 * level - 38 : 9 * level - 158;
    return static_cast<std::int64_t>(std::llround(base + progress * next));
}
struct Placement { BlockPos pos; std::string before, proposed; uint beforeId; };
struct BlockWrite { BlockPos pos; std::string before; uint beforeId; };
struct UseContext { Player* player; UseContext* previous; std::vector<Placement> placements; std::vector<BlockWrite> writes; bool overflow = false; std::string item; };
thread_local UseContext* usingItem = nullptr;
UseContext* placementContext() {
    auto current = usingItem;
    while (current && current->previous && current->previous->player == current->player) current = current->previous;
    return current;
}
struct UseScope {
    UseContext context;
    explicit UseScope(Player& player, ItemStack const& item) : context{&player, usingItem, {}, {}} {
        try { if (item.mCount) context.item = item.getTypeName(); } catch (...) {}
        usingItem = &context;
    }
    ~UseScope() { usingItem = context.previous; }
};
struct DeferredPart {
    BlockSource* region; BlockPos primary, pos; uint state;
    std::uint64_t expires; json mined; std::optional<json> crop;
};
std::vector<DeferredPart> deferredParts;
std::mutex deferredMutex;
std::atomic<std::size_t> pendingParts{0};
std::atomic<std::uint64_t> observationTick{0};
std::atomic<std::size_t> deferredCompleted{0}, deferredExpired{0}, deferredCancelled{0}, deferredOverflow{0};
struct DeferredCheck { DeferredPart const& part; bool removedByPhysics = false; DeferredCheck* previous; };
thread_local DeferredCheck* deferredCheck = nullptr;
void deferPart(Player const& player, BlockPos const& primary, BlockPos const& pos, Block const& block, std::optional<std::string> const& crop) {
    std::shared_lock alive(lifetime); if (!observer) return;
    auto mined = event(player, "COUNTER"); mined["metric"] = "blocks.mined"; mined["value"] = 1; mined["subject"] = block.getTypeName();
    mined["position"] = {{"x",pos.x},{"y",pos.y},{"z",pos.z}};
    std::optional<json> harvested;
    if (crop) { harvested = event(player, "COUNTER"); (*harvested)["metric"] = "crops.harvested"; (*harvested)["value"] = 1; (*harvested)["subject"] = *crop; }
    std::lock_guard guard(deferredMutex);
    if (deferredParts.size() >= 4096) { ++deferredOverflow; return; }
    deferredParts.push_back({&player.getDimensionBlockSource(), primary, pos, block.mNetworkId, observationTick.load() + 20, std::move(mined), std::move(harvested)});
    pendingParts = deferredParts.size();
}
LL_TYPE_INSTANCE_HOOK(ArchiveDeferredCropTick, ll::memory::HookPriority::Highest, FoliageBlock,
    &FoliageBlock::$tick, void, BlockEvents::BlockQueuedTickEvent& data) {
    auto& region = data.mRegion; auto const& pos = data.mPos.get();
    std::optional<DeferredPart> pending;
    try {
        if (pendingParts.load()) {
            std::lock_guard guard(deferredMutex);
            auto found = std::find_if(deferredParts.begin(), deferredParts.end(), [&](auto const& item) { return item.region == &region && item.pos == pos; });
            if (found != deferredParts.end()) { pending = std::move(*found); deferredParts.erase(found); pendingParts = deferredParts.size(); }
        }
        if (pending && (region.getBlock(pos).mNetworkId != pending->state || region.getBlock(pending->primary).getTypeName() != "minecraft:air")) { pending.reset(); ++deferredCancelled; }
    } catch (...) { pending.reset(); }
    if (!pending) { origin(data); return; }
    DeferredCheck check{*pending, false, deferredCheck}; deferredCheck = &check;
    try { origin(data); } catch (...) { deferredCheck = check.previous; throw; }
    deferredCheck = check.previous;
    try {
        if (check.removedByPhysics && region.getBlock(pos).getTypeName() == "minecraft:air" && region.getBlock(pending->primary).getTypeName() == "minecraft:air") {
            publish(std::move(pending->mined)); if (pending->crop) publish(std::move(*pending->crop)); ++deferredCompleted;
        } else ++deferredCancelled;
    } catch (...) { ++deferredCancelled; }
}
bool companion(BlockPos const& firstPos, Block const& first, BlockPos const& secondPos, Block const& second) {
    if (firstPos.x == secondPos.x && firstPos.z == secondPos.z && std::abs(firstPos.y - secondPos.y) == 1) {
        auto firstUpper = first.getState<bool>(VanillaStates::UpperBlockBit());
        auto secondUpper = second.getState<bool>(VanillaStates::UpperBlockBit());
        return firstUpper && secondUpper && *firstUpper != *secondUpper
            && (*firstUpper ? firstPos.y > secondPos.y : firstPos.y < secondPos.y);
    }
    if (firstPos.y == secondPos.y && std::abs(firstPos.x - secondPos.x) + std::abs(firstPos.z - secondPos.z) == 1) {
        auto firstHead = first.getState<bool>(VanillaStates::HeadPieceBit());
        auto secondHead = second.getState<bool>(VanillaStates::HeadPieceBit());
        auto direction = first.getState<int>(VanillaStates::Direction());
        return firstHead && secondHead && *firstHead != *secondHead && direction
            && direction == second.getState<int>(VanillaStates::Direction());
    }
    return false;
}
// Observe all main-layer writes inside this player's operation, including the
// second half of a door/bed that does not publish its own placement proposal.
// Neighbor updates alone are not placements: proposals still authorize the
// matching position or one newly occupied adjacent cell of the same type.
LL_TYPE_INSTANCE_HOOK(ArchivePlacementWrite, ll::memory::HookPriority::Highest, BlockSource,
    &BlockSource::$setBlock, bool, BlockPos const& pos, Block const& block, int flags,
    ActorBlockSyncMessage const* sync, BlockChangeContext const& source) {
    try {
        auto context = placementContext();
        if (context && !context->overflow && &context->player->getDimensionBlockSource() == this
            && std::none_of(context->writes.begin(), context->writes.end(), [&](auto const& old) { return old.pos == pos; })) {
            if (context->writes.size() >= 4096) { context->overflow = true; ++placementOverflows; }
            else { auto const& before = getBlock(pos); context->writes.push_back({pos, before.getTypeName(), before.mNetworkId}); }
        }
    } catch (...) {}
    std::optional<uint> before;
    try { if (deferredCheck || pendingParts.load()) before = getBlock(pos).mNetworkId; } catch (...) {}
    auto result = origin(pos, block, flags, sync, source);
    if(result)markProjectModelDirty(*this,pos);
    try { if (before && getBlock(pos).mNetworkId != *before) {
        for (auto check = deferredCheck; check; check = check->previous)
            if (check->part.region == this && check->part.pos == pos && check->part.state == *before
                && source.mContextSource->index() == 0 && getBlock(pos).getTypeName() == "minecraft:air") check->removedByPhysics = true;
        if (pendingParts.load()) { std::lock_guard guard(deferredMutex); std::erase_if(deferredParts, [&](auto const& pending) { if (pending.region != this || pending.pos != pos) return false; ++deferredCancelled; return true; }); pendingParts = deferredParts.size(); }
    }} catch (...) {}
    return result;
}
thread_local unsigned destroying = 0;
thread_local unsigned addingExperience = 0;
struct DestroyScope { DestroyScope() { ++destroying; } ~DestroyScope() { --destroying; } };
struct ExperienceScope { ExperienceScope() { ++addingExperience; } ~ExperienceScope() { --addingExperience; } };

template <class Origin> bool minedBlock(Player& player, BlockPos const& pos, Origin&& origin) {
    DestroyScope depth;
    miningCalls++;
    struct Before { BlockPos pos; std::string type; std::optional<std::string> crop; uint state; };
    std::vector<Before> before;
    try { if (destroying == 1 && player.isPlayerInitialized()) {
        auto& region = player.getDimensionBlockSource(); auto const& block = region.getBlock(pos);
        before.push_back({pos, block.getTypeName(), matureCrop(block), block.mNetworkId});
        std::vector<BlockPos> neighbors{{pos.x,pos.y-1,pos.z}, {pos.x,pos.y+1,pos.z}};
        BlockPos second;
        if (block.getBlockType().getSecondPart(region, pos, second) && second != pos
            && std::none_of(neighbors.begin(), neighbors.end(), [&](auto const& old) { return old == second; })) neighbors.push_back(second);
        // Component crops can remove their other half without implementing the
        // legacy getSecondPart virtual. Validate the vertical pair directly.
        for (auto const& second : neighbors) {
            auto const& other = region.getBlock(second);
            if (other.getTypeName() == block.getTypeName() && companion(pos, block, second, other))
                before.push_back({second, other.getTypeName(), matureCrop(other), other.mNetworkId});
        }
    }} catch (...) {}
    auto success = origin();
    try {
        if (success) for (auto const& old : before) {
            if (old.type == "minecraft:air") continue;
            auto const& after = player.getDimensionBlockSource().getBlock(old.pos);
            if (after.getTypeName() == old.type) {
                if (old.pos != pos && old.type == "minecraft:pitcher_crop" && after.mNetworkId == old.state && player.getDimensionBlockSource().getBlock(pos).getTypeName() == "minecraft:air") deferPart(player, pos, old.pos, after, old.crop);
                continue;
            }
            counter(player, "blocks.mined", 1, old.type, &old.pos);
            auditContainerBlock(player, old.pos, old.type, false);
            if (old.crop) counter(player, "crops.harvested", 1, *old.crop);
        }
    } catch (...) {}
    return success;
}
LL_TYPE_INSTANCE_HOOK(ArchiveMinedBlock, ll::memory::HookPriority::Lowest, GameMode, &GameMode::$destroyBlock,
    bool, BlockPos const& pos, uchar face) { return minedBlock(mPlayer, pos, [&] { return origin(pos, face); }); }
LL_TYPE_INSTANCE_HOOK(ArchiveCreativeMinedBlock, ll::memory::HookPriority::Lowest, GameMode, MCARCHIVE_NATIVE_SYMBOL("?_creativeDestroyBlock@GameMode@@QEAA_NAEBVBlockPos@@E@Z", &GameMode::_creativeDestroyBlock),
    bool, BlockPos const& pos, uchar face) { return minedBlock(mPlayer, pos, [&] { return origin(pos, face); }); }
LL_STATIC_HOOK(ArchiveStartBreaking, ll::memory::HookPriority::Lowest, &ServerPlayerBlockUseHandler::onStartDestroyBlock,
    void, ServerPlayer& player, BlockPos const& pos, int face) { minedBlock(player, pos, [&] { origin(player, pos, face); return true; }); }
LL_STATIC_HOOK(ArchiveTickBreaking, ll::memory::HookPriority::Lowest, MCARCHIVE_NATIVE_SYMBOL("?serverTickBlockBreaking@ServerPlayerBlockUseHandler@@YAXAEAVServerPlayer@@AEBVBlockPos@@H@Z", &ServerPlayerBlockUseHandler::serverTickBlockBreaking),
    void, ServerPlayer& player, BlockPos const& pos, int face) { minedBlock(player, pos, [&] { origin(player, pos, face); return true; }); }
LL_TYPE_INSTANCE_HOOK(ArchivePlacedBlock, ll::memory::HookPriority::Lowest, GameMode, &GameMode::$useItemOn,
    InteractionResult, ItemStack& item, BlockPos const& at, uchar face, Vec3 const& hit, HandSlot hand, Block const* target, bool first) {
    UseScope scope(mPlayer, item);
    usingCalls++;
    auto result = origin(item, at, face, hit, hand, target, first);
    try {
        if (!scope.context.previous || scope.context.previous->player != &mPlayer) {
            auto& placements = scope.context.placements;
            auto& writes = scope.context.writes;
            if (!scope.context.overflow) for (auto const& write : writes) {
                auto const& after = mPlayer.getDimensionBlockSource().getBlock(write.pos);
                auto type = after.getTypeName();
                if (type == "minecraft:air" || after.mNetworkId == write.beforeId) continue;
                if (auto crop = plantedCrop(scope.context.item, write.before, after)) counter(mPlayer, "crops.planted", 1, *crop);
                bool placed = std::any_of(placements.begin(), placements.end(), [&](auto const& proposal) {
                    if (proposal.proposed != type) return false;
                    if (proposal.pos == write.pos) return true;
                    auto const& anchor = mPlayer.getDimensionBlockSource().getBlock(proposal.pos);
                    return write.before != type && anchor.getTypeName() == proposal.proposed
                        && anchor.mNetworkId != proposal.beforeId && companion(proposal.pos, anchor, write.pos, after);
                });
                if (placed) {
                    counter(mPlayer, "blocks.placed", 1, type, &write.pos);
                    auditContainerBlock(mPlayer, write.pos, type, true);
                }
            }
        }
    } catch (...) {}
    return result;
}
LL_STATIC_HOOK(ArchiveSweetBerryHarvest, ll::memory::HookPriority::Lowest, MCARCHIVE_NATIVE_SYMBOL("?_pickBerries@SweetBerryBushBlock@@SA_NAEAVBlockSource@@AEBVBlockPos@@AEBVBlock@@AEAVActor@@@Z", &SweetBerryBushBlock::_pickBerries),
    bool, BlockSource& region, BlockPos const& pos, Block const& block, Actor& source) {
    if (source.isPlayer()) noteBlockInteraction(static_cast<Player&>(source));
    std::optional<int> before;
    try { if (source.isPlayer() && block.getTypeName() == "minecraft:sweet_berry_bush") before = block.getState<int>(VanillaStates::Growth()); } catch (...) {}
    auto result = origin(region, pos, block, source);
    try {
        auto const& after = region.getBlock(pos);
        if (result && before && *before >= 2 && after.getTypeName() == "minecraft:sweet_berry_bush"
            && after.getState<int>(VanillaStates::Growth()) == 1)
            counter(static_cast<Player&>(source), "crops.interacted", 1, "minecraft:sweet_berry_bush");
    } catch (...) {}
    return result;
}
LL_STATIC_HOOK(ArchiveGlowBerryHarvest, ll::memory::HookPriority::Lowest, MCARCHIVE_NATIVE_SYMBOL("?_pickBerries@CaveVinesBlock@@SA_NAEAVBlockSource@@AEBVBlockPos@@AEAVActor@@@Z", &CaveVinesBlock::_pickBerries),
    bool, BlockSource& region, BlockPos const& pos, Actor& source) {
    if (source.isPlayer()) noteBlockInteraction(static_cast<Player&>(source));
    bool before = false;
    try { before = source.isPlayer() && berryVine(region.getBlock(pos).getTypeName()); } catch (...) {}
    auto result = origin(region, pos, source);
    try {
        if (result && before && region.getBlock(pos).getTypeName() == "minecraft:cave_vines")
            counter(static_cast<Player&>(source), "crops.interacted", 1, "minecraft:cave_vines");
    } catch (...) {}
    return result;
}
LL_TYPE_INSTANCE_HOOK(ArchiveExperience, ll::memory::HookPriority::Lowest, Player, &Player::$addExperience, void, int amount) {
    ExperienceScope depth;
    experienceCalls++;
    std::optional<std::int64_t> before;
    try { if (addingExperience == 1) before = experiencePoints(*this); } catch (...) {}
    origin(amount);
    try {
        auto after = experiencePoints(*this);
        if (before && after && amount > 0) counter(*this, "experience.gained", std::min<std::int64_t>(amount, std::max<std::int64_t>(0, *after - *before)));
    } catch (...) {}
}
LL_TYPE_INSTANCE_HOOK(ArchivePlayerDeath, ll::memory::HookPriority::Lowest, Player, &Player::$die, void, ActorDamageSource const& source) {
    deathCalls++;
    bool alive = false; std::optional<json> death;
    try {
        alive = !isDead();
        if (alive && isPlayerInitialized()) {
            death = event(*this, "DEATH"); auto cause = MCARCHIVE_DEATH_CAUSE(source.mCause);
            std::transform(cause.begin(), cause.end(), cause.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            (*death)["cause"] = cause.empty() ? "unknown" : cause;
            if (source.isEntitySource()) {
                auto killer = getLevel().MCARCHIVE_FETCH_ENTITY(source.isChildEntitySource() ? source.getDamagingEntityUniqueID() : source.getEntityUniqueID(), false);
                if (killer) (*death)["killerType"] = killer->getTypeName();
            }
        }
    } catch (...) {}
    origin(source);
    try { if (death && isDead()) publish(std::move(*death)); } catch (...) {}
}
}
struct BasicBehavior::Impl : Observer {
    Engine& engine;
    ll::event::ListenerPtr placement;
    ll::memory::HookRegistrar<ArchiveMinedBlock, ArchiveCreativeMinedBlock, ArchiveStartBreaking, ArchiveTickBreaking, ArchivePlacedBlock, ArchivePlacementWrite, ArchiveDeferredCropTick, ArchiveSweetBerryHarvest, ArchiveGlowBerryHarvest, ArchiveExperience, ArchivePlayerDeath> hooks;
    explicit Impl(Engine& value) : engine(value) {
        miningCalls = 0; usingCalls = 0; experienceCalls = 0; deathCalls = 0; placementOverflows = 0;
        { std::lock_guard guard(deferredMutex); deferredParts.clear(); pendingParts = 0; }
        observationTick = 0; deferredCompleted = 0; deferredExpired = 0; deferredCancelled = 0; deferredOverflow = 0;
        placement = ll::event::EventBus::getInstance().emplaceListener<ll::event::PlayerPlacedBlockEvent>([](auto& proposed) {
            auto context = placementContext();
            if (!context || context->player != &proposed.self() || context->overflow) return;
            try {
                if (context->placements.size() >= 4096) { context->overflow = true; ++placementOverflows; return; }
                auto const& before = proposed.self().getDimensionBlockSource().getBlock(proposed.pos());
                context->placements.push_back({proposed.pos(), before.getTypeName(), proposed.placedBlock().getTypeName(), before.mNetworkId});
            } catch (...) {}
        }, ll::event::EventPriority::Lowest);
        if (!placement) throw std::runtime_error("Placement listener unavailable");
        std::unique_lock lock(lifetime);
        if (observer) { ll::event::EventBus::getInstance().removeListener(placement); throw std::runtime_error("Behavior observer already installed"); }
        observer = this;
    }
    ~Impl() {
        { std::unique_lock lock(lifetime); observer = nullptr; }
        ll::event::EventBus::getInstance().removeListener(placement);
        engine.note("Behavior diagnostics: " + std::to_string(miningCalls.load()) + " mining callbacks, " + std::to_string(usingCalls.load()) + " block uses, " + std::to_string(experienceCalls.load()) + " XP calls, " + std::to_string(deathCalls.load()) + " death calls");
        engine.recordCaptureGap(placementOverflows.load() + deferredOverflow.load());
        engine.note("Placement diagnostics: " + std::to_string(placementOverflows.load()) + " operations exceeded observation capacity");
        engine.note("Deferred crop diagnostics: " + std::to_string(deferredCompleted.load()) + " confirmed, " + std::to_string(deferredCancelled.load()) + " invalidated, " + std::to_string(deferredExpired.load()) + " expired, " + std::to_string(deferredOverflow.load()) + " overflow, " + std::to_string(pendingParts.load()) + " unresolved");
        { std::lock_guard guard(deferredMutex); deferredParts.clear(); pendingParts = 0; }
    }
    void submit(json value) override { if (!engine.submit(std::move(value))) engine.recordCaptureGap(); }
};
BasicBehavior::BasicBehavior(Engine& engine) : impl_(std::make_unique<Impl>(engine)) {}
BasicBehavior::~BasicBehavior() = default;
void BasicBehavior::tick() {
    ++observationTick;
    if (pendingParts.load()) { std::lock_guard guard(deferredMutex); std::erase_if(deferredParts, [](auto const& pending) { if (pending.expires > observationTick.load()) return false; ++deferredExpired; return true; }); pendingParts = deferredParts.size(); }
}
}
