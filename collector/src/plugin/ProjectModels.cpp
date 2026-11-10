#include "plugin/ProjectModels.h"
#include "plugin/SceneCapture.h"
#include "core/Transport.h"
#include "core/Platform.h"
#include "mc/world/level/Level.h"
#include "mc/world/level/BlockSource.h"
#include "mc/world/level/block/Block.h"
#include "mc/world/level/dimension/Dimension.h"
#ifdef MCARCHIVE_BDS_12661
#include "mc/world/level/biome/Biome.h"
#include "mc/world/level/biome/registry/BiomeRegistry.h"
#include "mc/world/level/chunk/LevelChunk.h"
#include "mc/world/level/ChunkBlockPos.h"
#include <shared_mutex>
#endif
#include "mc/world/actor/player/Player.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <optional>
#include <set>
#include <thread>
#include <tuple>
#include <unordered_map>

namespace mcarchive {
namespace {
using json=nlohmann::json;
int floor8(int n){return n>=0?n/8*8:(n-7)/8*8;}
struct Plan {std::string id;int revision,dimension,minX,maxX,minZ,maxZ;std::uint64_t cursor=0;int startY=0;std::int64_t nextScan=0;};
struct Section {
    Plan plan;int x,y,z,index=0;std::int64_t at=0;
    std::array<int,512> cells{};
    std::array<int,512> extraCells{};
    std::array<int,512> biomeCells{};
    std::vector<std::string> biomePalette;
    std::unordered_map<void const*,int> biomeTypes;
    bool biomesComplete=true;
    json visuals=json::array(),entityScene=nullptr;
    SceneEntityScan entityScan;
    bool visualsComplete=true;
    std::vector<std::pair<std::string,std::string>> palette{{"minecraft:air",""}};
    std::unordered_map<Block const*,int> types;
};
std::mutex activeMutex; ProjectModels* active=nullptr;
std::atomic<bool> observing{false};
}
struct ProjectModels::Impl {
    HttpTransport transport;Engine& engine;
    std::mutex mutex;std::condition_variable changed;bool stopping=false;
    std::vector<Plan> incoming;bool hasPlan=false;
    std::deque<Section> uploads;
    // Bounded and coalesced: even a large fill never allocates per-block history.
    std::set<std::tuple<std::string,int,int,int,int,int>> dirty;
    std::thread worker;
    std::vector<Plan> plans;std::size_t next=0;unsigned picks=0;
    std::optional<Section> scanning;
    std::uint64_t ticks=0,totalMicros=0,maxMicros=0;bool biomeWarning=false;
    std::chrono::steady_clock::time_point planAt{};
    Impl(EngineConfig const& config,Engine& value):transport(config.endpoint,config.token),engine(value),worker([this]{run();}){}
    void mark(int dimension,BlockPos const& pos) {
        std::lock_guard lock(mutex);
        for(auto const& p:plans)if(dirty.size()<2048 && p.dimension==dimension && pos.x>=p.minX && pos.x<=p.maxX && pos.z>=p.minZ && pos.z<=p.maxZ)dirty.emplace(p.id,p.revision,dimension,floor8(pos.x),floor8(pos.y),floor8(pos.z));
    }
    void run() noexcept {
        auto poll=std::chrono::steady_clock::time_point{};
        std::unordered_map<std::string,std::pair<std::string,std::int64_t>> uploaded;
        while(true) {
            {std::lock_guard lock(mutex);if(stopping)return;}
            try {
                if(std::chrono::steady_clock::now()>=poll) {
                    auto response=transport.postCommand("/project-models/plan",json{{"bootId",engine.bootId()}}.dump());
                    poll=std::chrono::steady_clock::now()+std::chrono::seconds(10);
                    if(response.status==200 && response.error.empty()) {
                        auto data=json::parse(response.body);std::vector<Plan> list;
                        if(!data.is_array() || data.size()>100)throw std::runtime_error("Invalid model plan");
                        for(auto const& p:data) {
                            auto d=p.at("dimension").get<std::string>();int dimension=d=="minecraft:overworld"?0:d=="minecraft:nether"?1:d=="minecraft:the_end"?2:-1;
                            Plan plan{p.at("id"),p.at("revision"),dimension,p.at("minX"),p.at("maxX"),p.at("minZ"),p.at("maxZ")};
                            if(dimension<0 || plan.minX>plan.maxX || plan.minZ>plan.maxZ || plan.minX<-30000000 || plan.maxX>30000000 || plan.minZ<-30000000 || plan.maxZ>30000000)throw std::runtime_error("Invalid model bounds");
                            list.push_back(std::move(plan));
                        }
                        std::lock_guard lock(mutex);incoming=std::move(list);hasPlan=true;
                    }
                }
                std::optional<Section> part;
                {std::lock_guard lock(mutex);if(!uploads.empty())part=uploads.front();}
                if(part) {
                    // JSON compression and network I/O stay off the game thread.
                    json palette=json::array(),runs=json::array(),extraRuns=json::array();
                    for(auto const& entry:part->palette)palette.push_back({{"name",entry.first},{"states",entry.second}});
                    for(int i=0;i<512;) {int value=part->cells[i],end=i+1;while(end<512 && part->cells[end]==value)++end;runs.push_back(value);runs.push_back(end-i);i=end;}
                    for(int i=0;i<512;) {int value=part->extraCells[i],end=i+1;while(end<512 && part->extraCells[end]==value)++end;extraRuns.push_back(value);extraRuns.push_back(end-i);i=end;}
                    json scene=part->entityScene;scene["version"]=1;scene["extraRuns"]=std::move(extraRuns);scene["blockEntities"]=part->visuals;scene["blocksComplete"]=part->visualsComplete;
                    if(part->biomesComplete && !part->biomePalette.empty()) {
                        json biomeRuns=json::array();
                        for(int i=0;i<512;) {int value=part->biomeCells[i],end=i+1;while(end<512 && part->biomeCells[end]==value)++end;biomeRuns.push_back(value);biomeRuns.push_back(end-i);i=end;}
                        scene["biomePalette"]=part->biomePalette;scene["biomeRuns"]=std::move(biomeRuns);
                    }
                    json body={{"bootId",engine.bootId()},{"projectId",part->plan.id},{"revision",part->plan.revision},{"observedAt",timestamp(part->at)},
                        {"section",{{"x",part->x},{"y",part->y},{"z",part->z},{"palette",std::move(palette)},{"runs",std::move(runs)},{"scene",std::move(scene)}}}};
                    auto key=part->plan.id+":"+std::to_string(part->plan.revision)+":"+std::to_string(part->x)+":"+std::to_string(part->y)+":"+std::to_string(part->z);
                    auto hash=sha256(body.at("section").dump());auto old=uploaded.find(key);
                    if(old!=uploaded.end() && old->second.first==hash && part->at-old->second.second<60000) {
                        std::lock_guard lock(mutex);if(!uploads.empty())uploads.pop_front();continue;
                    }
                    auto reply=transport.postCommand("/project-models/capture",body.dump());
                    if(reply.status==200 && reply.error.empty()){if(uploaded.size()>=8192)uploaded.erase(uploaded.begin());uploaded.insert_or_assign(key,std::make_pair(std::move(hash),part->at));}
                    if(reply.status==200 || reply.status==400 || reply.status==401 || reply.status==403 || reply.status==409 || nowMillis()-part->at>240000) {
                        std::lock_guard lock(mutex);if(!uploads.empty())uploads.pop_front();
                    } else {std::unique_lock lock(mutex);changed.wait_for(lock,std::chrono::seconds(2),[this]{return stopping;});}
                }
            } catch(...) {}
            std::unique_lock lock(mutex);changed.wait_for(lock,std::chrono::milliseconds(100),[this]{return stopping || !uploads.empty();});
        }
    }
    bool valid(Plan const& p,int dim,int x,int z)const{return p.dimension==dim && x+7>=p.minX && x<=p.maxX && z+7>=p.minZ && z<=p.maxZ;}
    void tick(Level& level) {
        auto begin=std::chrono::steady_clock::now();
        {
            std::lock_guard lock(mutex);
            if(hasPlan) {
                for(auto& p:incoming){auto old=std::find_if(plans.begin(),plans.end(),[&](auto const& v){return v.id==p.id && v.revision==p.revision;});if(old!=plans.end()){p.cursor=old->cursor;p.startY=old->startY;p.nextScan=old->nextScan;}
                    else level.forEachPlayer([&](Player& player){if(player.isPlayerInitialized() && static_cast<int>(player.getDimensionId())==p.dimension){p.startY=floor8(static_cast<int>(player.getPosition().y));return false;}return true;});}
                plans=std::move(incoming);hasPlan=false;planAt=begin;
                if(scanning && std::none_of(plans.begin(),plans.end(),[&](auto const& p){return p.id==scanning->plan.id && p.revision==scanning->plan.revision;}))scanning.reset();
            }
            observing=!plans.empty();
            if(uploads.size()>=8)return;
        }
        if(plans.empty() || begin-planAt>std::chrono::seconds(60)){observing=false;scanning.reset();return;}
        // Baseline scanning is guaranteed every fourth selection even under heavy writes.
        if(!scanning && (++picks%4)!=0) {
            std::optional<std::tuple<std::string,int,int,int,int,int>> item;
            {std::lock_guard lock(mutex);if(!dirty.empty()){item=*dirty.begin();dirty.erase(dirty.begin());}}
            if(item) {
                auto [id,revision,dim,x,y,z]=*item;
                for(std::size_t n=0;n<plans.size();++n) {auto& p=plans[(next+n)%plans.size()];if(p.id==id && p.revision==revision && valid(p,dim,x,z)) {scanning=Section{p,x,y,z};next=(next+n+1)%plans.size();break;}}
            }
        }
        for(int attempts=0;!scanning && attempts<16;++attempts) {
            auto& p=plans[next++%plans.size()];if(nowMillis()<p.nextScan)continue;auto dimension=level.getDimension(DimensionType{p.dimension}).lock();if(!dimension)continue;
            auto& region=dimension->getBlockSourceFromMainChunkSource();int lo=floor8(region.getMinHeight()),hi=floor8(region.getMaxHeight()-1);
            int countY=(hi-lo)/8+1;if(countY<=0 || countY>768)continue;
            std::uint64_t countX=(floor8(p.maxX)-floor8(p.minX))/8+1,countZ=(floor8(p.maxZ)-floor8(p.minZ))/8+1;
            auto ordinal=p.cursor++%(countX*countZ*countY);int x=floor8(p.minX)+static_cast<int>((ordinal/countY)%countX)*8,z=floor8(p.minZ)+static_cast<int>((ordinal/countY/countX)%countZ)*8;
            int offset=(std::clamp(p.startY,lo,hi)-lo)/8,y=lo+static_cast<int>((ordinal%countY+offset)%countY)*8;
            if(!region.hasChunk(ChunkPos{BlockPos{x,y,z}},true)){p.cursor+=countY-1-(ordinal%countY);if(p.cursor%(countX*countZ*countY)==0)p.nextScan=nowMillis()+30000;continue;}
            if(p.cursor%(countX*countZ*countY)==0)p.nextScan=nowMillis()+30000;
            scanning=Section{p,x,y,z};
        }
        if(!scanning)return;
        auto& part=*scanning;auto dimension=level.getDimension(DimensionType{part.plan.dimension}).lock();if(!dimension){scanning.reset();return;}
        auto& region=dimension->getBlockSourceFromMainChunkSource();
        if(!region.hasChunk(ChunkPos{BlockPos{part.x,part.y,part.z}},true)){scanning.reset();return;}
        for(int reads=0;part.index<512 && reads<256;++reads,++part.index) {
            if(reads%16==0 && std::chrono::steady_clock::now()-begin>std::chrono::microseconds(750))break;
            int i=part.index;BlockPos pos{part.x+i%8,part.y+i/64,part.z+(i/8)%8};
            if(pos.x<part.plan.minX || pos.x>part.plan.maxX || pos.z<part.plan.minZ || pos.z>part.plan.maxZ || pos.y<region.getMinHeight() || pos.y>=region.getMaxHeight())continue;
            auto indexFor=[&](Block const& block){auto found=part.types.find(&block);
            if(found==part.types.end()) {
                std::string name=block.getTypeName();int index=0;
                if(name!="minecraft:air" && name!="minecraft:cave_air" && name!="minecraft:void_air") {
                    auto states=block.mSerializationId.get().toSnbt(SnbtFormat::Minimize);
                    if(states.size()>1024){states.clear();part.visualsComplete=false;}index=static_cast<int>(part.palette.size());part.palette.emplace_back(std::move(name),std::move(states));
                }
                found=part.types.emplace(&block,index).first;
            }
            return found->second;};
#ifdef MCARCHIVE_BDS_12661
            // Read the actual loaded biome at each recorded cell, within the same per-tick budget.
            // Do not infer it from seed, vegetation, or the player's current biome.
            if(part.biomesComplete)try {
                auto* chunk=region.getChunkAt(pos);if(!chunk){scanning.reset();return;}
                auto& storage=chunk->mBiomes.get();std::shared_lock lock(storage.mBiomesMutex.get());
                auto const& layers=storage.mBiomeSubchunks.get();auto local=ChunkBlockPos{pos,region.getMinHeight()};
                Biome const* value=nullptr;
                if(chunk->mUse3DBiomeMaps) {
                    auto layer=static_cast<unsigned>(local.y.mVal)/16;
                    if(layer>=layers.size())throw std::runtime_error("Recorded biome layer unavailable");
                    // Null biome sections serialize as 0xff: reuse the preceding section's palette.
                    // Keep the cell's within-section Y rather than substituting an arbitrary surface biome.
                    while(layer && !layers[layer])--layer;
                    if(!layers[layer])throw std::runtime_error("Recorded biome palette unavailable");
                    value=&layers[layer]->getElement(static_cast<unsigned short>((local.x<<8)|(local.z<<4)|(local.y.mVal&15)));
                } else {
                    auto id=storage.m2DBiomes.get()[(local.x<<4)|local.z].mValue;
                    for(auto const& [hash,candidate]:level.getBiomeRegistry().mBiomesByName.get())if(candidate->mId.get().mValue==id){value=candidate.get();break;}
                    if(!value)throw std::runtime_error("Recorded legacy biome unavailable");
                }
                auto const& biome=*value;auto found=part.biomeTypes.find(&biome);
                if(found==part.biomeTypes.end()) {
                    auto name=biome.mHash.get().getString();if(name.find(':')==std::string::npos)name="minecraft:"+name;
                    if(name.size()>128 || name=="minecraft:" || name.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_:./-")!=std::string::npos)throw std::runtime_error("Biome name invalid: length="+std::to_string(name.size()));
                    else found=part.biomeTypes.emplace(&biome,static_cast<int>(part.biomePalette.size())).first,part.biomePalette.push_back(std::move(name));
                }
                if(part.biomesComplete)part.biomeCells[i]=found->second;
            }catch(std::exception const& e){part.biomesComplete=false;if(!biomeWarning){engine.note(std::string{"Biome capture unavailable: "}+e.what());biomeWarning=true;}}catch(...){part.biomesComplete=false;if(!biomeWarning){engine.note("Biome capture unavailable: native exception");biomeWarning=true;}}
#endif
            part.cells[i]=indexFor(region.getBlock(pos));
            part.extraCells[i]=indexFor(region.getExtraBlock(pos));
            try{auto visual=captureSceneBlock(region,pos);if(!visual.is_null())part.visuals.push_back({{"index",i},{"data",std::move(visual)}});}catch(...){part.visualsComplete=false;}
        }
        if(part.index==512) {
            // Entity capture has its own tick; it never adds work to an already spent block budget.
            if(std::chrono::steady_clock::now()-begin>std::chrono::microseconds(250))return;
            if(!captureSceneEntities(part.entityScan,region,part.x,part.y,part.z,part.plan.minX,part.plan.maxX,part.plan.minZ,part.plan.maxZ))return;
            part.entityScene={{"entities",std::move(part.entityScan.entities)},{"entitiesComplete",part.entityScan.complete}};
            part.at=nowMillis();part.types.clear();part.biomeTypes.clear();
            {std::lock_guard lock(mutex);uploads.push_back(std::move(part));}
            scanning.reset();changed.notify_one();
        }
    }
    ~Impl(){ {std::lock_guard lock(mutex);stopping=true;}changed.notify_all();if(worker.joinable())worker.join();engine.note("Project model main-thread diagnostics: ticks="+std::to_string(ticks)+" total_us="+std::to_string(totalMicros)+" max_us="+std::to_string(maxMicros)); }
};
ProjectModels::ProjectModels(EngineConfig const& config,Engine& engine):impl_(std::make_unique<Impl>(config,engine)){std::lock_guard lock(activeMutex);active=this;}
ProjectModels::~ProjectModels(){std::lock_guard lock(activeMutex);active=nullptr;observing=false;}
void ProjectModels::tick(Level& level){auto begin=std::chrono::steady_clock::now();try{impl_->tick(level);}catch(...){impl_->scanning.reset();}auto elapsed=static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now()-begin).count());++impl_->ticks;impl_->totalMicros+=elapsed;impl_->maxMicros=std::max(impl_->maxMicros,elapsed);}
void markProjectModelDirty(BlockSource& region,BlockPos const& pos) noexcept {
    if(!observing.load(std::memory_order_relaxed))return;
    try{std::lock_guard lock(activeMutex);if(active)active->impl_->mark(static_cast<int>(region.getDimensionId()),pos);}catch(...){}
}
}
