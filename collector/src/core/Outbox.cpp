#include "core/Outbox.h"
#include "core/Engine.h"
#include "core/Platform.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <iomanip>
#include <limits>
#include <regex>
#include <sstream>
#include <stdexcept>

namespace mcarchive {
std::size_t Outbox::pendingEvents() {
    std::lock_guard lock(mutex_);
    std::size_t count = 0;
    for (auto const& path : pending_) count += read(path).eventCount;
    return count;
}
namespace {
using Json = nlohmann::json;
const std::regex filePattern("^[0-9]{20}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.pending$");
Json parse(std::string const& text) {
    return Json::parse(text, [](int depth, Json::parse_event_t, Json&) { if (depth > 32) throw std::runtime_error("Outbox JSON depth exceeded"); return true; });
}
PendingBatch inspect(std::filesystem::path path, std::string const& body, std::string const& serverId) {
    if (body.size() > 1'048'576) throw std::runtime_error("Batch exceeds protocol size limit");
    auto payload = parse(body);
    if (!payload.is_object() || payload.value("protocolVersion", 0) != 1 || !payload.contains("batchId") || !payload["batchId"].is_string()
        || !payload.contains("events") || !payload["events"].is_array() || payload["events"].size() > 1000) throw std::runtime_error("Invalid batch envelope");
    auto id = payload["batchId"].get<std::string>();
    if (!std::regex_match("00000000000000000001_" + id + ".pending", filePattern)) throw std::runtime_error("Batch ID must be a canonical UUID v4");
    return PendingBatch{std::move(path), body, std::move(id), payload["events"].size(), serverId};
}
}
Outbox::Outbox(std::filesystem::path root, std::string serverId) : root_(std::filesystem::absolute(std::move(root))), serverId_(std::move(serverId)) {
    if (!std::regex_match("00000000000000000001_" + serverId_ + ".pending", filePattern)) throw std::runtime_error("Outbox requires a canonical archive UUID v4");
    std::filesystem::create_directories(root_ / L"acknowledged");
    lock_ = CreateFileW((root_ / L"collector.lock").c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (lock_ == INVALID_HANDLE_VALUE) throw std::runtime_error("Outbox is already owned by another process or cannot be locked");
    try {
        auto owner = root_ / L"server-id", temporary = root_ / L"server-id.writing";
        if (std::filesystem::exists(temporary)) {
            if (std::filesystem::exists(owner) || boundedRead(temporary, 80) != serverId_) throw std::runtime_error("Interrupted outbox ownership record requires recovery");
            durableRename(temporary, owner);
        }
        if (std::filesystem::exists(owner)) {
            if (boundedRead(owner, 80) != serverId_) throw std::runtime_error("Outbox belongs to another server archive; use its original credentials or a separate directory");
        } else {
            for (auto const& entry : std::filesystem::directory_iterator(root_)) {
                auto name = entry.path().filename();
                if (name != L"collector.lock" && name != L"acknowledged") throw std::runtime_error("Cannot assign an existing unowned outbox to a server");
            }
            if (!std::filesystem::is_empty(root_ / L"acknowledged")) throw std::runtime_error("Cannot assign unowned acknowledged history to a server");
            atomicWrite(owner, serverId_);
        }
        recover();
    } catch (...) { CloseHandle(lock_); lock_ = INVALID_HANDLE_VALUE; throw; }
}
Outbox::~Outbox() { if (lock_ != INVALID_HANDLE_VALUE) CloseHandle(lock_); }
std::vector<std::filesystem::path> Outbox::pendingPaths() const {
    std::vector<std::filesystem::path> paths;
    for (auto const& entry : std::filesystem::directory_iterator(root_)) {
        auto name = entry.path().filename().string();
        if (entry.path().extension() == L".pending") {
            if (!std::regex_match(name, filePattern)) throw std::runtime_error("Unrecognized pending outbox filename");
            paths.push_back(entry.path());
        } else if (entry.path().extension() == L".writing") throw std::runtime_error("Unrecovered outbox write remains");
    }
    std::sort(paths.begin(), paths.end()); return paths;
}
PendingBatch Outbox::read(std::filesystem::path const& path) const {
    auto record = parse(boundedRead(path, 3 * 1'048'576));
    if (!record.is_object() || record.value("schema", 0) != 1 || !record.contains("body") || !record["body"].is_string() || !record.contains("sha256") || !record["sha256"].is_string()) throw std::runtime_error("Invalid outbox record");
    auto body = record["body"].get<std::string>();
    if (sha256(body) != record["sha256"].get<std::string>()) throw std::runtime_error("Outbox checksum mismatch; restore the original record before continuing");
    return inspect(path, body, serverId_);
}
void Outbox::recover() {
    std::vector<std::filesystem::path> writes;
    for (auto const& entry : std::filesystem::directory_iterator(root_)) if (entry.path().extension() == L".writing") writes.push_back(entry.path());
    std::sort(writes.begin(), writes.end());
    for (auto const& temporary : writes) {
        auto target = temporary; target.replace_extension();
        if (!std::regex_match(target.filename().string(), filePattern)) throw std::runtime_error("Unrecognized interrupted outbox write");
        auto batch = read(temporary);
        if (target.filename().string().find(batch.batchId) == std::string::npos) throw std::runtime_error("Interrupted batch filename does not match its ID");
        if (std::filesystem::exists(target)) throw std::runtime_error("Interrupted write conflicts with an existing batch; preserve both files");
        durableRename(temporary, target);
    }
    for (auto const& directory : {root_, root_ / L"acknowledged"}) {
        for (auto const& entry : std::filesystem::directory_iterator(directory)) {
            auto name = entry.path().filename().string();
            if (!std::regex_match(name, filePattern)) continue;
            auto sequence = std::stoull(name.substr(0, 20));
            if (sequence == std::numeric_limits<unsigned long long>::max()) throw std::runtime_error("Outbox sequence exhausted");
            next_ = std::max(next_, sequence + 1);
        }
    }
    auto paths = pendingPaths();
    for (auto const& path : paths) {
        auto batch = read(path);
        if (path.filename().string().find(batch.batchId) == std::string::npos) throw std::runtime_error("Batch filename does not match its stored ID");
    }
    pending_.assign(paths.begin(), paths.end());
}
PendingBatch Outbox::append(std::string const& body) {
    std::lock_guard guard(mutex_);
    if (interruptedWrite_) throw std::runtime_error("Interrupted outbox write requires recovery");
    auto batch = inspect({}, body, serverId_);
    if (next_ == std::numeric_limits<unsigned long long>::max()) throw std::runtime_error("Outbox sequence exhausted");
    std::ostringstream name; name << std::setfill('0') << std::setw(20) << next_++ << '_' << batch.batchId << ".pending";
    batch.path = root_ / name.str();
    pending_.push_back(batch.path);
    try { atomicWrite(batch.path, Json{{"schema", 1}, {"sha256", sha256(body)}, {"body", body}}.dump()); }
    catch (...) {
        pending_.pop_back();
        auto temporary=batch.path; temporary+=L".writing";
        interruptedWrite_=std::filesystem::exists(temporary);
        throw;
    }
    return batch;
}
std::optional<PendingBatch> Outbox::front() {
    std::lock_guard guard(mutex_);
    if (interruptedWrite_) throw std::runtime_error("Interrupted outbox write requires recovery");
    return pending_.empty() ? std::nullopt : std::optional(read(pending_.front()));
}
std::vector<PendingBatch> Outbox::frontWindow(std::size_t limit) {
    std::lock_guard guard(mutex_);
    if (interruptedWrite_) throw std::runtime_error("Interrupted outbox write requires recovery");
    std::vector<PendingBatch> result;
    std::size_t wireBytes = 16, events = 0;
    for (auto const& path : pending_) {
        if (result.size() >= std::min<std::size_t>(limit, 16)) break;
        PendingBatch batch;
        try { batch = read(path); }
        catch (...) { if (result.empty()) throw; else break; }
        // Count escaped original JSON strings, not just the unescaped bodies.
        auto bytes = Json(batch.body).dump().size() + 1;
        if (!result.empty() && (wireBytes + bytes > 1'048'576 || events + batch.eventCount > 512)) break;
        wireBytes += bytes; events += batch.eventCount;
        result.push_back(std::move(batch));
        // A large individual legacy batch is delivered through the original route.
        if (wireBytes > 1'048'576 || events > 512) break;
    }
    return result;
}
void Outbox::acknowledge(PendingBatch const& batch) {
    std::lock_guard guard(mutex_);
    auto expected = root_ / batch.path.filename();
    if (batch.serverId != serverId_ || batch.path != expected || !std::regex_match(batch.path.filename().string(), filePattern)) throw std::runtime_error("Batch does not belong to this outbox");
    auto target = root_ / L"acknowledged" / batch.path.filename();
    auto source = std::filesystem::exists(batch.path) ? batch.path : target;
    auto stored = read(source);
    if (stored.batchId != batch.batchId || stored.body != batch.body) throw std::runtime_error("Acknowledgement does not match stored bytes");
    if (source == batch.path) durableRename(batch.path, target);
    auto found = std::lower_bound(pending_.begin(), pending_.end(), batch.path);
    if (found != pending_.end() && *found == batch.path) pending_.erase(found);
}
std::size_t Outbox::pendingCount() { std::lock_guard guard(mutex_); return pending_.size(); }
nlohmann::json Outbox::backupCheckpoint() {
    std::lock_guard guard(mutex_);
    auto pending = pendingPaths();
    std::vector<std::string> names;
    auto add = [&](std::filesystem::path const& path) {
        auto name = path.filename().string();
        if (!std::regex_match(name, filePattern) || std::stoull(name.substr(0, 20)) >= next_ || names.size() >= 100000)
            throw std::runtime_error("Invalid backup outbox inventory");
        names.push_back(std::move(name));
    };
    for (auto const& file : pending) add(file);
    for (auto const& entry : std::filesystem::directory_iterator(root_ / L"acknowledged"))
        if (entry.path().extension() == L".pending") add(entry.path());
    std::sort(names.begin(), names.end());
    if (std::adjacent_find(names.begin(), names.end()) != names.end())
        throw std::runtime_error("Duplicate backup outbox record");
    std::string inventory;
    for (auto const& name : names) { inventory += name; inventory += '\n'; }
    return {{"nextSequence", std::to_string(next_)}, {"records", names.size()},
            {"namesSha256", sha256(inventory)}, {"capturedAt", timestamp(nowMillis())}};
}
std::size_t Outbox::replayAcknowledged() {
    std::lock_guard guard(mutex_); std::vector<std::filesystem::path> paths;
    for (auto const& entry : std::filesystem::directory_iterator(root_ / L"acknowledged")) {
        if (!std::regex_match(entry.path().filename().string(), filePattern)) throw std::runtime_error("Unrecognized acknowledged record");
        read(entry.path()); paths.push_back(entry.path());
    }
    std::sort(paths.begin(), paths.end());
    try {
        for (auto const& path : paths) durableRename(path, root_ / path.filename());
    } catch (...) {
        auto current = pendingPaths(); pending_.assign(current.begin(), current.end()); throw;
    }
    auto current = pendingPaths(); pending_.assign(current.begin(), current.end());
    return paths.size();
}
}
