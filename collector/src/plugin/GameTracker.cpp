#include "plugin/RuntimeApi.h"
#include "plugin/GameTracker.h"
#include "core/Platform.h"
#include "ll/api/event/EventBus.h"
#include "ll/api/event/player/PlayerChatEvent.h"
#include "ll/api/event/player/PlayerDisconnectEvent.h"
#include "ll/api/event/player/PlayerJoinEvent.h"
#include "ll/api/event/world/ServerLevelTickEvent.h"
#include "ll/api/memory/Hook.h"
#include "mc/network/LoopbackPacketSender.h"
#include "mc/network/packet/TextPacket.h"
#include "mc/platform/UUID.h"
#include "mc/world/actor/player/Player.h"
#include "mc/world/level/PlayerDimensionTransferManager.h"
#include "mc/world/level/IPlayerDimensionTransferer.h"
#include "mc/legacy/ActorUniqueID.h"
#include "mc/network/NetworkIdentifierWithSubId.h"
#include <algorithm>
#include <cctype>
#include <deque>
#include <map>
#include <mutex>
#include <optional>
#include <regex>
#include <set>
#include <shared_mutex>

namespace mcarchive {
namespace {
using json = nlohmann::json;
struct Person { json identity; std::string key, name, xuid, dimension; };
bool sameConnection(NetworkIdentifierWithSubId const& a, NetworkIdentifierWithSubId const& b) {
    return a.id == b.id && a.subClientId == b.subClientId;
}
NetworkIdentifierWithSubId connectionOf(Player const& player) {
    return {player.getNetworkIdentifier(), player.getClientSubId()};
}
std::string dimensionName(int id) {
    switch (id) {
        case 0: return "minecraft:overworld";
        case 1: return "minecraft:nether";
        case 2: return "minecraft:the_end";
        default: return "bedrock:dimension_" + std::to_string(id);
    }
}
std::string plainAuthor(std::string const& author) {
    std::string result;
    for (std::size_t i = 0; i < author.size(); ++i) {
        if (i + 2 < author.size() && static_cast<unsigned char>(author[i]) == 0xc2 && static_cast<unsigned char>(author[i + 1]) == 0xa7
            && std::isalnum(static_cast<unsigned char>(author[i + 2]))) { i += 2; continue; }
        result.push_back(author[i]);
    }
    return result;
}
Person person(Player const& player) {
    Person result; result.name = player.getRealName(); result.xuid = player.getXuid();
    static std::regex const xuidPattern("[1-9][0-9]{0,19}");
    const bool xuid = std::regex_match(result.xuid, xuidPattern);
    std::string id = xuid ? result.xuid : player.getUuid().asString();
    std::transform(id.begin(), id.end(), id.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    result.identity = {{"identityType", xuid ? "XUID" : "UUID"}, {"identity", id}, {"name", result.name}};
    result.key = (xuid ? "xuid:" : "uuid:") + id;
    result.dimension = dimensionName(static_cast<int>(player.getDimensionId()));
    return result;
}
struct Capture {
    virtual void broadcast(Packet const&) = 0;
    virtual void dimensionChanged(Player&) = 0;
    virtual ~Capture() = default;
};
std::shared_mutex lifetime;
Capture* active = nullptr;
void capture(Packet const& packet) noexcept {
    try {
        if (packet.getId() != MinecraftPacketIds::Text) return;
        auto const& text = static_cast<TextPacket const&>(packet);
        auto body = std::get_if<TextPacketPayload::AuthorAndMessage>(&text.mBody.get());
        if (!body || body->mType != TextPacketType::Chat) return;
        std::shared_lock guard(lifetime); if (active) active->broadcast(packet);
    } catch (...) {}
}
LL_TYPE_INSTANCE_HOOK(ArchiveBroadcast, ll::memory::HookPriority::Lowest, LoopbackPacketSender,
    static_cast<void (LoopbackPacketSender::*)(Packet const&)>(&LoopbackPacketSender::$sendBroadcast), void, Packet const& packet) {
    origin(packet); capture(packet);
}
LL_TYPE_INSTANCE_HOOK(ArchiveBroadcastExcept, ll::memory::HookPriority::Lowest, LoopbackPacketSender,
    MCARCHIVE_NATIVE_SYMBOL("?$sendBroadcast@LoopbackPacketSender@@QEAAXAEBVNetworkIdentifier@@W4SubClientId@@AEBVPacket@@@Z", static_cast<void (LoopbackPacketSender::*)(NetworkIdentifier const&, SubClientId, Packet const&)>(&LoopbackPacketSender::$sendBroadcast)),
    void, NetworkIdentifier const& except, SubClientId subId, Packet const& packet) {
    origin(except, subId, packet); capture(packet);
}
LL_TYPE_INSTANCE_HOOK(ArchiveSendToClients, ll::memory::HookPriority::Lowest, LoopbackPacketSender,
    &LoopbackPacketSender::$sendToClients, void, std::vector<NetworkIdentifierWithSubId> const& ids, Packet const& packet) {
    origin(ids, packet); capture(packet);
}
}
struct GameTracker::Impl : Capture {
    struct Change { Person person; std::int64_t at; };
    struct Session { Person person; std::string id; std::int64_t started, checkpoint; std::uint64_t sequence = 0; std::deque<Change> changes; std::int64_t lastPresent = started; bool transferring = false; std::optional<NetworkIdentifierWithSubId> connection; };
    struct Candidate { Person person; std::string text; std::int64_t at; };
    Engine& engine;
    std::function<void(Level&)> gameActions;
    std::mutex state;
    std::map<std::string, Session> sessions;
    std::map<std::string, NetworkIdentifierWithSubId> joining;
    std::deque<Candidate> candidates;
    std::size_t candidateCount = 0, textPackets = 0, publicPackets = 0, captured = 0, dimensionChanges = 0;
    std::vector<ll::event::ListenerPtr> listeners;
    std::unique_ptr<Bedrock::PubSub::Subscription> dimensionConnection;
    std::unique_ptr<Bedrock::PubSub::Subscription> dimensionLeavingConnection;
    ll::memory::HookRegistrar<ArchiveBroadcast, ArchiveBroadcastExcept, ArchiveSendToClients> hooks;
    explicit Impl(Engine& value, std::function<void(Level&)> actions) : engine(value), gameActions(std::move(actions)) {
        auto& bus = ll::event::EventBus::getInstance();
        listeners.push_back(bus.emplaceListener<ll::event::ServerLevelTickEvent>([this](auto& event) {
            std::shared_lock guard(lifetime); if (active == this) { tick(event.level()); if (gameActions) gameActions(event.level()); }
        }));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerChatEvent>([this](auto& event) {
            std::shared_lock guard(lifetime); if (active != this || event.isCancelled()) return;
            std::lock_guard lock(state);
            if (candidates.size() >= 1024) { candidates.pop_front(); engine.recordCaptureGap(); }
            candidates.push_back({person(event.self()), event.message(), nowMillis()});
            candidateCount++;
        }, ll::event::EventPriority::Lowest));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerJoinEvent>([this](auto& event) {
            std::shared_lock guard(lifetime);
            if (active != this || event.isCancelled() || event.self().isPlayerInitialized()) return;
            std::lock_guard lock(state);
            joining.insert_or_assign(person(event.self()).key, connectionOf(event.self()));
        }, ll::event::EventPriority::Lowest));
        listeners.push_back(bus.emplaceListener<ll::event::PlayerDisconnectEvent>([this](auto& event) {
            std::shared_lock guard(lifetime); if (active != this) return;
            std::lock_guard lock(state); auto key = person(event.self()).key;
            auto connection = connectionOf(event.self());
            auto pending = joining.find(key);
            if (pending != joining.end() && sameConnection(pending->second, connection)) joining.erase(pending);
            auto found = sessions.find(key);
            if (found != sessions.end() && sameConnection(*found->second.connection, connection)) {
                if (!checkpoint(found->second, nowMillis(), true)) engine.recordCaptureGap();
                sessions.erase(found);
            }
            std::erase_if(candidates, [&](auto const& candidate) { return candidate.person.key == key; });
        }));
        if (std::any_of(listeners.begin(), listeners.end(), [](auto const& listener) { return !listener; })) {
            for (auto const& listener : listeners) if (listener) bus.removeListener(listener);
            throw std::runtime_error("Required player event listener could not be installed");
        }
        std::unique_lock guard(lifetime); if (active) throw std::runtime_error("Another collector tracker is already active"); active = this;
    }
    ~Impl() {
        { std::unique_lock guard(lifetime); active = nullptr; }
        dimensionConnection.reset();
        dimensionLeavingConnection.reset();
        for (auto const& listener : listeners) ll::event::EventBus::getInstance().removeListener(listener);
        std::lock_guard lock(state);
        for (auto& [key, session] : sessions)
            if (!checkpoint(session, session.lastPresent, true, "CAPTURE_STOPPED")) engine.recordCaptureGap();
        engine.note("Chat capture diagnostics: " + std::to_string(candidateCount) + " player candidates, " + std::to_string(textPackets) + " text packet paths, " + std::to_string(publicPackets) + " public packet paths, " + std::to_string(captured) + " messages queued");
        engine.note("Dimension capture diagnostics: " + std::to_string(dimensionChanges) + " confirmed transitions queued");
    }
    json checkpointEvent(Session const& session, Person const& player, std::int64_t at, std::uint64_t sequence, bool ended) {
        return {{"eventId", uuid()}, {"kind", "SESSION"}, {"at", timestamp(at)}, {"player", player.identity},
            {"dimension", player.dimension}, {"sessionId", session.id}, {"startedAt", timestamp(session.started)},
            {"sequence", sequence}, {"onlineMillis", at - session.started}, {"ended", ended}};
    }
    json visit(Person const& player, std::int64_t at) {
        return {{"eventId", uuid()}, {"kind", "COUNTER"}, {"at", timestamp(at)}, {"player", player.identity},
            {"dimension", player.dimension}, {"metric", "dimension.visits"}, {"value", 1}, {"subject", player.dimension}};
    }
    bool drainChanges(Session& session) {
        while (!session.changes.empty()) {
            auto const& change = session.changes.front(); auto at = std::max(change.at, session.checkpoint);
            if (!engine.submitEvents(json::array({checkpointEvent(session, session.person, at, session.sequence + 1, false),
                checkpointEvent(session, change.person, at, session.sequence + 2, false), visit(change.person, at)}))) return false;
            session.sequence += 2; session.checkpoint = at; session.person = change.person; session.changes.pop_front();
        }
        return true;
    }
    bool checkpoint(Session& session, std::int64_t at, bool ended, char const* endReason = nullptr) {
        if (!drainChanges(session)) return false;
        at = std::max(at, session.checkpoint);
        auto event = checkpointEvent(session, session.person, at, session.sequence + 1, ended);
        if (endReason) event["sessionEnd"] = endReason;
        if (!engine.submit(std::move(event))) return false;
        session.sequence++; session.checkpoint = at; return true;
    }
    void dimensionChanged(Player& player) override {
        std::lock_guard lock(state); auto current = person(player); auto found = sessions.find(current.key);
        if (found == sessions.end()) return;
        auto& session = found->second; session.transferring = false; session.lastPresent = nowMillis();
        auto const& last = session.changes.empty() ? session.person : session.changes.back().person;
        if (last.dimension == current.dimension) return;
        session.changes.push_back({std::move(current), nowMillis()}); dimensionChanges++; drainChanges(session);
    }
    void tick(Level& level) {
        if (!dimensionConnection) {
            auto manager = level.getPlayerDimensionTransferManager();
            auto& transferer = *manager->mPlayerDimensionTransferer.get();
            auto& connector = transferer.getOnAnyPlayerChangeDimensionCompleteConnector();
            dimensionConnection.reset(new Bedrock::PubSub::Subscription(connector.connect([this, &level](ActorUniqueID id, DimensionType) {
                try {
                    std::shared_lock guard(lifetime); if (active != this) return;
                    auto player = level.MCARCHIVE_FETCH_ENTITY(id, false);
                    if (player && player->getEntityTypeId() == ActorType::Player) dimensionChanged(static_cast<Player&>(*player));
                } catch (...) {}
            }, Bedrock::PubSub::ConnectPosition::AtBack, {})));
            dimensionLeavingConnection.reset(new Bedrock::PubSub::Subscription(transferer.getOnPlayerLeftDimensionConnector().connect([this](NetworkIdentifierWithSubId const& connection, DimensionType from) {
                try {
                    std::shared_lock guard(lifetime); if (active != this) return;
                    std::lock_guard lock(state);
                    for (auto& [key, session] : sessions) {
                        auto const& last = session.changes.empty() ? session.person : session.changes.back().person;
                        if (session.connection && sameConnection(*session.connection, connection) && last.dimension == dimensionName(static_cast<int>(from))) {
                            session.transferring = true; session.lastPresent = nowMillis();
                        }
                    }
                } catch (...) {}
            }, Bedrock::PubSub::ConnectPosition::AtBack, {})));
            engine.note("Native dimension completion subscription established");
        }
        std::lock_guard lock(state); const auto now = nowMillis(); std::set<std::string> seen;
        level.forEachPlayer([&](Player& player) {
            Person current = person(player); seen.insert(current.key);
            auto found = sessions.find(current.key);
            if (found != sessions.end()) found->second.lastPresent = now;
            if (!player.isPlayerInitialized()) return true;
            if (found == sessions.end()) {
                Session session{current, uuid(), now, now};
                session.connection = connectionOf(player);
                auto pending = joining.find(current.key);
                // The initialization packet is cancellable. Only a player the game
                // subsequently reports as initialized can start a confirmed join.
                bool joined = pending != joining.end() && sameConnection(pending->second, *session.connection);
                auto start = checkpointEvent(session, current, now, 0, false);
                start["sessionStart"] = joined ? "JOIN" : "OBSERVED";
                auto group = json::array({std::move(start)});
                if (joined) group.push_back(visit(current, now));
                if (engine.submitEvents(std::move(group))) {
                    if (pending != joining.end()) joining.erase(pending);
                    sessions.emplace(current.key, std::move(session));
                }
            } else {
                auto& session = found->second;
                if (drainChanges(session) && now - session.checkpoint >= 5000)
                    if (checkpoint(session, now, false)) { current.dimension = session.person.dimension; session.person = std::move(current); }
            }
            return true;
        });
        for (auto it = sessions.begin(); it != sessions.end();) {
            if (!seen.contains(it->first) && !it->second.transferring && now - it->second.lastPresent >= 10000) {
                if (checkpoint(it->second, it->second.lastPresent, true)) it = sessions.erase(it); else ++it;
            } else ++it;
        }
        while (!candidates.empty() && now - candidates.front().at > 5000) candidates.pop_front();
        engine.observeTick(static_cast<int>(seen.size()));
    }
    void broadcast(Packet const& packet) override {
        if (packet.getId() != MinecraftPacketIds::Text) return;
        std::lock_guard lock(state); textPackets++;
        auto const& text = static_cast<TextPacket const&>(packet);
        auto body = std::get_if<TextPacketPayload::AuthorAndMessage>(&text.mBody.get());
        if (!body || body->mType != TextPacketType::Chat) return;
        publicPackets++; auto now = nowMillis(); auto author = plainAuthor(body->mAuthor.get());
        auto found = std::find_if(candidates.begin(), candidates.end(), [&](Candidate const& candidate) {
            return now - candidate.at <= 5000 && candidate.text == body->mMessage.get()
                && (candidate.person.key.starts_with("xuid:") ? candidate.person.xuid == text.mXuid.get() : candidate.person.name == author);
        });
        if (found == candidates.end()) {
            if (!candidates.empty() && publicPackets <= 4) {
                auto const& candidate = candidates.front();
                engine.note("Public chat match diagnostic: text=" + std::to_string(candidate.text == body->mMessage.get())
                    + ", name=" + std::to_string(candidate.person.name == body->mAuthor.get()) + ", xuid=" + std::to_string(candidate.person.xuid == text.mXuid.get())
                    + ", authenticatedIdentity=" + std::to_string(candidate.person.key.starts_with("xuid:")) + ", ageMillis=" + std::to_string(now - candidate.at));
            }
            return;
        }
        // Consume before submitting: nested broadcast helpers cannot count this public message twice.
        Person sender = found->person; candidates.erase(found);
        if (engine.submit({{"eventId", uuid()}, {"kind", "CHAT"}, {"at", timestamp(now)}, {"player", sender.identity}, {"dimension", sender.dimension}, {"text", body->mMessage.get()}}))
            captured++;
        else engine.recordCaptureGap();
    }
};
GameTracker::GameTracker(Engine& engine, std::function<void(Level&)> actions) : impl_(std::make_unique<Impl>(engine, std::move(actions))) {}
GameTracker::~GameTracker() = default;
std::string stablePlayerKey(Player const& player) { return person(player).key; }
nlohmann::json playerIdentity(Player const& player) { return person(player).identity; }
std::string playerDimension(Player const& player) { return person(player).dimension; }
}
