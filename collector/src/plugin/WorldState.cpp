#include "plugin/WorldState.h"
#include "plugin/GameTracker.h"
#include "core/Transport.h"
#include "ll/api/event/EventBus.h"
#include "ll/api/event/player/PlayerDisconnectEvent.h"
#include "mc/world/actor/player/Inventory.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/attribute/AttributeInstance.h"
#include "mc/world/attribute/AttributeInstanceConstRef.h"
#include "mc/world/item/ItemStack.h"
#include "mc/world/level/BlockSource.h"
#include "mc/world/level/Level.h"
#include "mc/world/level/block/Block.h"
#include "mc/world/level/block/actor/FurnaceBlockActor.h"
#include "mc/world/level/dimension/Dimension.h"
#include "mc/world/level/storage/LevelData.h"
#include "mc/world/phys/AABB.h"
#include <algorithm>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <thread>
#include <unordered_map>

namespace mcarchive {
namespace {
using json = nlohmann::json;
json position(Vec3 const& value) { return {{"x",value.x},{"y",value.y},{"z",value.z}}; }
json item(ItemStack const& value,int slot) {
    if(value.isNull()) return {{"slot",slot},{"item",nullptr},{"count",0}};
    return {{"slot",slot},{"item",value.getTypeName()},{"count",static_cast<int>(value.mCount)}};
}
json container(Container const& value) {
    int size=value.getContainerSize(); json items=json::array();
    for(int slot=0;slot<std::min(size,64);++slot) items.push_back(item(value.getItem(slot),slot));
    return {{"size",size},{"slots",std::move(items)},{"truncated",size>64}};
}
json playerState(Player const& player) {
    auto hunger=player.getAttribute(Player::HUNGER());
    json armor=json::array();
    for(int slot=0;slot<4;++slot) armor.push_back(item(player.getArmor(static_cast<SharedTypes::Legacy::ArmorSlot>(slot)),slot));
    return {{"playerKey",stablePlayerKey(player)},{"identity",playerIdentity(player)},
        {"dimension",playerDimension(player)},{"position",position(player.getPosition())},
        {"health",player.getHealth()},{"maxHealth",player.getMaxHealth()},{"alive",!player.isDead()},
        {"hunger",hunger.mPtr?json(static_cast<float>(hunger.mPtr->mCurrentValue)):json(nullptr)},
        {"inventory",container(player.getInventory())},{"armor",std::move(armor)},
        {"selectedSlot",player.getSelectedItemSlot()},{"mainHand",item(player.getSelectedItem(),player.getSelectedItemSlot())},
        {"offHand",item(player.getOffhandSlot(),0)},
        {"gameMode",static_cast<int>(player.getPlayerGameType())}};
}
int dimensionId(std::string const& name) {
    if(name=="minecraft:overworld") return 0;
    if(name=="minecraft:nether") return 1;
    if(name=="minecraft:the_end") return 2;
    throw std::runtime_error("Unsupported query dimension");
}
json blockState(BlockSource& region,BlockPos const& pos,bool contents) {
    auto const& block=region.getBlock(pos);
    auto states=block.mSerializationId.get().toSnbt(SnbtFormat::Minimize);
    bool statesTruncated=states.size()>4096;
    json result={{"x",pos.x},{"y",pos.y},{"z",pos.z},{"block",block.getTypeName()},
        {"states",statesTruncated?json(nullptr):json(std::move(states))},{"statesTruncated",statesTruncated}};
    if(contents) {
        auto value=region.tryGetContainer(pos);
        result["container"]=value?container(*value):json(nullptr);
        auto actor=region.getBlockEntity(pos);
        if(actor && (actor->getType()==BlockActorType::Furnace || actor->getType()==BlockActorType::BlastFurnace || actor->getType()==BlockActorType::Smoker)) {
            auto const& furnace=static_cast<FurnaceBlockActor const&>(*actor);
            result["furnace"]={{"burnTicksRemaining",static_cast<int>(furnace.mLitTime)},
                {"burnDurationTicks",static_cast<int>(furnace.mLitDuration)},{"cookingProgressTicks",static_cast<int>(furnace.mCookingProgress)}};
        }
    }
    return result;
}
json execute(Level& level,json const& request) {
    std::string kind=request.at("kind");
    if(kind=="WORLD") {
        json players=json::array(); std::size_t count=0;
        level.forEachPlayer([&](Player& player) {
            if(player.isPlayerInitialized()) {
                if(count<100) players.push_back({{"playerKey",stablePlayerKey(player)},{"identity",playerIdentity(player)},{"dimension",playerDimension(player)}});
                ++count;
            }
            return true;
        });
        auto const& data=level.getLevelData();
        return {{"status","READY"},{"data",{{"gameTimeTicks",level.getTime()},
            {"rainLevel",static_cast<float>(data.mRainLevel)},{"lightningLevel",static_cast<float>(data.mLightningLevel)},
            {"observedOnlineCount",count},{"players",std::move(players)},{"playersTruncated",count>100}}}};
    }
    if(kind=="PLAYER") {
        json found;
        level.forEachPlayer([&](Player& player) {
            if(player.isPlayerInitialized() && stablePlayerKey(player)==request.at("playerKey").get<std::string>()) { found=playerState(player); return false; }
            return true;
        });
        return found.is_null()?json{{"status","PLAYER_OFFLINE"},{"data",json::object()}}:json{{"status","READY"},{"data",std::move(found)}};
    }
    auto locked=level.getDimension(DimensionType{dimensionId(request.at("dimension").get<std::string>())}).lock();
    auto dimension=locked.get();
    if(!dimension) return {{"status","UNAVAILABLE"},{"data",json::object()}};
    auto& region=dimension->getBlockSourceFromMainChunkSource();
    BlockPos pos{request.at("x").get<int>(),request.at("y").get<int>(),request.at("z").get<int>()};
    if(pos.y<region.getMinHeight() || pos.y>=region.getMaxHeight()) return {{"status","OUT_OF_BOUNDS"},{"data",json::object()}};
    if(!region.hasChunk(ChunkPos{pos},true)) return {{"status","CHUNK_UNLOADED"},{"data",json::object()}};
    if(kind=="BLOCK" || kind=="CONTAINER") {
        auto result=blockState(region,pos,kind=="CONTAINER");
        result["dimension"]=request.at("dimension");
        return {{"status","READY"},{"data",std::move(result)}};
    }
    if(kind!="NEARBY") throw std::runtime_error("Unsupported query kind");
    int radius=request.at("radius").get<int>(); bool partial=false,truncated=false;
    json blocks=json::array(),entities=json::array();
    std::string filter=request.at("blockType").is_string()?request.at("blockType").get<std::string>():"";
    for(int x=pos.x-radius;x<=pos.x+radius;++x) for(int z=pos.z-radius;z<=pos.z+radius;++z) {
        if(!region.hasChunk(ChunkPos{BlockPos{x,pos.y,z}},true)) { partial=true; continue; }
        for(int y=std::max(pos.y-radius,static_cast<int>(region.getMinHeight()));y<=std::min(pos.y+radius,static_cast<int>(region.getMaxHeight())-1);++y) {
            BlockPos target{x,y,z};
            bool matched=filter.empty()?region.getBlockEntity(target)!=nullptr:region.getBlock(target).getTypeName()==filter;
            if(matched) {
                if(blocks.size()<64) blocks.push_back(blockState(region,target,false)); else truncated=true;
            }
        }
    }
    auto nearby=region.getEntities(AABB{Vec3{static_cast<float>(pos.x-radius),static_cast<float>(pos.y-radius),static_cast<float>(pos.z-radius)},
        Vec3{static_cast<float>(pos.x+radius+1),static_cast<float>(pos.y+radius+1),static_cast<float>(pos.z+radius+1)}},0);
    for(auto actor:nearby) {
        if(!actor) continue;
        if(entities.size()>=64) { truncated=true; break; }
        bool living=actor->hasCategory(ActorCategory::Mob);
        entities.push_back({{"entityId",std::to_string(actor->getOrCreateUniqueID().rawID)},
            {"type",actor->getTypeName()},{"position",position(actor->getPosition())},{"alive",!actor->isDead()},
            {"health",living?json(actor->getHealth()):json(nullptr)},{"maxHealth",living?json(actor->getMaxHealth()):json(nullptr)},
            {"onFire",actor->isOnFire()},{"inWater",actor->isInWater()}});
    }
    return {{"status","READY"},{"data",{{"dimension",request.at("dimension")},{"center",{{"x",pos.x},{"y",pos.y},{"z",pos.z}}},
        {"radius",radius},{"blocks",std::move(blocks)},{"entities",std::move(entities)},{"partialCoverage",partial},{"truncated",truncated}}}};
}
}
struct WorldState::Impl {
    HttpTransport transport;
    Engine& engine;
    std::mutex mutex;
    std::condition_variable changed;
    bool stopping=false,executing=false;
    std::optional<json> scheduled,completed;
    std::unordered_map<std::string,json> snapshots;
    std::unordered_map<std::string,std::int64_t> lastCaptured;
    ll::event::ListenerPtr disconnect;
    std::thread worker;
    Impl(EngineConfig const& config,Engine& value) : transport(config.endpoint,config.token),engine(value) {
        disconnect=ll::event::EventBus::getInstance().emplaceListener<ll::event::PlayerDisconnectEvent>([this](auto& event) {
            try {
                if(event.self().isPlayerInitialized()) remember(event.self());
                std::lock_guard lock(mutex); lastCaptured.erase(stablePlayerKey(event.self()));
            }
            catch(...) {}
        });
        try { worker=std::thread([this] { run(); }); }
        catch(...) { ll::event::EventBus::getInstance().removeListener(disconnect); throw; }
    }
    void remember(Player const& player) {
        auto key=stablePlayerKey(player);
        auto data=playerState(player);
        json snapshot={{"playerKey",key},{"observedAt",timestamp(nowMillis())},{"data",std::move(data)}};
        std::lock_guard lock(mutex);
        if(snapshots.size()<1024 || snapshots.contains(key)) { snapshots.insert_or_assign(key,std::move(snapshot)); lastCaptured[key]=nowMillis(); }
        changed.notify_one();
    }
    void run() noexcept {
        while(true) {
            json batch=json::array(); std::optional<json> result; bool stop;
            {
                std::lock_guard lock(mutex); stop=stopping;
                for(auto const& [key,value]:snapshots) { if(batch.size()==8) break; batch.push_back(value); }
                result=completed;
            }
            try {
                if(!batch.empty()) {
                    auto reply=transport.postCommand("/world-queries/player-snapshots",json{{"bootId",engine.bootId()},{"players",batch}}.dump());
                    if((reply.status==200 && reply.error.empty()) || reply.status==400 || reply.status==403 || reply.status==409) {
                        std::lock_guard lock(mutex);
                        for(auto const& saved:batch) {
                            auto current=snapshots.find(saved.at("playerKey").get<std::string>());
                            if(current!=snapshots.end() && current->second==saved) snapshots.erase(current);
                        }
                    }
                }
                if(result) {
                    auto reply=transport.postCommand("/world-queries/"+result->at("id").get<std::string>()+"/complete",result->at("body").dump());
                    if(reply.status==200 || reply.status==400 || reply.status==403 || reply.status==409) {
                        std::lock_guard lock(mutex); completed.reset();
                    }
                }
                if(stop) return;
                bool idle;
                { std::lock_guard lock(mutex); idle=!scheduled && !completed && !executing; }
                if(idle) {
                    auto reply=transport.postCommand("/world-queries/claim",json{{"bootId",engine.bootId()}}.dump());
                    if(reply.status==200 && reply.error.empty()) {
                        auto leases=json::parse(reply.body);
                        if(leases.is_array() && leases.size()==1 && leases[0].at("bootId")==engine.bootId()) {
                            std::lock_guard lock(mutex); scheduled=leases[0];
                        }
                    }
                }
            } catch(...) {}
            std::unique_lock lock(mutex);
            changed.wait_for(lock,std::chrono::milliseconds(500),[this] { return stopping; });
        }
    }
    void tick(Level& level) {
        std::optional<json> lease;
        { std::lock_guard lock(mutex); if(scheduled) { lease=std::move(scheduled); scheduled.reset(); executing=true; } }
        if(lease) {
            json result;
            try {
                result=execute(level,lease->at("request"));
                if(result.at("data").dump().size()>55000) result={{"status","UNAVAILABLE"},{"data",{{"reason","RESULT_TOO_LARGE"}}}};
            }
            catch(...) { result={{"status","UNAVAILABLE"},{"data",json::object()}}; }
            result["observedAt"]=timestamp(nowMillis()); result["leaseId"]=lease->at("leaseId"); result["bootId"]=engine.bootId();
            { std::lock_guard lock(mutex); completed=json{{"id",lease->at("id")},{"body",std::move(result)}}; executing=false; }
        }
        int captured=0;
        level.forEachPlayer([&](Player& player) {
            if(!player.isPlayerInitialized()) return true;
            auto key=stablePlayerKey(player); bool due;
            { std::lock_guard lock(mutex); auto found=lastCaptured.find(key); due=found==lastCaptured.end() || nowMillis()-found->second>=30000; }
            if(due) { try { remember(player); ++captured; } catch(...) {} }
            return captured<2;
        });
    }
    ~Impl() {
        ll::event::EventBus::getInstance().removeListener(disconnect);
        { std::lock_guard lock(mutex); stopping=true; }
        changed.notify_all();
        if(worker.joinable()) worker.join();
    }
};
WorldState::WorldState(EngineConfig const& config,Engine& engine) : impl_(std::make_unique<Impl>(config,engine)) {}
WorldState::~WorldState()=default;
void WorldState::tick(Level& level) { impl_->tick(level); }
}
