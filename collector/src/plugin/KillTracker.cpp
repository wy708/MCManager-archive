#include "plugin/RuntimeApi.h"
#include "plugin/KillTracker.h"
#include "plugin/GameTracker.h"
#include "core/Platform.h"
#include "ll/api/memory/Hook.h"
#include "mc/deps/nbt/CompoundTag.h"
#include "mc/world/actor/Actor.h"
#include "mc/world/actor/Mob.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/actor/boss/WitherBoss.h"
#include "mc/world/actor/ActorDamageSource.h"
#include "mc/world/actor/ActorHurtResult.h"
#include "mc/world/level/Level.h"
#include "mc/world/phys/HitResult.h"
#include "mc/entity/components/ActorOwnerComponent.h"
#include "mc/entity/components/OnFireComponent.h"
#include "mc/entity/components/AbilitiesComponent.h"
#include "mc/entity/components_json_legacy/ProjectileComponent.h"
#include "mc/entity/components_json_legacy/TameableComponent.h"
#include "mc/world/gamemode/InteractionResult.h"
#include "mc/entity/systems/OnFireSystem.h"
#include "mc/entity/systems/OnFireServerSystem.h"
#include "mc/deps/ecs/gamerefs_entity/EntityContext.h"
#include <algorithm>
#include <atomic>
#include <deque>
#include <mutex>
#include <optional>
#include <regex>
#include <shared_mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace mcarchive {
namespace {
using json = nlohmann::json;
using Cause = SharedTypes::Legacy::ActorDamageCause;
struct Credit {
    json identity;
    std::string key;
    ActorUniqueID actor;
    bool pet;
    bool delayedBoss = false;
    bool cachedPet = false;
    bool savedPet = false;
    std::int64_t observedAt = 0;
};
struct ProjectileCredit { Credit owner; ActorUniqueID shooter; };
struct DamageKey {
    Cause cause; ActorUniqueID parent, damaging; bool entity, child;
    bool operator==(DamageKey const&) const = default;
};
DamageKey damageKey(ActorDamageSource const& source) { return {source.mCause,source.getEntityUniqueID(),source.getDamagingEntityUniqueID(),source.isEntitySource(),source.isChildEntitySource()}; }
struct DelayedDeath { Credit owner; DamageKey source; int aliveScans = 0; };
struct Capture { virtual void submit(json) = 0; virtual ~Capture() = default; };
std::shared_mutex lifetime;
Capture* capture = nullptr;
std::mutex stateMutex;
std::string petArchiveId;
std::unordered_set<ActorUniqueID> credited;
std::unordered_map<ActorUniqueID,Credit> burning, pets;
std::unordered_map<ActorUniqueID,ProjectileCredit> projectiles;
std::unordered_map<ActorUniqueID,DelayedDeath> delayedDeaths;
std::atomic<std::size_t> directCredits{0}, petCredits{0}, burnCredits{0}, duplicateCredits{0}, unassigned{0}, capacityLoss{0};
std::atomic<std::size_t> delayedBossCredits{0}, delayedInvalidations{0};
std::atomic<std::size_t> cachedPetCredits{0}, delayedSourceMismatches{0};
std::atomic<std::size_t> savedPetCredits{0};
constexpr auto petOwnerTag = "MCArchivePetOwnerV1";

void cachePet(ActorUniqueID pet, Credit owner) {
    if (pets.size() < 32768 || pets.contains(pet))
        pets.insert_or_assign(pet, std::move(owner));
    else
        ++capacityLoss;
}

std::optional<Credit> credit(Actor const* source) noexcept { try {
    if (!source) return {};
    std::shared_lock alive(lifetime);if(!capture)return {};
    bool pet = !source->isPlayer();
    auto id=source->getOrCreateUniqueID();
    if(pet&&!source->isTame()){std::lock_guard lock(stateMutex);pets.erase(id);return {};}
    auto player = pet ? source->getPlayerOwner() : static_cast<Player const*>(source);
    if(player&&player->isPlayerInitialized()){
        Credit owner{playerIdentity(*player),stablePlayerKey(*player),player->getOrCreateUniqueID(),pet};
        if(pet){
            if(source->getOwnerId()!=owner.actor)return {};
            owner.observedAt = nowMillis();
            std::lock_guard lock(stateMutex);
            cachePet(id,owner);
        }
        return owner;
    }
    if(pet){auto ownerId=source->getOwnerId();std::lock_guard lock(stateMutex);auto found=pets.find(id);
        if(found!=pets.end()){if(found->second.actor==ownerId){auto owner=found->second;owner.cachedPet=true;return owner;}pets.erase(found);}
    }
    return {};
} catch (...) { return {}; } }

// Store the observed identity with the actual pet in the native world snapshot.
// The archive, pet ID and native owner ID must all match on the next load.
LL_TYPE_INSTANCE_HOOK(ArchiveSavePetOwner, ll::memory::HookPriority::Lowest, Actor, &Actor::save,
    bool, CompoundTag& tag) {
    auto saved = origin(tag);
    try {
        if (!saved || !isTame() || isPlayer() || !hasUniqueID())
            return saved;
        auto id = getOrCreateUniqueID();
        auto ownerId = getOwnerId();
        std::lock_guard lock(stateMutex);
        auto found = pets.find(id);
        if (!petArchiveId.empty() && found != pets.end() && found->second.actor == ownerId) {
            tag.putString(petOwnerTag, json{{"archive", petArchiveId}, {"pet", id.rawID},
                {"owner", ownerId.rawID}, {"identity", found->second.identity},
                {"observedAt", found->second.observedAt}}.dump());
        }
    } catch (...) {}
    return saved;
}

LL_TYPE_INSTANCE_HOOK(ArchiveLoadPetOwner, ll::memory::HookPriority::Lowest, Actor, &Actor::$load,
    bool, CompoundTag const& tag, DataLoadHelper& helper) {
    auto loaded = origin(tag, helper);
    try {
        if (!loaded || !hasUniqueID() || !tag.contains(petOwnerTag, Tag::String))
            return loaded;
        auto const& encoded = tag.at(petOwnerTag).get<StringTag>();
        if (encoded.size() > 2048)
            return loaded;
        auto value = json::parse(encoded);
        auto id = getOrCreateUniqueID();
        auto const& storedOwner = value.at("owner");
        if (isPlayer() || value.at("pet") != id.rawID || !storedOwner.is_number_integer())
            return loaded;
        // Derived mob loading can restore the owner after Actor::load returns.
        // Use the snapshot only after comparing the current native owner.
        ActorUniqueID owner{storedOwner.get<int64>()};
        if (owner == ActorUniqueID::INVALID_ID() || owner.rawID == 0)
            return loaded;
        auto const& storedTime = value.at("observedAt");
        if (!storedTime.is_number_integer())
            return loaded;
        auto observedAt = storedTime.get<std::int64_t>();
        if (observedAt <= 0 || observedAt > nowMillis())
            return loaded;
        auto const& identity = value.at("identity");
        auto const& type = identity.at("identityType").get_ref<std::string const&>();
        auto const& identityId = identity.at("identity").get_ref<std::string const&>();
        auto const& name = identity.at("name").get_ref<std::string const&>();
        static std::regex const xuidPattern("[1-9][0-9]{0,19}");
        static std::regex const uuidPattern("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}");
        bool xuid = type == "XUID" && std::regex_match(identityId, xuidPattern) &&
            (identityId.size() < 20 || identityId <= "18446744073709551615");
        bool uuid = type == "UUID" && std::regex_match(identityId, uuidPattern);
        if ((!xuid && !uuid) || name.empty() || name.size() > 240 ||
            std::any_of(name.begin(), name.end(), [](unsigned char c) {return c < 32 || c == 127;}))
            return loaded;
        std::lock_guard lock(stateMutex);
        if (petArchiveId.empty() || value.at("archive") != petArchiveId)
            return loaded;
        auto current = pets.find(id);
        if (current != pets.end() && current->second.observedAt > observedAt)
            return loaded;
        cachePet(id, {{{"identityType", type}, {"identity", identityId}, {"name", name}},
            (xuid ? "xuid:" : "uuid:") + identityId, owner, true, false, false, true, observedAt});
    } catch (...) {}
    return loaded;
}
std::string dimension(Actor const& victim) {
    int id = static_cast<int>(victim.getDimensionId());
    if (id == 0) return "minecraft:overworld";
    if (id == 1) return "minecraft:nether";
    if (id == 2) return "minecraft:the_end";
    return "bedrock:dimension_" + std::to_string(id);
}
bool eligible(Actor const& actor) {
    return (actor.isPlayer() || actor.hasCategory(ActorCategory::Mob)) && actor.getTypeName() != "minecraft:armor_stand";
}
bool alreadyCredited(ActorUniqueID id) { std::lock_guard lock(stateMutex); return credited.contains(id); }
void record(Actor const& victim, Credit const& owner, bool burn) noexcept { try {
    if (!eligible(victim) || !victim.isDead() || (victim.isPlayer() && stablePlayerKey(static_cast<Player const&>(victim)) == owner.key)) return;
    auto id = victim.getOrCreateUniqueID();
    std::shared_lock alive(lifetime); if (!capture) return;
    { std::lock_guard lock(stateMutex);
        if (credited.contains(id)) { ++duplicateCredits; return; }
        if (credited.size() >= 32768) { ++capacityLoss; return; }
        credited.insert(id);
    }
    auto at = nowMillis();
    json event = {{"eventId",uuid()},{"kind","COUNTER"},{"at",timestamp(at)},{"player",owner.identity},
        {"dimension",dimension(victim)},{"metric",victim.isPlayer()?"kills.players":"kills.mobs"},{"value",1},{"subject",victim.getTypeName()}};
    if (owner.cachedPet && owner.observedAt <= at)
        event["playerObservedAt"] = timestamp(owner.observedAt);
    capture->submit(std::move(event));
    if (burn) ++burnCredits; else if (owner.pet) ++petCredits; else ++directCredits;
    if (owner.delayedBoss) ++delayedBossCredits;
    if (owner.cachedPet) ++cachedPetCredits;
    if (owner.savedPet) ++savedPetCredits;
} catch (...) {} }
int fireTicks(Actor const& actor) noexcept { try { auto component = actor.getEntityContext().tryGetComponent<OnFireComponent>(); return component ? int(component->mOnFireTicks) : 0; } catch (...) { return 0; } }
struct SourceScope;
thread_local SourceScope* sourceScope = nullptr;
struct SourceScope {
    Actor const* target; std::optional<Credit> owner; ActorUniqueID projectile; SourceScope* previous;
    SourceScope(Actor const* target, std::optional<Credit> owner, ActorUniqueID projectile = {0}) : target(target),owner(std::move(owner)),projectile(projectile),previous(sourceScope) { sourceScope = this; }
    ~SourceScope() { sourceScope = previous; }
};
thread_local Actor const* fireVictim = nullptr;
struct FireScope { Actor const* previous; explicit FireScope(Actor const* actor) : previous(fireVictim) { fireVictim = actor; } ~FireScope() { fireVictim = previous; } };
void rememberProjectile(Actor& projectile, std::optional<Credit> owner, ActorUniqueID shooter) noexcept { try {
    if (!owner || !projectile.hasUniqueID()) return;
    std::shared_lock alive(lifetime); if (!capture) return;
    std::lock_guard lock(stateMutex); auto id = projectile.getOrCreateUniqueID();
    if (projectiles.size() < 32768 || projectiles.contains(id)) projectiles.insert_or_assign(id,ProjectileCredit{std::move(*owner),shooter}); else ++capacityLoss;
} catch (...) {} }
std::optional<Credit> fromDamage(Actor& victim, ActorDamageSource const& source) noexcept { try {
    if (source.isEntitySource()) {
        auto parent = source.getEntityUniqueID(), damaging = source.getDamagingEntityUniqueID();
        if (auto result = credit(victim.getLevel().MCARCHIVE_FETCH_ENTITY(parent,false))) return result;
        for (auto scope = sourceScope; scope; scope = scope->previous)
            if (scope->target == &victim && scope->owner && scope->projectile.rawID != 0 && (scope->projectile == parent || scope->projectile == damaging)) return scope->owner;
        if (source.isChildEntitySource()) {
            std::lock_guard lock(stateMutex); auto found = projectiles.find(damaging);
            if (found != projectiles.end() && found->second.shooter == parent) return found->second.owner;
        }
    } else if (source.mCause == Cause::FireTick && fireVictim == &victim) {
        std::lock_guard lock(stateMutex); auto found = burning.find(victim.getOrCreateUniqueID());
        if (found != burning.end()) return found->second;
    }
} catch (...) {} return {}; }

std::optional<Credit> deathOwner(Actor& victim, ActorDamageSource const& source) noexcept { try {
    if (auto owner = fromDamage(victim,source)) return owner;
    auto key=damageKey(source);std::lock_guard lock(stateMutex);auto found=delayedDeaths.find(victim.getOrCreateUniqueID());
    if(found!=delayedDeaths.end()){if(found->second.source==key){auto owner=found->second.owner;owner.delayedBoss=true;return owner;}++delayedSourceMismatches;}
} catch (...) {} return {}; }

// Wither marks itself dead before its animation, then clears that flag and calls
// Mob::die at final settlement. Snapshot the exact source without counting here.
LL_TYPE_INSTANCE_HOOK(ArchiveDelayedWitherDeath, ll::memory::HookPriority::Highest, WitherBoss, MCARCHIVE_NATIVE_SYMBOL("?$die@WitherBoss@@QEAAXAEBVActorDamageSource@@@Z", &WitherBoss::$die),
    void, ActorDamageSource const& source) {
    std::optional<DelayedDeath> candidate;ActorUniqueID id{0};bool started=false;
    try {started=!isDead();if(started){id=getOrCreateUniqueID();if(auto owner=fromDamage(*this,source))candidate=DelayedDeath{std::move(*owner),damageKey(source)};}}catch(...){}
    origin(source);
    try {if(started){std::shared_lock alive(lifetime);if(!capture)return;std::lock_guard lock(stateMutex);
        delayedDeaths.erase(id);
        if(candidate&&isDead()&&!credited.contains(id)){if(delayedDeaths.size()<32768)delayedDeaths.emplace(id,std::move(*candidate));else ++capacityLoss;}
    }}catch(...){}
}

struct DeathContext { ActorUniqueID id; std::optional<Credit> nativeOwner; DeathContext* previous; };
thread_local DeathContext* deathContext = nullptr;
DeathContext* deathRoot(ActorUniqueID id) { DeathContext* found=nullptr;for(auto scope=deathContext;scope;scope=scope->previous)if(scope->id==id)found=scope;return found; }
LL_TYPE_INSTANCE_HOOK(ArchiveKillCredit, ll::memory::HookPriority::Lowest, Actor, MCARCHIVE_NATIVE_SYMBOL("?killed@Actor@@QEAAXAEAV1@@Z", &Actor::killed), void, Actor& victim) {
    auto owner = credit(this);
    origin(victim);
    if (owner) { if(auto root=deathRoot(victim.getOrCreateUniqueID())) {if(!root->nativeOwner)root->nativeOwner=std::move(owner);else ++duplicateCredits;} else record(victim,*owner,false); }
}
template<class Origin> void death(Actor& victim, ActorDamageSource const& source, Origin&& origin) {
    auto id = victim.getOrCreateUniqueID(); bool outer = deathRoot(id)==nullptr;
    bool alive = false; std::optional<Credit> owner;
    try { alive = outer && !victim.isDead(); if (alive) { { std::lock_guard lock(stateMutex); credited.erase(id); } owner = deathOwner(victim,source); } } catch (...) {}
    DeathContext context{id,{},deathContext};deathContext=&context;struct Pop { DeathContext* previous; ~Pop() { deathContext=previous; } } pop{context.previous};
    origin();
    try { if (alive && victim.isDead()) {
        auto effective=context.nativeOwner?context.nativeOwner:owner;
        if (effective && !alreadyCredited(id)) record(victim,*effective,!context.nativeOwner&&source.mCause == Cause::FireTick);
        if (!alreadyCredited(id)) ++unassigned;
        std::lock_guard lock(stateMutex); burning.erase(id);delayedDeaths.erase(id);
    }} catch (...) {}
}
LL_TYPE_INSTANCE_HOOK(ArchiveMobKillDeath, ll::memory::HookPriority::Highest, Mob, &Mob::$die, void, ActorDamageSource const& source) { death(*this,source,[&]{origin(source);}); }
LL_TYPE_INSTANCE_HOOK(ArchivePlayerKillDeath, ll::memory::HookPriority::Highest, Player, &Player::$die, void, ActorDamageSource const& source) { death(*this,source,[&]{origin(source);}); }
LL_TYPE_INSTANCE_HOOK(ArchiveKillPlayerAttack, ll::memory::HookPriority::Highest, Player,
    static_cast<ActorHurtResult(Player::*)(Actor&,Cause const&,Player::AttackParameters const&)>(&Player::attack),
    ActorHurtResult, Actor& target, Cause const& cause, Player::AttackParameters const& parameters) {
    SourceScope scope(&target,credit(this)); return origin(target,cause,parameters);
}
LL_TYPE_INSTANCE_HOOK(ArchiveKillPlayerVirtualAttack, ll::memory::HookPriority::Highest, Player, &Player::$attack,
    ActorHurtResult, Actor& target, Cause const& cause) { SourceScope scope(&target,credit(this)); return origin(target,cause); }
LL_TYPE_INSTANCE_HOOK(ArchiveKillMobAttack, ll::memory::HookPriority::Highest, Mob, MCARCHIVE_NATIVE_SYMBOL("?$attack@Mob@@QEAA?AVActorHurtResult@@AEAVActor@@AEBW4ActorDamageCause@Legacy@SharedTypes@@@Z", &Mob::$attack),
    ActorHurtResult, Actor& target, Cause const& cause) { SourceScope scope(&target,credit(this)); return origin(target,cause); }
LL_TYPE_INSTANCE_HOOK(ArchiveKillProjectileHit, ll::memory::HookPriority::Highest, ProjectileComponent, &ProjectileComponent::onHit,
    void, Actor& projectile, HitResult const& hit) {
    auto owner = credit(projectile.getLevel().MCARCHIVE_FETCH_ENTITY(mOwnerId,false));
    if (!owner) { std::lock_guard lock(stateMutex); auto found = projectiles.find(projectile.getOrCreateUniqueID()); if (found != projectiles.end() && found->second.shooter == mOwnerId) owner = found->second.owner; }
    SourceScope scope(hit.getEntity(),std::move(owner),projectile.getOrCreateUniqueID()); origin(projectile,hit);
}
LL_TYPE_INSTANCE_HOOK(ArchiveKillProjectileFired, ll::memory::HookPriority::Lowest, ProjectileComponent,
    MCARCHIVE_NATIVE_SYMBOL("?shoot@ProjectileComponent@@QEAAXAEAVActor@@0@Z", static_cast<void(ProjectileComponent::*)(Actor&,Actor&)>(&ProjectileComponent::shoot)), void, Actor& projectile, Actor& shooter) {
    origin(projectile,shooter); rememberProjectile(projectile,credit(&shooter),shooter.getOrCreateUniqueID());
}
LL_TYPE_INSTANCE_HOOK(ArchiveKillDirectedShot, ll::memory::HookPriority::Lowest, ProjectileComponent,
    static_cast<void(ProjectileComponent::*)(Actor&,Vec3 const&,float,float,Vec3 const&,Actor*)>(&ProjectileComponent::shoot),
    void, Actor& projectile, Vec3 const& direction, float power, float uncertainty, Vec3 const& speed, Actor* target) {
    origin(projectile,direction,power,uncertainty,speed,target); rememberProjectile(projectile,credit(projectile.getLevel().MCARCHIVE_FETCH_ENTITY(mOwnerId,false)),mOwnerId);
}
LL_STATIC_HOOK(ArchiveKillIgnition, ll::memory::HookPriority::Lowest, MCARCHIVE_NATIVE_SYMBOL("?_setOnFireImpl@OnFireSystem@@SAXAEAVActor@@H_NH@Z", &OnFireSystem::_setOnFireImpl),
    void, Actor& target, int seconds, bool wet, int protection) {
    auto before = fireTicks(target); origin(target,seconds,wet,protection);
    try { if (fireTicks(target) > before) {
        std::optional<Credit> owner;
        for (auto scope = sourceScope; scope; scope = scope->previous) if (scope->target == &target) { owner = scope->owner; break; }
        std::shared_lock alive(lifetime); if (!capture) return;
        std::lock_guard lock(stateMutex); auto id = target.getOrCreateUniqueID();
        if (!owner) burning.erase(id);
        else if (burning.size() < 32768 || burning.contains(id)) burning.insert_or_assign(id,std::move(*owner)); else ++capacityLoss;
    }} catch (...) {}
}
LL_STATIC_HOOK(ArchiveKillFireTick, ll::memory::HookPriority::Highest, MCARCHIVE_NATIVE_SYMBOL("?_tickServer@OnFireServerSystem@@SAXAEAVEntityContext@@AEAVActorOwnerComponent@@AEAUOnFireComponent@@V?$Optional@$$CBUAbilitiesComponent@@@@@Z", &OnFireServerSystem::_tickServer),
    void, EntityContext& entity, ActorOwnerComponent& actorOwner, OnFireComponent& fire, Optional<AbilitiesComponent const> abilities) {
    FireScope scope(Actor::tryGetFromEntity(entity,false)); origin(entity,actorOwner,fire,abilities);
}
LL_TYPE_INSTANCE_HOOK(ArchiveKillTameOwnership, ll::memory::HookPriority::Lowest, TameableComponent, &TameableComponent::tame,
    void, Actor& actor, Player& player) {origin(actor,player);credit(&actor);}
LL_TYPE_INSTANCE_HOOK(ArchiveKillPetInteraction, ll::memory::HookPriority::Lowest, Player, &Player::interact,
    InteractionResult, Actor& actor, Vec3 const& location MCARCHIVE_INTERACT_HAND_PARAMETER) {auto result=origin(actor,location MCARCHIVE_INTERACT_HAND_ARGUMENT);credit(&actor);return result;}
}
struct KillTracker::Impl : Capture {
    Engine& engine; std::mutex mutex; std::deque<json> pending; std::size_t admitted = 0, lost = 0, ticks = 0;
    ll::memory::HookRegistrar<ArchiveKillCredit,ArchiveMobKillDeath,ArchivePlayerKillDeath,ArchiveKillPlayerAttack,ArchiveKillPlayerVirtualAttack,ArchiveKillMobAttack,ArchiveKillProjectileHit,ArchiveKillProjectileFired,ArchiveKillDirectedShot,ArchiveKillIgnition,ArchiveKillFireTick,ArchiveDelayedWitherDeath,ArchiveKillTameOwnership,ArchiveKillPetInteraction> hooks;
    explicit Impl(Engine& engine) : engine(engine) {
        std::unique_lock alive(lifetime); if (capture) throw std::runtime_error("Kill tracker already installed");
        { std::lock_guard lock(stateMutex); credited.clear(); burning.clear(); projectiles.clear();delayedDeaths.clear(); }
        delayedBossCredits=0;delayedInvalidations=0;cachedPetCredits=0;delayedSourceMismatches=0;savedPetCredits=0;
        directCredits=0;petCredits=0;burnCredits=0;duplicateCredits=0;unassigned=0;capacityLoss=0;capture=this;
    }
    void flush() { while (!pending.empty()) {
        json batch=json::array(); auto count=std::min<std::size_t>(64,pending.size());for(std::size_t i=0;i<count;++i)batch.push_back(pending[i]);
        if (!engine.submitEvents(std::move(batch))) return;for(std::size_t i=0;i<count;++i)pending.pop_front();admitted+=count;
    }}
    void submit(json item) override {
        std::lock_guard lock(mutex);
        flush();
        if (pending.size() < 32768) pending.push_back(std::move(item));
        else {
            engine.recordCaptureGap();
            if (++lost == 1) engine.note("Kill backlog is full; capture gap detected");
        }
        flush();
    }
    void tick(Level& level) {
        { std::lock_guard lock(mutex);flush(); }
        if (++ticks%20) return;
        std::lock_guard lock(stateMutex);
        std::erase_if(credited,[&](auto id){auto actor=level.MCARCHIVE_FETCH_ENTITY(id,false);return !actor||!actor->isDead();});
        std::erase_if(burning,[&](auto const& item){auto actor=level.MCARCHIVE_FETCH_ENTITY(item.first,false);return !actor||fireTicks(*actor)<=0;});
        std::erase_if(projectiles,[&](auto const& item){return !level.MCARCHIVE_FETCH_ENTITY(item.first,false);});
        std::erase_if(pets,[&](auto const& item){auto actor=level.MCARCHIVE_FETCH_ENTITY(item.first,false);return !actor||actor->isDead()||!actor->isTame()||actor->getOwnerId()!=item.second.actor;});
        for(auto it=delayedDeaths.begin();it!=delayedDeaths.end();){auto actor=level.MCARCHIVE_FETCH_ENTITY(it->first,false);
            if(!actor||(!actor->isDead()&&++it->second.aliveScans>=2)){++delayedInvalidations;it=delayedDeaths.erase(it);}
            else {if(actor->isDead())it->second.aliveScans=0;++it;}
        }
    }
    ~Impl() {
        {std::unique_lock alive(lifetime);capture=nullptr;}
        std::lock_guard lock(mutex);flush();
        engine.recordCaptureGap(pending.size() + capacityLoss.load());
        engine.note("Kill diagnostics: "+std::to_string(admitted)+" admitted, "+std::to_string(pending.size())+" pending, "+std::to_string(lost)+" lost, "+std::to_string(capacityLoss.load())+" capacity gaps; direct="+std::to_string(directCredits.load())+" pet="+std::to_string(petCredits.load())+" burn="+std::to_string(burnCredits.load())+" duplicates="+std::to_string(duplicateCredits.load())+" unassigned="+std::to_string(unassigned.load()));
        std::lock_guard state(stateMutex);
        engine.note("Delayed kill diagnostics: "+std::to_string(delayedBossCredits.load())+" final credits from source snapshots, "+std::to_string(delayedInvalidations.load())+" invalidated, "+std::to_string(delayedSourceMismatches.load())+" source mismatches, "+std::to_string(delayedDeaths.size())+" unresolved; cached pet credits="+std::to_string(cachedPetCredits.load()));
        engine.note("Saved pet owner credits: " + std::to_string(savedPetCredits.load()));
        credited.clear();burning.clear();projectiles.clear();delayedDeaths.clear();
    }
};
KillTracker::KillTracker(Engine& engine):impl_(std::make_unique<Impl>(engine)){}
KillTracker::~KillTracker()=default;
void KillTracker::tick(Level& level){impl_->tick(level);}

struct PetOwnerPersistence::Impl {
    ll::memory::HookRegistrar<ArchiveSavePetOwner, ArchiveLoadPetOwner> hooks;
    explicit Impl(std::string const& archiveId) {
        std::lock_guard lock(stateMutex);
        if (!petArchiveId.empty())
            throw std::runtime_error("Pet owner persistence already installed");
        petArchiveId = archiveId;
    }
    ~Impl() {
        std::lock_guard lock(stateMutex);
        petArchiveId.clear();
        pets.clear();
    }
};
PetOwnerPersistence::PetOwnerPersistence(std::string const& archiveId)
    : impl_(std::make_unique<Impl>(archiveId)) {}
PetOwnerPersistence::~PetOwnerPersistence() = default;
}
