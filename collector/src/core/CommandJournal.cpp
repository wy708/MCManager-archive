#include "core/CommandJournal.h"
#include "core/Platform.h"
#include <algorithm>
#include <map>
#include <regex>
#include <stdexcept>

namespace mcarchive {
using json = nlohmann::json;
namespace {
bool id(std::string const& value) {
    static std::regex const pattern("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    return std::regex_match(value, pattern);
}
void validate(CommandRecord const& record, std::string const& server) {
    auto const& lease = record.lease;
    if (!lease.is_object() || !id(lease.at("leaseId").get<std::string>()) || !id(lease.at("bootId").get<std::string>())
        || !id(lease.at("reply").at("id").get<std::string>()) || lease.at("reply").at("serverId").get<std::string>() != server
        || record.phase < 0 || record.phase > 3) throw std::runtime_error("Invalid command journal identity or stage");
    if (record.phase >= 1 && record.executionDeadline <= 0) throw std::runtime_error("Command start deadline missing");
    if (record.phase >= 2 && (!record.result.is_object() || record.result.at("leaseId") != lease.at("leaseId") || record.result.at("bootId") != lease.at("bootId"))) throw std::runtime_error("Command result does not match its lease");
}
}
CommandJournal::CommandJournal(std::filesystem::path directory, std::string serverId)
    : directory_(std::move(directory) / "records"), serverId_(std::move(serverId)), owner_(directory_.parent_path(), serverId_) {
    std::filesystem::create_directories(directory_);
    for (auto const& entry : std::filesystem::directory_iterator(directory_)) {
        if (!entry.is_regular_file() || !entry.path().filename().string().ends_with(".json.writing")) continue;
        auto record = read(entry.path()); auto target = filename(record);
        if (std::filesystem::exists(target)) {
            if (boundedRead(entry.path(), 65536) != boundedRead(target, 65536)) throw std::runtime_error("Conflicting interrupted command journal write");
            auto duplicate = entry.path(); duplicate += L".duplicate"; durableRename(entry.path(), duplicate);
        } else durableRename(entry.path(), target);
    }
    recover();
}
std::filesystem::path CommandJournal::filename(CommandRecord const& record) const {
    validate(record, serverId_);
    return directory_ / (record.lease.at("reply").at("id").get<std::string>() + "_" + record.lease.at("leaseId").get<std::string>() + "_" + std::to_string(record.phase) + ".json");
}
CommandRecord CommandJournal::read(std::filesystem::path const& path) const {
    auto wrapper = json::parse(boundedRead(path, 65536)); auto body = wrapper.at("body").get<std::string>();
    if (wrapper.at("schema").get<int>() != 1 || wrapper.at("sha256").get<std::string>() != sha256(body)) throw std::runtime_error("Corrupt command journal checksum");
    auto payload = json::parse(body);
    CommandRecord record{payload.at("lease"), payload.at("phase").get<int>(), payload.at("executionDeadline").get<std::int64_t>(), payload.at("result")};
    validate(record, serverId_);
    auto expected = filename(record).filename().string(); auto actual = path.filename().string();
    if (actual != expected && actual != expected + ".writing") throw std::runtime_error("Command journal filename does not match its identity");
    return record;
}
void CommandJournal::save(CommandRecord const& record) {
    auto target = filename(record);
    if (std::filesystem::exists(target)) {
        auto old = read(target);
        if (old.lease != record.lease || old.executionDeadline != record.executionDeadline || old.result != record.result) throw std::runtime_error("Conflicting command stage rewrite");
        return;
    }
    auto body = json({{"lease", record.lease}, {"phase", record.phase}, {"executionDeadline", record.executionDeadline}, {"result", record.result}}).dump();
    auto wrapper = json({{"schema", 1}, {"sha256", sha256(body)}, {"body", body}}).dump();
    if (wrapper.size() > 65536) throw std::runtime_error("Command journal record exceeds size limit");
    atomicWrite(target, wrapper);
}
CommandRecord CommandJournal::prepare(json lease) {
    CommandRecord record{std::move(lease)}; auto target = filename(record);
    if (std::filesystem::exists(target)) {
        auto old = read(target); if (old.lease != record.lease) throw std::runtime_error("Command payload changed under the same lease");
        auto records = recover(); auto found = std::find_if(records.begin(), records.end(), [&](auto const& saved) { return saved.lease == old.lease; });
        return found == records.end() ? old : *found;
    }
    save(record); return record;
}
CommandRecord CommandJournal::start(CommandRecord record, std::int64_t deadline) {
    if (record.phase != 0 || !std::filesystem::exists(filename(record))) throw std::runtime_error("Command was not durably prepared");
    record.phase = 1; record.executionDeadline = deadline; save(record); return record;
}
CommandRecord CommandJournal::finish(CommandRecord record, json result) {
    if (record.phase != 1 || !std::filesystem::exists(filename(record))) throw std::runtime_error("Command was not durably started");
    record.phase = 2; record.result = std::move(result); save(record); return record;
}
void CommandJournal::acknowledge(CommandRecord record) {
    if (record.phase != 2 || !std::filesystem::exists(filename(record))) throw std::runtime_error("Command result is not durable");
    record.phase = 3; save(record);
}
std::vector<CommandRecord> CommandJournal::recover() {
    std::map<std::string, std::vector<CommandRecord>> groups;
    for (auto const& entry : std::filesystem::directory_iterator(directory_)) {
        if (!entry.is_regular_file() || entry.path().extension() != ".json") continue;
        auto record = read(entry.path()); groups[record.lease.at("reply").at("id").get<std::string>() + record.lease.at("leaseId").get<std::string>()].push_back(std::move(record));
    }
    std::vector<CommandRecord> result;
    for (auto& [key, records] : groups) {
        std::sort(records.begin(), records.end(), [](auto const& a, auto const& b) { return a.phase < b.phase; });
        for (std::size_t i = 0; i < records.size(); ++i) {
            if (records[i].phase != static_cast<int>(i) || records[i].lease != records.front().lease
                || (i >= 2 && records[i].executionDeadline != records[1].executionDeadline)
                || (i == 3 && records[i].result != records[2].result)) throw std::runtime_error("Incomplete or conflicting command stage history");
        }
        result.push_back(records.back());
    }
    return result;
}
}
