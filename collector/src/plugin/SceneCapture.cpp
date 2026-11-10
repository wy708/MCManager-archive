#include "plugin/SceneCapture.h"
#include "mc/deps/nbt/CompoundTagVariant.h"
#include "mc/world/actor/Actor.h"
#include "mc/world/level/BlockSource.h"
#include "mc/world/level/block/Block.h"
#include "mc/world/level/block/actor/BlockActor.h"
#include "mc/world/item/SaveContext.h"
#include "mc/world/phys/AABB.h"
#include <algorithm>
#include <cmath>
#include <chrono>
#include <set>
#include <string_view>
#include <unordered_map>

namespace mcarchive {
namespace {
using json=nlohmann::json;
// A bounded conversion of selected visual fields, not general NBT export.
json value(Tag const& tag,int depth,int& remaining) {
    if(depth>8 || --remaining<0)throw std::runtime_error("Scene visual data exceeds budget");
    switch(tag.getId()) {
    case Tag::Byte:return tag.as<ByteTag>().data;
    case Tag::Short:return tag.as<ShortTag>().data;
    case Tag::Int:return tag.as<IntTag>().data;
    case Tag::Int64:return std::to_string(tag.as<Int64Tag>().data);
    case Tag::Float:return tag.as<FloatTag>().data;
    case Tag::Double:return tag.as<DoubleTag>().data;
    case Tag::String:{auto const& text=static_cast<std::string const&>(tag.as<StringTag>());if(text.size()>4096)throw std::runtime_error("Scene text exceeds budget");return text;}
    case Tag::List:{json result=json::array();for(auto const& child:tag.as<ListTag>())result.push_back(value(*child,depth+1,remaining));return result;}
    case Tag::Compound:{json result=json::object();for(auto const& [key,child]:tag.as<CompoundTag>().mTags)result[key]=value(child.get(),depth+1,remaining);return result;}
    default:return nullptr;
    }
}
json selected(CompoundTag const& tag,std::initializer_list<std::string_view> keys) {
    json result=json::object();int budget=4096;
    for(auto key:keys){auto found=tag.mTags.find(key);if(found!=tag.mTags.end())result[std::string(key)]=value(found->second.get(),0,budget);}
    return result;
}
json visibleItem(json const& input) {
    if(!input.is_object())return nullptr;
    json result=json::object();
    for(auto key:{"Name","Count","Damage","WasPickedUp"})if(input.contains(key))result[key]=input[key];
    if(input.contains("tag") && input["tag"].is_object()){
        auto const& tag=input["tag"];json visual=json::object();
        // No BlockEntityTag, container inventory, books, lore, owner or command text.
        for(auto key:{"customColor","ench","Trim","CustomModelData"})if(tag.contains(key))visual[key]=tag[key];
        if(!visual.empty())result["tag"]=std::move(visual);
    }
    return result;
}
void sanitizeItems(json& data) {
    for(auto key:{"Item","item"})if(data.contains(key))data[key]=visibleItem(data[key]);
    for(auto key:{"Armor","Mainhand","Offhand"})if(data.contains(key)){
        if(!data[key].is_array()){data.erase(key);continue;}
        for(auto& item:data[key])item=visibleItem(item);
    }
    for(auto key:{"FrontText","BackText"})if(data.contains(key)){
        auto original=data[key];data[key]=json::object();
        // LastEditXuid and other editor identity fields are deliberately excluded.
        for(auto field:{"Text","SignTextColor","IgnoreLighting","PersistFormatting"})if(original.contains(field))data[key][field]=original[field];
    }
}
}
json captureSceneBlock(BlockSource& region,BlockPos const& pos) {
    auto name=region.getBlock(pos).getTypeName();
    if(name.find("sign")==std::string::npos && name.find("frame")==std::string::npos && name.find("banner")==std::string::npos && name.find("skull")==std::string::npos && name.find("head")==std::string::npos)return nullptr;
    auto actor=region.getBlockEntity(pos);if(!actor)return nullptr;
    CompoundTag saved;SaveContext context;
    if(!actor->save(saved,context))return nullptr;
    auto data=selected(saved,{"id","Text","FrontText","BackText","SignTextColor","IgnoreLighting","Item","ItemRotation","isMovable","Base","Patterns","SkullType","Rot","MouthMoving","MouthTickCount","color"});
    sanitizeItems(data);
    // Empty/chest/furnace data carries no visible additional model information.
    if(data.size()<=2 && !data.contains("Item"))return nullptr;
    return data;
}
bool captureSceneEntities(SceneEntityScan& scan,BlockSource& region,int x,int y,int z,int minX,int maxX,int minZ,int maxZ) {
    auto start=std::chrono::steady_clock::now();
    auto inside=[&](Actor* actor){if(!actor||actor->isPlayer()||actor->isDead())return false;auto const type=actor->getTypeName();if(type=="minecraft:item")return false;auto const& p=actor->getPosition();return std::isfinite(p.x)&&std::isfinite(p.y)&&std::isfinite(p.z)&&p.x>=x&&p.x<x+8&&p.y>=y&&p.y<y+8&&p.z>=z&&p.z<z+8&&p.x>=minX&&p.x<double(maxX)+1&&p.z>=minZ&&p.z<double(maxZ)+1;};
    // Re-resolve from the current dimension's loaded region each tick. No pointer survives this call.
    std::unordered_map<std::int64_t,Actor*> current;
    auto actors=region.getEntities(AABB{Vec3{float(x),float(y),float(z)},Vec3{float(x+8),float(y+8),float(z+8)}},0);
    for(auto actor:actors)if(inside(actor))current.emplace(actor->getOrCreateUniqueID().rawID,actor);
    if(!scan.initialized){
        scan.initialized=true;
        for(auto const& [id,actor]:current){
            if(scan.ids.size()>=512){scan.complete=false;break;}
            scan.ids.push_back(id);
        }
    }
    while(scan.cursor<scan.ids.size()) {
        if(std::chrono::steady_clock::now()-start>std::chrono::microseconds(750))return false;
        auto id=scan.ids[scan.cursor++];auto found=current.find(id);if(found==current.end())continue;auto actor=found->second;
        auto const& p=actor->getPosition();
        try {
            CompoundTag saved;if(!actor->save(saved)){scan.complete=false;continue;}
            auto data=selected(saved,{"identifier","Pos","Rotation","Variant","MarkVariant","Color","Color2","IsBaby","CustomName","CustomNameVisible","Armor","Mainhand","Offhand","Item","Pose","PoseIndex","SkinID","Saddled","Sheared","IsTamed","IsAngry","IsSitting","IsEating","IsStanding","IsSwimming","IsSleeping","definitions","BodyRot","HeadYaw","Invisible","ShowArms","NoBasePlate","Small","Art","Motive","Direction","Dir","TileX","TileY","TileZ"});
            sanitizeItems(data);
            auto const& rotation=actor->getRotation();
            json entity={{"id",std::to_string(id)},{"type",actor->getTypeName()},
                {"x",p.x},{"y",p.y},{"z",p.z},{"pitch",rotation.x},{"yaw",rotation.y},{"data",std::move(data)}};
            std::size_t nodes=0;auto count=[&](auto&& self,json const& node)->void{++nodes;if(node.is_structured())for(auto const& child:node)self(self,child);};count(count,entity);
            auto bytes=entity.dump().size();
            if(scan.bytes+bytes>700000||scan.nodes+nodes>48000){scan.complete=false;scan.cursor=scan.ids.size();break;}
            scan.bytes+=bytes;scan.nodes+=nodes;scan.entities.push_back(std::move(entity));
        }catch(...){scan.complete=false;}
    }
    scan.ids.clear();return true;
}
}
