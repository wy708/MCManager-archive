// Separately packaged QA mod. Never installed by the normal collector installer.
#include "ll/api/event/EventBus.h"
#include "ll/api/event/world/ServerLevelTickEvent.h"
#include "ll/api/event/player/PlayerDestroyBlockEvent.h"
#include "ll/api/event/player/PlayerPlaceBlockEvent.h"
#include "ll/api/event/player/PlayerAddExperienceEvent.h"
#include "ll/api/event/player/PlayerJumpEvent.h"
#include "ll/api/event/player/PlayerSneakEvent.h"
#include "ll/api/event/player/PlayerChatEvent.h"
#include "ll/api/event/player/PlayerAttackEvent.h"
#include "ll/api/event/player/PlayerPickUpItemEvent.h"
#include "ll/api/event/player/PlayerUseItemEvent.h"
#include "ll/api/event/player/PlayerInteractBlockEvent.h"
#include "mc/world/level/block/VanillaStates.h"
#include "mc/legacy/ActorUniqueID.h"
#include "mc/world/level/Level.h"
#include "mc/world/actor/player/Inventory.h"
#include "mc/world/item/ItemStack.h"
#include "mc/world/item/ItemUseMethod.h"
#include "mc/world/gamemode/GameMode.h"
#include "mc/world/gamemode/InteractionResult.h"
#include "mc/world/level/BlockSource.h"
#include "mc/world/level/block/Block.h"
#include "mc/world/events/ItemEventCoordinator.h"
#include "mc/world/events/ItemUsedOnEvent.h"
#include "ll/api/mod/NativeMod.h"
#include "ll/api/mod/RegisterHelper.h"
#include "ll/api/memory/Hook.h"
#include "mc/network/ServerNetworkHandler.h"
#include "mc/network/packet/PlayerAuthInputPacket.h"
#include "mc/entity/components/PlayerBlockActionData.h"
#include "mc/server/ServerPlayer.h"
#include "mc/network/ServerPlayerBlockUseHandler.h"
#include "mc/world/level/block/BlockChangeContext.h"
#include "mc/world/actor/ActorDamageSource.h"
#include "mc/world/actor/Mob.h"
#include "mc/world/actor/monster/EnderDragon.h"
#include "mc/world/actor/monster/Slime.h"
#include "mc/world/actor/FishingHook.h"
#include "mc/world/actor/ActorDataIDs.h"
#include "mc/entity/components/SynchedActorDataComponent.h"
#include "mc/world/item/FishingRodItem.h"
#include "mc/world/level/Spawner.h"
#include "mc/entity/components_json_legacy/BreedableComponent.h"
#include "mc/deps/ecs/WeakEntityRef.h"
#include "mc/world/item/ItemInstance.h"
#include "mc/world/inventory/network/crafting/CraftHandlerCrafting.h"
#include "mc/world/inventory/network/crafting/CraftHandlerTrade.h"
#include "mc/world/inventory/network/crafting/ItemStackRequestActionCraftBase.h"
#include "mc/world/item/trading/MerchantRecipeList.h"
#include "mc/world/item/trading/MerchantRecipe.h"
#include "mc/entity/components_json_legacy/EconomyTradeableComponent.h"
#include "mc/entity/components_json_legacy/LegacyTradeableComponent.h"
#include "mc/world/inventory/network/crafting/ItemStackRequestActionCraftHandler.h"
#include "mc/world/inventory/network/ItemStackRequestActionHandler.h"
#include "mc/world/inventory/network/ContainerScreenContext.h"
#include "mc/world/containers/FullContainerName.h"
#include "mc/world/inventory/simulation/ExpectedSlotConsume.h"
#include "mc/world/inventory/simulation/ExpectedAnywhereConsume.h"
#include "mc/world/inventory/simulation/AllowedAnywhereConsume.h"
#include "mc/world/inventory/simulation/ContainerScreenValidation.h"
#include "mc/world/SimpleSparseContainer.h"
#include "mc/world/inventory/network/ItemStackRequestAction.h"
#include "mc/network/packet/ItemStackResponseContainerInfo.h"
#include "mc/world/actor/boss/WitherBoss.h"
#include <sstream>
#include <vector>

namespace archive_qa_guards {
static std::size_t inputCount = 0;
static std::size_t cancelledMining = 0, cancelledPlacement = 0, cancelledExperience = 0;
static std::size_t cancelledLevels = 0;
static std::size_t cancelledJumps = 0, jumpEvents = 0, cancelledSneakStarts = 0, cancelledSneakStops = 0, forcedStops = 0;
static int lastActionFlags = -1;
static ActorUniqueID lastPickupId{0};
static std::string lastPickupType;
static std::size_t cancelledPickup = 0, cancelledItemUse = 0;
static bool cancelNextFoodCompletion = false;
static std::size_t cancelledCompletions = 0;
static bool cancelDoorUpper = false;
static std::size_t cancelledDoorWrites = 0;
static bool cancelBerryInteraction = false;
static std::size_t cancelledBerryInteractions = 0;
static bool replacePitcherResidual = false;
static std::size_t replacedPitcherResiduals = 0;
static bool killDiagnostics = false;
static bool cancelNextAttack = false;
static std::size_t cancelledAttacks = 0;
static bool breedingDiagnostics=false;
static bool fishingDiagnostics = false;
static int motionFixtureTicks = 0;
static Vec3 motionFixturePosition{};
static thread_local int fishingRetrieveDepth = 0;
static bool cancelFishingUse = false, cancelFishingRetrieve = false, cancelFishingPull = false,
            cancelFishingSpawn = false;
static int fishingQuantity = 0;
struct FishingDepthGuard {
    FishingDepthGuard() { ++fishingRetrieveDepth; }
    ~FishingDepthGuard() { --fishingRetrieveDepth; }
};
static bool attachFishingTarget(FishingHook &hook, Actor &actor) {
    hook.setTarget(&actor);
    for (auto &data : hook.mEntityData->mData.get()->mData->mItemsArray.get()) {
        if (data && data->getId() == static_cast<ushort>(ActorDataIDs::Target)) {
            data->setData<int64>(static_cast<int64>(actor.getOrCreateUniqueID().rawID));
            auto target = hook.mEntityData->getInt64(static_cast<ushort>(ActorDataIDs::Target));
            ll::mod::NativeMod::current()->getLogger().info("QA fishing synchronized target={}", target);
            return target == actor.getOrCreateUniqueID().rawID;
        }
    }
    return false;
}
LL_TYPE_INSTANCE_HOOK(QAFishingRetrieveProbe, ll::memory::HookPriority::Highest, FishingHook,
                      &FishingHook::retrieve, int) {
    if (cancelFishingRetrieve) {
        cancelFishingRetrieve = false;
        ll::mod::NativeMod::current()->getLogger().info("QA fishing retrieve cancelled");
        return 0;
    }
    if (fishingDiagnostics)
        ll::mod::NativeMod::current()->getLogger().info(
            "QA fishing retrieve before: id={} source={} owner={} target={} removed={} hooked={} lured={} "
            "nibble={} ground={}",
            getOrCreateUniqueID().rawID, getSourceUniqueID().rawID, getOwnerId().rawID,
            mEntityData->getInt64(static_cast<ushort>(ActorDataIDs::Target)), bool(mRemoved),
            int(mTimeUntilHooked), int(mTimeUntilLured), int(mTimeUntilNibble), bool(mInGround));
    FishingDepthGuard guard;
    auto result = origin();
    if (fishingDiagnostics)
        ll::mod::NativeMod::current()->getLogger().info("QA fishing retrieve after: result={} removed={}",
                                                        result, bool(mRemoved));
    return result;
}
LL_TYPE_INSTANCE_HOOK(QAFishingPullProbe, ll::memory::HookPriority::Highest, FishingHook,
                      &FishingHook::_pullCloser, void, Actor &actor, float speed) {
    if (cancelFishingPull) {
        cancelFishingPull = false;
        ll::mod::NativeMod::current()->getLogger().info("QA fishing pull cancelled");
        return;
    }
    auto before = actor.getPosDelta();
    auto id = actor.getOrCreateUniqueID();
    if (fishingDiagnostics)
        ll::mod::NativeMod::current()->getLogger().info(
            "QA fishing pull before: hook={} target={} type={} itemCount={} fromFishing={} speed={} depth={}",
            getOrCreateUniqueID().rawID, id.rawID, actor.getTypeName(),
            actor.hasCategory(ActorCategory::Item) ? int(static_cast<ItemActor &>(actor).item().mCount) : 0,
            actor.hasCategory(ActorCategory::Item) ? bool(static_cast<ItemActor &>(actor).isFromFishing())
                                                   : false,
            speed, fishingRetrieveDepth);
    origin(actor, speed);
    if (fishingDiagnostics) {
        auto after = actor.getPosDelta();
        ll::mod::NativeMod::current()->getLogger().info(
            "QA fishing pull after: target={} deltaBefore={},{},{} deltaAfter={},{},{}", id.rawID, before.x,
            before.y, before.z, after.x, after.y, after.z);
    }
}
LL_TYPE_INSTANCE_HOOK(QAFishingSpawnProbe, ll::memory::HookPriority::Highest, Spawner, &Spawner::$spawnItem,
                      ItemActor *, BlockSource &region, ItemStack const &item, Actor *spawner,
                      Vec3 const &position, int throwTime) {
    if (fishingRetrieveDepth && cancelFishingSpawn) {
        cancelFishingSpawn = false;
        ll::mod::NativeMod::current()->getLogger().info("QA fishing spawn cancelled");
        return nullptr;
    }
    ItemStack adjusted(item);
    if (fishingRetrieveDepth && fishingQuantity > 0) {
        adjusted.mCount = static_cast<uchar>(fishingQuantity);
        fishingQuantity = 0;
        ll::mod::NativeMod::current()->getLogger().info("QA fishing actual loot quantity={}",
                                                        int(adjusted.mCount));
    }
    auto result = origin(region, adjusted, spawner, position, throwTime);
    if (fishingDiagnostics && fishingRetrieveDepth)
        ll::mod::NativeMod::current()->getLogger().info(
            "QA fishing spawn: item={} count={} spawner={} result={} fromFishing={}", item.getTypeName(),
            int(item.mCount), spawner ? spawner->getTypeName() : "none",
            result ? result->getOrCreateUniqueID().rawID : 0, result ? bool(result->isFromFishing()) : false);
    return result;
}
LL_TYPE_INSTANCE_HOOK(QAFishingEventProbe, ll::memory::HookPriority::Lowest, FishingHook,
                      &FishingHook::$handleEntityEvent, void, ActorEvent event, int data) {
    origin(event, data);
    if (fishingDiagnostics)
        ll::mod::NativeMod::current()->getLogger().info(
            "QA fishing event: id={} event={} data={} hooked={} lured={} nibble={}",
            getOrCreateUniqueID().rawID, int(event), data, int(mTimeUntilHooked), int(mTimeUntilLured),
            int(mTimeUntilNibble));
}
LL_TYPE_INSTANCE_HOOK(QAFishingRodProbe, ll::memory::HookPriority::Lowest, FishingRodItem,
                      &FishingRodItem::$use, ItemStack &, ItemStack &item, Player &player, HandSlot hand) {
    auto before = player.mFishingHookID->rawID;
    auto &result = origin(item, player, hand);
    if (fishingDiagnostics && player.getRealName() == "ArchiveQA")
        ll::mod::NativeMod::current()->getLogger().info("QA fishing rod use: before={} after={} damage={}",
                                                        before, player.mFishingHookID->rawID,
                                                        item.getAuxValue());
    return result;
}
static bool craftingDiagnostics=false;
static bool oldTradeScreen=false;
LL_TYPE_INSTANCE_HOOK(QAOldTradeScreen,ll::memory::HookPriority::Highest,Actor,&Actor::isUseNewTradeScreen,
    bool){auto result=origin();if(oldTradeScreen&&(getTypeName()=="minecraft:villager_v2"||getTypeName()=="minecraft:wandering_trader"||getTypeName()=="minecraft:villager")){ll::mod::NativeMod::current()->getLogger().info("QA legacy trade screen selected: id={}",getOrCreateUniqueID().rawID);return false;}return result;}
static bool failCraftCommit=false;
static std::size_t failedCraftCommits=0;
LL_TYPE_INSTANCE_HOOK(QAFailCraftCommit,ll::memory::HookPriority::Highest,ContainerScreenValidation,&ContainerScreenValidation::tryCommitActionResults,
    bool){if(failCraftCommit&&mScreenContext->mPlayer&&mScreenContext->mPlayer->getRealName()=="ArchiveQA"){failCraftCommit=false;++failedCraftCommits;ll::mod::NativeMod::current()->getLogger().info("QA crafting commit rejected before origin");return false;}return origin();}
using QARequestEnd=std::tuple<ItemStackNetResult,std::vector<ItemStackResponseContainerInfo>>;
LL_TYPE_INSTANCE_HOOK(QATradeRecipeProbe,ll::memory::HookPriority::Highest,CraftHandlerTrade,&CraftHandlerTrade::$_handleCraftAction,
    ItemStackNetResult,ItemStackRequestActionCraftBase const& action){auto result=origin(action);if(craftingDiagnostics){auto owner=std::get_if<ActorUniqueID>(&mScreenContext.mOwner.get());ll::mod::NativeMod::current()->getLogger().info("QA trade action: type={} requested={} status={} trade2={} crafts={} index={} owner={} screen={}",int(action.mActionType),int(action.mNumCrafts),int(result),bool(mIsTrade2),int(mNumCrafts),mTradeIndex->has_value()?std::to_string(mTradeIndex->value()):"none",owner?owner->rawID:0,int(mScreenContext.mScreenContainerType));}return result;}
LL_TYPE_INSTANCE_HOOK(QATradeInitProbe,ll::memory::HookPriority::Lowest,CraftHandlerTrade,&CraftHandlerTrade::_initResultItem,
    ItemStackNetResult,RecipeNetId const& recipe,uchar count){auto result=origin(recipe,count);if(craftingDiagnostics){ll::mod::NativeMod::current()->getLogger().info("QA trade init: recipe={} count={} status={} crafts={}",recipe.mRawId,int(count),int(result),int(mNumCrafts));for(auto const& [item,repeats]:mCraftRequestHandler.mCraftResults.get())ll::mod::NativeMod::current()->getLogger().info("QA trade output: type={} count={} repeats={}",item.getTypeName(),int(item.mCount),repeats);}return result;}
LL_TYPE_INSTANCE_HOOK(QATradePostProbe,ll::memory::HookPriority::Lowest,CraftHandlerTrade,&CraftHandlerTrade::$_postCraftRequest,
    void,bool success){if(craftingDiagnostics)ll::mod::NativeMod::current()->getLogger().info("QA trade post before: success={} crafts={} trade2={}",success,int(mNumCrafts),bool(mIsTrade2));origin(success);if(craftingDiagnostics)ll::mod::NativeMod::current()->getLogger().info("QA trade post after: success={} crafts={} trade2={}",success,int(mNumCrafts),bool(mIsTrade2));}
LL_TYPE_INSTANCE_HOOK(QACraftSetProbe,ll::memory::HookPriority::Lowest,ItemStackRequestActionCraftHandler,&ItemStackRequestActionCraftHandler::_setCreatedItemOutputSlot,
    ItemStackNetResult,uchar index){auto result=origin(index);if(craftingDiagnostics){ll::mod::NativeMod::current()->getLogger().info("QA craft output slot: index={} status={}",int(index),int(result));if(mCreatedOutputSparseContainer)for(auto const& [slot,item]:mCreatedOutputSparseContainer->mItems.get())ll::mod::NativeMod::current()->getLogger().info("QA craft created container: slot={} type={} count={}",slot,item.getTypeName(),int(item.mCount));}return result;}
LL_TYPE_INSTANCE_HOOK(QACraftRequestActionProbe,ll::memory::HookPriority::Lowest,ItemStackRequestActionHandler,&ItemStackRequestActionHandler::handleRequestAction,
    ItemStackNetResult,ItemStackRequestAction const& action){auto result=origin(action);if(craftingDiagnostics)ll::mod::NativeMod::current()->getLogger().info("QA craft request action: type={} status={}",int(action.mActionType),int(result));return result;}
LL_TYPE_INSTANCE_HOOK(QACraftResultsProbe,ll::memory::HookPriority::Lowest,ItemStackRequestActionCraftHandler,&ItemStackRequestActionCraftHandler::_initCraftResults,
    ItemStackNetResult,std::vector<ItemInstance> const& results,uchar count){
    auto result=origin(results,count);
    if(craftingDiagnostics&&mPlayer.getRealName()=="ArchiveQA"){ll::mod::NativeMod::current()->getLogger().info("QA craft init results: status={} numCrafts={} outputs={} stored={}",int(result),int(count),results.size(),mCraftResults->size());for(auto const& item:results)ll::mod::NativeMod::current()->getLogger().info("QA craft output argument: type={} count={}",item.getTypeName(),item.mCount);for(auto const& [item,repeats]:mCraftResults.get())ll::mod::NativeMod::current()->getLogger().info("QA craft output stored: type={} count={} repeats={}",item.getTypeName(),item.mCount,repeats);}
    return result;
}
LL_TYPE_INSTANCE_HOOK(QACraftActionProbe,ll::memory::HookPriority::Lowest,CraftHandlerCrafting,&CraftHandlerCrafting::$_handleCraftAction,
    ItemStackNetResult,ItemStackRequestActionCraftBase const& action){auto result=origin(action);if(craftingDiagnostics&&mPlayer.getRealName()=="ArchiveQA")ll::mod::NativeMod::current()->getLogger().info("QA crafting action: status={} deferred={} workbench={} expectedSlots={} expectedAnywhere={} allowedAnywhere={}",int(result),int(mDeferredCraftCount),bool(mWorkbench),mExpectedSlotConsumes->size(),mExpectedAnywhereConsumes->size(),mAllowedAnywhereConsumes->size());return result;}
LL_TYPE_INSTANCE_HOOK(QACraftConsumeProbe,ll::memory::HookPriority::Lowest,CraftHandlerCrafting,&CraftHandlerCrafting::$handleConsumedItem,
    ItemStackNetResult,FullContainerName const& container,uchar slot,ItemStack const& item){auto result=origin(container,slot,item);if(craftingDiagnostics)ll::mod::NativeMod::current()->getLogger().info("QA craft consume: container={} slot={} item={} count={} status={}",int(container.mName),int(slot),item.getTypeName(),item.mCount,int(result));return result;}
LL_TYPE_INSTANCE_HOOK(QAStackRequestEndProbe,ll::memory::HookPriority::Highest,ItemStackRequestActionHandler,&ItemStackRequestActionHandler::endRequest,
    QARequestEnd,ItemStackNetResult current){auto result=origin(current);if(craftingDiagnostics&&mPlayer.getRealName()=="ArchiveQA")ll::mod::NativeMod::current()->getLogger().info("QA stack request end: initial={} final={}",int(current),int(std::get<0>(result)));return result;}
static bool cancelBreeding=false,cancelFeeding=false,duplicateNextBirth=false;
static std::size_t cancelledMatingCalls=0,cancelledFeedingCalls=0,duplicatedBirthRefs=0;
LL_TYPE_INSTANCE_HOOK(QACancelAnimalFeed,ll::memory::HookPriority::Highest,Player,&Player::interact,
    InteractionResult,Actor& actor,Vec3 const& location){
    if(cancelFeeding&&getRealName()=="ArchiveQA"&&actor.getEntityContext().hasComponent<BreedableComponent>()){++cancelledFeedingCalls;ll::mod::NativeMod::current()->getLogger().info("QA animal feeding cancelled: id={}",actor.getOrCreateUniqueID().rawID);return {};}
    return origin(actor,location);
}
LL_TYPE_INSTANCE_HOOK(QABreedingResultProbe, ll::memory::HookPriority::Normal, BreedableComponent, &BreedableComponent::mate,
    std::vector<WeakEntityRef>, Actor& owner, Actor& partner) {
    if(breedingDiagnostics){auto other=partner.getEntityContext().tryGetComponent<BreedableComponent>();ll::mod::NativeMod::current()->getLogger().info("QA mate before: type={} owner={} partner={} loveCause={} partnerLoveCause={} loveTimer={} cooldown={}",owner.getTypeName(),owner.getOrCreateUniqueID().rawID,partner.getOrCreateUniqueID().rawID,mLoveCause->rawID,other?other->mLoveCause->rawID:0,int(mLoveTimer),int(mBreedCooldown));}
    if(cancelBreeding){++cancelledMatingCalls;ll::mod::NativeMod::current()->getLogger().info("QA mating cancelled: owner={} partner={}",owner.getOrCreateUniqueID().rawID,partner.getOrCreateUniqueID().rawID);return {};}
    auto result=origin(owner,partner);
    if(duplicateNextBirth&&!result.empty()){duplicateNextBirth=false;auto first=result.front();result.push_back(first);result.push_back(first);duplicatedBirthRefs+=2;ll::mod::NativeMod::current()->getLogger().info("QA birth result duplicated: refs={}",result.size());}
    if(breedingDiagnostics){ll::mod::NativeMod::current()->getLogger().info("QA mate returned: owner={} results={} loveCause={} loveTimer={} cooldown={}",owner.getOrCreateUniqueID().rawID,result.size(),mLoveCause->rawID,int(mLoveTimer),int(mBreedCooldown));for(auto const& weak:result){auto locked=weak.lock();auto actor=locked.tryUnwrap();if(actor)ll::mod::NativeMod::current()->getLogger().info("QA mate result entity: id={} type={} baby={} dead={} actualWorld={}",actor->getOrCreateUniqueID().rawID,actor->getTypeName(),actor->isBaby(),actor->isDead(),owner.getLevel().$fetchEntity(actor->getOrCreateUniqueID(),false)==actor.as_ptr());}}
    return result;
}
LL_TYPE_INSTANCE_HOOK(QAKillCreditProbe, ll::memory::HookPriority::Highest, Actor, &Actor::killed,
    void, Actor& entity) {
    if (killDiagnostics) ll::mod::NativeMod::current()->getLogger().info("QA native killed callback: self={} selfId={} other={} otherId={} otherDead={}", getTypeName(),getOrCreateUniqueID().rawID,entity.getTypeName(),entity.getOrCreateUniqueID().rawID,entity.isDead());
    origin(entity);
}
LL_TYPE_INSTANCE_HOOK(QAMobDeathProbe, ll::memory::HookPriority::Highest, Mob, &Mob::$die,
    void, ActorDamageSource const& source) {
    if (killDiagnostics) ll::mod::NativeMod::current()->getLogger().info("QA mob death before: type={} id={} dead={} cause={} child={} parentId={} damagingId={} lastPlayerId={} lastPlayerTime={}",getTypeName(),getOrCreateUniqueID().rawID,isDead(),ActorDamageSource::lookupCauseName(source.mCause),source.isChildEntitySource(),source.getEntityUniqueID().rawID,source.getDamagingEntityUniqueID().rawID,mLastHurtByPlayerId->rawID,int(mLastHurtByPlayerTime));
    origin(source);
    if (killDiagnostics) ll::mod::NativeMod::current()->getLogger().info("QA mob death after: type={} id={} dead={}",getTypeName(),getOrCreateUniqueID().rawID,isDead());
}
LL_TYPE_INSTANCE_HOOK(QADragonDeathProbe, ll::memory::HookPriority::Highest, EnderDragon, &EnderDragon::$die,
    void, ActorDamageSource const& source) {
    if (killDiagnostics) ll::mod::NativeMod::current()->getLogger().info("QA special death before: type={} id={} dead={} health={} cause={} parentId={}",getTypeName(),getOrCreateUniqueID().rawID,isDead(),getHealth(),ActorDamageSource::lookupCauseName(source.mCause),source.getEntityUniqueID().rawID);
    origin(source);
    if (killDiagnostics) ll::mod::NativeMod::current()->getLogger().info("QA special death after: type={} id={} dead={} health={}",getTypeName(),getOrCreateUniqueID().rawID,isDead(),getHealth());
}
LL_TYPE_INSTANCE_HOOK(QAWitherDeathProbe, ll::memory::HookPriority::Highest, WitherBoss, &WitherBoss::$die,
    void, ActorDamageSource const& source) {
    if (killDiagnostics) ll::mod::NativeMod::current()->getLogger().info("QA special death before: type={} id={} dead={} health={} cause={} parentId={}",getTypeName(),getOrCreateUniqueID().rawID,isDead(),getHealth(),ActorDamageSource::lookupCauseName(source.mCause),source.getEntityUniqueID().rawID);
    origin(source);
    if (killDiagnostics) ll::mod::NativeMod::current()->getLogger().info("QA special death after: type={} id={} dead={} health={}",getTypeName(),getOrCreateUniqueID().rawID,isDead(),getHealth());
}
LL_STATIC_HOOK(QAReplacePitcherResidual, ll::memory::HookPriority::Highest, &ServerPlayerBlockUseHandler::onStartDestroyBlock,
    void, ServerPlayer& player, BlockPos const& pos, int face) {
    origin(player,pos,face);
    if (replacePitcherResidual && player.getRealName() == "ArchiveQA" && pos == BlockPos{0,101,2}) {
        replacePitcherResidual = false; auto& region = player.getDimensionBlockSource();
        BlockChangeContext context{}; context.mContextSource = std::variant<std::monostate,EnvironmentChangeContext,ActorChangeContext,StatelessBlockChangeContext>{StatelessBlockChangeContext::Commands}; context.mTickSchedulingEnabled = true;
        auto const& stone = region.getBlock(BlockPos{4,99,4});
        if (stone.getTypeName() == "minecraft:stone" && region.$setBlock(BlockPos{0,100,2},stone,3,nullptr,context)) ++replacedPitcherResiduals;
        ll::mod::NativeMod::current()->getLogger().info("QA pitcher residual replaced: type={}", region.getBlock(BlockPos{0,100,2}).getTypeName());
    }
}
LL_TYPE_INSTANCE_HOOK(QACancelDoorUpperWrite, ll::memory::HookPriority::Highest, BlockSource,
    &BlockSource::$setBlock, bool, BlockPos const& pos, Block const& block, int flags,
    ActorBlockSyncMessage const* sync, BlockChangeContext const& source) {
    if (cancelDoorUpper && pos.x == 4 && pos.y == 101 && pos.z == 2 && block.getTypeName() == "minecraft:wooden_door") {
        cancelDoorUpper = false; ++cancelledDoorWrites;
        ll::mod::NativeMod::current()->getLogger().info("QA door upper write cancelled"); return false;
    }
    return origin(pos, block, flags, sync, source);
}
static int inventoryCount(Player const& player, std::string const& type) {
    auto& inventory = player.getInventory(); int total = 0;
    for (int i = 0; i < inventory.getContainerSize(); ++i) { auto& item = inventory.getItem(i); if (item.mCount && item.getTypeName() == type) total += item.mCount; }
    return total;
}
LL_TYPE_INSTANCE_HOOK(QAPickupTake, ll::memory::HookPriority::Lowest, Player,
    &Player::take, bool, Actor& actor, int orgCount, int favoredSlot) {
    auto* item = actor.hasCategory(ActorCategory::Item) ? static_cast<ItemActor*>(&actor) : nullptr;
    std::string type = item ? item->item().getTypeName() : "none";
    int count = item ? item->item().mCount : 0, before = item ? inventoryCount(*this, type) : 0;
    auto result = origin(actor, orgCount, favoredSlot);
    if (getRealName() == "ArchiveQA" && item) ll::mod::NativeMod::current()->getLogger().info("QA pickup take: type={} org={} itemBefore={} inventoryBefore={} inventoryAfter={} result={}", type, orgCount, count, before, inventoryCount(*this, type), result);
    return result;
}
LL_TYPE_INSTANCE_HOOK(QACompletedItemUse, ll::memory::HookPriority::Lowest, Player,
    &Player::$useItem, void, ItemStackBase& item, ItemUseMethod method, bool consume) {
    auto type = item.getTypeName(); int count = item.mCount;
    origin(item, method, consume);
    if (getRealName() == "ArchiveQA") ll::mod::NativeMod::current()->getLogger().info("QA committed use callback: type={} method={} consume={} before={} after={}", type, static_cast<int>(method), consume, count, item.mCount);
}
LL_TYPE_INSTANCE_HOOK(QACancelFoodCompletion, ll::memory::HookPriority::Highest, Player,
    &Player::completeUsingItem, void) {
    if (getRealName() == "ArchiveQA" && cancelNextFoodCompletion && mItemInUse->mItem->getTypeName() == "minecraft:apple") {
        cancelNextFoodCompletion = false; ++cancelledCompletions; stopUsingItem();
        ll::mod::NativeMod::current()->getLogger().info("QA food completion cancelled"); return;
    }
    origin();
}
LL_TYPE_INSTANCE_HOOK(QABlockUse, ll::memory::HookPriority::High, GameMode,
    &GameMode::$useItemOn, InteractionResult, ItemStack& item, BlockPos const& pos, uchar face,
    Vec3 const& hit, HandSlot hand, Block const* target, bool first) {
    auto type = item.getTypeName(), before = mPlayer.getDimensionBlockSource().getBlock(pos).getTypeName();
    auto result = origin(item, pos, face, hit, hand, target, first);
    if (mPlayer.getRealName() == "ArchiveQA") ll::mod::NativeMod::current()->getLogger().info("QA block use: item={} at={},{},{} face={} first={} before={} after={} success={}", type, pos.x, pos.y, pos.z, face, first, before, mPlayer.getDimensionBlockSource().getBlock(pos).getTypeName(), bool(result.mSuccess));
    return result;
}
LL_TYPE_INSTANCE_HOOK(QAItemCoordinator, ll::memory::HookPriority::Lowest, ItemEventCoordinator,
    &ItemEventCoordinator::sendEvent, CoordinatorResult, EventRef<MutableItemGameplayEvent<CoordinatorResult>> event) {
    auto result = origin(event);
    event.get().visit([&](auto& entry) {
        using Type = std::remove_cvref_t<decltype(entry.value())>;
        if constexpr (std::is_same_v<Type, ItemUsedOnEvent>) {
            auto const& data = entry.value();
            ll::mod::NativeMod::current()->getLogger().info("QA ItemUsedOnEvent: before={} after={} result={}", data.mItemBeforeUse->getTypeName(), data.mItemAfterUse->getTypeName(), static_cast<int>(result));
        }
    });
    return result;
}
LL_TYPE_INSTANCE_HOOK(QACancelLevels, ll::memory::HookPriority::Highest, Player,
    &Player::$addLevels, void, int amount) {
    if (getRealName() == "ArchiveQA" && amount == 13) { ++cancelledLevels; return; }
    origin(amount);
}
LL_TYPE_INSTANCE_HOOK(QAInputDiagnostic, ll::memory::HookPriority::Highest, ServerNetworkHandler,
    static_cast<void(ServerNetworkHandler::*)(NetworkIdentifier const&, PlayerAuthInputPacket const&)>(&ServerNetworkHandler::$handle),
    void, NetworkIdentifier const& source, PlayerAuthInputPacket const& packet) {
    auto player = thisFor<NetEventCallback>()->_getServerPlayer(source, packet.mSenderSubId);
    using Input = PlayerAuthInputPacket::InputData;
    bool startSneak = packet.mInputData->contains(Input::StartSneaking), stopSneak = packet.mInputData->contains(Input::StopSneaking);
    bool actionInput = startSneak || stopSneak || packet.mInputData->contains(Input::StartSprinting) || packet.mInputData->contains(Input::StopSprinting);
    bool cancelled = player && player->getRealName() == "ArchiveQA" && ((startSneak && !cancelledSneakStarts) || (stopSneak && player->isSneaking() && !cancelledSneakStops));
    if (cancelled) { if (startSneak) ++cancelledSneakStarts; else ++cancelledSneakStops; }
    auto actions = packet.mPlayerBlockActions->get();
    if (++inputCount <= 2 || !actions.empty()) {
        auto const& pos = packet.mPos.get();
        ll::mod::NativeMod::current()->getLogger().info("QA input {} at {},{},{}; {} block actions", packet.mClientTick->mValue, pos.x, pos.y, pos.z, actions.size());
        auto player = thisFor<NetEventCallback>()->_getServerPlayer(source, packet.mSenderSubId);
        if (player) ll::mod::NativeMod::current()->getLogger().info("QA player loading={}, initialized={}, alive={}", player->isLoading(), player->isPlayerInitialized(), player->isAlive());
        for (auto const& action : actions) ll::mod::NativeMod::current()->getLogger().info("QA block action {} at {},{},{}", static_cast<int>(action.mPlayerActionType), action.mPos->x, action.mPos->y, action.mPos->z);
    }
    if (!cancelled) origin(source, packet);
    player = thisFor<NetEventCallback>()->_getServerPlayer(source, packet.mSenderSubId);
    if (player && player->getRealName() == "ArchiveQA") {
        auto flags = (player->isSneaking() ? 1 : 0) | (player->isSprinting() ? 2 : 0) | (player->isAlive() ? 4 : 0);
        if (flags != lastActionFlags || actionInput) {
            ll::mod::NativeMod::current()->getLogger().info("QA state: sneak={} sprint={} alive={} cancelled={}", player->isSneaking(), player->isSprinting(), player->isAlive(), cancelled);
            lastActionFlags = flags;
        }
    }
    if (packet.mInputData->contains(PlayerAuthInputPacket::InputData::Jumping)) {
        auto player = thisFor<NetEventCallback>()->_getServerPlayer(source, packet.mSenderSubId);
        if (player) {
            auto delta = packet.mPos.get() - player->getPosition();
            ll::mod::NativeMod::current()->getLogger().info("QA jump input: grounded={} delta={},{},{}", player->isOnGround(), delta.x, delta.y, delta.z);
        }
    }
}
class Guards {
    std::vector<ll::event::ListenerPtr> listeners;
    std::unique_ptr<ll::memory::HookRegistrar<QAInputDiagnostic, QACancelLevels, QAPickupTake, QACompletedItemUse, QACancelFoodCompletion, QABlockUse, QAItemCoordinator, QACancelDoorUpperWrite, QAReplacePitcherResidual, QAKillCreditProbe, QAMobDeathProbe, QADragonDeathProbe, QAWitherDeathProbe, QABreedingResultProbe, QACancelAnimalFeed, QACraftResultsProbe, QACraftActionProbe, QAStackRequestEndProbe, QACraftConsumeProbe, QAFailCraftCommit, QACraftSetProbe, QACraftRequestActionProbe, QATradeRecipeProbe, QATradeInitProbe, QATradePostProbe, QAOldTradeScreen, QAFishingRetrieveProbe, QAFishingPullProbe, QAFishingSpawnProbe, QAFishingEventProbe, QAFishingRodProbe>> hooks;
public:
    static Guards& instance() { static Guards value; return value; }
    bool load() { return true; }
    bool enable() {
        motionFixtureTicks = 0;
        inputCount = 0; cancelledMining = 0; cancelledPlacement = 0; cancelledExperience = 0; cancelledLevels = 0;
        cancelledJumps = 0; jumpEvents = 0; cancelledSneakStarts = 0; cancelledSneakStops = 0; forcedStops = 0;
        lastActionFlags = -1;
        cancelledPickup = 0; cancelledItemUse = 0; lastPickupId = {0}; lastPickupType.clear();
        cancelNextFoodCompletion = false; cancelledCompletions = 0;
        cancelDoorUpper = false; cancelledDoorWrites = 0;
        cancelBerryInteraction = false; cancelledBerryInteractions = 0;
        replacePitcherResidual = false; replacedPitcherResiduals = 0;
        killDiagnostics = false; cancelNextAttack = false; cancelledAttacks = 0;breedingDiagnostics=false;fishingDiagnostics=false;cancelFishingUse=false;cancelFishingRetrieve=false;cancelFishingPull=false;cancelFishingSpawn=false;fishingQuantity=0;craftingDiagnostics=false;oldTradeScreen=false;failCraftCommit=false;failedCraftCommits=0;cancelBreeding=false;cancelFeeding=false;duplicateNextBirth=false;cancelledMatingCalls=0;cancelledFeedingCalls=0;duplicatedBirthRefs=0;
        hooks = std::make_unique<ll::memory::HookRegistrar<QAInputDiagnostic, QACancelLevels, QAPickupTake, QACompletedItemUse, QACancelFoodCompletion, QABlockUse, QAItemCoordinator, QACancelDoorUpperWrite, QAReplacePitcherResidual, QAKillCreditProbe, QAMobDeathProbe, QADragonDeathProbe, QAWitherDeathProbe, QABreedingResultProbe, QACancelAnimalFeed, QACraftResultsProbe, QACraftActionProbe, QAStackRequestEndProbe, QACraftConsumeProbe, QAFailCraftCommit, QACraftSetProbe, QACraftRequestActionProbe, QATradeRecipeProbe, QATradeInitProbe, QATradePostProbe, QAOldTradeScreen, QAFishingRetrieveProbe, QAFishingPullProbe, QAFishingSpawnProbe, QAFishingEventProbe, QAFishingRodProbe>>();
        auto& bus = ll::event::EventBus::getInstance();
        listeners.push_back(bus.emplaceListener<ll::event::PlayerAttackEvent>([](auto& event) {
            if (cancelNextAttack && event.self().getRealName() == "ArchiveQA") {
                event.cancel(); cancelNextAttack = false; ++cancelledAttacks;
                ll::mod::NativeMod::current()->getLogger().info("QA lethal attack cancelled");
            }
        }));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerInteractBlockEvent>([](auto& event) {
            if (cancelBerryInteraction && event.self().getRealName() == "ArchiveQA" && event.block()
                && (event.block()->getTypeName() == "minecraft:sweet_berry_bush" || event.block()->getTypeName().starts_with("minecraft:cave_vines"))) {
                event.cancel(); cancelBerryInteraction = false; ++cancelledBerryInteractions;
                ll::mod::NativeMod::current()->getLogger().info("QA berry interaction cancelled");
            }
        }));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerPickUpItemEvent>([](auto& event) {
            if (event.self().getRealName() == "ArchiveQA" && event.itemActor().item().getTypeName() == "minecraft:emerald") {
                event.cancel(); if (++cancelledPickup == 1) ll::mod::NativeMod::current()->getLogger().info("QA emerald pickup cancelled");
            }
        }));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerUseItemEvent>([](auto& event) {
            if(cancelFishingUse&&event.self().getRealName()=="ArchiveQA"&&event.item().getTypeName()=="minecraft:fishing_rod"){cancelFishingUse=false;event.cancel();ll::mod::NativeMod::current()->getLogger().info("QA fishing use cancelled");return;}
            if (event.self().getRealName() == "ArchiveQA" && event.item().getTypeName() == "minecraft:snowball" && !cancelledItemUse) {
                event.cancel(); ++cancelledItemUse; ll::mod::NativeMod::current()->getLogger().info("QA first snowball use cancelled");
            }
        }));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerDestroyBlockEvent>([](auto& event) {
            if (event.self().getRealName() == "ArchiveQA" && event.pos() == BlockPos{2, 100, 0}) { event.cancel(); ++cancelledMining; }
        }));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerPlacingBlockEvent>([](auto& event) {
            if (event.self().getRealName() == "ArchiveQA" && (event.pos().x == -1 || event.pos().x == 1) && event.pos().z == 0) { event.cancel(); ++cancelledPlacement; }
        }));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerAddExperienceEvent>([](auto& event) {
            if (event.self().getRealName() == "ArchiveQA" && event.experience() == 13) { event.cancel(); ++cancelledExperience; }
        }));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerJumpEvent>([](auto& event) {
            if (event.self().getRealName() != "ArchiveQA") return;
            if (++jumpEvents == 1) { event.cancel(); ++cancelledJumps; }
            ll::mod::NativeMod::current()->getLogger().info("QA jump event {}: cancelled={}", jumpEvents, event.isCancelled());
        }, ll::event::EventPriority::Lowest));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerSneakingEvent>([](auto& event) {
            if (event.self().getRealName() == "ArchiveQA" && !cancelledSneakStarts) { event.cancel(); ++cancelledSneakStarts; }
        }));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerSneakedEvent>([](auto& event) {
            if (event.self().getRealName() == "ArchiveQA" && event.self().isSneaking() && !cancelledSneakStops) { event.cancel(); ++cancelledSneakStops; }
        }));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerChatEvent>([](auto &event) {
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] overflow chat observations") {
                event.cancel();
                for (int i = 0; i < 1027; ++i) {
                    std::string message = "QA unpublished observation " + std::to_string(i);
                    ll::event::PlayerChatEvent candidate(event.self(), message);
                    ll::event::EventBus::getInstance().publish(candidate);
                }
                ll::mod::NativeMod::current()->getLogger().info("QA filled chat observation buffer without broadcasting");
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] inspect motion") {
                event.cancel();
                auto &player = event.self();
                auto const &pos = player.getPosition();
                auto *vehicle = player.getVehicle();
                auto const &carrier = vehicle ? vehicle->getPosition() : pos;
                ll::mod::NativeMod::current()->getLogger().info(
                    "QA motion state: pos={},{},{} dim={} ground={} water={} swim={} fly={} glide={} dead={} vehicle={} carrier={},{},{}",
                    pos.x, pos.y, pos.z, static_cast<int>(player.getDimensionId()), player.isOnGround(),
                    player.isInWater(), player.isSwimming(), player.isFlying(), player.isGliding(), player.isDead(),
                    vehicle ? vehicle->getTypeName() : "none", carrier.x, carrier.y, carrier.z);
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] push minecart") {
                event.cancel();
                auto *vehicle = event.self().getVehicle();
                if (vehicle && vehicle->getTypeName() == "minecraft:minecart") {
                    vehicle->lerpMotion({0, 0, 0.34f});
                    ll::mod::NativeMod::current()->getLogger().info("QA native minecart impulse applied");
                }
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] start native glide") {
                event.cancel();
                auto &player = event.self();
                if (!player.isOnGround() && !player.isDead() && !player.isFlying()) {
                    player.startGliding();
                    ll::mod::NativeMod::current()->getLogger().info(
                        "QA native startGliding result={}", player.isGliding());
                }
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] position discontinuity") {
                event.cancel();
                motionFixturePosition = event.self().getPosition();
                motionFixturePosition.z += 30;
                motionFixtureTicks = 8;
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" &&
                event.message().starts_with("[QA] fishing control ")) {
                event.cancel();
                auto control = event.message().substr(std::string("[QA] fishing control ").size());
                if (control == "cancel-use")
                    cancelFishingUse = true;
                else if (control == "cancel-retrieve")
                    cancelFishingRetrieve = true;
                else if (control == "cancel-pull")
                    cancelFishingPull = true;
                else if (control == "cancel-spawn")
                    cancelFishingSpawn = true;
                else if (control == "quantity7")
                    fishingQuantity = 7;
                ll::mod::NativeMod::current()->getLogger().info("QA fishing control armed: {}", control);
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" &&
                event.message().starts_with("[QA] fishing item ")) {
                event.cancel();
                if (auto hook = event.self().fetchFishingHook()) {
                    bool old = event.message().ends_with("old");
                    ItemStack item;
                    item.reinit(old ? "minecraft:cod" : "minecraft:dirt", old ? 7 : 5, 0);
                    auto actor = hook->spawnAtLocation(item, 0);
                    if (actor) {
                        actor->pickupDelay() = 100000;
                        actor->isFromFishing() = old;
                        if (!attachFishingTarget(*hook, *actor))
                            return;
                        ll::mod::NativeMod::current()->getLogger().info(
                            "QA fishing existing item attached: id={} type={} count={} fromFishing={}",
                            actor->getOrCreateUniqueID().rawID, actor->item().getTypeName(),
                            int(actor->item().mCount), old);
                    }
                }
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" &&
                event.message().starts_with("[QA] fishing target ")) {
                event.cancel();
                try {
                    ActorUniqueID id{
                        std::stoll(event.message().substr(std::string("[QA] fishing target ").size()))};
                    auto hook = event.self().fetchFishingHook();
                    auto actor = event.self().getLevel().$fetchEntity(id, false);
                    if (hook && actor) {
                        if (actor->hasCategory(ActorCategory::Item)) {
                            actor->_setPos(hook->getPosition());
                            ll::mod::NativeMod::current()->getLogger().info(
                                "QA existing item moved to water hook: id={}", id.rawID);
                        }
                        if (!attachFishingTarget(*hook, *actor))
                            return;
                        ll::mod::NativeMod::current()->getLogger().info(
                            "QA fishing existing actor attached: id={} type={}", id.rawID,
                            actor->getTypeName());
                    }
                } catch (...) {
                }
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" &&
                event.message() == "[QA] enable fishing diagnostics") {
                event.cancel();
                fishingDiagnostics = true;
                ll::mod::NativeMod::current()->getLogger().info("QA fishing diagnostics enabled");
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] inspect fishing") {
                event.cancel();
                auto hook = event.self().fetchFishingHook();
                if (hook) {
                    auto pos = hook->getPosition();
                    ll::mod::NativeMod::current()->getLogger().info(
                        "QA fishing state: id={} removed={} hooked={} lured={} nibble={} ground={} water={} "
                        "pos={},{},{}",
                        hook->getOrCreateUniqueID().rawID, bool(hook->mRemoved), int(hook->mTimeUntilHooked),
                        int(hook->mTimeUntilLured), int(hook->mTimeUntilNibble), bool(hook->mInGround),
                        hook->_getWaterPercentage(), pos.x, pos.y, pos.z);
                } else
                    ll::mod::NativeMod::current()->getLogger().info("QA fishing state: none");
                return;
            }
            if(event.self().getRealName()=="ArchiveQA"&&event.message().starts_with("[QA] use old trade screen ")){
                event.cancel();
                oldTradeScreen = event.message().ends_with("on");
                ll::mod::NativeMod::current()->getLogger().info("QA old trade screen={}", oldTradeScreen);
                return;
            }
            if(event.self().getRealName()=="ArchiveQA"&&event.message().starts_with("[QA] inspect trades ")){
                event.cancel();
                try {
                    ActorUniqueID id{
                        std::stoll(event.message().substr(std::string("[QA] inspect trades ").size()))};
                    auto actor = event.self().getLevel().$fetchEntity(id, false);
                    if (actor) {
                        ll::mod::NativeMod::current()->getLogger().info(
                            "QA trading actor: id={} type={} baby={} economy={} legacy={}", id.rawID,
                            actor->getTypeName(), actor->isBaby(),
                            actor->getEntityContext().hasComponent<EconomyTradeableComponent>(),
                            actor->getEntityContext().hasComponent<LegacyTradeableComponent>());
                        if (auto offers = actor->getTradeOffers())
                            for (auto const &offer : offers->mRecipeList.get())
                                ll::mod::NativeMod::current()->getLogger().info(
                                    "QA trade offer: id={} recipe={} uses={} max={} sell={} count={}",
                                    id.rawID, offer.mRecipeNetId->mRawId, int(offer.mUses),
                                    int(offer.mMaxUses), offer.mSell->getTypeName(),
                                    int(offer.mSell->mCount));
                    }
                } catch (...) {
                }
                return;
            }
            if(event.self().getRealName()=="ArchiveQA"&&event.message()=="[QA] enable crafting diagnostics"){
                event.cancel();
                craftingDiagnostics = true;
                ll::mod::NativeMod::current()->getLogger().info("QA crafting diagnostics enabled");
                return;
            }
            if(event.self().getRealName()=="ArchiveQA"&&event.message()=="[QA] fail next crafting commit"){
                event.cancel();
                failCraftCommit = true;
                ll::mod::NativeMod::current()->getLogger().info("QA crafting commit failure armed");
                return;
            }
            if(event.self().getRealName()=="ArchiveQA"&&event.message().starts_with("[QA] remove baby ")){
                event.cancel();
                try {
                    ActorUniqueID id{
                        std::stoll(event.message().substr(std::string("[QA] remove baby ").size()))};
                    auto actor = event.self().getLevel().$fetchEntity(id, false);
                    if (actor && actor->isBaby()) {
                        actor->remove();
                        ll::mod::NativeMod::current()->getLogger().info("QA unselected baby removed: id={}",
                                                                        id.rawID);
                    }
                } catch (...) {
                }
                return;
            }
            if(event.self().getRealName()=="ArchiveQA"&&event.message().starts_with("[QA] cancel mating ")){
                event.cancel();
                cancelBreeding = event.message().ends_with("on");
                ll::mod::NativeMod::current()->getLogger().info("QA mating cancellation={}", cancelBreeding);
                return;
            }
            if(event.self().getRealName()=="ArchiveQA"&&event.message().starts_with("[QA] cancel feeding ")){
                event.cancel();
                cancelFeeding = event.message().ends_with("on");
                ll::mod::NativeMod::current()->getLogger().info("QA feeding cancellation={}", cancelFeeding);
                return;
            }
            if(event.self().getRealName()=="ArchiveQA"&&event.message()=="[QA] duplicate next birth result"){
                event.cancel();
                duplicateNextBirth = true;
                ll::mod::NativeMod::current()->getLogger().info("QA birth result duplication armed");
                return;
            }
            if(event.self().getRealName()=="ArchiveQA"&&event.message().starts_with("[QA] inspect breeding ")){
                event.cancel();
                try {
                    ActorUniqueID id{
                        std::stoll(event.message().substr(std::string("[QA] inspect breeding ").size()))};
                    auto actor = event.self().getLevel().$fetchEntity(id, false);
                    if (actor) {
                        auto component = actor->getEntityContext().tryGetComponent<BreedableComponent>();
                        ll::mod::NativeMod::current()->getLogger().info(
                            "QA breeding state: id={} baby={} loveCause={} loveTimer={} cooldown={}",
                            id.rawID, actor->isBaby(), component ? component->mLoveCause->rawID : 0,
                            component ? int(component->mLoveTimer) : -1,
                            component ? int(component->mBreedCooldown) : -1);
                    }
                } catch (...) {
                }
                return;
            }
            if(event.self().getRealName()=="ArchiveQA"&&event.message()=="[QA] enable breeding diagnostics"){
                event.cancel();
                breedingDiagnostics = true;
                ll::mod::NativeMod::current()->getLogger().info("QA breeding diagnostics enabled");
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message().starts_with("[QA] large slime ")) {
                event.cancel();
                try {
                    ActorUniqueID id{
                        std::stoll(event.message().substr(std::string("[QA] large slime ").size()))};
                    auto actor = event.self().getLevel().$fetchEntity(id, false);
                    if(actor&&(actor->getTypeName()=="minecraft:slime"||actor->getTypeName()=="minecraft:magma_cube")){
                        static_cast<Slime *>(actor)->_setSlimeSize(4);
                        ll::mod::NativeMod::current()->getLogger().info(
                            "QA actual large slime: id={} type={}", id.rawID, actor->getTypeName());
                    }
                }catch(...){
                }
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message().starts_with("[QA] replace wither source ")) {
                event.cancel();
                try {
                    ActorUniqueID id{std::stoll(event.message().substr(std::string("[QA] replace wither source ").size()))};
                    auto actor = event.self().getLevel().$fetchEntity(id, false);
                    if(actor&&actor->getTypeName()=="minecraft:wither"&&actor->isDead()){
                        static_cast<WitherBoss*>(actor)->mDeathSource=std::make_unique<ActorDamageSource>(SharedTypes::Legacy::ActorDamageCause::Fall,"");
                        ll::mod::NativeMod::current()->getLogger().info("QA wither source replaced: id={} cause=fall",id.rawID);
                    }
                }catch(...){
                }
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] cancel next attack") {
                event.cancel();
                cancelNextAttack = true;
                ll::mod::NativeMod::current()->getLogger().info("QA attack cancellation armed");
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message().starts_with("[QA] ignite actor ")) {
                event.cancel();
                try {
                    ActorUniqueID id{std::stoll(event.message().substr(std::string("[QA] ignite actor ").size()))};
                    if (auto actor = event.self().getLevel().$fetchEntity(id,false)) {
                        actor->setOnFire(20);
                        ll::mod::NativeMod::current()->getLogger().info("QA independent ignition: id={} burning={}",id.rawID,actor->isOnFire());
                    }
                } catch (...) {
                }
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message().starts_with("[QA] inspect actor ")) {
                event.cancel();
                try {
                    ActorUniqueID id{std::stoll(event.message().substr(std::string("[QA] inspect actor ").size()))};
                    auto actor = event.self().getLevel().$fetchEntity(id, false);
                    auto owner=actor?actor->getPlayerOwner():nullptr;
                    ll::mod::NativeMod::current()->getLogger().info("QA actor snapshot: id={} type={} dead={} health={} burning={} tame={} sitting={} owner={} lastPlayerTime={}",id.rawID,actor?actor->getTypeName():"missing",actor?actor->isDead():true,actor&&actor->hasCategory(ActorCategory::Mob)?actor->getHealth():-1,actor?actor->isOnFire():false,actor?actor->isTame():false,actor?actor->isSitting():false,owner?owner->getRealName():"none",actor?int(actor->mLastHurtByPlayerTime):-1);
                    if (actor) {
                        auto center = actor->getAABB().center();
                        ll::mod::NativeMod::current()->getLogger().info(
                            "QA actor geometry: id={} center={},{},{} baby={}", id.rawID, center.x, center.y,
                            center.z, actor->isBaby());
                    }
                }catch(...) {
                    ll::mod::NativeMod::current()->getLogger().info("QA actor snapshot rejected");
                }
                return;
            }
            if (event.self().getRealName() == "ArchivePetQA" && event.message().starts_with("[QA] offline wolf target ")) {
                event.cancel();
                std::istringstream arguments(event.message().substr(std::string("[QA] offline wolf target ").size()));
                ActorUniqueID wolfId{0}, targetId{0};
                bool replaceOwner = false;
                if (!(arguments >> wolfId.rawID >> targetId.rawID >> replaceOwner))
                    return;
                auto& level = event.self().getLevel();
                auto wolf = level.$fetchEntity(wolfId, false);
                auto target = level.$fetchEntity(targetId, false);
                if (!wolf || !target || wolf->getTypeName() != "minecraft:wolf" || target->getTypeName() != "minecraft:cow" ||
                    !wolf->isTame() || wolf->isDead() || target->isDead() || wolf->getPlayerOwner())
                    return;
                auto owner = wolf->getOwnerId();
                if (replaceOwner)
                    wolf->setOwner(ActorUniqueID{owner.rawID ^ 1});
                wolf->setSitting(false);
                wolf->setTarget(target);
                ll::mod::NativeMod::current()->getLogger().info(
                    "QA offline wolf target: wolf={} cow={} owner={} replaced={} currentOwner={} offline={}",
                    wolfId.rawID, targetId.rawID, owner.rawID, replaceOwner, wolf->getOwnerId().rawID, !wolf->getPlayerOwner());
                return;
            }
            if ((event.self().getRealName() == "ArchiveQA" || event.self().getRealName() == "ArchivePetQA") &&
                event.message() == "[QA] enable kill diagnostics") {
                event.cancel();
                killDiagnostics = true;
                ll::mod::NativeMod::current()->getLogger().info("QA kill diagnostics enabled");
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] replace next pitcher residual") {
                event.cancel();
                replacePitcherResidual = true;
                ll::mod::NativeMod::current()->getLogger().info("QA pitcher replacement armed");
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] cancel next berry interaction") {
                event.cancel();
                cancelBerryInteraction = true;
                ll::mod::NativeMod::current()->getLogger().info("QA berry interaction cancellation armed");
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] crop snapshot") {
                event.cancel();
                for (int y : {99,100,101,102,103}) {
                    auto const& block = event.self().getDimensionBlockSource().getBlock(BlockPos{0,y,2});
                    ll::mod::NativeMod::current()->getLogger().info("QA crop snapshot: y={} type={} runtime={} growth={} age={} upper={} head={}", y, block.getTypeName(), uint(block.mNetworkId), block.getState<int>(VanillaStates::Growth()).value_or(-1), block.getState<int>(VanillaStates::Age()).value_or(-1), block.getState<bool>(VanillaStates::UpperBlockBit()).value_or(false), block.getState<bool>(VanillaStates::HeadPieceBit()).value_or(false));
                }
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] cancel next door upper write") {
                event.cancel();
                cancelDoorUpper = true;
                ll::mod::NativeMod::current()->getLogger().info("QA door upper cancellation armed");
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] cancel next food completion") {
                event.cancel();
                cancelNextFoodCompletion = true;
                ll::mod::NativeMod::current()->getLogger().info("QA food completion cancellation armed");
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] selected item") {
                event.cancel();
                auto const &selected = event.self().getSelectedItem();
                ll::mod::NativeMod::current()->getLogger().info("QA selected item: type={} count={} using={}", selected.getTypeName(), selected.mCount, event.self().mItemInUse->mItem->getTypeName());
                return;
            }
            if ((event.self().getRealName() == "ArchiveQA" || event.self().getRealName() == "ArchiveVictimQA") && event.message() == "[QA] sync inventory") {
                event.cancel();
                event.self().sendInventory(false);
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && event.message() == "[QA] inspect pickup") {
                event.cancel();
                auto *actor = event.self().getLevel().$fetchEntity(lastPickupId, false);
                auto* item = actor && actor->hasCategory(ActorCategory::Item) ? static_cast<ItemActor*>(actor) : nullptr;
                ll::mod::NativeMod::current()->getLogger().info("QA pickup snapshot: type={} inventory={} remaining={}", lastPickupType, inventoryCount(event.self(), lastPickupType), item ? item->item().mCount : 0);
                return;
            }
            if (event.self().getRealName() == "ArchiveQA" && (event.message() == "[QA] spawn pickup diamonds" || event.message() == "[QA] spawn pickup emeralds" || event.message() == "[QA] spawn pickup dirt")) {
                event.cancel();
                lastPickupType = event.message() == "[QA] spawn pickup diamonds"   ? "minecraft:diamond"
                                 : event.message() == "[QA] spawn pickup emeralds" ? "minecraft:emerald"
                                                                                   : "minecraft:dirt";
                ItemStack item;
                item.reinit(lastPickupType,
                            lastPickupType == "minecraft:diamond"   ? 11
                            : lastPickupType == "minecraft:emerald" ? 7
                                                                    : 5,
                            0);
                auto* actor = event.self().spawnAtLocation(item, 0);
                if (actor)
                    actor->pickupDelay() = 0;
                lastPickupId = actor ? actor->getOrCreateUniqueID() : ActorUniqueID{0};
                ll::mod::NativeMod::current()->getLogger().info("QA pickup spawned: type={} success={}", lastPickupType, actor != nullptr);
                return;
            }
            if (event.self().getRealName() != "ArchiveQA" || event.message() != "[QA] force action stop")
                return;
            event.cancel();
            bool sneak = event.self().isSneaking(), sprint = event.self().isSprinting();
            event.self().setSneaking(false);
            event.self().setSprinting(false);
            ++forcedStops;
            ll::mod::NativeMod::current()->getLogger().info("QA forced action stop {}: before={},{} after={},{}", forcedStops, sneak, sprint, event.self().isSneaking(), event.self().isSprinting());
        }));
        listeners.push_back(bus.emplaceListener<ll::event::ServerLevelTickEvent>([](auto &event) {
            if (!motionFixtureTicks) return;
            event.level().forEachPlayer([](Player &player) {
                if (player.getRealName() != "ArchiveQA") return true;
                player._setPos(motionFixturePosition);
                if (--motionFixtureTicks == 0)
                    ll::mod::NativeMod::current()->getLogger().info(
                        "QA direct position discontinuity sampled: z={}", player.getPosition().z);
                return false;
            });
        }, ll::event::EventPriority::Highest));
        ll::mod::NativeMod::current()->getLogger().info("Isolated behavior QA cancellation guards enabled");
        return true;
    }
    bool disable() {
        ll::mod::NativeMod::current()->getLogger().info("QA crafting guards: failedCommits={}",failedCraftCommits);
        ll::mod::NativeMod::current()->getLogger().info("QA breeding guards: matingCancelled={} feedingCancelled={} duplicatedRefs={}",cancelledMatingCalls,cancelledFeedingCalls,duplicatedBirthRefs);
        hooks.reset(); for (auto const& listener : listeners) ll::event::EventBus::getInstance().removeListener(listener); listeners.clear();
        ll::mod::NativeMod::current()->getLogger().info("QA cancellations: mining={} placement={} experience={}", cancelledMining, cancelledPlacement, cancelledExperience);
        ll::mod::NativeMod::current()->getLogger().info("QA cancelled level requests: {}", cancelledLevels);
        ll::mod::NativeMod::current()->getLogger().info("QA actions: jumps={} cancelledJumps={} cancelledSneakStarts={} cancelledSneakStops={} forcedStops={}", jumpEvents, cancelledJumps, cancelledSneakStarts, cancelledSneakStops, forcedStops);
        ll::mod::NativeMod::current()->getLogger().info("QA items: cancelledPickup={} cancelledUse={} cancelledCompletion={}", cancelledPickup, cancelledItemUse, cancelledCompletions);
        ll::mod::NativeMod::current()->getLogger().info("QA door writes cancelled={}", cancelledDoorWrites);
        ll::mod::NativeMod::current()->getLogger().info("QA berry interactions cancelled={}", cancelledBerryInteractions);
        ll::mod::NativeMod::current()->getLogger().info("QA pitcher residual replacements={}", replacedPitcherResiduals);
        return true;
    }
    bool unload() { return disable(); }
};
}
LL_REGISTER_MOD(archive_qa_guards::Guards, archive_qa_guards::Guards::instance());
