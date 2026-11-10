#pragma once
#include <nlohmann/json.hpp>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace mcarchive {
struct AiAnswer { std::string player, text; };
// All disk access is performed by the worker. The game thread only submits
// bounded values and drains answers; no model or network call runs on it.
class AiMailbox {
public:
    AiMailbox(std::filesystem::path directory, std::string serverId);
    ~AiMailbox();
    std::string submit(nlohmann::json player, std::string playerKey,
                       std::string dimension, nlohmann::json position, std::string question);
    std::vector<AiAnswer> drain();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
