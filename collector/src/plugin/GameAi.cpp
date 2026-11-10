#include "plugin/GameAi.h"
#include "plugin/GameTracker.h"
#include "core/AiMailbox.h"
#include "ll/api/command/CommandHandle.h"
#include "ll/api/command/CommandRegistrar.h"
#include "mc/server/commands/CommandOrigin.h"
#include "mc/server/commands/CommandRawText.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/level/Level.h"
#include <mutex>

namespace mcarchive {
struct AiParameters { CommandRawText question; };
namespace {
std::mutex lifetime;
struct Target { virtual void ask(Player&, std::string const&, CommandOutput&) = 0; virtual ~Target() = default; };
Target* active = nullptr;
}
struct GameAi::Impl : Target {
    AiMailbox mailbox;
    explicit Impl(EngineConfig const& config) : mailbox(config.dataDirectory.parent_path() / "game-ai", config.serverId) {
        std::lock_guard guard(lifetime);
        if (active) throw std::runtime_error("Game AI already registered");
        auto& command = ll::command::CommandRegistrar::getServerInstance().getOrCreateCommand(
            "ai", "向小鲸鱼提问（与 QQ 群共享记忆，回答私发到游戏）", CommandPermissionLevel::Any);
        command.overload().execute([](CommandOrigin const&, CommandOutput& output) {
            output.success("用法：/ai 你的问题。游戏内消息会进入关联 QQ 群的 AI 记忆，回答仅发给提问玩家。");
        });
        command.overload<AiParameters>().required("question").execute([](CommandOrigin const& origin, CommandOutput& output, AiParameters const& args) {
            std::lock_guard guard(lifetime);
            auto actor = origin.getEntity();
            if (!active || origin.getOriginType() != CommandOriginType::Player || !actor || !actor->isPlayer()) {
                output.error("请由玩家在游戏内输入 /ai 问题"); return;
            }
            auto& player = static_cast<Player&>(*actor);
            if (!player.isPlayerInitialized()) { output.error("请等待玩家加载完成"); return; }
            try { active->ask(player, args.question.mText, output); }
            catch (...) { output.error("问题暂时无法受理，请稍后再试"); }
        });
        active = this;
    }
    void ask(Player& player, std::string const& question, CommandOutput& output) override {
        auto pos = player.getPosition();
        auto error = mailbox.submit(playerIdentity(player), stablePlayerKey(player), playerDimension(player),
            {{"x", pos.x}, {"y", pos.y}, {"z", pos.z}}, question);
        if (!error.empty()) output.error(error);
        else output.success("已交给小鲸鱼，会通过个人消息回答（与关联 QQ 群共享 AI 记忆）。");
    }
    void tick(Level& level) {
        auto ready = mailbox.drain();
        if (ready.empty()) return;
        level.forEachPlayer([&](Player& player) {
            if (player.isPlayerInitialized()) {
                auto key = stablePlayerKey(player);
                for (auto const& result : ready) if (result.player == key) player.sendMessage("[小鲸鱼] " + result.text);
            }
            return true;
        });
    }
    ~Impl() { std::lock_guard guard(lifetime); if (active == this) active = nullptr; }
};
GameAi::GameAi(EngineConfig const& config) : impl_(std::make_unique<Impl>(config)) {}
GameAi::~GameAi() = default;
void GameAi::tick(Level& level) { impl_->tick(level); }
}
