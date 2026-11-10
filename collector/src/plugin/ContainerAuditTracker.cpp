#include "plugin/ContainerAuditTracker.h"
#if defined(MCARCHIVE_BDS_12661)
#include "plugin/GameTracker.h"
#include "core/Platform.h"
#include "ll/api/memory/Hook.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/containers/managers/models/ContainerManagerModel.h"
#include "mc/world/inventory/simulation/ContainerScreenValidation.h"
#include "mc/world/level/Level.h"
#include "mc/world/level/BlockSource.h"
#include "mc/world/level/block/Block.h"
#include "mc/world/level/block/actor/ChestBlockActor.h"
#include "mc/world/item/ItemStack.h"
#include <map>
#include <set>
#include <optional>
#include <shared_mutex>
#include <mutex>

namespace mcarchive {
namespace {
using json=nlohmann::json;
bool supported(std::string const& type) {
    static const std::set<std::string> types={"minecraft:chest","minecraft:trapped_chest","minecraft:barrel",
        "minecraft:shulker_box","minecraft:undyed_shulker_box","minecraft:hopper","minecraft:dispenser",
        "minecraft:dropper","minecraft:furnace","minecraft:lit_furnace","minecraft:blast_furnace",
        "minecraft:lit_blast_furnace","minecraft:smoker","minecraft:lit_smoker","minecraft:brewing_stand","minecraft:crafter"};
    return types.contains(type) || (type.starts_with("minecraft:") && type.ends_with("_shulker_box"));
}
json position(BlockPos const& p) { return {{"x",p.x},{"y",p.y},{"z",p.z}}; }
struct Snapshot { std::string key,dimension,block; json positions,slots; };
std::optional<Snapshot> snapshot(Player const& player, BlockPos pos) {
    if(!player.isPlayerInitialized()) return {};
    auto& region=player.getDimensionBlockSource();
    auto type=region.getBlock(pos).getTypeName();
    if(!supported(type)) return {};
    json positions=json::array({position(pos)});
    if(type=="minecraft:chest" || type=="minecraft:trapped_chest") {
        auto actor=region.getBlockEntity(pos);
        if(!actor || actor->getType()!=BlockActorType::Chest) return {};
        auto& chest=static_cast<ChestBlockActor&>(*actor);
        if(auto other=chest.mLargeChestPaired) {
            auto otherPos=other->getPosition();
            // Do not trust a stale pair pointer after a block replacement.
            if(region.getBlockEntity(otherPos)!=other || region.getBlock(otherPos).getTypeName()!=type) return {};
            if(!chest.mPairLead) pos=otherPos;
            auto lead=static_cast<ChestBlockActor*>(region.getBlockEntity(pos));
            auto paired=lead->mLargeChestPaired;
            if(!paired) return {};
            positions=json::array({position(pos),position(paired->getPosition())});
        }
    }
    auto container=region.tryGetContainer(pos);
    if(!container) return {};
    int size=container->getContainerSize();
    if(size<1 || size>256) return {};
    json slots=json::array();
    for(int slot=0;slot<size;++slot) {
        auto const& item=container->getItem(slot);
        if(!item.mCount) slots.push_back(nullptr);
        else {
            auto name=item.getTypeName();
            if(name.empty() || name.size()>128 || name=="minecraft:air") return {};
            slots.push_back({{"type",name},{"count",static_cast<unsigned>(item.mCount)}});
        }
    }
    auto dimension=playerDimension(player);
    return Snapshot{dimension+":"+std::to_string(pos.x)+":"+std::to_string(pos.y)+":"+std::to_string(pos.z),
        dimension,std::move(type),std::move(positions),std::move(slots)};
}
json changes(Snapshot const& before,Snapshot const& after) {
    json result=json::array();
    if(before.key!=after.key || before.block!=after.block || before.positions!=after.positions || before.slots.size()!=after.slots.size()) return result;
    for(std::size_t slot=0;slot<before.slots.size();++slot) if(before.slots[slot]!=after.slots[slot])
        result.push_back({{"slot",slot},{"before",before.slots[slot]},{"after",after.slots[slot]}});
    return result;
}
struct Sink {
    virtual void publish(Player const*, Snapshot const&, char const*, char const*, json)=0;
    virtual void baseline(Snapshot const&,bool)=0;
    virtual void gap() noexcept=0;
    virtual ~Sink()=default;
};
Sink* sink=nullptr;
std::shared_mutex lifetime;
thread_local unsigned commitDepth=0;
struct Depth { Depth(){++commitDepth;} ~Depth(){--commitDepth;} };
LL_TYPE_INSTANCE_HOOK(ArchiveContainerCommit,ll::memory::HookPriority::Highest,ContainerScreenValidation,
    ll::memory::SymbolView{"?tryCommitActionResults@ContainerScreenValidation@@QEAA_NXZ"},bool) {
    Depth depth;
    if(commitDepth!=1) return origin();
    // This exact symbol is already verified by the 1.26.61.1 runtime adapter.
    // Failed/rolled-back requests must never become attributed transfers.
    std::shared_lock alive(lifetime);
    Player* player=nullptr;
    std::optional<BlockPos> pos;
    std::optional<Snapshot> before;
    try { if(sink && commitDepth==1) {
        auto const& context=mScreenContext.get();
        player=context.mPlayer;
        if(player) if(auto block=std::get_if<BlockPos>(&context.mOwner.get())) {
            pos=*block; before=snapshot(*player,*pos);
            if(before) sink->baseline(*before,true);
        }
    }} catch(...) { if(sink) sink->gap(); before.reset(); }
    bool success=origin();
    try { if(sink && before && player && pos) {
        auto after=snapshot(*player,*pos);
        if(after) {
            auto delta=changes(*before,*after);
            if(!delta.empty()) sink->publish(success?player:nullptr,*after,success?"TRANSFER":"CHANGE",
                success?"COMMITTED_TRANSACTION":"OBSERVED_CHANGE",std::move(delta));
            sink->baseline(*after,false);
        } else sink->gap();
    }} catch(...) { if(sink) sink->gap(); }
    return success;
}
}
struct ContainerAuditTracker::Impl : Sink {
    Engine& engine;
    struct Open { std::weak_ptr<ContainerManagerModel> manager; std::string location; };
    std::map<std::string,Open> opened;
    std::map<std::string,Snapshot> baselines;
    ll::memory::HookRegistrar<ArchiveContainerCommit> hooks;
    unsigned ticks=0;
    explicit Impl(Engine& e):engine(e) { std::unique_lock lock(lifetime); if(sink) throw std::runtime_error("Container audit already installed"); sink=this; }
    ~Impl() { std::unique_lock lock(lifetime); sink=nullptr; }
    void gap() noexcept override { engine.recordCaptureGap(); }
    void publish(Player const* player,Snapshot const& value,char const* operation,char const* evidence,json delta) override {
        json event={{"eventId",uuid()},{"kind","CONTAINER"},{"at",timestamp(nowMillis())},
            {"dimension",value.dimension},{"player",player?playerIdentity(*player):json(nullptr)},
            {"container",{{"operation",operation},{"evidence",evidence},{"block",value.block},{"positions",value.positions},{"changes",std::move(delta)}}}};
        // Engine's bounded queue, off-thread durable writer and idempotent retry
        // are shared with existing telemetry. Never write disk/HTTP here.
        if(!engine.submit(std::move(event))) gap();
    }
    void baseline(Snapshot const& value,bool observe) override {
        auto found=baselines.find(value.key);
        if(found!=baselines.end()) {
            if(observe) {
                auto delta=changes(found->second,value);
                if(!delta.empty()) publish(nullptr,value,"CHANGE","OBSERVED_CHANGE",std::move(delta));
            }
            found->second=value;
        } else if(baselines.size()<128) baselines.emplace(value.key,value);
        else gap();
    }
    void tick(Level& level) {
        ++ticks;
        std::set<std::string> present,watched,checked;
        level.forEachPlayer([&](Player& player) {
            if(!player.isPlayerInitialized()) return true;
            try {
                auto key=stablePlayerKey(player); present.insert(key);
                auto manager=player.mContainerManager;
                if(!manager || manager->mScreenContext->mPlayer!=&player) { opened.erase(key); return true; }
                auto pos=std::get_if<BlockPos>(&manager->mScreenContext->mOwner.get());
                if(!pos) { opened.erase(key); return true; }
                auto old=opened.find(key);
                bool fresh=old==opened.end() || old->second.manager.lock()!=manager;
                if(!fresh && ticks%20!=0) { watched.insert(old->second.location); return true; }
                auto value=snapshot(player,*pos);
                if(!value) { opened.erase(key); return true; }
                watched.insert(value->key);
                if(fresh) {
                    if(opened.size()>=128) { gap(); return true; }
                    // This proves a server-side screen was observed, not the
                    // precise open instant. Sub-tick open/close can be missed.
                    publish(&player,*value,"OPEN","OBSERVED_OPEN",json::array());
                    opened.insert_or_assign(key,Open{manager,value->key});
                }
                if(checked.insert(value->key).second) baseline(*value,true);
            } catch(...) { gap(); }
            return true;
        });
        std::erase_if(opened,[&](auto const& row){return !present.contains(row.first);});
        // No world scan or chunk forcing. Unknown changes are sampled only
        // while a supported container has a viewer, at most 128 containers.
        std::erase_if(baselines,[&](auto const& row){return !watched.contains(row.first);});
    }
};
void auditContainerBlock(Player const& player,BlockPos const& pos,std::string const& type,bool placed) noexcept {
    try {
        std::shared_lock alive(lifetime);
        if(!sink || !supported(type) || !player.isPlayerInitialized()) return;
        Snapshot value{"",playerDimension(player),type,json::array({position(pos)}),json::array()};
        sink->publish(&player,value,placed?"PLACE":"BREAK",placed?"CONFIRMED_PLACE":"CONFIRMED_BREAK",json::array());
    } catch(...) { std::shared_lock alive(lifetime); if(sink) sink->gap(); }
}
ContainerAuditTracker::ContainerAuditTracker(Engine& e):impl_(std::make_unique<Impl>(e)) {}
ContainerAuditTracker::~ContainerAuditTracker()=default;
void ContainerAuditTracker::tick(Level& level) { impl_->tick(level); }
}
#else
namespace mcarchive {
struct ContainerAuditTracker::Impl {};
ContainerAuditTracker::ContainerAuditTracker(Engine&):impl_(std::make_unique<Impl>()) {}
ContainerAuditTracker::~ContainerAuditTracker()=default;
void ContainerAuditTracker::tick(Level&) {}
void auditContainerBlock(Player const&,BlockPos const&,std::string const&,bool) noexcept {}
}
#endif
