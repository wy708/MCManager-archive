#include "plugin/RuntimeApi.h"
#include "plugin/ItemBehavior.h"
#include "plugin/GameTracker.h"
#include "core/Platform.h"
#include "ll/api/memory/Hook.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/actor/player/Inventory.h"
#include "mc/world/actor/item/ItemActor.h"
#include "mc/world/inventory/transaction/PlayerTransactionSubject.h"
#include "mc/world/gamemode/InteractionResult.h"
#include "mc/world/item/ItemUseMethod.h"
#include "mc/world/events/ItemEventCoordinator.h"
#include "mc/world/events/ItemUsedOnEvent.h"

#if defined(MCARCHIVE_BDS_12661)
// New bedrockdata omits these imports, although the native destructors still
// exist. Keep EventRef's by-value ABI and native cleanup, including any owned
// variant alternative. The compatibility provider verifies the exact binary
// before exposing these symbols; do not replace cleanup with a no-op.
namespace {
void nativeItemUseOnDestructor(ItemUseOnEvent* event) noexcept {
    using Fn = void (*)(ItemUseOnEvent*);
    static auto fn = reinterpret_cast<Fn>(ll::memory::SymbolView{"??1ItemUseOnEvent@@QEAA@XZ"}.resolve());
    if (!fn) std::terminate();
    fn(event);
}
void nativeItemUsedOnDestructor(ItemUsedOnEvent* event) noexcept {
    using Fn = void (*)(ItemUsedOnEvent*);
    static auto fn = reinterpret_cast<Fn>(ll::memory::SymbolView{"??1ItemUsedOnEvent@@QEAA@XZ"}.resolve());
    if (!fn) std::terminate();
    fn(event);
}
}
extern "C" {
void (*archiveItemUseOnDtorSlot)(ItemUseOnEvent*) = &nativeItemUseOnDestructor;
void (*archiveItemUsedOnDtorSlot)(ItemUsedOnEvent*) = &nativeItemUsedOnDestructor;
}
#pragma comment(linker, "/alternatename:__imp_??1ItemUseOnEvent@@QEAA@XZ=archiveItemUseOnDtorSlot")
#pragma comment(linker, "/alternatename:__imp_??1ItemUsedOnEvent@@QEAA@XZ=archiveItemUsedOnDtorSlot")
#endif
#include "mc/world/level/BlockSource.h"
#include "mc/world/level/block/Block.h"
#include "mc/world/actor/projectile/ProjectileFactory.h"
#include "mc/world/item/RangedWeaponItem.h"
#include "mc/entity/components_json_legacy/ProjectileComponent.h"
#include "mc/world/level/Level.h"
#include "mc/legacy/ActorUniqueID.h"
#include <vector>
#include <algorithm>
#include <deque>
#include <mutex>
#include <optional>
#include <shared_mutex>

namespace mcarchive {
namespace {
using json = nlohmann::json;
struct Observer { virtual void submit(json) = 0; virtual ~Observer() = default; };
std::shared_mutex lifetime;
Observer* observer = nullptr;
void counter(Player const& player, char const* metric, int count, std::string const& subject) noexcept {
    try {
        if (!player.isPlayerInitialized() || player.isDead() || count <= 0 || subject.empty() || subject == "minecraft:air") return;
        json event{{"eventId", uuid()}, {"kind", "COUNTER"}, {"at", timestamp(nowMillis())}, {"player", playerIdentity(player)},
            {"dimension", playerDimension(player)}, {"metric", metric}, {"value", count}, {"subject", subject}};
        std::shared_lock guard(lifetime); if (observer) observer->submit(std::move(event));
    } catch (...) {}
}
int inventoryCount(Player const& player, std::string const& type) {
    auto& inventory = player.getInventory(); int total = 0;
    for (int i = 0; i < inventory.getContainerSize(); ++i) {
        auto const& item = inventory.getItem(i);
        if (item.mCount && item.getTypeName() == type) total += item.mCount;
    }
    return total;
}
std::string itemType(ItemStackBase const& item) noexcept {
    try { return item.mCount ? item.getTypeName() : std::string{}; } catch (...) { return {}; }
}
struct HeldItem { std::string type; int count; short damage; };
std::optional<HeldItem> heldItem(PlayerTransactionSubject const& subject, HandSlot hand) noexcept {
    try { auto const& item = subject.getItemInHandSlot(hand); return HeldItem{itemType(item), item.mCount, item.getDamageValue()}; }
    catch (...) { return {}; }
}
bool changedHeldItem(std::optional<HeldItem> const& before, std::optional<HeldItem> const& after) {
    return before && after && !before->type.empty()
        && (after->type != before->type || after->count < before->count || after->damage != before->damage);
}
struct ExecutionScope;
thread_local ExecutionScope* executing = nullptr;
struct ExecutionScope {
    struct Target { BlockPos pos; std::string type; };
    Player const& player;
    std::string subject;
    ExecutionScope* previous;
    std::optional<Target> target;
    std::vector<ActorUniqueID> projectiles;
    bool confirmed = false;
    bool targetConfirmed = false, interaction = false;
    ExecutionScope(Player const& player, std::string subject) : player(player), subject(std::move(subject)), previous(executing) { executing = this; }
    ~ExecutionScope() { executing = previous; }
    void finish() noexcept { try {
        // A confirmed native use is authoritative. In creative mode an item
        // can spawn a projectile while the outer use function returns false.
        if (previous && &previous->player == &player) {
            previous->confirmed = previous->confirmed || confirmed;
            previous->targetConfirmed = previous->targetConfirmed || targetConfirmed;
            previous->interaction = previous->interaction || interaction;
            previous->projectiles.insert(previous->projectiles.end(), projectiles.begin(), projectiles.end());
            if (previous->subject.empty()) previous->subject = subject;
        } else {
            for (auto const& id : projectiles) if (player.getLevel().MCARCHIVE_FETCH_ENTITY(id, false)) { confirmed = true; break; }
            if (confirmed || (targetConfirmed && !interaction)) counter(player, "items.used", 1, subject);
        }
    } catch (...) {} }
};
void confirmedProjectile(Actor& projectile, Actor const* shooter) noexcept {
    if (!shooter || !shooter->isPlayer()) return;
    try {
        for (auto scope = executing; scope; scope = scope->previous) if (&scope->player == shooter) {
            scope->projectiles.push_back(projectile.getOrCreateUniqueID()); break;
        }
    } catch (...) {}
}
LL_TYPE_INSTANCE_HOOK(ArchiveItemProjectile, ll::memory::HookPriority::Lowest, ProjectileFactory,
    MCARCHIVE_NATIVE_SYMBOL("?shootProjectileFromDefinition@ProjectileFactory@@QEAAPEAVActor@@AEBUActorDefinitionIdentifier@@PEAVMob@@VVec3@@HM_N32@Z", &ProjectileFactory::shootProjectileFromDefinition), Actor*, ActorDefinitionIdentifier const& definition,
    Mob* owner, Vec3 direction, int aux, float power, bool unmodified, bool overridePosition, Vec3 position) {
    auto projectile = origin(definition, owner, direction, aux, power, unmodified, overridePosition, position);
    if (projectile) confirmedProjectile(*projectile, owner);
    return projectile;
}
LL_TYPE_INSTANCE_HOOK(ArchiveOwnedProjectile, ll::memory::HookPriority::Lowest, ProjectileComponent,
    MCARCHIVE_NATIVE_SYMBOL("?shoot@ProjectileComponent@@QEAAXAEAVActor@@0@Z", static_cast<void(ProjectileComponent::*)(Actor&, Actor&)>(&ProjectileComponent::shoot)),
    void, Actor& projectile, Actor& shooter) {
    origin(projectile, shooter); confirmedProjectile(projectile, &shooter);
}
LL_TYPE_INSTANCE_HOOK(ArchiveDirectedProjectile, ll::memory::HookPriority::Lowest, ProjectileComponent,
    static_cast<void(ProjectileComponent::*)(Actor&, Vec3 const&, float, float, Vec3 const&, Actor*)>(&ProjectileComponent::shoot),
    void, Actor& projectile, Vec3 const& direction, float power, float uncertainty, Vec3 const& speed, Actor* target) {
    origin(projectile, direction, power, uncertainty, speed, target);
    try { confirmedProjectile(projectile, projectile.getLevel().MCARCHIVE_FETCH_ENTITY(mOwnerId, false)); } catch (...) {}
}
LL_TYPE_INSTANCE_HOOK(ArchiveRangedItemUse, ll::memory::HookPriority::Lowest, RangedWeaponItem,
    &RangedWeaponItem::$releaseUsing, void, ItemStack& item, Player* player, int duration) {
    if (!player) { origin(item, player, duration); return; }
    ExecutionScope execution(*player, itemType(item)); auto count = item.mCount; std::optional<short> damage;
    try { damage = item.getDamageValue(); } catch (...) {}
    origin(item, player, duration);
    try { if (item.mCount < count || (damage && item.getDamageValue() != *damage)) execution.confirmed = true; } catch (...) {}
    execution.finish();
}
LL_TYPE_INSTANCE_HOOK(ArchiveConfirmedItemUse, ll::memory::HookPriority::Lowest, Player,
    &Player::$useItem, void, ItemStackBase& item, ItemUseMethod method, bool consume) {
    ExecutionScope scope(*this, itemType(item));
    origin(item, method, consume);
    auto value = static_cast<int>(method);
    scope.confirmed = value >= 0 && value < static_cast<int>(ItemUseMethod::Count);
    scope.finish();
}
LL_TYPE_INSTANCE_HOOK(ArchiveCompletedItemUse, ll::memory::HookPriority::Highest, Player,
    &Player::completeUsingItem, void) {
    ExecutionScope scope(*this, itemType(mItemInUse->mItem));
    origin(); scope.finish();
}
LL_TYPE_INSTANCE_HOOK(ArchiveReleasedItemUse, ll::memory::HookPriority::Highest, Player,
    &Player::releaseUsingItem, void) {
    ExecutionScope scope(*this, itemType(mItemInUse->mItem));
    origin(); scope.finish();
}
LL_TYPE_INSTANCE_HOOK(ArchiveItemUsedOnEvent, ll::memory::HookPriority::Lowest, ItemEventCoordinator,
    MCARCHIVE_NATIVE_SYMBOL("?sendEvent@ItemEventCoordinator@@QEAA?AW4CoordinatorResult@@V?$EventRef@U?$MutableItemGameplayEvent@W4CoordinatorResult@@@@@@@Z", &ItemEventCoordinator::sendEvent), CoordinatorResult, EventRef<MutableItemGameplayEvent<CoordinatorResult>> event) {
    auto result = origin(event);
    if (result == CoordinatorResult::Continue) try {
        event.get().visit([](auto& entry) {
            using Type = std::remove_cvref_t<decltype(entry.value())>;
            if constexpr (std::is_same_v<Type, ItemUsedOnEvent>) {
                auto const& data = entry.value(); auto actor = data.mActor->tryUnwrap();
                if (!actor || !actor->isPlayer()) return;
                auto& player = static_cast<Player&>(*actor);
                auto const& before = data.mItemBeforeUse.get(); auto const& after = data.mItemAfterUse.get();
                bool effect = before.mCount != after.mCount || itemType(before) != itemType(after)
                    || before.getDamageValue() != after.getDamageValue();
                bool targetEffect = false;
                // The same event also fires when a held tool merely opens a
                // gate. Require an item change or a changed target block type.
                for (auto scope = executing; !targetEffect && scope; scope = scope->previous) {
                    if (&scope->player == &player && scope->target && scope->target->pos == data.mBlockPosition.get())
                        targetEffect = player.getDimensionBlockSource().getBlock(scope->target->pos).getTypeName() != scope->target->type;
                }
                ExecutionScope execution(player, itemType(data.mItemBeforeUse));
                // The after-use event covers component tools that bypass the
                // legacy ItemStack::useOn wrapper. Do not count a charge start.
                execution.confirmed = effect && player.mItemInUse->mItem->mCount == 0;
                execution.targetConfirmed = targetEffect && player.mItemInUse->mItem->mCount == 0;
                execution.finish();
            }
        });
    } catch (...) {}
    return result;
}
LL_TYPE_INSTANCE_HOOK(ArchiveItemPickup, ll::memory::HookPriority::Lowest, Player,
    &Player::take, bool, Actor& actor, int orgCount, int favoredSlot) {
    struct Snapshot { std::string type; int count, inventory; };
    std::optional<Snapshot> before;
    try {
        if (isPlayerInitialized() && !isDead() && actor.hasCategory(ActorCategory::Item)) {
            auto const& item = static_cast<ItemActor const&>(actor).item();
            if (item.mCount) { auto type = item.getTypeName(); before = Snapshot{type, item.mCount, inventoryCount(*this, type)}; }
        }
    } catch (...) {}
    auto result = origin(actor, orgCount, favoredSlot);
    try {
        // The return value alone need not describe a partially accepted stack.
        // Read the committed inventory delta, bounded by this entity's stack.
        // Do not dereference an item actor that origin may have removed.
        if (before) counter(*this, "items.picked_up", std::clamp(inventoryCount(*this, before->type) - before->inventory, 0, before->count), before->type);
    } catch (...) {}
    return result;
}
thread_local unsigned requestDepth = 0;
struct RequestScope { bool outer = requestDepth++ == 0; ~RequestScope() { --requestDepth; } };
void request(Player const& player, ItemStack const& item, RequestScope const& scope) {
    try { if (scope.outer && item.mCount) counter(player, "items.use_requests", 1, item.getTypeName()); } catch (...) {}
}
// Requests must wrap the normal cancellation emitter so cancelled attempts are
// still requests. Pickup, in contrast, only observes committed inventory changes.
LL_TYPE_INSTANCE_HOOK(ArchiveItemRequest, ll::memory::HookPriority::Highest, PlayerTransactionSubject,
    &PlayerTransactionSubject::$baseUseItem, bool, ItemStack& item, HandSlot hand) {
    RequestScope scope; request(mUnk18866d.as<Player&>(), item, scope);
    ExecutionScope execution(mUnk18866d.as<Player&>(), itemType(item));
    auto count = item.mCount;
    auto held = heldItem(*this, hand);
    auto success = origin(item, hand);
    auto& player = mUnk18866d.as<Player&>();
    if (player.mItemInUse->mItem->mCount == 0 && !execution.subject.empty()
        && (item.mCount < count || itemType(item) != execution.subject || changedHeldItem(held, heldItem(*this, hand)))) execution.confirmed = true;
    execution.finish(); return success;
}
LL_TYPE_INSTANCE_HOOK(ArchiveItemOnRequest, ll::memory::HookPriority::Highest, PlayerTransactionSubject,
    MCARCHIVE_NATIVE_SYMBOL("?$useItemOn@PlayerTransactionSubject@@QEAA?AVInteractionResult@@AEAVItemStack@@AEBVBlockPos@@EAEBVVec3@@W4HandSlot@@PEBVBlock@@_N@Z", &PlayerTransactionSubject::$useItemOn), InteractionResult, ItemStack& item, BlockPos const& pos, uchar face,
    Vec3 const& hit, HandSlot hand, Block const* target, bool first) {
    RequestScope scope; request(mUnk18866d.as<Player&>(), item, scope);
    ExecutionScope execution(mUnk18866d.as<Player&>(), itemType(item));
    try { execution.target = ExecutionScope::Target{pos, execution.player.getDimensionBlockSource().getBlock(pos).getTypeName()}; } catch (...) {}
    auto count = item.mCount; auto held = heldItem(*this, hand);
    auto result = origin(item, pos, face, hit, hand, target, first);
    if (execution.player.mItemInUse->mItem->mCount == 0 && !execution.subject.empty()
        && (item.mCount < count || itemType(item) != execution.subject || changedHeldItem(held, heldItem(*this, hand)))) execution.confirmed = true;
    execution.finish(); return result;
}
}
void noteBlockInteraction(Player const& player) noexcept {
    for (auto scope = executing; scope; scope = scope->previous) if (&scope->player == &player) scope->interaction = true;
}
struct ItemBehavior::Impl : Observer {
    Engine& engine;
    std::mutex mutex;
    std::deque<json> pending;
    std::size_t admitted = 0, lost = 0;
    ll::memory::HookRegistrar<ArchiveItemPickup, ArchiveItemRequest, ArchiveItemOnRequest, ArchiveConfirmedItemUse, ArchiveCompletedItemUse, ArchiveReleasedItemUse, ArchiveItemUsedOnEvent, ArchiveItemProjectile, ArchiveRangedItemUse, ArchiveOwnedProjectile, ArchiveDirectedProjectile> hooks;
    explicit Impl(Engine& value) : engine(value) {
        std::unique_lock guard(lifetime);
        if (observer) throw std::runtime_error("Item observer already installed");
        observer = this;
    }
    void flush() {
        while (!pending.empty()) {
            auto batch = json::array(); auto count = std::min<std::size_t>(64, pending.size());
            for (std::size_t i = 0; i < count; ++i) batch.push_back(pending[i]);
            if (!engine.submitEvents(std::move(batch))) return;
            for (std::size_t i = 0; i < count; ++i) pending.pop_front();
            admitted += count;
        }
    }
    void submit(json event) override {
        std::lock_guard lock(mutex); flush();
        if (pending.size() < 32768) pending.push_back(std::move(event));
        else {
            engine.recordCaptureGap();
            if (++lost == 1) engine.note("Item observation backlog is full; capture gap detected");
        }
        flush();
    }
    ~Impl() {
        { std::unique_lock guard(lifetime); observer = nullptr; }
        std::lock_guard lock(mutex); flush();
        engine.recordCaptureGap(pending.size());
        engine.note("Item diagnostics: " + std::to_string(admitted) + " admitted events, " + std::to_string(pending.size()) + " unadmitted events, " + std::to_string(lost) + " lost observations");
    }
};
ItemBehavior::ItemBehavior(Engine& engine) : impl_(std::make_unique<Impl>(engine)) {}
ItemBehavior::~ItemBehavior() = default;
void ItemBehavior::tick() { std::lock_guard lock(impl_->mutex); impl_->flush(); }
}
