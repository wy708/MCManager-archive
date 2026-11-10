#include "core/AiMailbox.h"
#include "core/Platform.h"
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <unordered_set>

namespace mcarchive {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
std::int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}
struct Pending { Json data; Clock::time_point deadline; bool written = false; };
}
struct AiMailbox::Impl {
    std::filesystem::path root;
    std::string serverId;
    std::mutex mutex;
    std::condition_variable changed;
    bool stopping = false;
    std::deque<Pending> incoming;
    std::vector<AiAnswer> results;
    std::unordered_set<std::string> busy;
    std::unordered_map<std::string, Clock::time_point> lastAsk;
    std::deque<Clock::time_point> recent;
    std::thread worker;
    Impl(std::filesystem::path directory, std::string server)
        : root(std::move(directory)), serverId(std::move(server)), worker([this] { run(); }) {}
    ~Impl() {
        { std::lock_guard guard(mutex); stopping = true; }
        changed.notify_all();
        worker.join();
    }
    std::string submit(Json identity, std::string key, std::string dimension, Json position, std::string question) {
        if (question.empty() || question.size() > 1536 || question.find_first_not_of(" \t\r\n") == std::string::npos)
            return "请用 /ai 问题 提问，问题不要超过 384 个汉字。";
        std::size_t characters = 0;
        for (unsigned char c : question) if ((c & 0xc0) != 0x80) ++characters;
        if (characters > 384) return "问题太长，请缩短到 384 个字以内。";
        for (unsigned char c : question) if (c < 32 && c != '\n' && c != '\t') return "问题含不支持的控制字符。";
        auto now = Clock::now();
        std::lock_guard guard(mutex);
        if (stopping || busy.contains(key)) return "小鲸鱼正在处理你的上一条问题，请稍候。";
        if (busy.size() >= 16) return "小鲸鱼的问题队列已满，请稍后再问。";
        for (auto it = lastAsk.begin(); it != lastAsk.end();) {
            if (now - it->second >= std::chrono::seconds(20)) it = lastAsk.erase(it); else ++it;
        }
        if (lastAsk.contains(key)) return "请间隔 20 秒再提问。";
        while (!recent.empty() && now - recent.front() >= std::chrono::minutes(1)) recent.pop_front();
        if (recent.size() >= 12) return "大家提问比较频繁，请稍后再问。";
        auto id = uuid(); auto timestamp = nowMs();
        Json data = {{"schema", 1}, {"requestId", id}, {"serverId", serverId}, {"playerKey", key},
                     {"player", std::move(identity)}, {"dimension", std::move(dimension)}, {"position", std::move(position)},
                     {"question", std::move(question)}, {"createdAt", timestamp}, {"expiresAt", timestamp + 300000}};
        incoming.push_back({std::move(data), now + std::chrono::minutes(5)});
        busy.insert(key); lastAsk[key] = now; recent.push_back(now);
        changed.notify_one();
        return {}; // accepted, not answered
    }
    void removeFiles(std::string const& id) noexcept {
        std::error_code ec;
        std::filesystem::remove(root / "requests" / (id + ".json"), ec);
        std::filesystem::remove(root / "responses" / (id + ".json"), ec);
        std::filesystem::remove(root / "requests" / (id + ".json.writing"), ec);
    }
    void run() noexcept {
        std::vector<Pending> pending;
        for (;;) {
            {
                std::unique_lock guard(mutex);
                changed.wait_for(guard, std::chrono::seconds(1), [&] { return stopping || !incoming.empty(); });
                if (stopping) {
                    for (auto const& p : pending) removeFiles(p.data.at("requestId").get<std::string>());
                    return;
                }
                while (!incoming.empty()) { pending.push_back(std::move(incoming.front())); incoming.pop_front(); }
            }
            for (auto it = pending.begin(); it != pending.end();) {
                auto const id = it->data.at("requestId").get<std::string>();
                auto const player = it->data.at("playerKey").get<std::string>();
                std::string answer;
                try {
                    if (Clock::now() >= it->deadline) answer = "小鲸鱼暂时没有完成回答，请稍后重新提问。";
                    else if (!it->written) {
                        std::filesystem::create_directories(root / "requests");
                        std::filesystem::create_directories(root / "responses");
                        atomicWrite(root / "requests" / (id + ".json"), it->data.dump());
                        it->written = true;
                    } else if (std::filesystem::exists(root / "responses" / (id + ".json"))) {
                        auto reply = Json::parse(boundedRead(root / "responses" / (id + ".json"), 12000));
                        if (reply.at("schema") != 1 || reply.at("requestId") != id || reply.at("serverId") != serverId
                            || reply.at("playerKey") != player || !reply.at("text").is_string()) throw std::runtime_error("AI identity mismatch");
                        answer = reply.at("text").get<std::string>();
                        if (answer.empty() || answer.size() > 6000) throw std::runtime_error("AI answer size invalid");
                        for (unsigned char c : answer) if (c < 32 && c != '\n' && c != '\t') throw std::runtime_error("AI control character");
                    }
                } catch (...) { answer = "小鲸鱼本机连接暂时不可用，请联系管理员检查桥接程序。"; }
                if (answer.empty()) { ++it; continue; }
                // Remove before delivery: a restart must never replay an old private answer.
                removeFiles(id);
                { std::lock_guard guard(mutex); results.push_back({player, std::move(answer)}); }
                it = pending.erase(it);
            }
        }
    }
    std::vector<AiAnswer> drain() {
        std::lock_guard guard(mutex);
        std::vector<AiAnswer> ready; ready.swap(results);
        for (auto const& item : ready) busy.erase(item.player);
        return ready;
    }
};
AiMailbox::AiMailbox(std::filesystem::path root, std::string server) : impl_(std::make_unique<Impl>(std::move(root), std::move(server))) {}
AiMailbox::~AiMailbox() = default;
std::string AiMailbox::submit(Json player, std::string key, std::string dimension, Json position, std::string question) {
    return impl_->submit(std::move(player), std::move(key), std::move(dimension), std::move(position), std::move(question));
}
std::vector<AiAnswer> AiMailbox::drain() { return impl_->drain(); }
}
