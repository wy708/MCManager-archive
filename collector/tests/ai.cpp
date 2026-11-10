#include "core/AiMailbox.h"
#include "core/Platform.h"
#include <chrono>
#include <filesystem>
#include <iostream>
#include <thread>

using namespace mcarchive;
using Json = nlohmann::json;
void require(bool condition, char const* error) { if (!condition) throw std::runtime_error(error); }
std::string const server = "11111111-1111-4111-8111-111111111111";
int wmain(int argc, wchar_t** argv) {
    try {
        require(argc == 2 || argc == 3, "Expected fresh test mailbox path");
        auto root = std::filesystem::path(argv[1]);
        require(!std::filesystem::exists(root), "Test needs a fresh directory");
        bool bridge = argc == 3;
        AiMailbox mailbox(root, server);
        Json identity = {{"identityType", "XUID"}, {"identity", "1234"}, {"name", "FixturePlayer"}};
        require(!mailbox.submit(identity, "xuid:1234", "overworld", {}, "").empty(), "Accepted empty question");
        require(!mailbox.submit(identity, "xuid:1234", "overworld", {}, std::string(1600, 'x')).empty(), "Accepted oversized question");
        require(mailbox.submit(identity, "xuid:1234", "overworld", {{"x", 1}, {"y", 70}, {"z", 2}}, "熔炉为什么没烧起来").empty(), "Valid question rejected");
        require(!mailbox.submit(identity, "xuid:1234", "overworld", {}, "重复提问").empty(), "Duplicate player not throttled");
        Json request;
        for (int i = 0; i < 100 && request.is_null(); ++i) {
            if (std::filesystem::exists(root / "requests"))
                for (auto const& entry : std::filesystem::directory_iterator(root / "requests"))
                    if (entry.path().extension() == ".json") request = Json::parse(boundedRead(entry.path(), 8192));
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        require(request.is_object(), "Native worker did not publish request");
        require(request.at("serverId") == server && request.at("playerKey") == "xuid:1234", "Identity lost");
        require(request.at("expiresAt").get<long long>() - request.at("createdAt").get<long long>() == 300000, "TTL invalid");
        std::cout << "request-ready\n" << std::flush;
        if (!bridge) atomicWrite(root / "responses" / (request.at("requestId").get<std::string>() + ".json"),
            Json{{"schema", 1}, {"requestId", request.at("requestId")}, {"serverId", server}, {"playerKey", "xuid:someone-else"}, {"text", "must not deliver"}}.dump());
        std::vector<AiAnswer> answers;
        for (int i = 0; i < 200 && answers.empty(); ++i) {
            answers = mailbox.drain();
            if (answers.empty()) std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        require(answers.size() == 1 && answers[0].player == "xuid:1234", "Missing or misdirected answer");
        if (bridge) require(answers[0].text == "检查燃料和配方。", "Bridge/native text changed");
        else require(answers[0].text.find("暂时不可用") != std::string::npos, "Foreign answer was delivered");
        require(mailbox.drain().empty(), "Answer replayed");
        require(!std::filesystem::exists(root / "requests" / (request.at("requestId").get<std::string>() + ".json")), "Completed request left behind");
        require(!mailbox.submit(identity, "xuid:1234", "overworld", {}, "冷却时间内再问").empty(), "Cooldown lost after delivery");
        std::cout << "native-mailbox-verified; real-gameplay=false\n";
        return 0;
    } catch (std::exception const& e) { std::cerr << e.what() << '\n'; return 1; }
}
