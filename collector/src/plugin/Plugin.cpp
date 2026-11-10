#include "ll/api/Versions.h"
#include "ll/api/mod/NativeMod.h"
#include "ll/api/mod/RegisterHelper.h"
#include "core/Engine.h"
#include "core/Commands.h"
#include "core/Platform.h"
#include "core/Transport.h"
#include "plugin/GameTracker.h"
#include "plugin/BasicBehavior.h"
#include "plugin/LevelObserver.h"
#include "plugin/ActionTracker.h"
#include "plugin/ItemBehavior.h"
#include "plugin/KillTracker.h"
#include "plugin/BreedTracker.h"
#include "plugin/CraftTracker.h"
#include "plugin/FishingTracker.h"
#include "plugin/MovementTracker.h"
#include "plugin/BackupControl.h"
#include "plugin/QqBinding.h"
#include "plugin/GameAi.h"
#include "plugin/ProjectCommands.h"
#include "plugin/ProjectModels.h"
#include "plugin/WorldState.h"
#include "plugin/ContainerAuditTracker.h"
#include "mc/world/level/Level.h"
#include "mc/world/actor/player/Player.h"
#include <filesystem>
#include <optional>
#include <string_view>
#if defined(MCARCHIVE_BDS_12661)
#include <Windows.h>
#endif

namespace archive_collector {
class Plugin {
    std::optional<mcarchive::EngineConfig> config;
    std::unique_ptr<mcarchive::Engine> engine;
    std::unique_ptr<mcarchive::GameTracker> tracker;
    std::unique_ptr<mcarchive::Commands> commands;
    std::unique_ptr<mcarchive::BasicBehavior> behavior;
    std::unique_ptr<mcarchive::LevelObserver> levels;
    std::unique_ptr<mcarchive::ActionTracker> actions;
    std::unique_ptr<mcarchive::ItemBehavior> items;
    std::unique_ptr<mcarchive::PetOwnerPersistence> petOwners;
    std::unique_ptr<mcarchive::KillTracker> kills;
    std::unique_ptr<mcarchive::BreedTracker> breeding;
    std::unique_ptr<mcarchive::CraftTracker> crafting;
    std::unique_ptr<mcarchive::FishingTracker> fishing;
    std::unique_ptr<mcarchive::MovementTracker> movement;
    std::unique_ptr<mcarchive::BackupControl> backups;
    std::unique_ptr<mcarchive::QqBinding> qqBinding;
    bool gameAiEnabled = false;
    std::unique_ptr<mcarchive::GameAi> gameAi;
    std::unique_ptr<mcarchive::ProjectCommands> projects;
    std::unique_ptr<mcarchive::ProjectModels> projectModels;
    std::unique_ptr<mcarchive::WorldState> worldState;
    std::unique_ptr<mcarchive::ContainerAuditTracker> containerAudit;
public:
    static Plugin& instance() { static Plugin plugin; return plugin; }
    bool load() {
        auto self = ll::mod::NativeMod::current();
        const auto loader = ll::getLoaderVersion();
        const auto game = ll::getGameVersion();
#if defined(MCARCHIVE_BDS_12661)
        auto adapter = GetModuleHandleW(L"archive-runtime-compat.dll");
        using CompatTarget = char const* (__cdecl*)() noexcept;
        auto query = adapter ? reinterpret_cast<CompatTarget>(GetProcAddress(adapter, "mcarchive_runtime_compat_target")) : nullptr;
        auto validatedTarget = query ? query() : nullptr;
        if (loader.major != 26 || loader.minor != 60 || loader.patch != 2
            || game.major != 1 || game.minor != 26 || game.patch != 61 || ll::isClient()
            || !validatedTarget || std::string_view(validatedTarget) != "1.26.61.1/26.60.2") {
            self->getLogger().error("Unsupported runtime: BDS {} / LeviLamina {}; requires exact BDS 1.26.61.1 / LeviLamina 26.60.2 with verified archive-runtime-compat", game.to_string(), loader.to_string());
            return false;
        }
#else
        if (loader.major != 26 || loader.minor != 51 || loader.patch != 8
            || game.major != 1 || game.minor != 26 || game.patch != 51 || ll::isClient()) {
            self->getLogger().error("Unsupported runtime: BDS {} / LeviLamina {}; requires BDS 1.26.51 / LeviLamina 26.51.8 server", game.to_string(), loader.to_string());
            return false;
        }
#endif
        auto const& version=self->getManifest().version;
        self->getLogger().info("Archive collector {} runtime linkage verified: BDS {} / LeviLamina {}",version?version->to_string():"unknown",game.to_string(),loader.to_string());
        try {
            auto directory = self->getConfigDir(); std::filesystem::create_directories(directory);
            auto file = directory / "config.json";
            if (!std::filesystem::exists(file)) mcarchive::atomicWrite(file, nlohmann::json({{"enabled", false}, {"serverId", ""}, {"token", ""}, {"endpoint", "http://127.0.0.1:8080/api/ingest/v1/batches"}, {"activityIdleSeconds", mcarchive::defaultIdleSeconds}}).dump(2));
            auto settings = nlohmann::json::parse(mcarchive::boundedRead(file, 16384));
            if (!settings.is_object()) throw std::runtime_error("Invalid configuration");
            for (auto const& item : settings.items()) if (item.key() != "enabled" && item.key() != "serverId" && item.key() != "token" && item.key() != "endpoint" && item.key() != "activityIdleSeconds" && item.key() != "mapEnabled" && item.key() != "gameAiEnabled") throw std::runtime_error("Unknown configuration field");
            gameAiEnabled = settings.value("gameAiEnabled", false);
            if(settings.value("mapEnabled",false)) self->getLogger().warn("Native map capture was replaced by original MipMap; configure the EndstoneRuntime plugin instead");
            int idleSeconds = mcarchive::defaultIdleSeconds;
            if (auto value = settings.find("activityIdleSeconds"); value != settings.end()) {
                if (!value->is_number_integer()) throw std::runtime_error("Activity idle threshold must be an integer");
                auto seconds = value->get<std::int64_t>();
                if (seconds < mcarchive::minIdleSeconds || seconds > mcarchive::maxIdleSeconds)
                    throw std::runtime_error("Activity idle threshold is outside the supported range");
                idleSeconds = static_cast<int>(seconds);
            }
            if (!settings.at("enabled").get<bool>()) {
                self->getLogger().warn("Collector is disabled; assign this archive's credential and enable config.json to collect player events");
                return true;
            }
            config = mcarchive::EngineConfig{settings.at("serverId").get<std::string>(), settings.at("token").get<std::string>(), settings.at("endpoint").get<std::string>(), self->getDataDir() / "outbox", idleSeconds};
            mcarchive::HttpTransport validate(config->endpoint, config->token);
            if (config->serverId != config->token.substr(0, 36)) throw std::runtime_error("Archive identity mismatch");
            petOwners = std::make_unique<mcarchive::PetOwnerPersistence>(config->serverId);
        } catch (...) { self->getLogger().error("Collector configuration is invalid; no uploads started. Check enabled, serverId, token, endpoint and activityIdleSeconds (30–3600)"); return false; }
        return true;
    }
    bool enable() {
        try {
            backups = std::make_unique<mcarchive::BackupControl>([this]() -> nlohmann::json {
                return engine ? engine->backupOutboxCheckpoint() : nlohmann::json(nullptr);
            });
        }
        catch (...) { ll::mod::NativeMod::current()->getLogger().error("Backup control could not start"); return false; }
        ll::mod::NativeMod::current()->getLogger().info("Console-only managed backup leases enabled");
        if (!config) return true;
        auto& logger = ll::mod::NativeMod::current()->getLogger();
        try {
            engine = std::make_unique<mcarchive::Engine>(*config, [&logger](auto const& message) { logger.warn("{}", message); });
            commands = std::make_unique<mcarchive::Commands>(*config, *engine);
            qqBinding = std::make_unique<mcarchive::QqBinding>(*config);
            if (gameAiEnabled) gameAi = std::make_unique<mcarchive::GameAi>(*config);
            projects = std::make_unique<mcarchive::ProjectCommands>(*config);
            projectModels = std::make_unique<mcarchive::ProjectModels>(*config,*engine);
            worldState = std::make_unique<mcarchive::WorldState>(*config,*engine);
            containerAudit = std::make_unique<mcarchive::ContainerAuditTracker>(*engine);
            behavior = std::make_unique<mcarchive::BasicBehavior>(*engine);
            levels = std::make_unique<mcarchive::LevelObserver>(*engine);
            actions = std::make_unique<mcarchive::ActionTracker>(*engine);
            items = std::make_unique<mcarchive::ItemBehavior>(*engine);
            kills = std::make_unique<mcarchive::KillTracker>(*engine);
            breeding = std::make_unique<mcarchive::BreedTracker>(*engine);
            crafting = std::make_unique<mcarchive::CraftTracker>(*engine);
            fishing = std::make_unique<mcarchive::FishingTracker>(*engine);
            movement = std::make_unique<mcarchive::MovementTracker>(*engine, config->activityIdleSeconds);
            tracker = std::make_unique<mcarchive::GameTracker>(*engine, [this](Level& level) {
                behavior->tick();
                levels->tick(level);
                actions->tick(level);
                items->tick();
                kills->tick(level);
                breeding->tick(level);
                crafting->tick();
                fishing->tick();
                movement->tick(level);
                commands->tick([&level](nlohmann::json const& reply) -> mcarchive::SendOutcome {
                    std::string text = "[" + reply.at("agentName").get<std::string>() + "] " + reply.at("text").get<std::string>();
                    auto target = reply.at("targetPlayerKey"); std::size_t sent = 0;
                    try {
                        level.forEachPlayer([&](Player& player) {
                            if (player.isPlayerInitialized() && (target.is_null() || mcarchive::stablePlayerKey(player) == target.get<std::string>())) { player.sendMessage(text); sent++; }
                            return true;
                        });
                    } catch (...) { return sent ? mcarchive::SendOutcome{"UNCERTAIN", "LOCAL_STATE_UNCERTAIN"} : mcarchive::SendOutcome{"FAILED", "SEND_FAILED"}; }
                    return sent ? mcarchive::SendOutcome{"DELIVERED", {}} : mcarchive::SendOutcome{"FAILED", "PLAYER_OFFLINE"};
                });
                qqBinding->tick(level);
                if (gameAi) gameAi->tick(level);
                projects->tick(level);
                worldState->tick(level);
                projectModels->tick(level);
                containerAudit->tick(level);
            });
            logger.info("Player session checkpoints and confirmed public chat capture enabled; durable writer and HTTP sender run off the game thread");
#if defined(MCARCHIVE_BDS_12661)
            logger.info("Container audit enabled: committed player slot changes, observed open screens, confirmed placement/breaking; non-player changes sampled only while viewed and never assigned to viewers");
#endif
            logger.info("Agent reply journal and game-thread text execution enabled");
            logger.info("Post-execution block, experience and player death capture enabled");
            logger.info("Observed maximum level capture enabled; pre-enable history is unavailable");
            logger.info("Jump/swing events and confirmed sneak/sprint state intervals enabled");
            logger.info("Committed item pickups, use requests and confirmed uses enabled; operation counts are not item consumption quantities");
            logger.info("Confirmed mob/player kills enabled; explicit sources, pet ownership and tracked ignition only; unknown environmental deaths are not assigned to the last attacker");
            logger.info("Confirmed native breeding offspring enabled; both parents must resolve to the same player; feeding alone is not a birth");
            logger.info("Player inventory/workbench crafting enabled; recipe counts and output quantities require successful final inventory commit");
            logger.info("Vanilla villager-class trades enabled; native trade result and final inventory commit must both succeed");
            logger.info("Native fishing retrievals, item pulls and newly spawned catches enabled; operation counts and item quantities are separate");
            logger.info("Movement estimates and active time enabled; activity idle threshold {} seconds", config->activityIdleSeconds);
            return true;
        } catch (...) { tracker.reset(); containerAudit.reset(); movement.reset(); fishing.reset(); crafting.reset(); breeding.reset(); kills.reset(); items.reset(); actions.reset(); levels.reset(); behavior.reset(); commands.reset(); gameAi.reset(); qqBinding.reset(); projects.reset(); projectModels.reset(); worldState.reset(); engine.reset(); backups.reset(); logger.error("Collector could not start; cache files preserved. Check archive ownership, storage and runtime hooks"); return false; }
    }
    bool disable() {
        if (backups && !backups->releaseAndStop()) return false;
        backups.reset();
        tracker.reset();
        gameAi.reset();
        containerAudit.reset();
        qqBinding.reset(); projects.reset(); projectModels.reset();
        worldState.reset();
        movement.reset();
        fishing.reset();
        crafting.reset();
        breeding.reset();
        kills.reset();
        items.reset();
        actions.reset();
        levels.reset();
        behavior.reset();
        commands.reset();
        if (engine) {
            engine->stop(); auto status = engine->status();
            ll::mod::NativeMod::current()->getLogger().info("Collector stopped: {} durable pending events, {} unpersisted events, {} rejected submissions", status.pendingEvents, status.queuedEvents, status.rejectedEvents);
            engine.reset();
        }
        return true;
    }
    bool unload() {
        if (!disable()) return false;
        petOwners.reset();
        return true;
    }
};
}
LL_REGISTER_MOD(archive_collector::Plugin, archive_collector::Plugin::instance());
