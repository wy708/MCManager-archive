#include "plugin/QqBinding.h"
#include "plugin/GameTracker.h"
#include "core/Transport.h"
#include "core/Platform.h"
#include "ll/api/command/CommandHandle.h"
#include "ll/api/command/CommandRegistrar.h"
#include "mc/server/commands/CommandOrigin.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/level/Level.h"
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>
#include <unordered_set>

namespace mcarchive {
namespace {
using json = nlohmann::json;
struct BindingRequest { std::string player, id, code; };
struct BindingResult { std::string player, text; };
std::mutex commandMutex;
struct CommandTarget {
    virtual void enqueue(Player&, CommandOutput&) = 0;
    virtual ~CommandTarget() = default;
};
CommandTarget* active = nullptr;
}
struct QqBinding::Impl : CommandTarget {
    HttpTransport transport;
    std::mutex mutex;
    std::condition_variable changed;
    std::deque<BindingRequest> requests;
    std::deque<BindingResult> results;
    std::unordered_set<std::string> pendingPlayers;
    bool stopping = false;
    std::thread worker;
    explicit Impl(EngineConfig const& config) : transport(config.endpoint,config.token) {
        std::lock_guard lock(commandMutex);
        if (active) throw std::runtime_error("QQ binding command already enabled");
        auto& command = ll::command::CommandRegistrar::getServerInstance().getOrCreateCommand(
            "qqbind","领取 QQ 账号绑定验证码",CommandPermissionLevel::Any);
        command.overload().execute([](CommandOrigin const& origin,CommandOutput& output) {
            std::lock_guard lock(commandMutex);
            auto actor = origin.getEntity();
            if (!active || origin.getOriginType() != CommandOriginType::Player || !actor || !actor->isPlayer()) {
                output.error("请由玩家在游戏内输入 /qqbind"); return;
            }
            auto& player = static_cast<Player&>(*actor);
            if (!player.isPlayerInitialized()) { output.error("请等待玩家加载完成"); return; }
            active->enqueue(player,output);
        });
        worker = std::thread([this] { run(); });
        active = this;
    }
    void enqueue(Player& player,CommandOutput& output) override {
        auto key = stablePlayerKey(player);
        std::lock_guard lock(mutex);
        if (stopping || pendingPlayers.contains(key) || pendingPlayers.size() >= 32) {
            output.error("验证码正在处理，请稍后再试"); return;
        }
        auto code = uuid().substr(0,8);
        for (auto& c : code) if (c >= 'a' && c <= 'f') c -= 'a' - 'A';
        requests.push_back({key,uuid(),code});
        pendingPlayers.insert(key);
        changed.notify_one();
        output.success("正在领取验证码，请查看个人消息");
    }
    void run() noexcept {
        for (;;) {
            BindingRequest request;
            {
                std::unique_lock lock(mutex);
                changed.wait(lock,[this] { return stopping || !requests.empty(); });
                if (stopping) return;
                request = std::move(requests.front()); requests.pop_front();
            }
            std::string text = "领取失败，请确认采集连接正常，稍后重新输入 /qqbind。";
            try {
                auto response = transport.postCommand("/qq-binding-codes",json{
                    {"requestId",request.id},{"playerKey",request.player},{"code",request.code}}.dump());
                if (response.status == 200 && response.error.empty()) {
                    auto receipt = json::parse(response.body);
                    if (receipt.at("requestId") == request.id && receipt.at("expiresAt").is_string())
                        text = "QQ 绑定验证码 " + request.code + "，5 分钟内有效。请到对应 QQ 群 @机器人 发送：绑定 " + request.code;
                } else if (response.status == 429) text = "领取过于频繁，请等待 30 秒后再输入 /qqbind。";
            } catch (...) {}
            std::lock_guard lock(mutex);
            results.push_back({request.player,std::move(text)});
        }
    }
    void tick(Level& level) {
        std::deque<BindingResult> ready;
        { std::lock_guard lock(mutex); ready.swap(results); for (auto const& result : ready) pendingPlayers.erase(result.player); }
        for (auto const& result : ready)
            level.forEachPlayer([&](Player& player) {
                if (player.isPlayerInitialized() && stablePlayerKey(player) == result.player) player.sendMessage(result.text);
                return true;
            });
    }
    ~Impl() {
        { std::lock_guard lock(commandMutex); if (active == this) active = nullptr; }
        { std::lock_guard lock(mutex); stopping = true; }
        changed.notify_all();
        if (worker.joinable()) worker.join();
    }
};
QqBinding::QqBinding(EngineConfig const& config) : impl_(std::make_unique<Impl>(config)) {}
QqBinding::~QqBinding() = default;
void QqBinding::tick(Level& level) { impl_->tick(level); }
}
