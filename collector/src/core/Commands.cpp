#include "core/Commands.h"
#include "core/CommandJournal.h"
#include "core/Transport.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <ctime>
#include <deque>
#include <mutex>
#include <optional>
#include <regex>
#include <stdexcept>
#include <thread>

namespace mcarchive {
using json = nlohmann::json;
using namespace std::chrono_literals;
namespace {
std::int64_t instant(std::string const& value) {
    static std::regex const pattern("([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\\.([0-9]{1,9}))?Z");
    std::smatch parts; if (!std::regex_match(value, parts, pattern)) throw std::runtime_error("Invalid command deadline");
    std::tm utc{}; utc.tm_year = std::stoi(parts[1].str()) - 1900; utc.tm_mon = std::stoi(parts[2].str()) - 1; utc.tm_mday = std::stoi(parts[3].str());
    utc.tm_hour = std::stoi(parts[4].str()); utc.tm_min = std::stoi(parts[5].str()); utc.tm_sec = std::stoi(parts[6].str());
    auto epoch = _mkgmtime64(&utc); if (epoch < 0) throw std::runtime_error("Command deadline before epoch");
    std::string fraction = parts[8].matched ? parts[8].str() : ""; fraction.resize(3, '0');
    return epoch * 1000 + std::stoi(fraction.substr(0, 3));
}
json normalized(json const& lease, std::string const& server, std::string const& boot) {
    if (!lease.is_object() || lease.at("bootId") != boot || lease.at("reply").at("serverId") != server) throw std::runtime_error("Command server or boot mismatch");
    auto const& reply = lease.at("reply");
    if (reply.at("status") != "LEASED" && reply.at("status") != "EXECUTING") throw std::runtime_error("Command is not leased for execution");
    auto text = reply.at("text").get<std::string>(); auto name = reply.at("agentName").get<std::string>();
    if (text.empty() || text.size() > 2048 || name.empty() || name.size() > 256 || text.find_first_of("\r\n\0", 0, 3) != std::string::npos || name.find_first_of("\r\n\0", 0, 3) != std::string::npos) throw std::runtime_error("Invalid command text");
    json immutable = json::object();
    for (char const* key : {"id", "serverId", "requestId", "replyTo", "targetPlayerKey", "agentName", "text", "createdAt", "expiresAt"}) immutable[key] = reply.at(key);
    instant(immutable.at("expiresAt").get<std::string>());
    return {{"leaseId", lease.at("leaseId")}, {"bootId", lease.at("bootId")}, {"reply", immutable}};
}
json outcome(CommandRecord const& record, std::string state, std::string error, std::optional<std::int64_t> sent = {}) {
    return {{"leaseId", record.lease.at("leaseId")}, {"bootId", record.lease.at("bootId")}, {"outcome", state},
        {"sentAt", sent ? json(timestamp(*sent)) : json(nullptr)}, {"errorCode", error.empty() ? json(nullptr) : json(error)}};
}
}
struct Commands::Impl {
    Engine& engine;
    EngineConfig config;
    HttpTransport transport;
    CommandJournal journal;
    std::deque<CommandRecord> results;
    std::optional<CommandRecord> current;
    std::mutex mutex;
    std::condition_variable changed;
    std::optional<CommandRecord> scheduled;
    std::optional<json> completed;
    std::atomic<bool> stopping{false};
    std::thread worker;
    bool failed = false;
    std::string failedOperation;
    unsigned failedStatus = 0;
    Impl(EngineConfig options, Engine& value) : engine(value), config(std::move(options)), transport(config.endpoint, config.token),
        journal(config.dataDirectory.parent_path() / "replies", config.serverId) {
        for (auto record : journal.recover()) {
            if (record.phase == 1) record = journal.finish(record, outcome(record, "UNCERTAIN", "LOCAL_STATE_UNCERTAIN"));
            if (record.phase == 2) results.push_back(std::move(record));
        }
        worker = std::thread([this] { loop(); });
    }
    void note(std::string const& message) { engine.note(message); }
    void acknowledge(CommandRecord const& record, std::string& operation, unsigned& status) {
        auto id = record.lease.at("reply").at("id").get<std::string>();
        auto response = transport.postCommand("/commands/" + id + "/ack", record.result.dump());
        status = response.status;
        if (response.status != 200 || !response.error.empty()) throw std::runtime_error("Command acknowledgement not confirmed");
        auto reply = json::parse(response.body);
        if (reply.at("id") != id || reply.at("serverId") != config.serverId || reply.at("status") != record.result.at("outcome")) throw std::runtime_error("Command acknowledgement identity mismatch");
        operation = "ack-journal"; journal.acknowledge(record);
    }
    void recovered() {
        if (failed) note("Game reply worker recovered after " + failedOperation + " (HTTP " + std::to_string(failedStatus) + "); original receipts preserved, no started messages resent");
        failed = false;
    }
    void collectCompletion() {
        std::optional<json> result;
        { std::lock_guard lock(mutex); if (completed) { result = std::move(completed); completed.reset(); } }
        if (result) {
            if (!current || current->phase != 1) throw std::runtime_error("Execution result without an active durable command");
            try { results.push_back(journal.finish(*current, *result)); current.reset(); }
            catch (...) { std::lock_guard lock(mutex); completed = std::move(result); throw; }
        }
    }
    void loop() noexcept {
        while (true) {
            std::string operation = "completion-journal";
            unsigned status = 0;
            try {
                collectCompletion();
                if (stopping) {
                    if (current && current->phase == 1) journal.finish(*current, outcome(*current, "UNCERTAIN", "LOCAL_STATE_UNCERTAIN"));
                    break;
                }
                if (!results.empty()) {
                    operation = "ack"; acknowledge(results.front(), operation, status);
                    results.pop_front(); recovered(); continue;
                }
                if (current && current->phase == 1) {
                    std::unique_lock lock(mutex); changed.wait_for(lock, 100ms, [this] { return stopping || completed.has_value(); }); continue;
                }
                if (!current) {
                    operation = "claim";
                    auto response = transport.postCommand("/commands/claim", json({{"bootId", engine.bootId()}}).dump());
                    status = response.status;
                    if (response.status != 200 || !response.error.empty()) throw std::runtime_error("Command claim not confirmed");
                    auto leases = json::parse(response.body); if (!leases.is_array() || leases.size() > 1) throw std::runtime_error("Invalid command claim response");
                    if (!leases.empty()) {
                        operation = "prepare-journal";
                        auto record = journal.prepare(normalized(leases.front(), config.serverId, engine.bootId()));
                        if (record.phase == 3) { /* Existing receipt, never send again. */ }
                        else if (record.phase == 2) results.push_back(std::move(record));
                        else if (record.phase == 1) results.push_back(journal.finish(record, outcome(record, "UNCERTAIN", "LOCAL_STATE_UNCERTAIN")));
                        else current = std::move(record);
                    }
                }
                if (current && current->phase == 0) {
                    auto id = current->lease.at("reply").at("id").get<std::string>();
                    operation = "begin";
                    auto response = transport.postCommand("/commands/" + id + "/begin", json({{"bootId", engine.bootId()}, {"leaseId", current->lease.at("leaseId")}}).dump());
                    status = response.status;
                    if (response.status == 409) { current.reset(); }
                    else {
                        if (response.status != 200 || !response.error.empty()) throw std::runtime_error("Command execution not authorized");
                        auto authorization = json::parse(response.body);
                        if (!authorization.at("executionAuthorized").get<bool>() || normalized(authorization.at("lease"), config.serverId, engine.bootId()) != current->lease) throw std::runtime_error("Execution authorization changed command identity");
                        auto deadline = std::min(instant(authorization.at("lease").at("leaseUntil").get<std::string>()), instant(current->lease.at("reply").at("expiresAt").get<std::string>()));
                        operation = "start-journal"; *current = journal.start(*current, deadline);
                        { std::lock_guard lock(mutex); scheduled = *current; }
                    }
                }
                recovered();
            } catch (...) {
                // Never print response bodies, message text or exception snippets.
                if (!failed || operation != failedOperation || status != failedStatus)
                    note("Game reply worker retrying " + operation + " (HTTP " + std::to_string(status) + "); durable command records retained; started messages are never resent");
                failed = true; failedOperation = operation; failedStatus = status;
                if (stopping) break;
            }
            std::unique_lock lock(mutex); changed.wait_for(lock, failed ? 2s : 500ms, [this] { return stopping || completed.has_value(); });
        }
    }
    void stop() { stopping = true; changed.notify_all(); if (worker.joinable()) worker.join(); }
};
Commands::Commands(EngineConfig config, Engine& engine) : impl_(std::make_unique<Impl>(std::move(config), engine)) {}
Commands::~Commands() { stop(); }
void Commands::stop() { if (impl_) impl_->stop(); }
void Commands::tick(std::function<SendOutcome(json const&)> const& execute) {
    std::optional<CommandRecord> record;
    { std::lock_guard lock(impl_->mutex); if (impl_->scheduled) { record = std::move(impl_->scheduled); impl_->scheduled.reset(); } }
    if (!record || impl_->stopping) return;
    json result;
    try {
        if (nowMillis() >= record->executionDeadline) result = outcome(*record, "FAILED", "SEND_FAILED");
        else {
            auto response = execute(record->lease.at("reply"));
            result = outcome(*record, response.outcome, response.errorCode, response.outcome == "DELIVERED" ? std::optional(nowMillis()) : std::nullopt);
        }
    } catch (...) { result = outcome(*record, "UNCERTAIN", "LOCAL_STATE_UNCERTAIN"); }
    { std::lock_guard lock(impl_->mutex); impl_->completed = std::move(result); impl_->changed.notify_all(); }
}
}
