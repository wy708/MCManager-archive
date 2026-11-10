// Isolated 1.26.61.1 acceptance helper. Never packaged with the collector.
#include "ll/api/event/EventBus.h"
#include "ll/api/event/player/PlayerChatEvent.h"
#include "ll/api/memory/Hook.h"
#include "ll/api/mod/NativeMod.h"
#include "ll/api/mod/RegisterHelper.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/inventory/network/ContainerScreenContext.h"
#include "mc/world/inventory/network/ItemStackRequestActionHandler.h"
#include "mc/world/inventory/network/crafting/CraftHandlerBase.h"
#include "mc/world/inventory/network/crafting/ItemStackRequestActionCraftHandler.h"
#include "mc/world/inventory/simulation/ContainerScreenValidation.h"
#include <atomic>
#include "mc/world/item/ItemInstance.h"

namespace archive_port_craft_qa {
std::atomic_bool failNext{false};
std::atomic_size_t rejected{0}, committed{0}, failed{0};

// Run inside the collector's Highest-priority hook so its origin() observes
// the rejected commit, including postRequest(true) after commitFailed.
LL_TYPE_INSTANCE_HOOK(RejectCommit, ll::memory::HookPriority::Lowest, ContainerScreenValidation,
    ll::memory::SymbolView{"?tryCommitActionResults@ContainerScreenValidation@@QEAA_NXZ"}, bool) {
    auto* player = mScreenContext->mPlayer;
    bool qa = player && player->getRealName() == "ArchiveQA";
    if (qa && failNext.exchange(false)) {
        ++rejected;
        ll::mod::NativeMod::current()->getLogger().info("QA crafting commit rejected before origin");
        return false;
    }
    auto result = origin();
    if (qa) {
        if (result) ++committed; else ++failed;
        ll::mod::NativeMod::current()->getLogger().info("QA actual inventory commit: success={}", result);
    }
    return result;
}
LL_TYPE_INSTANCE_HOOK(PostObservation, ll::memory::HookPriority::Lowest, CraftHandlerBase,
    &CraftHandlerBase::postRequest, void, bool success) {
    auto& handler = mCraftRequestHandler.mRequestActionHandler;
    auto id = handler.mClientRequestId->mRawId;
    bool qa = handler.mPlayer.getRealName() == "ArchiveQA";
    origin(success);
    if (qa) ll::mod::NativeMod::current()->getLogger().info("QA native craft post: request={} flag={}", id, success);
}
LL_TYPE_INSTANCE_HOOK(InitResultsObservation, ll::memory::HookPriority::Lowest, ItemStackRequestActionCraftHandler,
    ll::memory::SymbolView{"?_initCraftResults@ItemStackRequestActionCraftHandler@@QEAA?AW4ItemStackNetResult@@AEBV?$vector@VItemInstance@@V?$allocator@VItemInstance@@@std@@@std@@E@Z"},
    ItemStackNetResult, std::vector<ItemInstance> const& results, uchar count) {
    auto result = origin(results, count);
    if (mPlayer.getRealName() == "ArchiveQA")
        ll::mod::NativeMod::current()->getLogger().info("QA craft init results: status={} numCrafts={} outputs={} stored={}", int(result), int(count), results.size(), mCraftResults->size());
    return result;
}
class Guards {
    ll::event::ListenerPtr listener;
    std::unique_ptr<ll::memory::HookRegistrar<RejectCommit, PostObservation, InitResultsObservation>> hooks;
public:
    static Guards& instance() { static Guards value; return value; }
    bool load() { return true; }
    bool enable() {
        hooks = std::make_unique<ll::memory::HookRegistrar<RejectCommit, PostObservation, InitResultsObservation>>();
        listener = ll::event::EventBus::getInstance().emplaceListener<ll::event::PlayerChatEvent>([](auto& event) {
            if (event.self().getRealName() != "ArchiveQA") return;
            if (event.message() == "[QA] sync inventory") {
                event.cancel();
                event.self().sendInventory(false);
                return;
            }
            if (event.message() == "[QA] enable crafting diagnostics") {
                event.cancel();
                ll::mod::NativeMod::current()->getLogger().info("QA crafting diagnostics enabled");
                return;
            }
            if (event.message() == "[QA] fail next crafting commit") {
                event.cancel(); failNext = true;
                ll::mod::NativeMod::current()->getLogger().info("QA crafting commit failure armed");
            }
        }, ll::event::EventPriority::Highest);
        ll::mod::NativeMod::current()->getLogger().info("Isolated 1.26.61.1 crafting commit QA enabled");
        return true;
    }
    bool disable() {
        hooks.reset();
        if (listener) ll::event::EventBus::getInstance().removeListener(listener);
        listener.reset(); failNext = false;
        ll::mod::NativeMod::current()->getLogger().info("QA crafting commit totals: committed={} failed={} injected={}", committed.load(), failed.load(), rejected.load());
        return true;
    }
    bool unload() { return disable(); }
};
}
LL_REGISTER_MOD(archive_port_craft_qa::Guards, archive_port_craft_qa::Guards::instance());
