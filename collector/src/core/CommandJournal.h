#pragma once
#include "core/Outbox.h"
#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace mcarchive {
struct CommandRecord {
    nlohmann::json lease;
    int phase = 0; // prepared, started, finished, acknowledged
    std::int64_t executionDeadline = 0;
    nlohmann::json result = nullptr;
};
class CommandJournal {
public:
    CommandJournal(std::filesystem::path directory, std::string serverId);
    CommandRecord prepare(nlohmann::json lease);
    CommandRecord start(CommandRecord record, std::int64_t deadline);
    CommandRecord finish(CommandRecord record, nlohmann::json result);
    void acknowledge(CommandRecord record);
    std::vector<CommandRecord> recover();
private:
    std::filesystem::path directory_;
    std::string serverId_;
    Outbox owner_;
    void save(CommandRecord const& record);
    CommandRecord read(std::filesystem::path const& path) const;
    std::filesystem::path filename(CommandRecord const& record) const;
};
}
