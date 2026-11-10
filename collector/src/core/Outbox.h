#pragma once
#include <Windows.h>
#include <filesystem>
#include <deque>
#include <mutex>
#include <nlohmann/json_fwd.hpp>
#include <optional>
#include <string>
#include <vector>

namespace mcarchive {
struct PendingBatch {
    std::filesystem::path path;
    std::string body;
    std::string batchId;
    std::size_t eventCount;
    std::string serverId;
};
class Outbox {
public:
    Outbox(std::filesystem::path root, std::string serverId);
    ~Outbox();
    Outbox(Outbox const&) = delete;
    Outbox& operator=(Outbox const&) = delete;
    PendingBatch append(std::string const& body);
    std::optional<PendingBatch> front();
    std::vector<PendingBatch> frontWindow(std::size_t limit = 16);
    void acknowledge(PendingBatch const& batch);
    std::size_t pendingCount();
    std::size_t pendingEvents();
    nlohmann::json backupCheckpoint();
    std::size_t replayAcknowledged();
private:
    std::filesystem::path root_;
    std::string serverId_;
    HANDLE lock_ = INVALID_HANDLE_VALUE;
    std::mutex mutex_;
    unsigned long long next_ = 1;
    std::deque<std::filesystem::path> pending_;
    bool interruptedWrite_ = false;
    std::vector<std::filesystem::path> pendingPaths() const;
    PendingBatch read(std::filesystem::path const& path) const;
    void recover();
};
}
