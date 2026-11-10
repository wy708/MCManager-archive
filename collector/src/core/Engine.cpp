#include "core/RuntimeProfile.h"
#include "core/Engine.h"
#include "core/Outbox.h"
#include "core/Platform.h"
#include "core/Transport.h"
#include "core/RuntimeMonitor.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <ctime>
#include <deque>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <thread>

namespace mcarchive {
using json = nlohmann::json;
using namespace std::chrono_literals;
std::int64_t nowMillis() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
std::string timestamp(std::int64_t millis) {
    auto seconds = static_cast<std::time_t>(millis / 1000); std::tm utc{};
    if (millis < 0 || gmtime_s(&utc, &seconds) != 0) throw std::runtime_error("Invalid event time");
    std::ostringstream out; out << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.' << std::setw(3) << std::setfill('0') << millis % 1000 << 'Z'; return out.str();
}
struct Engine::Impl {
    EngineConfig config;
    Log log;
    std::string boot = uuid();
    Outbox outbox;
    HttpTransport transport;
    mutable std::mutex mutex;
    std::mutex spoolAccounting;
    std::condition_variable changed;
    std::deque<json> events;
    std::atomic<std::size_t> pending{0}, captureGaps{0};
    std::size_t rejected = 0, diskFaults = 0, diagnosticSequence = 0;
    std::atomic<EventObserver> observer{nullptr};
    std::atomic<bool> stopping{false};
    bool diskError = false;
    std::thread writer, sender;
    RuntimeMonitor runtimeMonitor;
    json runtimeSample=nullptr;
    Impl(EngineConfig options, Log logger) : config(std::move(options)), log(std::move(logger)), outbox(config.dataDirectory, config.serverId), transport(config.endpoint, config.token) {
        if (config.token.substr(0, 36) != config.serverId) throw std::runtime_error("Collector credential belongs to another server archive");
        pending = outbox.pendingEvents();
        writer = std::thread([this] { writeLoop(); });
        try { sender = std::thread([this] { sendLoop(); }); }
        catch (...) { stop(false); throw; }
    }
    void report(std::string const& message) noexcept { try { if (log) log(message); } catch (...) {} }
    json diagnostics(bool final) {
        std::lock_guard lock(mutex);
        return {{"sequence", ++diagnosticSequence}, {"queuedEvents", events.size()}, {"rejectedSubmissions", rejected},
                {"captureGaps", captureGaps.load()}, {"diskError", diskError}, {"diskFaults", diskFaults}, {"final", final}};
    }
    json batch(json batchEvents, bool final = false) {
        json caps = json::array();
        for (char const* key : {"chat.messages", "chat.contents", "deaths", "experience.gained"})
            caps.push_back({{"metric", key}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-v1"}, {"dimensionAware", true}});
        caps.push_back({{"metric", "online.millis"}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-dimension-v2"}, {"dimensionAware", true}});
        caps.push_back({{"metric", "dimension.visits"}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-dimension-v3"}, {"dimensionAware", true}});
        caps.push_back({{"metric", "level.max"}, {"state", "ACTIVE"}, {"quality", "OBSERVED"}, {"algorithmVersion", "native-level-observed-v1"}, {"dimensionAware", true}});
        caps.push_back({{"metric", "blocks.placed"}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-placement-v2"}, {"dimensionAware", true}});
        caps.push_back({{"metric", "blocks.mined"}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-mining-v2"}, {"dimensionAware", true}});
        for (char const* key : {"crops.planted", "crops.harvested", "crops.interacted"})
            caps.push_back({{"metric", key}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-crop-state-v1"}, {"dimensionAware", true}});
        for (char const* key : {"kills.mobs", "kills.players"})
            caps.push_back({{"metric", key}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-kill-source-v3"}, {"dimensionAware", true}});
        caps.push_back({{"metric","breeding.offspring"},{"state","ACTIVE"},{"quality","EXACT"},{"algorithmVersion","native-breeding-result-v1"},{"dimensionAware",true}});
        for (char const* key : {"crafting.crafts", "crafting.items"})
            caps.push_back({{"metric", key}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", runtime::craftingAlgorithm}, {"dimensionAware", true}});
        for (char const* key : {"villager.trades", "villager.items"})
            caps.push_back({{"metric", key}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", runtime::tradeAlgorithm}, {"dimensionAware", true}});
        for (char const* key : {"fishing.retrievals", "fishing.item_pull_events", "fishing.items_pulled", "fishing.catch_events", "fishing.catches"})
            caps.push_back({{"metric", key}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-fishing-result-v1"}, {"dimensionAware", true}});
        caps.push_back({{"metric", "items.picked_up"}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-item-inventory-v1"}, {"dimensionAware", true}});
        caps.push_back({{"metric", "items.use_requests"}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-item-request-v1"}, {"dimensionAware", true}});
        caps.push_back({{"metric", "items.used"}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-item-confirmed-v2"}, {"dimensionAware", true}});
        for (char const* key : {"actions.jumps", "actions.swings", "actions.sneak_starts", "actions.sneak_millis", "actions.sprint_starts", "actions.sprint_millis"})
            caps.push_back({{"metric", key}, {"state", "ACTIVE"}, {"quality", "EXACT"}, {"algorithmVersion", "native-action-state-v1"}, {"dimensionAware", true}});
        for (char const* key : travelMetrics)
            caps.push_back({{"metric", key}, {"state", "ACTIVE"}, {"quality", "ESTIMATED"}, {"algorithmVersion", travelAlgorithm}, {"dimensionAware", true}});
        caps.push_back({{"metric", "activity.millis"}, {"state", "ACTIVE"}, {"quality", "ESTIMATED"},
            {"algorithmVersion", "native-activity-idle-" + std::to_string(config.activityIdleSeconds) + "s-v1"}, {"dimensionAware", true}});
        std::string reported = timestamp(nowMillis());
        for (auto const& event : batchEvents) reported = std::max(reported, event.at("at").get<std::string>());
        json sample;{std::lock_guard lock(mutex);sample=runtimeSample;}
        return {{"protocolVersion", 1}, {"batchId", uuid()}, {"reportedAt", reported}, {"collector", {
            {"version", "0.37.0"}, {"runtime",std::move(sample)}, {"bdsVersion", runtime::bdsVersion}, {"leviLaminaVersion", runtime::loaderVersion}, {"bootId", boot},
            {"pendingEvents", pending.load()}, {"diagnostics", diagnostics(final)}}},
            {"capabilities", std::move(caps)}, {"events", std::move(batchEvents)}};
    }
    void writeLoop() noexcept {
        while (true) {
            json selected = json::array();
            {
                std::unique_lock lock(mutex);
                changed.wait(lock, [this] { return stopping || !events.empty(); });
                if (events.empty() && stopping) break;
                for (std::size_t i = 0; i < std::min<std::size_t>(events.size(), 64); ++i) selected.push_back(events[i]);
            }
            try {
                std::size_t count = selected.size();
                {
                    std::lock_guard accounting(spoolAccounting);
                    // Container audits carry slot details. Keep each durable HTTP
                    // batch below the backend's 1 MiB limit without dropping events.
                    auto payload = batch(selected).dump();
                    while (payload.size() > 1'048'576 && selected.size() > 1) {
                        selected.erase(selected.begin() + selected.size() / 2, selected.end());
                        payload = batch(selected).dump();
                    }
                    if (payload.size() > 1'048'576) throw std::runtime_error("Single event exceeds ingestion limit");
                    count = selected.size();
                    outbox.append(payload);
                    pending.fetch_add(count);
                }
                {
                    std::lock_guard lock(mutex);
                    for (std::size_t i = 0; i < count; ++i) events.pop_front();
                    diskError = false;
                }
                changed.notify_all();
            } catch (std::exception const&) {
                bool firstFailure;
                {
                    std::lock_guard lock(mutex);
                    firstFailure = !diskError;
                    diskError = true;
                    if (firstFailure) ++diskFaults;
                }
                if (firstFailure) report("Collector disk persistence failed; queued events retained in memory, durable outbox untouched");
                if (stopping) { report("Collector stopping with unpersisted events; inspect storage before restarting"); break; }
                std::unique_lock lock(mutex); changed.wait_for(lock, 1s, [this] { return stopping.load(); });
            }
        }
    }
    void sendLoop() noexcept {
        unsigned previousStatus = 0; bool failed = false;
        auto heartbeatDue = std::chrono::steady_clock::now();
        bool heartbeatFailed = false;
        auto bulkRetryAt = std::chrono::steady_clock::time_point::min();
        while (!stopping) {
            if (std::chrono::steady_clock::now() >= heartbeatDue) {
                // A fresh status snapshot can bypass the event queue without taking a FIFO slot.
                try {
                    {auto sample=runtimeMonitor.sample();std::lock_guard lock(mutex);runtimeSample=std::move(sample);}
                    auto payload = batch(json::array());
                    PendingBatch heartbeat{{}, payload.dump(), payload.at("batchId").get<std::string>(), 0, config.serverId};
                    auto receipt = transport.deliver(heartbeat);
                    if (!receipt.confirmed && !heartbeatFailed)
                        report("Collector heartbeat not confirmed (HTTP " + std::to_string(receipt.status) + "); player events use the durable queue");
                    if (receipt.confirmed && heartbeatFailed) report("Collector heartbeat restored");
                    heartbeatFailed = !receipt.confirmed;
                } catch (std::exception const&) {
                    if (!heartbeatFailed) report("Collector heartbeat failed; player events use the durable queue");
                    heartbeatFailed = true;
                }
                heartbeatDue = std::chrono::steady_clock::now() + 10s;
            }
            if (stopping) break;
            try {
                std::vector<PendingBatch> window;
                { std::lock_guard accounting(spoolAccounting); window = outbox.frontWindow(std::chrono::steady_clock::now() >= bulkRetryAt ? 16 : 1); }
                if (!window.empty()) {
                    auto receipt = transport.deliverMany(window);
                    if (!receipt.confirmed && window.size() > 1) {
                        // Older platforms, partial commits or one invalid later batch must
                        // not prevent the original FIFO head from making progress.
                        bulkRetryAt = std::chrono::steady_clock::now() + (receipt.status == 404 || receipt.status == 405 ? 5min : 30s);
                        window.resize(1);
                        receipt = transport.deliver(window.front());
                    }
                    if (receipt.confirmed) {
                        { std::lock_guard accounting(spoolAccounting);
                            for (auto const& batch : window) {
                                outbox.acknowledge(batch);
                                pending = pending.load() >= batch.eventCount ? pending.load() - batch.eventCount : 0;
                            }
                        }
                        if (failed) report("Collector connection restored; confirmed original batches continue in order");
                        failed = false; continue;
                    }
                    if (!failed || previousStatus != receipt.status) report("Collector upload not confirmed (HTTP " + std::to_string(receipt.status) + "); original bytes retained for retry");
                    previousStatus = receipt.status; failed = true;
                }
            } catch (std::exception const&) { if (!failed) report("Collector sender failed; durable files retained for retry"); failed = true; }
            std::unique_lock lock(mutex); changed.wait_for(lock, failed ? 2s : 100ms, [this] { return stopping.load(); });
        }
    }
    void stop(bool persistDiagnostics = true) {
        if (!writer.joinable()) return;
        {
            std::lock_guard lock(mutex);
            stopping = true;
        }
        changed.notify_all();
        writer.join();
        if (sender.joinable()) sender.join();
        // Keep the last known anomaly through a clean restart, even if no
        // heartbeat reached the central service while this boot was running.
        if (persistDiagnostics && !diskError) {
            {auto sample=runtimeMonitor.sample(true);std::lock_guard lock(mutex);runtimeSample=std::move(sample);}
            try { outbox.append(batch(json::array(), true).dump()); }
            catch (...) { report("Collector final diagnostics could not be persisted"); }
        }
    }
};
Engine::Engine(EngineConfig config, Log log) : impl_(std::make_unique<Impl>(std::move(config), std::move(log))) {}
Engine::~Engine() { stop(); }
void Engine::observeTick(int onlinePlayers) noexcept { impl_->runtimeMonitor.tick(onlinePlayers); }
bool Engine::submit(json event) {
    return submitEvents(json::array({std::move(event)}));
}
bool Engine::submitEvents(json group) {
    if (!group.is_array() || group.empty() || group.size() > 32768) throw std::runtime_error("Invalid collector event group");
    // Observe live publications before taking the queue lock. Native timestamps
    // let the observer ignore repeated submissions and delayed source events.
    if (auto observer = impl_->observer.load())
        for (auto const& event : group) observer(event);
    std::lock_guard lock(impl_->mutex);
    if (impl_->stopping || impl_->events.size() > 32768 - group.size()) { impl_->rejected += group.size(); return false; }
    auto originalSize = impl_->events.size();
    try { for (auto& event : group) impl_->events.push_back(std::move(event)); }
    catch (...) { while (impl_->events.size() > originalSize) impl_->events.pop_back(); throw; }
    impl_->changed.notify_all(); return true;
}
void Engine::setEventObserver(EventObserver observer) noexcept { impl_->observer.store(observer); }
void Engine::recordCaptureGap(std::size_t count) noexcept { impl_->captureGaps.fetch_add(count); }
void Engine::stop() { if (impl_) impl_->stop(); }
EngineStatus Engine::status() const { std::lock_guard lock(impl_->mutex); return {impl_->events.size(), impl_->pending.load(), impl_->rejected, impl_->diskError}; }
nlohmann::json Engine::backupOutboxCheckpoint() const { return impl_->outbox.backupCheckpoint(); }
std::string const& Engine::bootId() const { return impl_->boot; }
void Engine::note(std::string const& message) const { impl_->report(message); }
}
