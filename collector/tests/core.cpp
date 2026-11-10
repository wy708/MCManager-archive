#include "core/Outbox.h"
#include "core/Platform.h"
#include "core/Transport.h"
#include "core/Engine.h"
#include "core/CommandJournal.h"
#include "core/ActionIntervals.h"
#include "core/RuntimeMonitor.h"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>
#include <cwchar>

using namespace mcarchive;
using Json = nlohmann::json;
static constexpr char fixtureServer[] = "11111111-1111-4111-8111-111111111111";
struct FixtureOutbox : Outbox {
    explicit FixtureOutbox(std::filesystem::path root) : Outbox(std::move(root), fixtureServer) {}
};
void require(bool condition, char const* message) { if (!condition) throw std::runtime_error(message); }
template<class Function> void fails(Function action, char const* message) {
    try { action(); } catch (std::exception const&) { return; }
    throw std::runtime_error(message);
}
std::string envelope() { return Json{{"protocolVersion", 1}, {"batchId", uuid()}, {"events", Json::array()}}.dump(); }
void tests(std::filesystem::path const& base) {
    {
        MotionPoint start{0, 0, 0, 1000, TravelMode::Walk, 0, 0};
        MotionPoint end{0.3, 0.4, 0, 1100, TravelMode::Walk, 0, 0};
        require(travelMillimeters(start, end) == 300, "Walking must use horizontal distance");
        end.mode = TravelMode::Swim;
        require(!travelMillimeters(start, end), "Mode changes must discard the crossing segment");
        start.mode = TravelMode::Swim;
        require(travelMillimeters(start, end) == 500, "Swimming must include vertical distance");
        end.dimension = 1;
        require(!travelMillimeters(start, end), "Dimension changes must discard the crossing segment");
        end.dimension = 0;
        start.mode = end.mode = TravelMode::Vehicle;
        start.carrier = 41;
        end.carrier = 42;
        require(!travelMillimeters(start, end), "Mount changes must discard seat offsets");
        end.carrier = start.carrier;
        end.at = 1751;
        require(!travelMillimeters(start, end), "Long sample gaps must not interpolate movement");
        end.at = 1100;
        end.x = 30;
        require(!travelMillimeters(start, end), "Position jumps beyond the mode speed limit must be dropped");
        end.x = std::numeric_limits<double>::quiet_NaN();
        require(!travelMillimeters(start, end), "Nonfinite positions must be rejected");
        end = start;
        end.at += 100;
        end.x += 0.01;
        require(travelMillimeters(start, end) == 0, "Small position jitter must not accumulate");
    }
    Json lease = {{"leaseId", uuid()}, {"bootId", uuid()}, {"reply", {{"id", uuid()}, {"serverId", fixtureServer}, {"text", "plain-text reply"}}}};
    CommandRecord started;
    {
        CommandJournal journal(base / "commands", fixtureServer);
        fails([&] { CommandJournal duplicate(base / "commands", fixtureServer); }, "Command journal allowed concurrent executors");
        auto prepared = journal.prepare(lease);
        require(prepared.phase == 0 && journal.prepare(lease).phase == 0, "Command preparation was not idempotent");
        auto changed = lease; changed["reply"]["text"] = "changed";
        fails([&] { journal.prepare(changed); }, "Same command lease accepted different text");
        fails([&] { journal.finish(prepared, Json::object()); }, "Unstarted command accepted a result");
        fails([&] { journal.acknowledge(prepared); }, "Unfinished command was acknowledged");
        started = journal.start(prepared, nowMillis() + 30000);
        require(started.phase == 1, "Command start was not persisted");
    }
    {
        CommandJournal journal(base / "commands", fixtureServer);
        auto recovered = journal.recover(); require(recovered.size() == 1 && recovered[0].phase == 1, "Interrupted execution was falsely completed or lost");
        Json result = {{"leaseId", lease["leaseId"]}, {"bootId", lease["bootId"]}, {"outcome", "UNCERTAIN"}, {"sentAt", nullptr}, {"errorCode", "LOCAL_STATE_UNCERTAIN"}};
        auto finished = journal.finish(recovered[0], result); journal.acknowledge(finished); journal.acknowledge(finished);
        require(journal.recover().front().phase == 3, "Command acknowledgement did not survive journal recovery");
        require(journal.prepare(lease).phase == 3, "Completed command could be prepared for execution again");
    }
    fails([&] { CommandJournal wrongArchive(base / "commands", "22222222-2222-4222-8222-222222222222"); }, "Command journal was adopted by another server");
    std::filesystem::path journalFile;
    {
        CommandJournal journal(base / "command-corrupt", fixtureServer); journal.prepare(lease);
        for (auto const& file : std::filesystem::directory_iterator(base / "command-corrupt" / "records")) journalFile = file.path();
    }
    {
        auto wrapper = Json::parse(boundedRead(journalFile, 65536)); wrapper["body"] = "changed";
        std::ofstream file(journalFile, std::ios::binary | std::ios::trunc); file << wrapper.dump();
    }
    fails([&] { CommandJournal corrupt(base / "command-corrupt", fixtureServer); }, "Corrupt command journal was accepted");
    require(std::filesystem::exists(journalFile), "Corrupt command evidence was removed");
    {
        CommandJournal journal(base / "command-path", fixtureServer); auto path = lease; path["reply"]["id"] = "../world";
        fails([&] { journal.prepare(path); }, "Command ID allowed a path escape");
    }
    require(timestamp(0) == "1970-01-01T00:00:00.000Z", "UTC epoch formatting mismatch");
    require(timestamp(1001) == "1970-01-01T00:00:01.001Z", "UTC millisecond formatting mismatch");
    auto midnight = actionIntervals(86'399'990, 25);
    require(midnight.size() == 2 && midnight[0].millis == 10 && midnight[0].at == 86'399'999
        && midnight[1].millis == 15 && midnight[1].at == 86'400'014, "UTC day boundary misattributed action time");
    auto hongKong = actionIntervals(57'599'990, 25);
    require(hongKong.size() == 2 && hongKong[0].at == 57'599'999 && hongKong[1].millis == 15, "UTC+8 day boundary misattributed action time");
    require(actionIntervals(0, 0).empty(), "Zero elapsed state created an interval");
    fails([&] { actionIntervals(0, -1); }, "Negative elapsed state time accepted");
    {
        Engine engine({fixtureServer, std::string(fixtureServer) + "." + std::string(43, 'a'), "http://127.0.0.1:1/api/ingest/v1/batches", base / "engine"}, [](auto const&) {});
        std::vector<std::thread> producers;
        for (int n = 0; n < 4; ++n) producers.emplace_back([&] {
            for (int i = 0; i < 20; ++i) {
                auto groupId = uuid(); Json group = Json::array();
                for (int position = 0; position < 3; ++position) group.push_back({{"eventId", uuid()}, {"kind", "COUNTER"}, {"at", timestamp(nowMillis())}, {"fixtureGroup", groupId}, {"fixturePosition", position}});
                require(engine.submitEvents(std::move(group)), "Asynchronous grouped submission rejected");
            }
        });
        for (auto& producer : producers) producer.join();
        engine.stop();
        auto status = engine.status();
        require(status.queuedEvents == 0 && status.pendingEvents == 240 && status.rejectedEvents == 0 && !status.diskError, "Writer failed to persist while network was unavailable");
        require(!engine.submit({{"eventId", uuid()}}), "Stopped collector accepted a new event");
        require(!engine.submitEvents(Json::array({Json::object(), Json::object(), Json::object()})), "Stopped collector accepted an event group");
        require(engine.status().queuedEvents == 0 && engine.status().rejectedEvents == 4, "Rejected group was partly queued or incorrectly counted");
    }
    {
        FixtureOutbox recovered(base / "engine");
        require(recovered.pendingEvents() == 240, "Restart lost asynchronous writer data");
        std::vector<Json> ordered;
        while (auto batch = recovered.front()) {
            auto saved = Json::parse(batch->body);
            require(batch->eventCount > 0 || (saved.at("collector").at("diagnostics").at("final").get<bool>() && saved.at("collector").at("runtime").at("stopped").get<bool>()), "Only the final stop observation may enter the durable queue without events");
            for (auto const& event : saved.at("events")) ordered.push_back(event);
            recovered.acknowledge(*batch);
        }
        require(ordered.size() == 240, "Persisted asynchronous event count mismatch");
        for (std::size_t i = 0; i < ordered.size(); i += 3) {
            for (int position = 0; position < 3; ++position) require(ordered[i + position].at("fixtureGroup") == ordered[i].at("fixtureGroup") && ordered[i + position].at("fixturePosition") == position, "Concurrent producers interleaved a dependent event group");
        }
    }
    require(sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256 vector mismatch");
    auto firstBody = envelope(), secondBody = envelope();
    require(firstBody != secondBody, "UUID repeated");
    {
        FixtureOutbox outbox(base / "window");
        std::vector<PendingBatch> originals;
        for (int i = 0; i < 35; ++i) originals.push_back(outbox.append(envelope()));
        auto window = outbox.frontWindow(); require(window.size() == 16, "Bulk window is not bounded");
        for (std::size_t i = 0; i < window.size(); ++i) require(window[i].body == originals[i].body, "Bulk changed original bytes or order");
        for (auto const& batch : window) outbox.acknowledge(batch);
        require(outbox.frontWindow()[0].body == originals[16].body, "Acknowledgement did not advance cached FIFO");
        require(outbox.pendingCount() == 19, "Cached pending count mismatch");
        require(outbox.replayAcknowledged() == 16 && outbox.frontWindow()[0].body == originals[0].body, "Replay did not rebuild cached FIFO");
    }
    {
        FixtureOutbox outbox(base / "window");
        require(outbox.pendingCount() == 35 && outbox.frontWindow().size() == 16, "Restart did not rebuild FIFO");
    }
    {
        FixtureOutbox outbox(base / "window-events");
        for(int i=0;i<10;++i) {auto body=Json::parse(envelope());body["events"]=Json::array();for(int j=0;j<64;++j)body["events"].push_back(Json::object());outbox.append(body.dump());}
        require(outbox.frontWindow().size()==8,"Bulk event limit exceeded");
    }
    {
        FixtureOutbox outbox(base / "window-bytes");
        auto body=Json::parse(envelope());body["padding"]=std::string(600000,'x');outbox.append(body.dump());outbox.append(envelope());
        auto window=outbox.frontWindow();Json bodies=Json::array();for(auto const& b:window)bodies.push_back(b.body);
        require(Json{{"batches",bodies}}.dump().size()<=1'048'576,"Escaped wire size exceeded");
        outbox.acknowledge(window.front());outbox.acknowledge(*outbox.front());
        body["batchId"]=uuid();
        // The original envelope must remain valid and individually fit the limit.
        body["padding"]=std::string(400000,'"');outbox.append(body.dump());outbox.append(envelope());
        require(outbox.frontWindow().size()==1,"Large escaped original did not fall back to a single request");
    }
    {
        FixtureOutbox outbox(base / "window-corrupt");auto first=outbox.append(envelope()),bad=outbox.append(envelope());
        {std::ofstream file(bad.path,std::ios::trunc);file<<"corrupt";}
        require(outbox.frontWindow().size()==1,"Later corrupt record blocked a valid earlier original");
        outbox.acknowledge(first);fails([&]{outbox.frontWindow();},"Corrupt FIFO head was skipped");
    }
    {
        FixtureOutbox outbox(base / "window-write-failure");auto body=envelope();
        auto temporary=base/"window-write-failure"/("00000000000000000001_"+Json::parse(body)["batchId"].get<std::string>()+".pending.writing");
        {std::ofstream file(temporary);file<<"partial";}
        fails([&]{outbox.append(body);},"Existing interrupted write was overwritten");
        fails([&]{outbox.frontWindow();},"Cached FIFO ignored interrupted persistence");
        fails([&]{outbox.append(envelope());},"Unrecovered disk fault accepted another append");
        require(outbox.pendingCount()==0 && std::filesystem::exists(temporary),"Failed persistence changed pending accounting or erased evidence");
    }
    std::filesystem::path firstPath, secondPath;
    {
        FixtureOutbox outbox(base / "restart");
        fails([&] { FixtureOutbox duplicate(base / "restart"); }, "Concurrent process ownership was allowed");
        auto first = outbox.append(firstBody), second = outbox.append(secondBody);
        firstPath = first.path; secondPath = second.path;
        require(outbox.pendingCount() == 2, "Pending count mismatch");
        require(outbox.front()->body == firstBody, "FIFO order mismatch");
        outbox.acknowledge(first); outbox.acknowledge(first);
        require(outbox.pendingCount() == 1, "Acknowledgement was not idempotent");
    }
    {
        FixtureOutbox outbox(base / "restart");
        require(outbox.front()->body == secondBody, "Restart changed pending bytes");
        require(outbox.replayAcknowledged() == 1, "Acknowledged batch was not retained");
        require(outbox.front()->body == firstBody, "Replay did not retain original FIFO order");
        outbox.acknowledge(*outbox.front()); outbox.acknowledge(*outbox.front());
        require(outbox.pendingCount() == 0, "Replay acknowledgement left pending data");
    }
    {
        FixtureOutbox outbox(base / "concurrent");
        std::vector<std::thread> threads;
        for (int worker = 0; worker < 4; ++worker) threads.emplace_back([&] { for (int i = 0; i < 10; ++i) outbox.append(envelope()); });
        for (auto& thread : threads) thread.join();
        require(outbox.pendingCount() == 40, "Concurrent append lost a batch");
        while (outbox.front()) outbox.acknowledge(*outbox.front());
        require(outbox.pendingCount() == 0, "Concurrent queue did not drain");
    }
    std::filesystem::path corrupted;
    { FixtureOutbox outbox(base / "corrupt"); corrupted = outbox.append(envelope()).path; }
    {
        auto record = Json::parse(boundedRead(corrupted, 3 * 1'048'576)); record["body"] = secondBody;
        std::ofstream file(corrupted, std::ios::binary | std::ios::trunc); file << record.dump();
    }
    fails([&] { FixtureOutbox outbox(base / "corrupt"); }, "Corrupt checksum was accepted");
    require(std::filesystem::exists(corrupted), "Corrupt evidence was deleted");
    std::filesystem::path interrupted;
    { FixtureOutbox outbox(base / "complete-write"); interrupted = outbox.append(firstBody).path; }
    auto writing = interrupted; writing += L".writing"; std::filesystem::rename(interrupted, writing);
    { FixtureOutbox outbox(base / "complete-write"); require(outbox.front()->body == firstBody, "Complete interrupted write was not recovered"); }
    { FixtureOutbox initialized(base / "partial-write"); }
    auto partial = base / "partial-write" / ("00000000000000000001_" + uuid() + ".pending.writing");
    { std::ofstream file(partial, std::ios::binary); file << "{truncated"; }
    fails([&] { FixtureOutbox outbox(base / "partial-write"); }, "Truncated interrupted write was ignored");
    require(std::filesystem::exists(partial), "Truncated write evidence was deleted");
    {
        FixtureOutbox outbox(base / "ack-integrity"); auto batch = outbox.append(envelope());
        auto forged = batch; forged.body = envelope();
        fails([&] { outbox.acknowledge(forged); }, "Forged acknowledgement removed data");
        require(outbox.pendingCount() == 1, "Invalid acknowledgement changed queue");
        fails([&] { outbox.append("{}"); }, "Invalid batch was persisted");
        fails([&] { outbox.append(std::string(1'048'577, ' ')); }, "Oversized batch was persisted");
        require(outbox.pendingCount() == 1, "Rejected append changed queue");
    }
    std::filesystem::create_directories(base / "blocked");
    { std::ofstream file(base / "blocked" / "not-a-directory"); file << "occupied"; }
    fails([&] { FixtureOutbox outbox(base / "blocked" / "not-a-directory"); }, "Invalid storage destination was accepted");
    std::string token = uuid() + "." + std::string(43, 'A');
    fails([&] { HttpTransport transport("http://127.0.0.1/", token); }, "Wrong endpoint path accepted");
    fails([&] { HttpTransport transport("http://user:pass@127.0.0.1/api/ingest/v1/batches", token); }, "URL credentials accepted");
    fails([&] { HttpTransport transport("http://127.0.0.1/api/ingest/v1/batches", token + "\r\nInjected: yes"); }, "Header injection accepted");
    fails([&] { Outbox wrongServer(base / "restart", uuid()); }, "Another archive could adopt the outbox");
    {
        Engine engine({fixtureServer, std::string(fixtureServer)+"."+std::string(43,'A'),
            "http://127.0.0.1:9/api/ingest/v1/batches",base/"large-events"},[](auto const&){});
        Json group=Json::array();
        for(int i=0;i<64;++i) group.push_back({{"eventId",uuid()},{"at",timestamp(nowMillis())},
            {"fixtureSequence",i},{"fixturePayload",std::string(60000,'x')}});
        require(engine.submitEvents(group),"Large event group rejected");
        engine.stop();
        require(engine.status().queuedEvents==0 && !engine.status().diskError,"Large batch failed persistence");
    }
    {
        FixtureOutbox spool(base/"large-events"); int sequence=0,batches=0;
        while(auto next=spool.front()) {
            require(next->body.size()<=1'048'576,"Durable batch exceeds HTTP limit");
            auto parsed=Json::parse(next->body);
            for(auto const& event:parsed.at("events"))
                require(event.at("fixtureSequence")==sequence++,"Batch splitting reordered or lost an event");
            spool.acknowledge(*next);++batches;
        }
        require(sequence==64 && batches>1,"Large events were not split into complete batches");
    }
    std::cout << "{\"coreVerified\":true,\"concurrentBatches\":40,\"crashRecovery\":true,\"corruptionRetained\":true,\"realGameplay\":false}\n";
}
void httpFixture(std::filesystem::path const& fixturePath, std::wstring const& phase) {
    auto fixture = Json::parse(boundedRead(fixturePath, 3 * 1'048'576));
    std::string token = fixture.at("token").get<std::string>();
    HttpTransport transport(fixture.at("endpoint").get<std::string>(), token);
    if (phase == L"--http-drain" || phase == L"--http-bulk-reject" || phase == L"--http-engine-drain") {
        auto root = std::filesystem::path(widen(fixture.at("outbox").get<std::string>()));
        auto server = fixture.at("serverId").get<std::string>();
        if (phase == L"--http-engine-drain") {
            {Outbox outbox(root,server);for(auto const& body:fixture.at("bodies"))outbox.append(body.get<std::string>());}
            Engine engine({server,token,fixture.at("endpoint").get<std::string>(),root},[](auto const&){});
            auto deadline=nowMillis()+120000;
            while(engine.status().pendingEvents && nowMillis()<deadline)std::this_thread::sleep_for(std::chrono::milliseconds(20));
            require(engine.status().pendingEvents==0,"Engine did not drain durable originals");engine.stop();
            std::cout<<"{\"engineDrained\":true}\n";return;
        }
        Outbox outbox(root,server);
        if(outbox.pendingCount()==0)for(auto const& body:fixture.at("bodies"))outbox.append(body.get<std::string>());
        auto started=nowMillis();std::size_t requests=0,batches=0;
        while(outbox.pendingCount()) {
            auto window=outbox.frontWindow(fixture.value("single",false)?1:16);
            auto receipt=transport.deliverMany(window);++requests;
            if(phase==L"--http-bulk-reject") {
                require(!receipt.confirmed,"Invalid bulk receipt was accepted");
                require(outbox.pendingCount()==fixture.at("bodies").size(),"Rejected receipt removed originals");
                std::cout<<"{\"bulkRejectedRetained\":true}\n";return;
            }
            require(receipt.confirmed,"Bulk drain was not confirmed");
            if(fixture.value("replay",false)) {
                auto duplicate=transport.deliverMany(window);++requests;
                require(duplicate.confirmed&&duplicate.duplicateBatch&&duplicate.acceptedEvents==0,"Lost-response replay duplicated original batches");
            }
            for(auto const& batch:window){outbox.acknowledge(batch);++batches;}
        }
        std::cout<<Json{{"batches",batches},{"requests",requests},{"millis",nowMillis()-started},{"pending",outbox.pendingCount()}}.dump()<<'\n';return;
    }
    if (phase == L"--http-control") {
        auto result = transport.postCommand(fixture.value("route", "/commands/claim"), fixture.value("controlBody", "{}"));
        require(result.status == fixture.at("expectedStatus").get<unsigned>(), "Unexpected command HTTP status");
        require(result.error.empty() == fixture.at("success").get<bool>(), "Command transport accepted an invalid response");
        if (result.error.empty()) require(result.body == "[]", "Command response bytes changed");
        else require(result.body.empty(), "Rejected control response exposed its body");
        std::cout << Json{{"phase", "control-verified"}, {"status", result.status}, {"realGameplay", false}}.dump() << '\n';
        return;
    }
    Outbox outbox(std::filesystem::path(widen(fixture.at("outbox").get<std::string>())), fixture.at("serverId").get<std::string>());
    auto body = fixture.at("body").get<std::string>();
    if (phase == L"--http-stage") {
        require(outbox.pendingCount() == 0, "HTTP fixture requires a fresh outbox");
        auto batch = outbox.append(body);
        auto rejectedToken = token; rejectedToken.back() = rejectedToken.back() == 'A' ? 'B' : 'A';
        auto denied = HttpTransport(fixture.at("endpoint").get<std::string>(), rejectedToken).deliver(batch);
        require(!denied.confirmed && denied.status == 401 && outbox.pendingCount() == 1, "401 did not preserve pending data");
        auto result = transport.deliver(batch);
        require(result.confirmed && result.acceptedEvents == batch.eventCount && !result.duplicateBatch, "Initial batch was not accepted by the real backend");
        std::cout << Json{{"phase", "accepted-unacknowledged"}, {"bodySha256", sha256(batch.body)}, {"pending", outbox.pendingCount()}, {"realGameplay", false}}.dump() << '\n';
    } else if (phase == L"--http-replay") {
        require(outbox.pendingCount() == 1 && outbox.front()->body == body, "Pending bytes did not survive process restart");
        auto batch = *outbox.front(); auto result = transport.deliver(batch);
        require(result.confirmed && result.duplicateBatch && result.acceptedEvents == 0 && result.duplicateEvents == batch.eventCount, "Restart replay was not deduplicated by the real backend");
        outbox.acknowledge(batch);
        require(outbox.pendingCount() == 0 && outbox.replayAcknowledged() == 1, "Acknowledged recovery history was not retained");
        auto replay = *outbox.front();
        require(transport.deliver(replay).confirmed, "Acknowledged replay failed");
        outbox.acknowledge(replay);
        std::cout << Json{{"phase", "replayed-confirmed"}, {"duplicateBatch", true}, {"pending", outbox.pendingCount()}, {"realGameplay", false}}.dump() << '\n';
    } else if (phase == L"--http-reject") {
        auto batch = outbox.pendingCount() == 0 ? outbox.append(body) : *outbox.front();
        auto result = transport.deliver(batch);
        require(!result.confirmed && outbox.pendingCount() == 1, "Invalid response removed a pending batch");
        if (fixture.contains("expectedStatus")) require(result.status == fixture.at("expectedStatus").get<unsigned>(), "Unexpected failure status");
        std::cout << Json{{"phase", "rejected-retained"}, {"status", result.status}, {"error", result.error}, {"pending", 1}, {"realGameplay", false}}.dump() << '\n';
    } else throw std::runtime_error("Unknown HTTP verification phase");
}
int wmain(int argc, wchar_t** argv) {
    try {
        if(argc==2&&std::wstring(argv[1])==L"--host-sample"){
            RuntimeMonitor monitor;monitor.tick(1);auto first=monitor.sample(true);
            require(first.at("hostCpuPercent").is_null(),"First CPU sample must not invent a delta");
            std::this_thread::sleep_for(std::chrono::milliseconds(1200));monitor.tick(1);auto sample=monitor.sample();
            require(sample.at("hostCpuPercent").is_number(),"Windows host CPU sample unavailable");
            require(sample.at("hostMemoryTotalBytes").get<std::uint64_t>()>0,"Host memory unavailable");
            require(!sample.at("hostDisks").empty(),"Fixed disk space unavailable");
            for(auto const& disk:sample.at("hostDisks"))require(disk.at("availableBytes").get<std::uint64_t>()<=disk.at("totalBytes").get<std::uint64_t>(),"Invalid disk space");
            std::cout<<sample.dump()<<'\n';return 0;
        }
        if (argc == 3 && std::wstring(argv[1]).starts_with(L"--http-")) httpFixture(std::filesystem::path(argv[2]), argv[1]);
        else {
            auto root = argc > 1 ? std::filesystem::path(argv[1]) : std::filesystem::temp_directory_path() / ("mcarchive-core-" + uuid());
            tests(root);
        }
        return 0;
    } catch (std::exception const& error) { std::cerr << "Collector core verification failed: " << error.what() << '\n'; return 1; }
}
