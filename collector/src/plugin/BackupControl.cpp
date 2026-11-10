#include "plugin/RuntimeApi.h"
#include "plugin/BackupControl.h"
#include "core/Platform.h"
#include "core/Engine.h"
#include "ll/api/command/CommandHandle.h"
#include "ll/api/command/CommandRegistrar.h"
#include "ll/api/event/EventBus.h"
#include "ll/api/event/world/ServerLevelTickEvent.h"
#include "ll/api/memory/Hook.h"
#include "ll/api/mod/NativeMod.h"
#include "ll/api/service/TargetedBedrock.h"
#include "mc/server/commands/CommandOrigin.h"
#include "mc/server/commands/CommandOriginType.h"
#include "mc/server/commands/ServerCommandOrigin.h"
#include "mc/server/commands/SaveCommand.h"
#include "mc/server/DedicatedServer.h"
#include "mc/world/level/storage/LevelStorage.h"
#include "mc/world/level/storage/DBStorage.h"
#include "mc/world/level/storage/SnapshotFilenameAndLength.h"
#include "mc/world/actor/player/Player.h"
#include <algorithm>
#include <atomic>
#include <charconv>
#include <chrono>
#include <deque>
#include <filesystem>
#include <mutex>
#include <regex>
#include <Windows.h>
#include <TlHelp32.h>

namespace mcarchive {
struct BackupParameters { std::string action, operationId, requestId, bootId; int offset; };
namespace {
using json = nlohmann::json;
using Clock = std::chrono::steady_clock;
using Parameters = BackupParameters;
struct Control {
    virtual ~Control() = default;
    virtual json request(Parameters const&, Level&) = 0;
    virtual void externalResume(bool succeeded) = 0;
    virtual bool owns(std::string const&) const = 0;
};
std::recursive_mutex controlMutex;
Control* activeControl = nullptr;
thread_local bool managedExecution = false;
// Snapshot work runs on a native worker. Its independent context survives an
// interrupted lease without touching the game-thread controller or taking its
// mutex while the engine drains storage tasks.
struct SnapshotFlush {
    LevelStorage* storage;
    std::atomic<bool> completed{false};
    explicit SnapshotFlush(LevelStorage* value) : storage(value) {}
};
std::atomic<std::shared_ptr<SnapshotFlush>> managedFlush;
bool validId(std::string const& id) {
    static std::regex const pattern("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    return std::regex_match(id, pattern);
}
std::string rootName() { auto value = std::filesystem::canonical(std::filesystem::current_path()).generic_u8string(); return {value.begin(), value.end()}; }

struct CloseProcessHandle {
    void operator()(void* handle) const noexcept { CloseHandle(handle); }
};
using ProcessHandle = std::unique_ptr<void, CloseProcessHandle>;

DWORD parentProcessId() {
    auto snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    ProcessHandle handle(snapshot);
    PROCESSENTRY32W process{};
    process.dwSize = sizeof(process);
    for (BOOL found = Process32FirstW(snapshot, &process); found; found = Process32NextW(snapshot, &process)) {
        if (process.th32ProcessID == GetCurrentProcessId()) return process.th32ParentProcessID;
    }
    return 0;
}

struct SupervisorGuard {
    bool configured = false;
    ProcessHandle process;
    SupervisorGuard() {
        char value[16]{};
        SetLastError(ERROR_SUCCESS);
        auto length = GetEnvironmentVariableA("MCARCHIVE_MANAGED_PARENT_PID", value, sizeof(value));
        if (!length && GetLastError() == ERROR_ENVVAR_NOT_FOUND) return;
        configured = true;
        if (!length || length >= sizeof(value)) return;
        DWORD pid = 0;
        auto [end, error] = std::from_chars(value, value + length, pid);
        if (error != std::errc{} || end != value + length || !pid || pid != parentProcessId()) return;
        ProcessHandle candidate(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
        if (!candidate) return;
        FILETIME parentCreated{}, gameCreated{}, exited{}, kernel{}, user{};
        if (!GetProcessTimes(candidate.get(), &parentCreated, &exited, &kernel, &user) ||
            !GetProcessTimes(GetCurrentProcess(), &gameCreated, &exited, &kernel, &user) ||
            CompareFileTime(&parentCreated, &gameCreated) > 0) return;
        process = std::move(candidate);
    }
    bool alive() const { return process && WaitForSingleObject(process.get(), 0) == WAIT_TIMEOUT; }
};
LL_TYPE_INSTANCE_HOOK(ArchiveSaveResume, ll::memory::HookPriority::Lowest, SaveCommand,
    MCARCHIVE_NATIVE_SYMBOL("?$execute@SaveCommand@@QEBAXAEBVCommandOrigin@@AEAVCommandOutput@@@Z", &SaveCommand::$execute), void, CommandOrigin const& originValue, CommandOutput& output) {
    std::lock_guard lock(controlMutex);
    const bool external = !managedExecution && this->mMode == SaveCommand::Mode::Resume;
    origin(originValue, output);
    if (external && activeControl) activeControl->externalResume(output.mSuccessCount > 0);
}
LL_TYPE_INSTANCE_HOOK(ArchiveSnapshotFlush, ll::memory::HookPriority::Normal, DBStorage,
    &DBStorage::$createSnapshot, std::vector<SnapshotFilenameAndLength>, std::string const& prefix, bool flushWriteCache) {
    auto context = managedFlush.load();
    const bool owned = context && context->storage == static_cast<LevelStorage*>(this);
    auto result = origin(prefix, flushWriteCache || owned);
    if (owned) context->completed.store(true);
    return result;
}
}
struct BackupControl::Impl : Control {
    std::string boot = uuid(), operation, startedAt, snapshotPayload;
    std::function<json()> outboxCheckpoint;
    json collectorCheckpoint;
    std::size_t playerSaveRequests = 0;
    std::shared_ptr<SnapshotFlush> pendingFlush;
    Clock::time_point expires{}, maximum{}, nextRetry{};
    SupervisorGuard supervisor;
    bool stoppingForSupervisor = false;
    Level* level = nullptr;
    std::deque<std::pair<std::string, std::string>> finished;
    ll::event::ListenerPtr listener;
    std::unique_ptr<ll::memory::HookRegistrar<ArchiveSaveResume, ArchiveSnapshotFlush>> hooks;
    explicit Impl(std::function<json()> checkpoint) : outboxCheckpoint(std::move(checkpoint)) {
        std::lock_guard lock(controlMutex);
        if (activeControl) throw std::runtime_error("Backup control already enabled");
        hooks = std::make_unique<ll::memory::HookRegistrar<ArchiveSaveResume, ArchiveSnapshotFlush>>();
        auto& command = ll::command::CommandRegistrar::getServerInstance().getOrCreateCommand(
            "archivebackup", "MCManager managed world snapshot (dedicated console only)", CommandPermissionLevel::Owner);
        command.overload<Parameters>().required("action").required("operationId").required("requestId").required("bootId").required("offset")
            .execute([](CommandOrigin const& origin, CommandOutput& output, Parameters const& params) {
                std::lock_guard guard(controlMutex);
                if (origin.getOriginType() != CommandOriginType::DedicatedServer || !activeControl || !origin.getLevel()) {
                    output.error("MCManager backup control requires the dedicated server console"); return;
                }
                try {
                    auto result = activeControl->request(params, *origin.getLevel());
                    result["leaseOwned"] = activeControl->owns(params.operationId);
                    // Command output translates printf-style placeholders, including
                    // those inside the native query metadata. The private console
                    // protocol must preserve every byte instead.
                    ll::mod::NativeMod::current()->getLogger().info("MCM_ARCHIVE_BACKUP {}", result.dump(-1, ' ', true));
                    output.success("MCManager backup control request handled");
                } catch (...) { output.error("MCManager backup control failed; inspect native save state before retrying"); }
            });
        listener = ll::event::EventBus::getInstance().emplaceListener<ll::event::ServerLevelTickEvent>([this](auto& event) {
            std::lock_guard guard(controlMutex); if (activeControl != this) return; level = &event.level();
            auto now = Clock::now();
            if (supervisor.configured && !supervisor.alive() && !stoppingForSupervisor && now >= nextRetry) {
                nextRetry = now + std::chrono::milliseconds(200);
                if (!release("SUPERVISOR_EXITED")) return;
                auto server = ll::service::getDedicatedServer();
                if (!server) return;
                stoppingForSupervisor = true;
                ll::mod::NativeMod::current()->getLogger().warn("Managed host supervisor unavailable; requesting a normal game shutdown");
                server->requestServerShutdown();
                return;
            }
            if (!operation.empty() && (now >= expires || now >= maximum) && now >= nextRetry) {
                nextRetry = now + std::chrono::milliseconds(200);
                if (release("EXPIRED")) ll::mod::NativeMod::current()->getLogger().warn("Backup lease expired; native snapshot released automatically");
            }
        });
        activeControl = this;
    }
    ~Impl() {
        std::lock_guard guard(controlMutex);
        if (activeControl == this) { activeControl = nullptr; managedFlush.store(nullptr); }
        ll::event::EventBus::getInstance().removeListener(listener); hooks.reset();
    }
    CommandOutput execute(std::string_view text) {
        if (!level) throw std::runtime_error("No game level");
        ServerCommandOrigin origin("MCManager-backup", static_cast<ServerLevel&>(*level), CommandPermissionLevel::Owner, DimensionType{0});
        struct Guard { bool previous = managedExecution; Guard() { managedExecution = true; } ~Guard() { managedExecution = previous; } } guard;
        return ll::command::CommandRegistrar::getServerInstance().executeCommand(text, origin);
    }
    void close(std::string const& reason) {
        managedFlush.store(nullptr); pendingFlush.reset();
        collectorCheckpoint = nullptr;
        finished.emplace_back(operation, reason); if (finished.size() > 32) finished.pop_front(); operation.clear(); startedAt.clear(); snapshotPayload.clear();
    }
    bool owns(std::string const& id) const override { return !operation.empty() && operation == id; }
    bool nativeIdle() {
        auto result = execute("save query");
        return !result.mSuccessCount && result.mMessages.size() == 1 && result.mMessages.front().mMessageId == "commands.save-on.notDone";
    }
    bool release(std::string const& reason) {
        if (operation.empty()) return true;
        if (!nativeIdle() && !execute("save resume").mSuccessCount && !nativeIdle()) return false;
        close(reason); return true;
    }
    void externalResume(bool succeeded) override {
        if (!operation.empty() && succeeded) close("INTERRUPTED_BY_CONSOLE");
    }
    json request(Parameters const& params, Level& currentLevel) override {
        level = &currentLevel;
        json result = {{"protocol", 1}, {"requestId", params.requestId}, {"operationId", params.operationId}, {"bootId", boot},
            {"root", rootName()}, {"phase", "INVALID_REQUEST"}};
        if (!validId(params.operationId) || !validId(params.requestId) || params.offset < 0 || params.offset > 16777216) return result;
        if (params.action == "status") {
            result["supervisorGuard"] = supervisor.configured && supervisor.alive();
            result["phase"] = operation.empty() ? "IDLE" : "OWNED"; result["activeOperationId"] = operation.empty() ? json(nullptr) : json(operation);
            result["nativeQuerySuccess"] = nullptr; result["nativeMessageIds"] = json::array();
            if (operation.empty()) { auto diagnostic = execute("save query"); result["nativeQuerySuccess"] = diagnostic.mSuccessCount;
                for (auto const& message : diagnostic.mMessages) result["nativeMessageIds"].push_back(message.mMessageId); }
            return result;
        }
        if (params.bootId != boot) { result["phase"] = "WRONG_BOOT"; return result; }
        auto previous = std::find_if(finished.begin(), finished.end(), [&](auto const& row) { return row.first == params.operationId; });
        if (previous != finished.end()) { result["phase"] = previous->second; return result; }
        if (params.action == "begin") {
            if (!operation.empty() && operation != params.operationId) { result["phase"] = "BUSY"; return result; }
            if (operation.empty()) {
                if (!nativeIdle()) { result["phase"] = "UNOWNED_NATIVE_SNAPSHOT"; return result; }
                // Snapshot creation pins persisted database state. Request the
                // game's regular save lifecycle and flush pending storage writes
                // before pinning it, including newly initialized players.
                level->save();
                level->saveGameData();
                playerSaveRequests = 0;
                level->forEachPlayer([&](Player& player) {
                    if (player.isPlayerInitialized()) { level->getLevelStorage().save(player); ++playerSaveRequests; }
                    return true;
                });
                level->getLevelStorage().flushToPermanentStorage();
                operation = params.operationId; startedAt = timestamp(nowMillis()); maximum = Clock::now() + std::chrono::minutes(15); expires = Clock::now() + std::chrono::seconds(10);
                pendingFlush = std::make_shared<SnapshotFlush>(&level->getLevelStorage());
                managedFlush.store(pendingFlush);
                auto output = execute("save hold");
                if (!output.mSuccessCount) { release("HOLD_FAILED"); result["phase"] = "HOLD_FAILED"; return result; }
            }
        } else if (params.operationId != operation) { result["phase"] = "LEASE_MISMATCH"; return result; }
        if (params.action == "release") {
            result["phase"] = release("RELEASED") ? "RELEASED" : "RELEASING"; return result;
        }
        if (params.action != "begin" && params.action != "query") return result;
        expires = Clock::now() + std::chrono::seconds(10); result["leaseMillis"] = 10000; result["snapshotStartedAt"] = startedAt;
        result["playerSaveRequests"] = playerSaveRequests;
        if (snapshotPayload.empty()) {
            auto output = execute("save query"); json messages = json::array();
            if (!output.mSuccessCount) { result["phase"] = "PREPARING"; return result; }
            if (!pendingFlush || !pendingFlush->completed.load()) { result["phase"] = "UNFLUSHED_SNAPSHOT"; return result; }
            for (auto const& message : output.mMessages) messages.push_back({{"id", message.mMessageId}, {"params", message.mParams}});
            try { collectorCheckpoint = outboxCheckpoint(); }
            catch (...) { result["phase"] = "COLLECTOR_CHECKPOINT_FAILED"; return result; }
            snapshotPayload = messages.dump(-1, ' ', true);
            if (snapshotPayload.size() > 16777216) { snapshotPayload.clear(); result["phase"] = "INVALID_FILE_LIST"; return result; }
        }
        result["phase"] = "READY";
        result["nativeWriteCacheFlushed"] = true;
        if (!collectorCheckpoint.is_null()) result["collectorCheckpoint"] = collectorCheckpoint;
        {
            if (static_cast<std::size_t>(params.offset) > snapshotPayload.size()) { result["phase"] = "INVALID_OFFSET"; return result; }
            auto end = std::min(snapshotPayload.size(), static_cast<std::size_t>(params.offset) + 2048);
            result["payloadBytes"] = snapshotPayload.size();
            result["payloadChunk"] = snapshotPayload.substr(params.offset, end - params.offset);
            result["nextOffset"] = end < snapshotPayload.size() ? json(end) : json(nullptr);
        }
        return result;
    }
};
BackupControl::BackupControl(std::function<nlohmann::json()> outboxCheckpoint)
    : impl_(std::make_unique<Impl>(std::move(outboxCheckpoint))) {}
BackupControl::~BackupControl() = default;
bool BackupControl::releaseAndStop() { std::lock_guard guard(controlMutex); return impl_->release("PLUGIN_DISABLED"); }
}
