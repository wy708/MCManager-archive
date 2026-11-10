package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:telemetry_test;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "mcmanager.admin-password=test-admin-password-2026", "mcmanager.statistics-zone=Asia/Hong_Kong",
        "mcmanager.activity-retention-worker-enabled=false", "MCM_IDLE_POLL_SECONDS=0"
})
@AutoConfigureMockMvc
class TelemetryIntegrationTest {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired ArchiveRepository archives;
    @Autowired CollectorCredentials credentials;
    @Autowired TelemetryQueries queries;
    @Autowired TelemetryService service;
    @Autowired ActivityFeed activity;
    @Autowired AgentCredentials agents;
    @Autowired ReplyQueue replies;
    @Autowired QqBindings qqBindings;
    @Autowired WorldQueries worldQueries;
    @Autowired ConstructionProjects projects;
    @Autowired ConstructionModels models;
    @Autowired ConstructionHistory history;
    @Autowired org.springframework.transaction.PlatformTransactionManager transactionManager;
    UUID server;
    String token;
    final ZoneId zone = ZoneId.of("Asia/Hong_Kong");
    Instant base;

    @BeforeEach void reset() {
        for (String table : List.of("construction_model_sections", "construction_deleted_requests", "construction_requests", "construction_events", "construction_phases", "construction_projects", "container_audit_locations", "container_audit", "world_queries", "world_state_cache", "qq_binding_attempts", "qq_player_bindings", "qq_binding_codes", "server_commands", "agent_server_access", "agent_accounts", "activity_feed", "player_server_names", "player_deaths", "daily_statistics", "player_sessions", "telemetry_events", "telemetry_batches",
                "player_servers", "player_names", "players", "metric_coverage", "collector_capabilities", "collector_boot_diagnostics", "collector_state", "collector_credentials", "server_archives")) jdbc.update("DELETE FROM " + table);
        jdbc.update("UPDATE telemetry_settings SET statistics_zone = NULL WHERE id = 1");
        jdbc.update("UPDATE activity_stream SET retention_days = 30, purge_before = NULL WHERE id = 1");
        server = archives.create("测试服务器", "QA only", LocalDate.of(2020, 1, 1)).id();
        token = credentials.rotate(server).token();
        base = LocalDate.now(zone).minusDays(2).atTime(23, 59, 50).atZone(zone).toInstant();
    }
    ObjectNode player(String identity, String name) {
        return json.createObjectNode().put("identityType", "XUID").put("identity", identity).put("name", name);
    }

    ResultActions sendBulk(String credential, List<String> originals) throws Exception {
        return mvc.perform(post("/api/ingest/v1/batches/bulk").header("Authorization", "Bearer " + credential)
                .contentType("application/json").content(json.writeValueAsBytes(Map.of("batches", originals))));
    }
    @Test void bulkRetainsOriginalBytesAndDeduplicatesAfterLostResponse() throws Exception {
        var first = batch(counter("blocks.placed", 1, "minecraft:stone"));
        var second = batch(counter("blocks.placed", 2, "minecraft:dirt"));
        ((ObjectNode)first.get("events").get(0).get("player")).put("name", "玩家中文");
        var originals = List.of(json.writerWithDefaultPrettyPrinter().writeValueAsString(first), json.writeValueAsString(second));
        sendBulk(token, originals).andExpect(status().isOk()).andExpect(jsonPath("$[0].acceptedEvents").value(1)).andExpect(jsonPath("$[1].acceptedEvents").value(1));
        sendBulk(token, originals).andExpect(status().isOk()).andExpect(jsonPath("$[0].duplicateBatch").value(true)).andExpect(jsonPath("$[1].duplicateBatch").value(true));
        mvc.perform(post("/api/ingest/v1/batches").header("Authorization","Bearer "+token).contentType("application/json").content(originals.getFirst()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.duplicateBatch").value(true));
        assertThat(jdbc.queryForObject("SELECT SUM(statistic_value) FROM daily_statistics WHERE metric='blocks.placed'",Long.class)).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT payload_hash FROM telemetry_batches WHERE batch_id=?",String.class,UUID.fromString(first.get("batchId").asText())))
                .isEqualTo(CollectorCredentials.hash(originals.getFirst().getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }
    @Test void bulkRollsBackNewWritesAndCanReplayPreviouslyCommittedOriginals() throws Exception {
        var first = batch(counter("blocks.placed", 3, "minecraft:stone"));
        var second = batch(counter("blocks.placed", 4, "minecraft:dirt"));
        send(token, second).andExpect(status().isOk());
        var changed = second.deepCopy(); ((ObjectNode)changed.get("events").get(0)).put("value", 5);
        sendBulk(token,List.of(first.toString(),changed.toString())).andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM telemetry_batches WHERE batch_id=?",Integer.class,UUID.fromString(first.get("batchId").asText()))).isZero();
        send(token,first).andExpect(status().isOk()).andExpect(jsonPath("$.acceptedEvents").value(1));
        sendBulk(token,List.of(first.toString(),second.toString())).andExpect(status().isOk()).andExpect(jsonPath("$[1].duplicateBatch").value(true));
        assertThat(jdbc.queryForObject("SELECT SUM(statistic_value) FROM daily_statistics WHERE metric='blocks.placed'",Long.class)).isEqualTo(7);
    }

    Map<String,List<String>> ingestionSnapshot() throws Exception {
        var result=new LinkedHashMap<String,List<String>>();
        for(String table:List.of("players","player_names","player_servers","player_server_names","player_sessions","player_deaths","daily_statistics","telemetry_events","telemetry_batches","metric_coverage","collector_capabilities","container_audit","container_audit_locations","activity_feed")) {
            var rows=new ArrayList<String>();
            String select=table.equals("container_audit_locations")?"SELECT l.*,a.event_id FROM container_audit_locations l JOIN container_audit a ON a.id=l.audit_id":"SELECT * FROM "+table;
            for(var row:jdbc.queryForList(select)) {
                var stable=new TreeMap<String,Object>(row);
                for(String key:List.of("server_id","received_at","cursor_id"))stable.remove(key);
                if(table.equals("container_audit"))stable.remove("id");
                if(table.equals("container_audit_locations"))stable.remove("audit_id");
                rows.add(json.writeValueAsString(stable));
            }
            Collections.sort(rows);result.put(table,rows);
        }
        return result;
    }
    @Test void groupedIngestPreservesAllQueryDataIncludingNamesCoordinatesAndCrossDaySessions() throws Exception {
        UUID sessionId=UUID.randomUUID();
        var placed=counter("blocks.placed",1,"minecraft:oak_log");placed.putObject("position").put("x",12).put("y",72).put("z",-9);
        var changed=counter("blocks.mined",2,"minecraft:stone").put("at",base.plusSeconds(30).toString());changed.set("player",player("123456789","改名后"));
        var late=counter("blocks.placed",1,"minecraft:dirt").put("at",base.plusSeconds(5).toString());late.set("player",player("123456789","旧名字"));
        var tied=counter("items.used",1,"minecraft:torch").put("at",base.plusSeconds(40).toString());tied.set("player",player("123456789","同时间后到名字"));
        var packets=List.of(batch(session(sessionId,0,0,false,"minecraft:overworld"),placed),
                batch(chat("中文聊天原文"),containerEvent("TRANSFER","COMMITTED_TRANSACTION"),changed),
                batch(session(sessionId,1,20000,false,"minecraft:overworld"),late,placed),
                batch(death("fall"),session(sessionId,2,40000,true,"minecraft:nether"),tied));
        for(var packet:packets)send(token,packet).andExpect(status().isOk());
        var expected=ingestionSnapshot();
        reset();
        sendBulk(token,packets.stream().map(ObjectNode::toString).toList()).andExpect(status().isOk());
        assertThat(ingestionSnapshot()).isEqualTo(expected);
        sendBulk(token,packets.stream().map(ObjectNode::toString).toList()).andExpect(status().isOk());
        assertThat(ingestionSnapshot()).isEqualTo(expected);
    }
    @Test void groupedCoverageConflictRollsBackAndDoesNotPoisonNextRequest() throws Exception {
        var first=batch(counter("blocks.placed",1,"minecraft:stone"));
        var second=batch(counter("blocks.placed",1,"minecraft:dirt"));
        ((ObjectNode)second.get("events").get(0)).remove("dimension");
        for(var cap:second.withArray("capabilities"))if(cap.get("metric").asText().equals("blocks.placed"))((ObjectNode)cap).put("dimensionAware",false);
        sendBulk(token,List.of(first.toString(),second.toString())).andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM metric_coverage",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM players",Integer.class)).isZero();
        send(token,first).andExpect(status().isOk()).andExpect(jsonPath("$.acceptedEvents").value(1));
    }
    @Test void bulkLimitsAndAuthorizationDoNotWriteRejectedRequests() throws Exception {
        String original = batch(counter("blocks.placed",1,"minecraft:stone")).toString();
        sendBulk("invalid",List.of(original)).andExpect(status().isUnauthorized());
        sendBulk(token,List.of()).andExpect(status().isBadRequest());
        sendBulk(token,Collections.nCopies(17,original)).andExpect(status().isBadRequest());
        sendBulk(token,List.of(original,"null")).andExpect(status().isBadRequest());
        sendBulk(token,List.of(original,"{broken")).andExpect(status().isBadRequest());
        var tooMany=batch();var events=(ArrayNode)tooMany.get("events");
        for(int i=0;i<513;i++)events.add(counter("blocks.placed",1,"minecraft:stone"));
        sendBulk(token,List.of(tooMany.toString())).andExpect(status().isBadRequest());
        sendBulk(token,List.of(" ".repeat(1_048_576))).andExpect(status().isPayloadTooLarge());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM telemetry_batches",Integer.class)).isZero();
        credentials.revoke(server);
        sendBulk(token,List.of(original)).andExpect(status().isUnauthorized());
    }
    @Test void bulkPreservesSessionSequenceAcrossOriginalBatches() throws Exception {
        UUID id=UUID.randomUUID();
        var originals=List.of(batch(session(id,0,0,false,"minecraft:overworld")).toString(),
                batch(session(id,1,10000,false,"minecraft:overworld")).toString(),
                batch(session(id,2,20000,true,"minecraft:overworld")).toString());
        sendBulk(token,originals).andExpect(status().isOk());
        sendBulk(token,originals).andExpect(status().isOk()).andExpect(jsonPath("$[2].duplicateBatch").value(true));
        assertThat(jdbc.queryForObject("SELECT online_millis FROM player_sessions WHERE session_id=?",Long.class,id)).isEqualTo(20000);
        assertThat(jdbc.queryForObject("SELECT ended FROM player_sessions WHERE session_id=?",Boolean.class,id)).isTrue();
    }

    ObjectNode containerEvent(String operation, String evidence) {
        var event=json.createObjectNode().put("eventId",UUID.randomUUID().toString()).put("kind","CONTAINER")
                .put("at",base.toString()).put("dimension","minecraft:overworld");
        event.set("player",player("123456789","Alice"));
        var data=event.putObject("container").put("operation",operation).put("evidence",evidence).put("block","minecraft:chest");
        data.putArray("positions").addObject().put("x",10).put("y",64).put("z",-20);
        data.withArray("positions").addObject().put("x",11).put("y",64).put("z",-20);
        var changes=data.putArray("changes");
        if(operation.equals("TRANSFER") || operation.equals("CHANGE")) {
            var change=changes.addObject().put("slot",0);
            change.putObject("before").put("type","minecraft:diamond").put("count",10);
            change.putObject("after").put("type","minecraft:diamond").put("count",7);
        }
        return event;
    }

    @Test void containerAuditIsDurableDeduplicatedScopedAndDoubleChestQueryable() throws Exception {
        var transfer=containerEvent("TRANSFER","COMMITTED_TRANSACTION");
        var open=containerEvent("OPEN","OBSERVED_OPEN");
        var unknown=containerEvent("CHANGE","OBSERVED_CHANGE"); unknown.putNull("player");
        var payload=batch(transfer,open,unknown);
        send(token,payload).andExpect(status().isOk()).andExpect(jsonPath("$.acceptedEvents").value(3));
        send(token,payload).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateBatch").value(true));
        send(token,batch(transfer,open,unknown)).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateEvents").value(3));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM container_audit",Integer.class)).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM telemetry_events",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM daily_statistics",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM players",Integer.class)).isEqualTo(1);
        var reader=agent(AgentCredentials.Scope.WORLD_READ);
        String path="/servers/"+server+"/container-history?dimension=minecraft:overworld&x=11&y=64&z=-20&limit=2";
        var first=agentGet(reader,path);
        assertThat(first.get("items").size()).isEqualTo(2);
        assertThat(first.get("items").get(0).get("attribution").asText()).isEqualTo("UNATTRIBUTED");
        assertThat(first.get("items").get(0).get("playerKey").isNull()).isTrue();
        assertThat(first.get("hasMore").asBoolean()).isTrue();
        var next=agentGet(reader,path+"&before="+first.get("nextBefore").asText());
        assertThat(next.get("items").size()).isEqualTo(1);
        var row=next.get("items").get(0);
        assertThat(row.get("playerKey").asText()).isEqualTo("xuid:123456789");
        assertThat(row.get("container").get("changes").get(0).get("after").get("count").asInt()).isEqualTo(7);
        assertThat(agentGet(reader,path.replace("x=11","x=10")).get("items")).isEqualTo(first.get("items"));
        assertThat(agentGet(reader,path.replace("minecraft:overworld","minecraft:nether")).get("items").size()).isZero();
        assertThat(agentGet(reader,path+"&playerKey=xuid:123456789").get("items").size()).isEqualTo(2);
        var noScope=agent(AgentCredentials.Scope.STATS_READ);
        mvc.perform(get("/api/agent"+path).header("Authorization","Bearer "+noScope.token())).andExpect(status().isForbidden());
        UUID other=archives.create("另一服","",LocalDate.of(2020,1,1)).id();
        mvc.perform(get("/api/agent"+path.replace(server.toString(),other.toString())).header("Authorization","Bearer "+reader.token())).andExpect(status().isForbidden());
        ((ObjectNode)transfer.get("container").get("changes").get(0).get("after")).put("count",8);
        send(token,batch(transfer)).andExpect(status().isConflict());
    }

    @Test void containerAuditRejectsAmbiguousInvalidAndOversizedEvidenceWithoutPartialWrites() throws Exception {
        var invalid=containerEvent("CHANGE","OBSERVED_CHANGE"); // unknown must not blame a player
        send(token,batch(invalid)).andExpect(status().isBadRequest());
        invalid=containerEvent("TRANSFER","COMMITTED_TRANSACTION"); invalid.putNull("player");
        send(token,batch(invalid)).andExpect(status().isBadRequest());
        invalid=containerEvent("OPEN","COMMITTED_TRANSACTION");
        send(token,batch(invalid)).andExpect(status().isBadRequest());
        invalid=containerEvent("TRANSFER","COMMITTED_TRANSACTION");
        ((ObjectNode)invalid.get("container").get("positions").get(1)).put("x",14);
        send(token,batch(invalid)).andExpect(status().isBadRequest());
        invalid=containerEvent("TRANSFER","COMMITTED_TRANSACTION");
        ((ObjectNode)invalid.get("container").get("changes").get(0)).put("slot",999);
        send(token,batch(invalid)).andExpect(status().isBadRequest());
        var old=counter("items.used",1,"minecraft:bow"); old.putNull("player");
        send(token,batch(old)).andExpect(status().isBadRequest());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM container_audit",Integer.class)).isZero();
        var reader=agent(AgentCredentials.Scope.WORLD_READ);
        String path="/api/agent/servers/"+server+"/container-history?dimension=minecraft:overworld&x=10&y=64&z=-20";
        for(var suffix:List.of("&radius=17","&limit=101","&before=0","&from=2020-01-01T00:00:00Z&to=2021-01-01T00:00:00Z"))
            mvc.perform(get(path+suffix).header("Authorization","Bearer "+reader.token())).andExpect(status().isBadRequest());
    }

    @Test void qqBindingCodesArePrivateScopedSingleUseAndUnbindCannotRemoveANewerBinding() throws Exception {
        send(token,batch(counter("blocks.mined",7,"minecraft:stone"))).andExpect(status().isOk());
        var issued=agent(AgentCredentials.Scope.QQ_BIND,AgentCredentials.Scope.STATS_READ);
        var collector=credentials.authenticate("Bearer "+token);
        UUID requestId=UUID.randomUUID();
        var request=new QqBindings.CodeRequest(requestId,"xuid:123456789","A1B2C3D4");
        var receipt=qqBindings.issue(collector,request);
        assertThat(qqBindings.issue(collector,request)).isEqualTo(receipt);
        mvc.perform(post("/api/ingest/v1/qq-binding-codes").header("Authorization","Bearer "+issued.token())
            .contentType("application/json").content(json.writeValueAsBytes(request))).andExpect(status().isUnauthorized());
        String bindingPath="/servers/"+server+"/qq-bindings/12345678";
        assertThat(agentGet(issued,bindingPath).get("bound").asBoolean()).isFalse();
        var claim=new QqBindings.Claim("12345678",request.code());
        var binding=qqBindings.bind(identity(issued),server,claim);
        assertThat(binding.binding().playerKey()).isEqualTo("xuid:123456789");
        assertThat(qqBindings.bind(identity(issued),server,claim)).isEqualTo(binding);
        assertThat(agentGet(issued,bindingPath+"/context").get("statistics").get("metrics")).isNotEmpty();
        mvc.perform(post("/api/agent/servers/"+server+"/qq-bindings").header("Authorization","Bearer "+issued.token())
            .contentType("application/json").content(json.writeValueAsBytes(new QqBindings.Claim("87654321",request.code()))))
            .andExpect(status().isBadRequest());
        jdbc.update("UPDATE qq_binding_codes SET created_at=?",TelemetryService.time(Instant.now().minusSeconds(31)));
        qqBindings.issue(collector,new QqBindings.CodeRequest(UUID.randomUUID(),request.playerKey(),"BEEF0001"));
        assertThat(qqBindings.unbind(identity(issued),server,claim.qqId(),new QqBindings.Unbind(binding.binding().id())).bound()).isFalse();
        assertThat(qqBindings.get(identity(issued),server,claim.qqId()).bound()).isFalse();
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> qqBindings.bind(identity(issued),server,new QqBindings.Claim("87654321","BEEF0001")))
            .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        jdbc.update("UPDATE qq_binding_codes SET created_at=?",TelemetryService.time(Instant.now().minusSeconds(31)));
        qqBindings.issue(collector,new QqBindings.CodeRequest(UUID.randomUUID(),request.playerKey(),"AABBCCDD"));
        var replacement=qqBindings.bind(identity(issued),server,new QqBindings.Claim(claim.qqId(),"AABBCCDD"));
        assertThat(replacement.binding().id()).isNotEqualTo(binding.binding().id());
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> qqBindings.unbind(identity(issued),server,claim.qqId(),new QqBindings.Unbind(binding.binding().id())))
            .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThat(qqBindings.get(identity(issued),server,claim.qqId())).isEqualTo(replacement);
    }

    @Test void qqBindingRequiresSeparateGrantAndInvalidCodeAttemptsRemainRateLimited() throws Exception {
        var reader=agent(AgentCredentials.Scope.STATS_READ);
        mvc.perform(get("/api/agent/servers/"+server+"/qq-bindings/12345678").header("Authorization","Bearer "+reader.token()))
            .andExpect(status().isForbidden());
        var binder=agent(AgentCredentials.Scope.QQ_BIND);
        for(int i=0;i<30;i++) mvc.perform(post("/api/agent/servers/"+server+"/qq-bindings").header("Authorization","Bearer "+binder.token())
            .contentType("application/json").content("{\"qqId\":\"12345678\",\"code\":\"DEADBEEF\"}")).andExpect(status().isBadRequest());
        mvc.perform(post("/api/agent/servers/"+server+"/qq-bindings").header("Authorization","Bearer "+binder.token())
            .contentType("application/json").content("{\"qqId\":\"12345678\",\"code\":\"DEADBEEF\"}")).andExpect(status().isTooManyRequests());
        UUID other=archives.create("另一服","",LocalDate.of(2020,1,1)).id();
        mvc.perform(get("/api/agent/servers/"+other+"/qq-bindings/12345678").header("Authorization","Bearer "+binder.token()))
            .andExpect(status().isForbidden());
    }

    @Test void qqExpiredCodesAndConcurrentClaimsCannotBindAnotherAccount() throws Exception {
        send(token,batch(counter("blocks.mined",1,"minecraft:stone"))).andExpect(status().isOk());
        var issued=agent(AgentCredentials.Scope.QQ_BIND);
        var collector=credentials.authenticate("Bearer "+token);
        qqBindings.issue(collector,new QqBindings.CodeRequest(UUID.randomUUID(),"xuid:123456789","0011AABB"));
        jdbc.update("UPDATE qq_binding_codes SET expires_at=?,created_at=?",TelemetryService.time(Instant.now().minusSeconds(1)),
            TelemetryService.time(Instant.now().minusSeconds(31)));
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> qqBindings.bind(identity(issued),server,new QqBindings.Claim("12345678","0011AABB")))
            .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        qqBindings.issue(collector,new QqBindings.CodeRequest(UUID.randomUUID(),"xuid:123456789","1122AABB"));
        try(var pool=Executors.newFixedThreadPool(2)) {
            var start=new CountDownLatch(1);
            var outcomes=new ArrayList<Future<Boolean>>();
            for(String qqId:List.of("12345678","87654321")) outcomes.add(pool.submit(() -> {
                start.await();
                try { return qqBindings.bind(identity(issued),server,new QqBindings.Claim(qqId,"1122AABB")).bound(); }
                catch(org.springframework.web.server.ResponseStatusException ex) { return false; }
            }));
            start.countDown();
            assertThat(outcomes.get(0).get() ^ outcomes.get(1).get()).isTrue();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qq_player_bindings",Integer.class)).isEqualTo(1);
    }

    @Test void worldQueriesKeepLiveOfflineAndHistoricalPlayerDataSeparate() throws Exception {
        UUID boot=heartbeat();
        var issued=agent(AgentCredentials.Scope.WORLD_READ);
        var collector=credentials.authenticate("Bearer "+token);
        String key="xuid:123456789";
        var request=new WorldQueries.Request(UUID.randomUUID(),WorldQueries.Kind.PLAYER,key,null,null,null,null,null,null);
        var pending=worldQueries.create(identity(issued),server,request);
        assertThat(worldQueries.create(identity(issued),server,request).id()).isEqualTo(pending.id());
        var lease=worldQueries.claim(collector,boot).getFirst();
        assertThat(lease.id()).isEqualTo(pending.id());
        Instant observed=Instant.now().truncatedTo(ChronoUnit.MILLIS);
        var data=json.createObjectNode().put("playerKey",key).put("health",20);
        data.set("position",json.createObjectNode().put("x",1).put("y",64).put("z",2));
        var result=new WorldQueries.Observation(lease.leaseId(),boot,observed,"READY",data);
        assertThat(worldQueries.complete(collector,lease.id(),result).status()).isEqualTo("READY");
        assertThat(worldQueries.complete(collector,lease.id(),result).observedAt()).isEqualTo(observed);
        var offline=worldQueries.create(identity(issued),server,new WorldQueries.Request(UUID.randomUUID(),WorldQueries.Kind.PLAYER,key,null,null,null,null,null,null));
        var next=worldQueries.claim(collector,boot).getFirst();
        var response=worldQueries.complete(collector,next.id(),new WorldQueries.Observation(next.leaseId(),boot,
            Instant.now().truncatedTo(ChronoUnit.MILLIS),"PLAYER_OFFLINE",json.createObjectNode()));
        assertThat(response.id()).isEqualTo(offline.id());
        assertThat(response.status()).isEqualTo("PLAYER_OFFLINE");
        assertThat(response.lastKnown().observedAt()).isEqualTo(observed);
        assertThat(response.lastKnown().data()).isEqualTo(data);
        assertThat(agentGet(issued,"/servers/"+server+"/players/"+key+"/world-snapshot").get("status").asText()).isEqualTo("HISTORY");
        var oldSnapshot=new WorldQueries.PlayerSnapshot(key,observed.minusSeconds(60),json.createObjectNode().put("playerKey",key).put("health",1));
        worldQueries.snapshots(collector,new WorldQueries.Snapshots(boot,List.of(oldSnapshot)));
        assertThat(worldQueries.lastPlayer(identity(issued),server,key).data().get("health").asInt()).isEqualTo(20);
    }

    @Test void worldQueriesRejectOtherAgentsRevocationWrongBootAndChangedRequests() throws Exception {
        UUID boot=heartbeat(); var collector=credentials.authenticate("Bearer "+token);
        var issued=agent(AgentCredentials.Scope.WORLD_READ);
        var reader=agent(AgentCredentials.Scope.STATS_READ);
        mvc.perform(get("/api/agent/servers/"+server+"/players/xuid:123456789/world-snapshot")
            .header("Authorization","Bearer "+reader.token())).andExpect(status().isForbidden());
        var request=new WorldQueries.Request(UUID.randomUUID(),WorldQueries.Kind.BLOCK,null,"minecraft:overworld",1,64,2,null,null);
        var pending=worldQueries.create(identity(issued),server,request);
        var other=agent(AgentCredentials.Scope.WORLD_READ);
        mvc.perform(get("/api/agent/world-queries/"+pending.id()).header("Authorization","Bearer "+other.token())).andExpect(status().isNotFound());
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> worldQueries.create(identity(issued),server,
            new WorldQueries.Request(request.requestId(),WorldQueries.Kind.WORLD,null,null,null,null,null,null,null)))
            .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> worldQueries.claim(collector,UUID.randomUUID()))
            .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        var lease=worldQueries.claim(collector,boot).getFirst();
        agents.revoke(issued.account().id());
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> worldQueries.complete(collector,lease.id(),
            new WorldQueries.Observation(lease.leaseId(),boot,Instant.now().truncatedTo(ChronoUnit.MILLIS),"READY",json.createObjectNode())))
            .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        var another=worldQueries.create(identity(other),server,new WorldQueries.Request(UUID.randomUUID(),WorldQueries.Kind.WORLD,null,null,null,null,null,null,null));
        jdbc.update("UPDATE world_queries SET expires_at=? WHERE id=?",TelemetryService.time(Instant.now().minusSeconds(1)),another.id());
        assertThat(worldQueries.get(identity(other),another.id()).status()).isEqualTo("EXPIRED");
        archives.archive(server,LocalDate.now(zone));
        var archived=worldQueries.create(identity(other),server,new WorldQueries.Request(UUID.randomUUID(),WorldQueries.Kind.WORLD,null,null,null,null,null,null,null));
        assertThat(archived.status()).isEqualTo("UNAVAILABLE");
    }

    @Test void worldStateCacheKeepsItsBoundWhenANewTargetArrives() throws Exception {
        UUID boot=heartbeat(); var collector=credentials.authenticate("Bearer "+token);
        var rows=new ArrayList<Object[]>();
        for(int i=0;i<10000;i++) rows.add(new Object[]{server,String.format("%064x",i),
            TelemetryService.time(Instant.EPOCH.plusSeconds(i)),"{}"});
        jdbc.batchUpdate("INSERT INTO world_state_cache(server_id,target_hash,observed_at,data_json) VALUES (?,?,?,?)",rows);
        var data=json.createObjectNode().put("playerKey","xuid:123456789").put("health",20);
        worldQueries.snapshots(collector,new WorldQueries.Snapshots(boot,
            List.of(new WorldQueries.PlayerSnapshot("xuid:123456789",Instant.now().truncatedTo(ChronoUnit.MILLIS),data))));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM world_state_cache WHERE server_id=?",Integer.class,server)).isEqualTo(10000);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM world_state_cache WHERE server_id=? AND target_hash=?",Integer.class,server,"0".repeat(64))).isZero();
    }
    @Test void constructionModelsCaptureAllHeightsFreezeRejectBoundsAndDelete() throws Exception {
        UUID boot=heartbeat();var collector=credentials.authenticate("Bearer "+token);
        var receipt=projects.admin(server,projectRequest("CREATE","三维小屋",-1,-1,7,7));var id=receipt.projectId();
        assertThat(models.plan(collector,new ConstructionModels.Boot(boot))).hasSize(1);
        var palette=List.of(new ConstructionModels.Block("minecraft:air",""),new ConstructionModels.Block("minecraft:oak_stairs","{states:{upside_down_bit:1b}}"));
        var section=new ConstructionModels.Section(0,96,0,palette,List.of(1,1,0,511));
        Instant at=Instant.now().plusMillis(1).truncatedTo(ChronoUnit.MILLIS);
        var capture=new ConstructionModels.Capture(boot,id,1,at,section);
        assertThat(models.capture(collector,capture).get("changed")).isTrue();
        assertThat(models.capture(collector,capture).get("changed")).isFalse();
        assertThat(models.status(id,1).blocks()).isEqualTo(1);assertThat(models.status(id,1).version()).isEqualTo(1);
        mvc.perform(get("/api/public/projects/"+id+"/phases/1/model")).andExpect(status().isOk()).andExpect(jsonPath("$.sections[0].data.palette[1].name").value("minecraft:oak_stairs"));
        // Entire section replacement records removals, rather than accumulating phantom blocks.
        var empty=new ConstructionModels.Section(0,96,0,List.of(palette.getFirst()),List.of(0,512));
        models.capture(collector,new ConstructionModels.Capture(boot,id,1,at.plusMillis(2),empty));
        models.capture(collector,capture);assertThat(models.status(id,1).blocks()).isZero();
        // Negative coordinates / underground heights, clipping on all edges, and malformed runs.
        var underground=new ConstructionModels.Section(-8,-64,-8,palette,List.of(0,63,1,1,0,448));
        models.capture(collector,new ConstructionModels.Capture(boot,id,1,at,underground));
        var outside=new ConstructionModels.Section(-8,-64,-8,palette,List.of(1,1,0,511));
        var bad=new ConstructionModels.Capture(boot,id,1,at.plusMillis(3),outside);
        mvc.perform(post("/api/ingest/v1/project-models/capture").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsBytes(bad))).andExpect(status().isBadRequest());
        mvc.perform(post("/api/ingest/v1/project-models/capture").contentType("application/json").content(json.writeValueAsBytes(capture))).andExpect(status().isUnauthorized());
        projects.admin(server,projectRequest("COMPLETE","三维小屋",null,null,null,null));
        assertThat(models.plan(collector,new ConstructionModels.Boot(boot))).isEmpty();
        mvc.perform(post("/api/ingest/v1/project-models/capture").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsBytes(capture))).andExpect(status().isConflict());
        assertThat(models.status(id,1).blocks()).isEqualTo(1);
        projects.admin(server,projectRequest("RESUME","三维小屋",null,null,null,null));assertThat(models.status(id,2).sections()).isZero();
        assertThat(models.page(id,1,null).sections()).hasSize(1);
        projects.admin(server,projectRequest("UPDATE","三维小屋",20,20,30,30));assertThat(models.plan(collector,new ConstructionModels.Boot(boot)).getFirst().revision()).isEqualTo(3);
        projects.delete(server,id);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM construction_model_sections",Integer.class)).isZero();
        mvc.perform(get("/api/public/projects/"+id+"/phases/1/model")).andExpect(status().isNotFound());
    }
    @Test void constructionModelsPageWithoutLeakingOtherProjectsAndRejectOldBoot() throws Exception {
        UUID boot=heartbeat();var collector=credentials.authenticate("Bearer "+token);
        var id=projects.admin(server,projectRequest("CREATE","模型分页",0,0,200,7)).projectId();
        Instant at=Instant.now().plusMillis(1).truncatedTo(ChronoUnit.MILLIS);
        var palette=List.of(new ConstructionModels.Block("minecraft:air",""),new ConstructionModels.Block("minecraft:stone",""));
        for(int i=0;i<20;i++)models.capture(collector,new ConstructionModels.Capture(boot,id,1,at,new ConstructionModels.Section(i*8,64,0,palette,List.of(1,512))));
        var page=models.page(id,1,null);assertThat(page.sections()).hasSize(16);assertThat(page.next()).isNotNull();
        var last=models.page(id,1,page.next());assertThat(last.sections()).hasSize(4);assertThat(last.next()).isNull();assertThat(last.sections().getFirst().x()).isEqualTo(128);
        var other=projects.admin(server,projectRequest("CREATE","另一模型",0,0,200,7)).projectId();assertThat(models.page(other,1,null).sections()).isEmpty();
        heartbeat();
        mvc.perform(post("/api/ingest/v1/project-models/plan").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsBytes(new ConstructionModels.Boot(boot)))).andExpect(status().isBadRequest());
        mvc.perform(get("/api/public/projects/"+id+"/phases/1/model?after=invalid")).andExpect(status().isBadRequest());
    }
    @Test void constructionScenesPreserveExtraLayersAndVisibleEntitiesWithoutPrivateInventory() throws Exception {
        UUID boot=heartbeat();var collector=credentials.authenticate("Bearer "+token);
        var id=projects.admin(server,projectRequest("CREATE","完整场景",1,1,7,7)).projectId();
        var palette=List.of(new ConstructionModels.Block("minecraft:air",""),new ConstructionModels.Block("minecraft:water",""));
        var scene=json.readTree("""
            {"version":1,"extraRuns":[0,9,1,1,0,502],"blocksComplete":true,"entitiesComplete":true,"biomePalette":["minecraft:forest"],"biomeRuns":[0,512],
             "blockEntities":[{"index":9,"data":{"id":"Sign","FrontText":{"Text":"工程小屋","SignTextColor":-16777216}}}],
             "entities":[{"id":"42","type":"minecraft:armor_stand","x":2.5,"y":65,"z":2.5,"pitch":0,"yaw":90,
                "data":{"Armor":[{"Name":"minecraft:diamond_chestplate","Count":1,"tag":{"ench":[{"id":0,"lvl":1}]}}]}}]}
            """);
        Instant at=Instant.now().plusMillis(1).truncatedTo(ChronoUnit.MILLIS);
        var part=new ConstructionModels.Section(0,64,0,palette,List.of(0,512),scene);
        models.capture(collector,new ConstructionModels.Capture(boot,id,1,at,part));
        assertThat(models.status(id,1).blocks()).isZero();
        // Non-air geometry can exist in the extra layer, or only as an entity in an empty section.
        mvc.perform(get("/api/public/projects/"+id+"/phases/1/model")).andExpect(status().isOk())
            .andExpect(jsonPath("$.sections[0].data.scene.entities[0].type").value("minecraft:armor_stand"))
            .andExpect(jsonPath("$.sections[0].data.scene.blockEntities[0].data.FrontText.Text").value("工程小屋"));
        for(String forbidden:List.of("Inventory","OwnerNew","EnderChestInventory")) {
            var bad=scene.deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)bad.path("entities").get(0).get("data")).put(forbidden,"private");
            var request=new ConstructionModels.Capture(boot,id,1,at.plusMillis(1),new ConstructionModels.Section(0,64,0,palette,List.of(0,512),bad));
            mvc.perform(post("/api/ingest/v1/project-models/capture").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsBytes(request))).andExpect(status().isBadRequest());
        }
        for(String encoding:List.of("[1,512]","[0,511]","[0,-1]","[0,513]")){
            var bad=scene.deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)bad).set("biomeRuns",json.readTree(encoding));
            mvc.perform(post("/api/ingest/v1/project-models/capture").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsBytes(new ConstructionModels.Capture(boot,id,1,at.plusMillis(2),new ConstructionModels.Section(0,64,0,palette,List.of(0,512),bad))))).andExpect(status().isBadRequest());
        }
        for(String type:List.of("minecraft:item","minecraft:player")){
            var bad=scene.deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)bad.path("entities").get(0)).put("type",type);
            mvc.perform(post("/api/ingest/v1/project-models/capture").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsBytes(new ConstructionModels.Capture(boot,id,1,at.plusMillis(2),new ConstructionModels.Section(0,64,0,palette,List.of(0,512),bad))))).andExpect(status().isBadRequest());
        }
        var outside=scene.deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)outside.path("entities").get(0)).put("x",0.5);
        mvc.perform(post("/api/ingest/v1/project-models/capture").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsBytes(new ConstructionModels.Capture(boot,id,1,at.plusMillis(2),new ConstructionModels.Section(0,64,0,palette,List.of(0,512),outside))))).andExpect(status().isBadRequest());
        var privateSign=scene.deepCopy();((com.fasterxml.jackson.databind.node.ObjectNode)privateSign.path("blockEntities").get(0).path("data").path("FrontText")).put("LastEditXuid","secret");
        mvc.perform(post("/api/ingest/v1/project-models/capture").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsBytes(new ConstructionModels.Capture(boot,id,1,at.plusMillis(2),new ConstructionModels.Section(0,64,0,palette,List.of(0,512),privateSign))))).andExpect(status().isBadRequest());
        projects.admin(server,projectRequest("COMPLETE","完整场景",null,null,null,null));
        assertThat(models.page(id,1,null).sections().getFirst().data().scene()).isEqualTo(scene);
        projects.admin(server,projectRequest("RESUME","完整场景",null,null,null,null));
        assertThat(models.page(id,2,null).sections()).isEmpty();
        var empty=json.readTree("{\"version\":1,\"extraRuns\":[0,512],\"blockEntities\":[],\"entities\":[],\"blocksComplete\":true,\"entitiesComplete\":true}");
        var nextAt=Instant.now().plusMillis(3).truncatedTo(ChronoUnit.MILLIS);
        models.capture(collector,new ConstructionModels.Capture(boot,id,2,nextAt,part));
        models.capture(collector,new ConstructionModels.Capture(boot,id,2,nextAt.plusMillis(1),new ConstructionModels.Section(0,64,0,palette,List.of(0,512),empty)));
        assertThat(models.page(id,2,null).sections()).isEmpty();
        assertThat(models.page(id,1,null).sections()).hasSize(1);
        projects.delete(server,id);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM construction_model_sections",Integer.class)).isZero();
    }
    @Test void constructionExportsRequireAdministratorAndCorrectServer() throws Exception {
        var id=projects.admin(server,projectRequest("CREATE","导出权限",0,0,7,7)).projectId();
        String endpoint="/api/servers/"+server+"/projects/"+id+"/phases/1/scene-export";
        mvc.perform(get(endpoint+"/status")).andExpect(status().isUnauthorized());
        mvc.perform(get(endpoint+"/"+UUID.randomUUID())).andExpect(status().isUnauthorized());
        mvc.perform(get(endpoint+"/status").with(user("reader").roles("VIEWER"))).andExpect(status().isForbidden());
        mvc.perform(get(endpoint+"/status").with(user("admin").roles("ADMIN"))).andExpect(status().isOk());
        mvc.perform(get("/api/servers/"+UUID.randomUUID()+"/projects/"+id+"/phases/1/scene-export/status").with(user("admin").roles("ADMIN"))).andExpect(status().isNotFound());
        mvc.perform(get("/api/public/projects/"+id+"/phases/1/scene/"+UUID.randomUUID()+"/scene-building.glb")).andExpect(status().isNotFound());
    }
    @Test void sceneHeightUsesOnlyRecordedPlacementsInsidePhaseAndBeforeSnapshot(@org.junit.jupiter.api.io.TempDir java.nio.file.Path temporary)throws Exception {
        UUID boot=heartbeat();var collector=credentials.authenticate("Bearer "+token);
        var id=projects.admin(server,projectRequest("CREATE","高度验收",0,0,7,7)).projectId();var at=Instant.now().plusMillis(1);
        var part=new ConstructionModels.Section(0,64,0,List.of(new ConstructionModels.Block("minecraft:air",""),new ConstructionModels.Block("minecraft:stone","")),List.of(1,512));
        models.capture(collector,new ConstructionModels.Capture(boot,id,1,at,part));
        var runner=temporary.resolve("fixture.mjs");java.nio.file.Files.writeString(runner,"""
            import {writeFile} from 'node:fs/promises';import path from 'node:path';const out=process.argv[3];
            const texture='a'.repeat(64)+'.png';const models=[-64,64,100].map(y=>({x:0,y,z:0,entity:false,faces:[{points:[0,0,0,16,0,0,16,16,0,0,16,0],uvs:[0,0,16,0,16,16,0,16],texture,doubleSided:true}]}));
            await writeFile(path.join(out,texture),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGPU6An4z8DAwMAEIkAYAB5AAgfNdB03AAAAAElFTkSuQmCC','base64'));
            await writeFile(path.join(out,'scene.json'),JSON.stringify({format:1,models,issues:[]}));
            await writeFile(path.join(out,'scene-info.json'),JSON.stringify({format:1,models:3,issues:[]}));
            """);
        for(String name:List.of("export-range.mjs","glb.mjs"))java.nio.file.Files.copy(java.nio.file.Path.of("../scene/"+name),temporary.resolve(name));
        var storage=temporary.resolve("scenes");var rendering=new ConstructionRendering(models,jdbc,json,transactionManager,runner.toString(),storage.toString(),"node");
        try {
            ConstructionRendering.State state=null;for(int n=0;n<200;n++){state=rendering.status(id,1);if(state.state().equals("READY")||state.state().equals("FAILED"))break;Thread.sleep(25);}assertThat(state.state()).isEqualTo("READY");var build=state.build();
            // Earlier and later players, unrelated horizontal coordinates, and BREAK must not move the default below 64.
            for(var row:List.of(new Object[]{64,0,"PLACE",at.minusSeconds(1)},new Object[]{-32,99,"PLACE",at.minusSeconds(1)},new Object[]{-50,0,"PLACE",at.plusSeconds(1)},new Object[]{-60,0,"BREAK",at.minusSeconds(1)}))
                jdbc.update("INSERT INTO construction_events VALUES (?,?,?,?,?,?,?,?,?,?,?)",id,1,UUID.randomUUID(),TelemetryService.time((Instant)row[3]),"xuid:qa","任何贡献玩家",row[2],"minecraft:stone",row[1],row[0],0);
            var range=rendering.heightRange(id,1,build);assertThat(range.minY()).isEqualTo(-64);assertThat(range.maxY()).isEqualTo(100);assertThat(range.suggestedMinY()).isEqualTo(64);assertThat(range.basis()).isEqualTo("PLAYER_PLACEMENT");
            var output=new java.io.ByteArrayOutputStream();rendering.writeRange(rendering.asset(id,1,build,"scene.json"),output,64,64);assertThat(json.readTree(output.toByteArray()).path("models")).hasSize(1);
            ConstructionRendering.State exported=null;for(int n=0;n<200;n++){exported=rendering.rangeExportStatus(server,id,1,build,64,64,false);if(exported.state().equals("READY")||exported.state().equals("FAILED"))break;Thread.sleep(25);}assertThat(exported.state()).isEqualTo("READY");
            var file=rendering.exportRange(server,id,1,build,64,64,false);var bytes=java.nio.file.Files.readAllBytes(file);assertThat(new String(bytes,0,4,java.nio.charset.StandardCharsets.UTF_8)).isEqualTo("glTF");
            int length=java.nio.ByteBuffer.wrap(bytes,12,4).order(java.nio.ByteOrder.LITTLE_ENDIAN).getInt();var gltf=json.readTree(new String(bytes,20,length,java.nio.charset.StandardCharsets.UTF_8));assertThat(gltf.path("extras").path("heightRange").path("minY").asInt()).isEqualTo(64);assertThat(gltf.path("images")).hasSize(1);
            org.assertj.core.api.Assertions.assertThatThrownBy(()->rendering.exportRange(UUID.randomUUID(),id,1,build,64,64,false)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
            projects.delete(server,id);org.assertj.core.api.Assertions.assertThatThrownBy(()->rendering.heightRange(id,1,build)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
            org.assertj.core.api.Assertions.assertThatThrownBy(()->rendering.exportRange(server,id,1,build,64,64,false)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        } finally {rendering.close();}
    }
    @Test void constructionRenderingCachesFrozenScenesAndRevokesDeletedAssets(@org.junit.jupiter.api.io.TempDir java.nio.file.Path temporary) throws Exception {
        UUID boot=heartbeat();var collector=credentials.authenticate("Bearer "+token);
        var id=projects.admin(server,projectRequest("CREATE","场景缓存",0,0,7,7)).projectId();
        var part=new ConstructionModels.Section(0,64,0,List.of(new ConstructionModels.Block("minecraft:air",""),new ConstructionModels.Block("minecraft:stone","")),List.of(1,1,0,511));
        models.capture(collector,new ConstructionModels.Capture(boot,id,1,Instant.now().plusMillis(1),part));
        projects.admin(server,projectRequest("COMPLETE","场景缓存",null,null,null,null));
        // Exercises process/cache/access boundaries; the separate native/browser test uses the real baker.
        var runner=temporary.resolve("fixture.mjs");
        java.nio.file.Files.writeString(runner,"""
            import {readFile,writeFile} from 'node:fs/promises';import path from 'node:path';
            const [input,out]=process.argv.slice(2),sections=JSON.parse(await readFile(input,'utf8'));
            if(sections.length!==1||sections[0].palette[1].name!=='minecraft:stone')process.exit(2);
            await writeFile(path.join(out,'scene.json'),JSON.stringify({format:1,models:[],issues:[]}));
            await writeFile(path.join(out,'scene-info.json'),JSON.stringify({format:1,models:0,issues:[]}));
            """);
        var storage=temporary.resolve("scenes");UUID build;
        var rendering=new ConstructionRendering(models,jdbc,json,transactionManager,runner.toString(),storage.toString(),"node");
        try {
            var first=rendering.status(id,1);build=first.build();
            for(int n=0;n<20;n++)assertThat(rendering.status(id,1).build()).isEqualTo(build);
            ConstructionRendering.State state=null;
            for(int n=0;n<200;n++){state=rendering.status(id,1);if(state.state().equals("READY")||state.state().equals("FAILED"))break;Thread.sleep(25);}
            assertThat(state.state()).isEqualTo("READY");
            assertThat(java.nio.file.Files.readString(rendering.asset(id,1,build,"scene.json"))).contains("models");
            org.assertj.core.api.Assertions.assertThatThrownBy(()->rendering.asset(id,1,build,"../input.json")).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
            org.assertj.core.api.Assertions.assertThatThrownBy(()->rendering.asset(id,1,UUID.randomUUID(),"scene.json")).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        } finally {rendering.close();}
        var restored=new ConstructionRendering(models,jdbc,json,transactionManager,runner.toString(),storage.toString(),"node");
        try {
            assertThat(restored.status(id,1).build()).isEqualTo(build);
            assertThat(restored.status(id,1).state()).isEqualTo("READY");
            var asset=restored.asset(id,1,build,"scene.json");projects.delete(server,id);
            org.assertj.core.api.Assertions.assertThatThrownBy(()->restored.asset(id,1,build,"scene.json")).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
            restored.cleanup();assertThat(java.nio.file.Files.exists(asset)).isFalse();
        } finally {restored.close();}
    }
    @Test void projectHistoryKeepsImmutableSectionsAndPointQueriesUseTheirOwnTime(@org.junit.jupiter.api.io.TempDir java.nio.file.Path temporary)throws Exception{
        UUID boot=heartbeat();var collector=credentials.authenticate("Bearer "+token);
        var id=projects.admin(server,projectRequest("CREATE","历史小屋",-8,-8,7,7)).projectId();
        var at=Instant.now().truncatedTo(ChronoUnit.MILLIS).plusMillis(1);
        var palette=List.of(new ConstructionModels.Block("minecraft:air",""),new ConstructionModels.Block("minecraft:stone","{\"states\":{}}"));
        var part=new ConstructionModels.Section(-8,64,-8,palette,List.of(0,63,1,1,0,448));
        models.capture(collector,new ConstructionModels.Capture(boot,id,1,at,part));
        var first=history.save(id,1);assertThat(history.save(id,1)).isEqualTo(first);
        jdbc.update("INSERT INTO construction_events VALUES (?,?,?,?,?,?,?,?,?,?,?)",id,1,UUID.randomUUID(),TelemetryService.time(at.minusMillis(1)),"xuid:1","早期建造者","PLACE","minecraft:stone",-1,64,-1);
        jdbc.update("INSERT INTO construction_events VALUES (?,?,?,?,?,?,?,?,?,?,?)",id,1,UUID.randomUUID(),TelemetryService.time(at.plusMillis(1)),"xuid:2","后来的玩家","BREAK","minecraft:stone",-1,64,-1);
        var empty=new ConstructionModels.Section(-8,64,-8,List.of(palette.getFirst()),List.of(0,512));
        models.capture(collector,new ConstructionModels.Capture(boot,id,1,at.plusMillis(2),empty));
        var second=history.save(id,1);assertThat(second).isNotEqualTo(first);
        assertThat(history.list(id,1,null).frames()).hasSize(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM construction_scene_blobs WHERE project_id=?",Integer.class,id)).isEqualTo(2);
        models.capture(collector,new ConstructionModels.Capture(boot,id,1,at.plusMillis(3),part));history.save(id,1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM construction_scene_blobs WHERE project_id=?",Integer.class,id)).isEqualTo(2);
        var writer=new java.io.StringWriter();history.write(id,1,first,writer);assertThat(writer.toString()).contains("minecraft:stone");
        mvc.perform(get("/api/public/projects/"+id+"/phases/1/scene/history")).andExpect(status().isOk()).andExpect(jsonPath("$.frames.length()").value(3));
        mvc.perform(get("/api/public/projects/"+id+"/phases/2/scene/history/"+first+"/status")).andExpect(status().isNotFound());
        var runner=temporary.resolve("fixture.mjs");java.nio.file.Files.writeString(runner,"""
            import {writeFile} from 'node:fs/promises';import path from 'node:path';const out=process.argv[3];
            await writeFile(path.join(out,'scene.json'),JSON.stringify({format:1,models:[],issues:[]}));
            await writeFile(path.join(out,'scene-info.json'),JSON.stringify({format:1,models:0,issues:[]}));
            """);
        var storage=temporary.resolve("scenes");var rendering=new ConstructionRendering(models,jdbc,json,transactionManager,runner.toString(),storage.toString(),"node");
        try{
            for(var frame:List.of(first,second)){
                ConstructionRendering.State state=null;for(int n=0;n<200;n++){state=rendering.historical(id,1,frame);if(state.state().equals("READY")||state.state().equals("FAILED"))break;Thread.sleep(25);}assertThat(state.state()).isEqualTo("READY");
            }
            var old=rendering.inspect(id,1,first,-1,64,-1);assertThat(old.block().name()).isEqualTo("minecraft:stone");assertThat(old.block().states()).contains("states");assertThat(old.observedAt()).isEqualTo(at);assertThat(old.events()).extracting(ConstructionRendering.BlockEvent::player).containsExactly("早期建造者");
            var newer=rendering.inspect(id,1,second,-1,64,-1);assertThat(newer.block().name()).isEqualTo("minecraft:air");assertThat(newer.events()).hasSize(2);
            assertThat(rendering.inspect(id,1,first,0,64,0).known()).isFalse();
            org.assertj.core.api.Assertions.assertThatThrownBy(()->rendering.inspect(id,1,first,99,64,0)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
            assertThat(java.nio.file.Files.exists(storage.resolve(id.toString()).resolve("1/latest.json"))).isFalse();
            projects.delete(server,id);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM construction_scene_snapshots WHERE project_id=?",Integer.class,id)).isZero();assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM construction_scene_blobs WHERE project_id=?",Integer.class,id)).isZero();
            org.assertj.core.api.Assertions.assertThatThrownBy(()->rendering.inspect(id,1,first,-1,64,-1)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        }finally{rendering.close();}
    }
    ConstructionProjects.Request projectRequest(String action,String name,Integer x1,Integer z1,Integer x2,Integer z2) {
        return new ConstructionProjects.Request(UUID.randomUUID(),action,null,name,"minecraft:overworld",x1,z1,x2,z2);
    }
    @Test void constructionRangeChangesFreezeOldPhasesAndEnforceCreator() throws Exception {
        send(token,batch(counter("blocks.mined",1,"minecraft:stone"))).andExpect(status().isOk());
        var collector=credentials.authenticate("Bearer "+token);
        var create=projectRequest("CREATE","小屋",0,0,10,10);
        var receipt=projects.collector(collector,"xuid:123456789",create);
        assertThat(projects.collector(collector,"xuid:123456789",create)).isEqualTo(receipt);
        var id=receipt.projectId();
        var inside=counter("blocks.placed",1,"minecraft:stone").put("at",Instant.now().truncatedTo(ChronoUnit.MILLIS).toString());
        inside.putObject("position").put("x",10).put("y",310).put("z",10);
        var outside=counter("blocks.placed",1,"minecraft:dirt").put("at",Instant.now().truncatedTo(ChronoUnit.MILLIS).toString());
        outside.putObject("position").put("x",11).put("y",-60).put("z",10);
        send(token,batch(inside,outside)).andExpect(status().isOk());send(token,batch(inside)).andExpect(status().isOk());
        assertThat(projects.detail(id,null).statistics().path("materials").get(0).path("count").asText()).isEqualTo("1");
        var image=new byte[]{(byte)137,80,78,71,13,10,26,10};
        jdbc.update("UPDATE construction_phases SET map_image=?,map_at=CURRENT_TIMESTAMP WHERE project_id=? AND revision=1",image,id);
        org.assertj.core.api.Assertions.assertThatThrownBy(()->projects.collector(collector,"xuid:987654321",new ConstructionProjects.Request(UUID.randomUUID(),"UPDATE",id,"小屋",null,20,20,30,30))).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        var update=projectRequest("UPDATE","小屋",20,20,30,30);
        assertThat(projects.collector(collector,"xuid:123456789",update).revision()).isEqualTo(2);
        assertThat(projects.collector(collector,"xuid:123456789",update).revision()).isEqualTo(2);
        assertThat(projects.detail(id,1).project().maxX()).isEqualTo(10);
        assertThat(projects.detail(id,1).project().status()).isEqualTo("COMPLETE");
        assertThat(projects.image(id,1)).isEqualTo(image);
        assertThat(projects.detail(id,2).project().minX()).isEqualTo(20);
        var second=counter("blocks.placed",1,"minecraft:dirt").put("at",Instant.now().truncatedTo(ChronoUnit.MILLIS).toString());
        second.putObject("position").put("x",20).put("y",-60).put("z",20);
        second.set("player",player("987654321","Bob"));
        send(token,batch(second)).andExpect(status().isOk());
        projects.collector(collector,"xuid:123456789",projectRequest("COMPLETE","小屋",null,null,null,null));
        assertThat(projects.detail(id,2).project().status()).isEqualTo("COMPLETE");
        assertThat(projects.detail(id,2).mapAvailable()).isFalse();
        var frozen=projects.detail(id,2).statistics();
        assertThat(frozen.path("contributors").size()).isEqualTo(2);
        assertThat(frozen.path("contributors").toString()).contains("Alice","Bob");
        var late=second.deepCopy().put("eventId",UUID.randomUUID().toString());send(token,batch(late)).andExpect(status().isOk());
        assertThat(projects.detail(id,2).statistics()).isEqualTo(frozen);
        org.assertj.core.api.Assertions.assertThatThrownBy(()->projects.collector(collector,"xuid:123456789",projectRequest("UPDATE","小屋",1,1,2,2))).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThat(projects.collector(collector,"xuid:123456789",projectRequest("RESUME","小屋",null,null,null,null)).revision()).isEqualTo(3);
        late.put("eventId",UUID.randomUUID().toString()).put("at",Instant.now().minusSeconds(20).truncatedTo(ChronoUnit.MILLIS).toString());
        send(token,batch(late)).andExpect(status().isOk());
        assertThat(projects.detail(id,3).statistics()).isEqualTo(frozen);
        String body=mvc.perform(get("/api/public/projects/"+id+"?revision=1")).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        assertThat(body).doesNotContain("xuid:","playerKey","qqId");
        mvc.perform(post("/api/public/projects/"+id)).andExpect(status().isForbidden());
        mvc.perform(get("/api/public/projects/"+id+"/phases/1/map.png")).andExpect(status().isOk()).andExpect(content().bytes(image));
        assertThat(admin("/api/servers/"+server+"/daily-report?date="+LocalDate.now(zone)).path("materials").isArray()).isTrue();
    }
    @Test void constructionAgentWritesRequireGrantedScopeAndTrustedBinding() throws Exception {
        send(token,batch(counter("blocks.mined",1,"minecraft:stone"))).andExpect(status().isOk());
        var issued=agent(AgentCredentials.Scope.QQ_BIND,AgentCredentials.Scope.PROJECT_WRITE,AgentCredentials.Scope.WORLD_READ);
        var collector=credentials.authenticate("Bearer "+token);
        var create=projectRequest("CREATE","绑定工程",-2,-2,2,2);
        org.assertj.core.api.Assertions.assertThatThrownBy(()->projects.agent(identity(issued),server,"12345678",create)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        qqBindings.issue(collector,new QqBindings.CodeRequest(UUID.randomUUID(),"xuid:123456789","ABCD0001"));
        qqBindings.bind(identity(issued),server,new QqBindings.Claim("12345678","ABCD0001"));
        var receipt=projects.agent(identity(issued),server,"12345678",create);
        assertThat(projects.project(receipt.projectId()).creator()).isEqualTo("Alice");
        var reader=agent(AgentCredentials.Scope.QQ_BIND,AgentCredentials.Scope.WORLD_READ);
        org.assertj.core.api.Assertions.assertThatThrownBy(()->projects.agent(identity(reader),server,"12345678",projectRequest("UPDATE","绑定工程",1,1,3,3))).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThat(projects.agent(identity(issued),server,"12345678",projectRequest("UPDATE","绑定工程",1,1,3,3)).revision()).isEqualTo(2);
        assertThat(agentGet(issued,"/servers/"+server+"/projects").size()).isEqualTo(1);
        assertThat(agentGet(reader,"/servers/"+server+"/projects?name=绑定工程").size()).isEqualTo(1);
        assertThat(agentGet(reader,"/servers/"+server+"/projects?name=不存在").size()).isZero();
        var linking=new ConstructionProjects(jdbc,json,agents,credentials,qqBindings,"https://public.example.test/");
        assertThat(linking.project(receipt.projectId()).mapUrl()).isEqualTo("https://public.example.test/projects/"+receipt.projectId());
        assertThat(agentGet(issued,"/servers/"+server+"/projects/"+receipt.projectId()).path("project").path("minX").asInt()).isEqualTo(1);
        var bad=counter("items.used",1,"minecraft:apple");bad.putObject("position").put("x",0).put("y",0).put("z",0);
        send(token,batch(bad)).andExpect(status().isBadRequest());
    }
    @Test void constructionMapWorkerSavesOnlyActivePhasesAndNeverFillsFrozenBlanks() throws Exception {
        var http=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);
        var calls=new java.util.concurrent.atomic.AtomicInteger();var requested=new java.util.concurrent.CopyOnWriteArrayList<JsonNode>();
        byte[] png=Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=");
        http.createContext("/internal/project-map",exchange->{
            assertThat(exchange.getRequestMethod()).isEqualTo("POST");requested.add(json.readTree(exchange.getRequestBody()));calls.incrementAndGet();
            var bytes=json.writeValueAsBytes(Map.of("image",Base64.getEncoder().encodeToString(png),"metadata",Map.of("foundTiles",1,"tileCoverageComplete",true)));
            exchange.sendResponseHeaders(200,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();
        });http.start();
        try {
            var worker=new ConstructionMapWorker(jdbc,json,agents,transactionManager,server+"=http://127.0.0.1:"+http.getAddress().getPort());
            var id=projects.admin(server,projectRequest("CREATE","地图工程",0,0,10,10)).projectId();
            worker.refresh();assertThat(projects.image(id,1)).isEqualTo(png);assertThat(calls.get()).isEqualTo(1);
            assertThat(requested.getFirst().path("maxX").asInt()).isEqualTo(10);
            projects.admin(server,projectRequest("COMPLETE","地图工程",null,null,null,null));worker.refresh();assertThat(calls.get()).isEqualTo(1);
            projects.admin(server,projectRequest("RESUME","地图工程",null,null,null,null));
            projects.admin(server,projectRequest("UPDATE","地图工程",20,20,30,30));worker.refresh();
            assertThat(calls.get()).isEqualTo(2);assertThat(requested.get(1).path("minX").asInt()).isEqualTo(20);
            assertThat(projects.detail(id,2).mapAvailable()).isFalse();assertThat(projects.detail(id,2).project().status()).isEqualTo("COMPLETE");
            assertThat(projects.image(id,1)).isEqualTo(png);assertThat(projects.image(id,3)).isEqualTo(png);
        }finally{http.stop(0);}
    }
    @Test void adminProjectDeletionRemovesPublicDataWithoutChangingServerTotalsOrReplayingCreates() throws Exception {
        send(token,batch(counter("blocks.mined",7,"minecraft:stone"))).andExpect(status().isOk());
        var collector=credentials.authenticate("Bearer "+token);
        var request=projectRequest("CREATE","删除验收",0,0,10,10);
        var receipt=projects.collector(collector,"xuid:123456789",request);var id=receipt.projectId();
        var event=counter("blocks.placed",1,"minecraft:stone").put("at",Instant.now().truncatedTo(ChronoUnit.MILLIS).toString());event.putObject("position").put("x",1).put("y",100).put("z",1);
        send(token,batch(event)).andExpect(status().isOk());
        String endpoint="/api/servers/"+server+"/projects/"+id;
        var reader=agent(AgentCredentials.Scope.PROJECT_WRITE,AgentCredentials.Scope.WORLD_READ);
        mvc.perform(delete(endpoint).with(csrf()).header("Authorization","Bearer "+reader.token())).andExpect(status().isUnauthorized());
        mvc.perform(delete(endpoint).with(user("admin").roles("ADMIN"))).andExpect(status().isForbidden());
        mvc.perform(delete("/api/servers/"+UUID.randomUUID()+"/projects/"+id).with(user("admin").roles("ADMIN")).with(csrf())).andExpect(status().isBadRequest());
        for(int i=0;i<2;i++)mvc.perform(delete(endpoint).with(user("admin").roles("ADMIN")).with(csrf())).andExpect(status().isNoContent());
        for(String table:List.of("construction_projects","construction_phases","construction_events","construction_requests"))assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM "+table,Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM construction_deleted_requests",Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM telemetry_events",Integer.class)).isEqualTo(2);
        mvc.perform(get("/api/public/projects/"+id)).andExpect(status().isNotFound());
        mvc.perform(get("/api/public/projects/"+id+"/phases/1/map.png")).andExpect(status().isNotFound());
        mvc.perform(post("/api/ingest/v1/projects").header("Authorization","Bearer "+token).contentType("application/json").content(json.writeValueAsBytes(new ConstructionController.CollectorRequest("xuid:123456789",request)))).andExpect(status().isGone());
        assertThat(projects.list(server)).isEmpty();
        var next=projects.collector(collector,"xuid:123456789",projectRequest("CREATE","删除验收",0,0,10,10));assertThat(next.projectId()).isNotEqualTo(id);
        projects.collector(collector,"xuid:123456789",projectRequest("COMPLETE","删除验收",null,null,null,null));
        projects.delete(server,next.projectId());assertThat(projects.list(server)).isEmpty();
    }
    @Autowired ExplorationDetails explorationDetails;
    @Test void hostRuntimeAndExtendedChartsUseExistingScopedData() throws Exception {
        var now=Instant.now().truncatedTo(ChronoUnit.MILLIS);var boot=UUID.randomUUID();
        for(int i=0;i<5;i++){
            var input=runtimeBatch(boot,i+1,now.minusSeconds(60-i*10),200);var runtime=(ObjectNode)input.at("/collector/runtime");
            runtime.put("hostCpuPercent",List.of(10,20,30,40,100).get(i)).put("hostLogicalProcessors",8).put("hostNetworkReceiveBps",1024).put("hostNetworkSendBps",512);
            runtime.putArray("hostDisks").addObject().put("drive","C:").put("totalBytes",100000).put("availableBytes",40000);
            send(token,input).andExpect(status().isOk());
        }
        var live=admin("/api/servers/"+server+"/runtime?hours=1");assertThat(live.at("/latest/hostCpuPercent").asDouble()).isEqualTo(100);
        assertThat(live.at("/latest/hostDisks/0/drive").asText()).isEqualTo("C:");assertThat(live.at("/points/0/hostNetworkReceiveBps").asDouble()).isEqualTo(1024);
        var legacy=runtimeBatch(boot,6,now,200);var parsed=json.treeToValue(legacy.at("/collector/runtime"),TelemetryPayload.RuntimeSample.class);
        assertThat(json.valueToTree(parsed).has("hostCpuPercent")).isFalse();send(token,legacy).andExpect(status().isOk());
        legacy.put("batchId",UUID.randomUUID().toString());send(token,legacy).andExpect(status().isOk());
        var date=now.atZone(zone).toLocalDate();var details=explorationDetails.get(server,date,date);
        var host=details.runtime().stream().filter(r->"host_cpu".equals(r.get("metric"))).findFirst().orElseThrow();
        assertThat(((Number)host.get("samples")).intValue()).isEqualTo(5);assertThat(((Number)host.get("q1")).doubleValue()).isEqualTo(20);assertThat(((Number)host.get("median")).doubleValue()).isEqualTo(30);assertThat(((Number)host.get("q3")).doubleValue()).isEqualTo(40);
        assertThat(explorationDetails.get(server,date,date)).isSameAs(details);
        var other=archives.create("其他主机","",date).id();assertThat(explorationDetails.get(other,date,date).runtime()).isEmpty();
        mvc.perform(get("/api/statistics/exploration/extended?serverId="+server).with(user("reader").roles("VIEWER"))).andExpect(status().isOk());
        mvc.perform(get("/api/statistics/exploration/extended?serverId="+server)).andExpect(status().isUnauthorized());
        var invalid=runtimeBatch(boot,7,now,200);((ObjectNode)invalid.at("/collector/runtime")).put("hostCpuPercent",101);send(token,invalid).andExpect(status().isBadRequest());
        var badDisk=runtimeBatch(boot,7,now,200);((ObjectNode)badDisk.at("/collector/runtime")).putArray("hostDisks").addObject().put("drive","C:").put("totalBytes",100).put("availableBytes",101);send(token,badDisk).andExpect(status().isBadRequest());
    }
    @Autowired ExplorationStatistics exploration;
    @Test void explorationSeparatesMissingCoordinatesAndSplitsHours() throws Exception {
        var positioned=counter("blocks.placed",1,"minecraft:stone");positioned.set("position",json.createObjectNode().put("x",-1).put("y",-1).put("z",-33));
        UUID sessionId=UUID.randomUUID();send(token,batch(positioned,counter("blocks.placed",2,"minecraft:dirt"),session(sessionId,0,0,false,"minecraft:overworld"),session(sessionId,1,20000,true,"minecraft:overworld"))).andExpect(status().isOk());
        var id=projects.admin(server,projectRequest("CREATE","协作工程",-5,-40,5,5)).projectId();
        for(String player:List.of("xuid:123456789","xuid:987654321"))jdbc.update("INSERT INTO construction_events VALUES (?,?,?,?,?,?,?,?,?,?,?)",id,1,UUID.randomUUID(),TelemetryService.time(base),player,"伙伴","PLACE","minecraft:stone",-1,-1,-33);
        var date=base.atZone(zone).toLocalDate();var result=exploration.get(server,date,date.plusDays(1));
        assertThat(result.hours()).hasSize(2);assertThat(result.hours().stream().mapToLong(r->((Number)r.get("millis")).longValue()).sum()).isEqualTo(20000);
        assertThat(((Number)result.coverage().get("recorded_blocks")).intValue()).isEqualTo(3);assertThat(((Number)result.coverage().get("positioned_blocks")).intValue()).isEqualTo(1);
        assertThat(result.hotspots()).hasSize(1);assertThat(((Number)result.hotspots().getFirst().get("x")).intValue()).isEqualTo(-32);assertThat(((Number)result.hotspots().getFirst().get("z")).intValue()).isEqualTo(-64);
        assertThat(((Number)result.heights().getFirst().get("y")).intValue()).isEqualTo(-8);assertThat(result.contributions()).hasSize(2);assertThat(((Number)result.ranking().getFirst().get("value")).intValue()).isEqualTo(3);
        assertThat(exploration.get(server,date,date.plusDays(1))).isSameAs(result);
        var other=archives.create("另一个服","",date).id();assertThat(exploration.get(other,date,date.plusDays(1)).ranking()).isEmpty();
        org.assertj.core.api.Assertions.assertThatThrownBy(()->exploration.get(server,date.minusDays(32),date)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        mvc.perform(get("/api/statistics/exploration?serverId="+server+"&from="+date+"&to="+date.plusDays(1)).with(user("reader").roles("VIEWER"))).andExpect(status().isOk());
        mvc.perform(get("/api/statistics/exploration?serverId="+server)).andExpect(status().isUnauthorized());
    }
    ObjectNode counter(String metric, long value, String subject) {
        ObjectNode event = json.createObjectNode().put("eventId", UUID.randomUUID().toString()).put("kind", "COUNTER").put("at", base.toString())
                .put("metric", metric).put("value", value).put("dimension", "minecraft:overworld");
        event.set("player", player("123456789", "Alice"));
        if (subject != null) event.put("subject", subject);
        return event;
    }
    ObjectNode session(UUID id, long sequence, long millis, boolean ended, String dimension) {
        ObjectNode event = json.createObjectNode().put("eventId", UUID.randomUUID().toString()).put("kind", "SESSION")
                .put("at", base.plusMillis(millis).toString()).put("sessionId", id.toString()).put("startedAt", base.toString())
                .put("sequence", sequence).put("onlineMillis", millis).put("ended", ended).put("dimension", dimension);
        event.set("player", player("123456789", "Alice")); return event;
    }
    ObjectNode death(String cause) {
        ObjectNode event = json.createObjectNode().put("eventId", UUID.randomUUID().toString()).put("kind", "DEATH")
                .put("at", base.plusSeconds(1).toString()).put("dimension", "minecraft:nether").put("cause", cause).put("killerType", "minecraft:zombie");
        event.set("player", player("123456789", "Alice")); return event;
    }
    ObjectNode capability(String metric, String quality, String version, boolean dimensional) {
        return json.createObjectNode().put("metric", metric).put("state", "ACTIVE").put("quality", quality).put("algorithmVersion", version).put("dimensionAware", dimensional);
    }
    ObjectNode batch(ObjectNode... events) {
        ObjectNode batch = json.createObjectNode().put("protocolVersion", 1).put("batchId", UUID.randomUUID().toString()).put("reportedAt", Instant.now().truncatedTo(ChronoUnit.MILLIS).toString());
        batch.set("collector", json.createObjectNode().put("version", "qa-1").put("bdsVersion", "qa-bds").put("leviLaminaVersion", "qa-ll").put("bootId", UUID.randomUUID().toString()).put("pendingEvents", 0));
        ArrayNode caps = batch.putArray("capabilities");
        for (var metric : MetricCatalog.ALL.values()) caps.add(capability(metric.key(), metric.estimatedOnly() ? "ESTIMATED" : "EXACT", "test-v1", true));
        ArrayNode array = batch.putArray("events"); for (ObjectNode event : events) array.add(event);
        return batch;
    }
    ObjectNode runtimeBatch(UUID boot,long sequence,Instant at,int ticks) {
        var b=batch();var c=(ObjectNode)b.get("collector");c.put("bootId",boot.toString());
        c.putObject("runtime").put("sequence",sequence).put("at",at.toString()).put("windowMillis",10000).put("uptimeMillis",100000)
            .put("ticks",ticks).put("players",3).put("lastTickAt",at.toString()).put("maxTickIntervalMillis",ticks<180?400:52)
            .put("cpuPercent",12.5).put("workingSetBytes",1073741824L).put("privateBytes",2000000000L)
            .put("hostMemoryTotalBytes",16000000000L).put("hostMemoryAvailableBytes",8000000000L).put("stopped",false);
        return b;
    }
    @Test void activityPreservesConfirmedBlockCoordinatesWithoutInventingLegacyLocations() throws Exception {
        var placed=counter("blocks.placed",1,"minecraft:oak_planks");placed.putObject("position").put("x",-120).put("y",64).put("z",37);
        var legacy=counter("blocks.placed",1,"minecraft:stone");var payload=batch(placed,legacy);
        send(token,payload).andExpect(status().isOk());send(token,payload).andExpect(status().isOk());
        var reader=agent(AgentCredentials.Scope.STATS_READ);var feed=agentGet(reader,"/servers/"+server+"/activity?limit=100");
        assertThat(feed.get("items").size()).isEqualTo(2);assertThat(feed.at("/items/0/position/x").asInt()).isEqualTo(-120);assertThat(feed.at("/items/0/position/y").asInt()).isEqualTo(64);assertThat(feed.at("/items/0/position/z").asInt()).isEqualTo(37);assertThat(feed.at("/items/1/position").isNull()).isTrue();
    }
    @Test void runtimeHistoryIsScopedDeduplicatedAndDoesNotReviveOldSamples() throws Exception {
        var boot=UUID.randomUUID();var now=Instant.now().truncatedTo(ChronoUnit.MILLIS);
        var first=runtimeBatch(boot,1,now.minusSeconds(120),100);var last=runtimeBatch(boot,3,now.minusSeconds(5),200);
        send(token,first).andExpect(status().isOk());send(token,last).andExpect(status().isOk());send(token,last).andExpect(status().isOk());
        var replay=last.deepCopy().put("batchId",UUID.randomUUID().toString());send(token,replay).andExpect(status().isOk());
        send(token,runtimeBatch(boot,2,now.minusSeconds(90),180)).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM server_runtime_samples WHERE server_id=?",Integer.class,server)).isEqualTo(3);
        var result=admin("/api/servers/"+server+"/runtime?hours=1");assertThat(result.get("state").asText()).isEqualTo("HEALTHY");
        assertThat(result.at("/latest/sequence").asLong()).isEqualTo(3);assertThat(result.at("/latest/tps").asDouble()).isEqualTo(20);
        assertThat(result.get("points").size()).isEqualTo(3);assertThat(result.get("events").toString()).contains("GAP","LAG");
        var reader=agent(AgentCredentials.Scope.STATS_READ);assertThat(agentGet(reader,"/servers/"+server+"/runtime?hours=1").get("points")).isEqualTo(result.get("points"));
        var other=archives.create("其他运行服","",LocalDate.of(2020,1,1)).id();
        mvc.perform(get("/api/agent/servers/"+other+"/runtime").header("Authorization","Bearer "+reader.token())).andExpect(status().isForbidden());
        var wrong=agent(AgentCredentials.Scope.CHAT_READ);mvc.perform(get("/api/agent/servers/"+server+"/runtime").header("Authorization","Bearer "+wrong.token())).andExpect(status().isForbidden());
        mvc.perform(get("/api/servers/"+server+"/runtime")).andExpect(status().isUnauthorized());
        ((ObjectNode)replay.get("collector").get("runtime")).put("ticks",190);replay.put("batchId",UUID.randomUUID().toString());send(token,replay).andExpect(status().isConflict());
        var invalid=runtimeBatch(boot,4,now,200);((ObjectNode)invalid.at("/collector/runtime")).put("cpuPercent",101);send(token,invalid).andExpect(status().isBadRequest());
        var stopped=runtimeBatch(boot,4,now,0);((ObjectNode)stopped.at("/collector/runtime")).put("stopped",true);send(token,stopped).andExpect(status().isOk());
        assertThat(admin("/api/servers/"+server+"/runtime").get("state").asText()).isEqualTo("STOPPED");
        send(token,runtimeBatch(boot,5,now.minusSeconds(50),200)).andExpect(status().isOk());assertThat(admin("/api/servers/"+server+"/runtime").get("state").asText()).isEqualTo("STOPPED");
        assertThat(admin("/api/servers/"+other+"/runtime").get("state").asText()).isEqualTo("NO_DATA");
    }
    @Test void runtimeStalenessAndNoTicksAreNotCalledCrash() throws Exception {
        var at=Instant.now().minusSeconds(60).truncatedTo(ChronoUnit.MILLIS);var boot=UUID.randomUUID();
        send(token,runtimeBatch(boot,1,at,200)).andExpect(status().isOk());assertThat(admin("/api/servers/"+server+"/runtime").get("state").asText()).isEqualTo("STALE");
        var current=runtimeBatch(boot,2,Instant.now().truncatedTo(ChronoUnit.MILLIS),0);((ObjectNode)current.at("/collector/runtime")).put("lastTickAt",at.toString());
        send(token,current).andExpect(status().isOk());var report=admin("/api/servers/"+server+"/runtime");assertThat(report.get("state").asText()).isEqualTo("TICK_STALLED");assertThat(report.at("/latest/tps").asDouble()).isZero();
        var tooOld=runtimeBatch(boot,3,Instant.now().minus(31,ChronoUnit.DAYS).truncatedTo(ChronoUnit.MILLIS),200);send(token,tooOld).andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM server_runtime_samples WHERE server_id=?",Integer.class,server)).isEqualTo(2);
    }
    ResultActions send(String credential, ObjectNode batch) throws Exception {
        return mvc.perform(post("/api/ingest/v1/batches").header("Authorization", "Bearer " + credential).contentType("application/json").content(json.writeValueAsBytes(batch)));
    }
    JsonNode admin(String url) throws Exception {
        return json.readTree(mvc.perform(get(url).with(user("admin").roles("ADMIN"))).andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray());
    }
    String metric(JsonNode summary, String key) {
        for (JsonNode row : summary.get("metrics")) if (row.get("key").asText().equals(key)) return row.get("value").isNull() ? null : row.get("value").asText();
        throw new AssertionError("Missing metric: " + key);
    }

    ObjectNode chat(String text) {
        ObjectNode event = json.createObjectNode().put("eventId", UUID.randomUUID().toString()).put("kind", "CHAT")
                .put("at", base.toString()).put("dimension", "minecraft:overworld").put("text", text);
        event.set("player", player("123456789", "Alice")); return event;
    }
    AgentCredentials.Issued agent(AgentCredentials.Scope... scopes) {
        return agents.create("测试 Agent", List.of(new AgentCredentials.Grant(server, Set.of(scopes))));
    }
    @Test void agentStatisticRankingCombinesSubjectsBeforePaginationAndPreservesEvidence() throws Exception {
        send(token, batch(counter("items.used", 6, "minecraft:bow"),
                counter("items.used", 7, "minecraft:bow").put("dimension", "minecraft:nether"),
                counter("items.used", 10, "minecraft:bread"),
                counter("items.used", 100, "minecraft:bread").put("at", base.plusSeconds(20).toString()),
                counter("level.max", 10, null), counter("level.max", 25, null).put("dimension", "minecraft:nether")))
                .andExpect(status().isOk());
        ObjectNode newer = batch(counter("items.used", 4, "minecraft:bow"));
        for (JsonNode cap : newer.get("capabilities")) ((ObjectNode) cap).put("algorithmVersion", "test-v2");
        send(token, newer).andExpect(status().isOk());
        var issued = agent(AgentCredentials.Scope.STATS_READ);
        String query = "/servers/" + server + "/statistics/ranking?metric=items.used&toDate=" + base.atZone(zone).toLocalDate();
        JsonNode ranked = agentGet(issued, query + "&pageSize=1");
        assertThat(ranked.get("total").asInt()).isEqualTo(2);
        assertThat(ranked.get("coveredServers").asInt()).isEqualTo(1);
        assertThat(ranked.get("statisticsZone").asText()).isEqualTo("Asia/Hong_Kong");
        assertThat(ranked.at("/items/0/subject").asText()).isEqualTo("minecraft:bow");
        assertThat(ranked.at("/items/0/value").asText()).isEqualTo("17");
        assertThat(ranked.at("/items/0/breakdown").size()).isEqualTo(3);
        assertThat(agentGet(issued, query + "&pageSize=1&page=2").at("/items/0/subject").asText()).isEqualTo("minecraft:bread");
        assertThat(agentGet(issued, query + "&dimension=minecraft:overworld&playerKey=xuid:123456789").at("/items/0/value").asText()).isEqualTo("10");
        JsonNode details = agentGet(issued, query.replace("/ranking?", "/breakdown?"));
        assertThat(details.get("total").asInt()).isEqualTo(4);
        assertThat(details.at("/items/0/quality").asText()).isEqualTo("EXACT");
        JsonNode max = agentGet(issued, "/servers/" + server + "/statistics/ranking?metric=level.max");
        assertThat(max.at("/metric/aggregation").asText()).isEqualTo("MAX");
        assertThat(max.at("/items/0/value").asText()).isEqualTo("25");
        jdbc.update("UPDATE daily_statistics SET statistic_value=9007199254740993 WHERE server_id=? AND metric='items.used' AND subject='minecraft:bread' AND statistic_day=?", server, base.atZone(zone).toLocalDate());
        assertThat(agentGet(issued, query).at("/items/0/value").asText()).isEqualTo("9007199254740993");
    }
    @Test void agentStatisticDetailsRejectCrossServerAccessAndInvalidFilters() throws Exception {
        heartbeat(counter("items.used", 2, "minecraft:bow"));
        var issued = agent(AgentCredentials.Scope.STATS_READ);
        UUID other = archives.create("其他服务器", "", LocalDate.of(2020, 1, 1)).id();
        String otherToken = credentials.rotate(other).token();
        ObjectNode foreign = counter("items.used", 999, "minecraft:bread");
        foreign.set("player", player("987654321", "Other server name"));
        send(otherToken, batch(foreign)).andExpect(status().isOk());
        var chatOnly = agent(AgentCredentials.Scope.CHAT_READ);
        for (String view : List.of("breakdown", "ranking")) {
            String url = "/api/agent/servers/" + server + "/statistics/" + view + "?metric=items.used";
            mvc.perform(get(url.replace(server.toString(), other.toString())).header("Authorization", "Bearer " + issued.token())).andExpect(status().isForbidden());
            mvc.perform(get(url).header("Authorization", "Bearer " + chatOnly.token())).andExpect(status().isForbidden());
            mvc.perform(get(url + "&playerKey=xuid:987654321").header("Authorization", "Bearer " + issued.token())).andExpect(status().isNotFound());
            for (String suffix : List.of("&page=0", "&pageSize=101", "&fromDate=2026-02-02&toDate=2026-01-01", "&category=WOOD"))
                mvc.perform(get(url + suffix).header("Authorization", "Bearer " + issued.token())).andExpect(status().isBadRequest());
            mvc.perform(get(url.replace("items.used", "not.a.metric")).header("Authorization", "Bearer " + issued.token())).andExpect(status().isBadRequest());
            assertThat(agentGet(issued, url.substring("/api/agent".length())).get("total").asInt()).isEqualTo(1);
        }
        agents.revoke(issued.account().id());
        mvc.perform(get("/api/agent/servers/" + server + "/statistics/ranking?metric=items.used").header("Authorization", "Bearer " + issued.token())).andExpect(status().isUnauthorized());
    }
    AgentCredentials.Identity identity(AgentCredentials.Issued issued) { return agents.authenticate("Bearer " + issued.token()); }
    JsonNode agentGet(AgentCredentials.Issued issued, String path) throws Exception {
        return json.readTree(mvc.perform(get("/api/agent" + path).header("Authorization", "Bearer " + issued.token()))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray());
    }
    ReplyQueue.Request request(UUID replyTo, String text) { return new ReplyQueue.Request(UUID.randomUUID(), replyTo, null, text, 60); }
    UUID heartbeat(ObjectNode... events) throws Exception {
        ObjectNode body = batch(events); send(token, body).andExpect(status().isOk());
        return UUID.fromString(body.get("collector").get("bootId").asText());
    }
    @Test void agentCredentialsCannotReuseAdminOrCollectorAndRemainScoped() throws Exception {
        var issued = agent(AgentCredentials.Scope.STATS_READ);
        mvc.perform(get("/api/agent/servers").with(user("admin").roles("ADMIN"))).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/agent/servers").header("Authorization", "Bearer " + token)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/servers").header("Authorization", "Bearer " + issued.token())).andExpect(status().isUnauthorized());
        send(issued.token(), batch()).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/agents").with(user("admin").roles("ADMIN")).contentType("application/json").content("{}"))
                .andExpect(status().isForbidden());
        assertThat(agents.list().toString()).doesNotContain(issued.token());
        assertThat(jdbc.queryForObject("SELECT token_hash FROM agent_accounts WHERE id = ?", String.class, issued.account().id())).hasSize(64).doesNotContain(issued.token());
        UUID other = archives.create("不能看到的服务器", "", LocalDate.of(2020, 1, 1)).id();
        send(token, batch(counter("blocks.mined", 3, "minecraft:stone"))).andExpect(status().isOk());
        ObjectNode secret = counter("blocks.mined", 99, "minecraft:diamond_ore"); secret.set("player", player("123456789", "跨服秘密名字"));
        send(credentials.rotate(other).token(), batch(secret)).andExpect(status().isOk());
        JsonNode servers = agentGet(issued, "/servers");
        assertThat(servers.size()).isEqualTo(1); assertThat(servers.get(0).get("id").asText()).isEqualTo(server.toString());
        JsonNode context = agentGet(issued, "/servers/" + server + "/players/xuid:123456789/context");
        assertThat(context.toString()).doesNotContain("跨服秘密名字", "不能看到的服务器", other.toString());
        assertThat(context.get("player").get("name").asText()).isEqualTo("Alice");
        assertThat(metric(context.get("statistics"), "blocks.mined")).isEqualTo("3");
        assertThat(agentGet(issued, "/servers/" + server + "/players").toString()).doesNotContain("跨服秘密名字");
        mvc.perform(get("/api/agent/servers/" + other + "/statistics").header("Authorization", "Bearer " + issued.token())).andExpect(status().isForbidden());
        mvc.perform(get("/api/agent/servers/" + server + "/activity?chat=true").header("Authorization", "Bearer " + issued.token())).andExpect(status().isForbidden());
        var rotated = agents.rotate(issued.account().id());
        mvc.perform(get("/api/agent/servers").header("Authorization", "Bearer " + issued.token())).andExpect(status().isUnauthorized());
        assertThat(agentGet(rotated, "/servers").size()).isEqualTo(1);
        agents.revoke(rotated.account().id());
        mvc.perform(get("/api/agent/servers").header("Authorization", "Bearer " + rotated.token())).andExpect(status().isUnauthorized());
    }
    @Test void chatPermissionDoesNotGrantStatisticsAndLegacyNamesNeverLeak() throws Exception {
        send(token, batch(chat("玩家公开正文"))).andExpect(status().isOk());
        var chatAgent = agent(AgentCredentials.Scope.CHAT_READ);
        assertThat(agentGet(chatAgent, "/servers/" + server + "/activity?chat=true").get("items").size()).isEqualTo(1);
        for (String path : List.of("/statistics", "/players", "/players/xuid:123456789/context", "/status", "/activity"))
            mvc.perform(get("/api/agent/servers/" + server + path).header("Authorization", "Bearer " + chatAgent.token())).andExpect(status().isForbidden());
        jdbc.update("DELETE FROM player_server_names");
        jdbc.update("UPDATE players SET current_name = 'Global-secret-name'");
        var statsAgent = agent(AgentCredentials.Scope.STATS_READ);
        JsonNode context = agentGet(statsAgent, "/servers/" + server + "/players/xuid:123456789/context");
        assertThat(context.toString()).doesNotContain("Global-secret-name", "玩家公开正文");
        assertThat(context.get("player").get("name").asText()).isEqualTo("xuid:123456789");
        assertThat(context.get("names")).isEmpty();
    }
    @Test void replyQueueIsIdempotentAndDeliveryRequiresExecutionReceipt() throws Exception {
        ObjectNode message = chat("我挖了多少？"); UUID boot = heartbeat(message);
        var issued = agent(AgentCredentials.Scope.CHAT_READ, AgentCredentials.Scope.CHAT_SEND);
        var who = identity(issued); var request = request(UUID.fromString(message.get("eventId").asText()), "已记录的数据为 4 个方块。");
        var queued = replies.enqueue(who, server, request);
        assertThat(queued.status()).isEqualTo("PENDING");
        assertThat(replies.enqueue(who, server, request).id()).isEqualTo(queued.id());
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> replies.enqueue(who, server, new ReplyQueue.Request(request.requestId(), request.replyTo(), null, "改变正文", 60))).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> replies.enqueue(who, server, request(request.replyTo(), "第二条回复"))).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        var collector = credentials.authenticate("Bearer " + token);
        var lease = replies.claim(collector, boot).getFirst();
        assertThat(replies.claim(collector, boot).getFirst().leaseId()).isEqualTo(lease.leaseId());
        var premature = new ReplyQueue.Acknowledgement(lease.leaseId(), boot, "DELIVERED", Instant.now().truncatedTo(ChronoUnit.MILLIS), null);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> replies.acknowledge(collector, queued.id(), premature)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThat(replies.begin(collector, queued.id(), lease.leaseId(), boot).executionAuthorized()).isTrue();
        var ack = new ReplyQueue.Acknowledgement(lease.leaseId(), boot, "DELIVERED", Instant.now().truncatedTo(ChronoUnit.MILLIS), null);
        assertThat(replies.acknowledge(collector, queued.id(), ack).status()).isEqualTo("DELIVERED");
        assertThat(replies.acknowledge(collector, queued.id(), ack).status()).isEqualTo("DELIVERED");
        assertThat(replies.status(who, queued.id()).completedAt()).isEqualTo(ack.sentAt());
        assertThat(activity.read(server, 0, 100, true, false, null).items()).hasSize(1);
        var all = activity.read(server, 0, 100, true, true, null).items();
        assertThat(all).hasSize(2); assertThat(all.getLast().source()).isEqualTo("AGENT");
        assertThat(all.getLast().text()).isEqualTo(request.text());
        assertThat(metric(admin("/api/statistics/summary"), "chat.messages")).isEqualTo("1");
        assertThat(replies.claim(collector, boot)).isEmpty();
    }
    @Test void leaseExpiryCanRetryUnstartedWorkButNeverReexecutesUncertainSends() throws Exception {
        UUID boot = heartbeat(); var issued = agent(AgentCredentials.Scope.CHAT_SEND); var who = identity(issued);
        var collector = credentials.authenticate("Bearer " + token);
        var reply = replies.enqueue(who, server, request(null, "租约测试"));
        var first = replies.claim(collector, boot).getFirst();
        jdbc.update("UPDATE server_commands SET lease_until = ? WHERE id = ?", TelemetryService.time(Instant.now().minusSeconds(1)), reply.id());
        var second = replies.claim(collector, boot).getFirst(); assertThat(second.leaseId()).isNotEqualTo(first.leaseId());
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> replies.begin(collector, reply.id(), first.leaseId(), boot)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        replies.begin(collector, reply.id(), second.leaseId(), boot);
        jdbc.update("UPDATE server_commands SET lease_until = ? WHERE id = ?", TelemetryService.time(Instant.now().minusSeconds(1)), reply.id());
        assertThat(replies.status(who, reply.id()).status()).isEqualTo("UNCERTAIN");
        assertThat(replies.claim(collector, boot)).isEmpty();
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> replies.begin(collector, reply.id(), second.leaseId(), boot)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        var late = new ReplyQueue.Acknowledgement(second.leaseId(), boot, "DELIVERED", Instant.now().truncatedTo(ChronoUnit.MILLIS), null);
        assertThat(replies.acknowledge(collector, reply.id(), late).status()).isEqualTo("DELIVERED");
        var pending = replies.enqueue(who, server, request(null, "过期测试"));
        jdbc.update("UPDATE server_commands SET expires_at = ? WHERE id = ?", TelemetryService.time(Instant.now().minusSeconds(1)), pending.id());
        assertThat(replies.status(who, pending.id()).status()).isEqualTo("EXPIRED");
        assertThat(replies.claim(collector, boot)).isEmpty();
    }
    @Test void permissionRevocationCancelsUnstartedRepliesAndMarksStartedRepliesUncertain() throws Exception {
        UUID boot = heartbeat(); var issued = agent(AgentCredentials.Scope.CHAT_SEND); var who = identity(issued);
        var collector = credentials.authenticate("Bearer " + token);
        var executing = replies.enqueue(who, server, request(null, "可能已发送"));
        var lease = replies.claim(collector, boot).getFirst(); replies.begin(collector, executing.id(), lease.leaseId(), boot);
        var pending = replies.enqueue(who, server, request(null, "尚未发送"));
        agents.update(issued.account().id(), List.of(new AgentCredentials.Grant(server, Set.of(AgentCredentials.Scope.CHAT_READ))));
        assertThat(jdbc.queryForObject("SELECT status FROM server_commands WHERE id = ?", String.class, executing.id())).isEqualTo("UNCERTAIN");
        assertThat(jdbc.queryForObject("SELECT status FROM server_commands WHERE id = ?", String.class, pending.id())).isEqualTo("CANCELLED");
        assertThat(replies.claim(collector, boot)).isEmpty();
        var other = agent(AgentCredentials.Scope.CHAT_SEND);
        var otherPending = replies.enqueue(identity(other), server, request(null, "撤销凭据"));
        agents.revoke(other.account().id());
        assertThat(jdbc.queryForObject("SELECT status FROM server_commands WHERE id = ?", String.class, otherPending.id())).isEqualTo("CANCELLED");
    }
    @Test void replyLeasesBindServerBootAndAgentAndEnforceRateLimits() throws Exception {
        UUID boot = heartbeat(); var issued = agent(AgentCredentials.Scope.CHAT_SEND); var who = identity(issued);
        var reply = replies.enqueue(who, server, request(null, "绑定验证"));
        var collector = credentials.authenticate("Bearer " + token);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> replies.claim(collector, UUID.randomUUID())).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        var lease = replies.claim(collector, boot).getFirst();
        UUID other = archives.create("其他服", "", LocalDate.of(2020, 1, 1)).id();
        var otherCollector = credentials.authenticate("Bearer " + credentials.rotate(other).token());
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> replies.acknowledge(otherCollector, reply.id(), new ReplyQueue.Acknowledgement(lease.leaseId(), boot, "UNCERTAIN", null, "LOCAL_STATE_UNCERTAIN"))).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        var otherAgent = agent(AgentCredentials.Scope.CHAT_SEND);
        mvc.perform(get("/api/agent/replies/" + reply.id()).header("Authorization", "Bearer " + otherAgent.token())).andExpect(status().isNotFound());
        for (int i = 1; i < 10; i++) replies.enqueue(who, server, request(null, "速率测试 " + i));
        mvc.perform(post("/api/agent/servers/" + server + "/replies").header("Authorization", "Bearer " + issued.token()).contentType("application/json").content(json.writeValueAsBytes(request(null, "第 11 条"))))
                .andExpect(status().isTooManyRequests());
        var statsOnly = agent(AgentCredentials.Scope.STATS_READ);
        mvc.perform(post("/api/agent/servers/" + server + "/replies").header("Authorization", "Bearer " + statsOnly.token()).contentType("application/json").content(json.writeValueAsBytes(request(null, "未授权"))))
                .andExpect(status().isForbidden());
    }
    @Test void agentLongPollWakesOnCommittedMessagesAndRevocationAndTimesOutHonestly() throws Exception {
        var issued = agent(AgentCredentials.Scope.CHAT_READ);
        long cursor = jdbc.queryForObject("SELECT last_cursor FROM activity_stream WHERE id = 1", Long.class);
        String path = "/servers/" + server + "/activity?chat=true&after=" + cursor + "&waitSeconds=5";
        try (var pool = Executors.newFixedThreadPool(1)) {
            var waiting = pool.submit(() -> agentGet(issued, path));
            Thread.sleep(100);
            send(token, batch(chat("唤醒等待中的 Agent"))).andExpect(status().isOk());
            JsonNode result = waiting.get(2, TimeUnit.SECONDS);
            assertThat(result.get("items").get(0).get("text").asText()).isEqualTo("唤醒等待中的 Agent");
            String next = result.get("nextCursor").asText();
            var revoked = pool.submit(() -> mvc.perform(get("/api/agent/servers/" + server + "/activity?chat=true&after=" + next + "&waitSeconds=5")
                    .header("Authorization", "Bearer " + issued.token())).andReturn().getResponse().getStatus());
            Thread.sleep(100); agents.revoke(issued.account().id());
            assertThat(revoked.get(2, TimeUnit.SECONDS)).isEqualTo(401);
            var nextAgent = agent(AgentCredentials.Scope.CHAT_READ);
            assertThat(agentGet(nextAgent, "/servers/" + server + "/activity?chat=true&after=" + next + "&waitSeconds=1").get("items")).isEmpty();
        }
    }
    @Test void concurrentReplyRetriesAndBootChangesPreserveOneExecution() throws Exception {
        UUID boot = heartbeat(); var issued = agent(AgentCredentials.Scope.CHAT_SEND); var who = identity(issued);
        var request = request(null, "并发幂等验证");
        try (var pool = Executors.newFixedThreadPool(4)) {
            List<Future<UUID>> results = new ArrayList<>(); CountDownLatch start = new CountDownLatch(1);
            for (int i = 0; i < 4; i++) results.add(pool.submit(() -> { start.await(); return replies.enqueue(who, server, request).id(); }));
            start.countDown(); Set<UUID> ids = new HashSet<>(); for (var result : results) ids.add(result.get(5, TimeUnit.SECONDS));
            assertThat(ids).hasSize(1);
        }
        var collector = credentials.authenticate("Bearer " + token); var first = replies.claim(collector, boot).getFirst();
        UUID replacementBoot = UUID.randomUUID();
        jdbc.update("UPDATE collector_state SET boot_id = ? WHERE server_id = ?", replacementBoot, server);
        var replacement = replies.claim(collector, replacementBoot).getFirst();
        assertThat(replacement.reply().id()).isEqualTo(first.reply().id());
        assertThat(replacement.leaseId()).isNotEqualTo(first.leaseId());
        replies.begin(collector, replacement.reply().id(), replacement.leaseId(), replacementBoot);
        jdbc.update("UPDATE collector_state SET boot_id = ? WHERE server_id = ?", UUID.randomUUID(), server);
        assertThat(replies.status(who, replacement.reply().id()).status()).isEqualTo("UNCERTAIN");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM server_commands", Integer.class)).isEqualTo(1);
    }
    @Test void replyValidationAndSealedArchivesBlockUnsafeOrUnsentMessages() throws Exception {
        ObjectNode message = chat("测试关联消息"); heartbeat(message);
        var issued = agent(AgentCredentials.Scope.CHAT_SEND, AgentCredentials.Scope.CHAT_READ); var who = identity(issued);
        for (String invalid : List.of(" ", "hello\nworld", "x".repeat(513), "§r伪装格式"))
            mvc.perform(post("/api/agent/servers/" + server + "/replies").header("Authorization", "Bearer " + issued.token())
                    .contentType("application/json").content(json.writeValueAsBytes(request(null, invalid)))).andExpect(status().isBadRequest());
        var foreignReply = new ReplyQueue.Request(UUID.randomUUID(), UUID.fromString(message.get("eventId").asText()), "xuid:999", "目标不匹配", 60);
        mvc.perform(post("/api/agent/servers/" + server + "/replies").header("Authorization", "Bearer " + issued.token())
                .contentType("application/json").content(json.writeValueAsBytes(foreignReply))).andExpect(status().isBadRequest());
        var pending = replies.enqueue(who, server, request(null, "封存前排队"));
        mvc.perform(post("/api/servers/" + server + "/archive").with(user("admin").roles("ADMIN")).with(csrf()).contentType("application/json")
                .content("{\"endDate\":\"" + LocalDate.now(zone) + "\"}")).andExpect(status().isOk());
        assertThat(replies.status(who, pending.id()).status()).isEqualTo("CANCELLED");
        mvc.perform(post("/api/agent/servers/" + server + "/replies").header("Authorization", "Bearer " + issued.token())
                .contentType("application/json").content(json.writeValueAsBytes(request(null, "封存后不能发送")))).andExpect(status().isConflict());
    }
    @Test void agentMissingPlayerErrorsDoNotRevealGlobalMembership() throws Exception {
        UUID other = archives.create("未授权的其他服", "", LocalDate.of(2020, 1, 1)).id();
        send(credentials.rotate(other).token(), batch(counter("blocks.mined", 2, "minecraft:stone"))).andExpect(status().isOk());
        var issued = agent(AgentCredentials.Scope.STATS_READ);
        for (String suffix : List.of("", "&daily=true")) {
            String existing = mvc.perform(get("/api/agent/servers/" + server + "/statistics?playerKey=xuid:123456789" + suffix)
                    .header("Authorization", "Bearer " + issued.token())).andExpect(status().isNotFound()).andReturn().getResponse().getContentAsString();
            String absent = mvc.perform(get("/api/agent/servers/" + server + "/statistics?playerKey=xuid:999" + suffix)
                    .header("Authorization", "Bearer " + issued.token())).andExpect(status().isNotFound()).andReturn().getResponse().getContentAsString();
            assertThat(existing).isEqualTo(absent);
        }
    }
    @Test void malformedUnicodeIsRejectedWhileEmojiSurvivesChatAndReplies() throws Exception {
        String invalid = "invalid-" + Character.toString((char) 0xd800);
        send(token, batch(chat(invalid))).andExpect(status().isBadRequest());
        ObjectNode playerName = chat("正文"); playerName.set("player", player("123456789", invalid));
        send(token, batch(playerName)).andExpect(status().isBadRequest());
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> agents.create(invalid, List.of())).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        send(token, batch(chat("你好 👋⛏️"))).andExpect(status().isOk());
        var issued = agent(AgentCredentials.Scope.CHAT_SEND);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> replies.enqueue(identity(issued), server, request(null, invalid))).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThat(replies.enqueue(identity(issued), server, request(null, "你好 👋⛏️")).status()).isEqualTo("PENDING");
        assertThat(activity.read(server, 0, 10, true, false, null).items().getFirst().text()).isEqualTo("你好 👋⛏️");
    }
    @Test void legacyOutboxCanonicalHashRemainsCompatible() throws Exception {
        JsonNode fixture;
        try (var input = getClass().getResourceAsStream("/legacy-event-v2.json")) { fixture = json.readTree(input); }
        var event = json.treeToValue(fixture.get("event"), TelemetryPayload.Event.class);
        assertThat(service.eventHash(event)).isEqualTo(fixture.get("payloadHash").asText());
        ObjectNode original = (ObjectNode) fixture.get("event");
        send(token, batch(original)).andExpect(status().isOk());
        send(token, batch(original)).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateEvents").value(1));
        assertThat(metric(admin("/api/statistics/summary"), "blocks.mined")).isEqualTo("3");
    }
    @Test void savedKillCreditsPreserveNewerPlayerNamesAndReplayIdentity() throws Exception {
        var renamed = chat("改名后上线").put("at", base.plusSeconds(1).toString());
        renamed.set("player", player("123456789", "Renamed"));
        send(token, batch(renamed)).andExpect(status().isOk());

        var kill = counter("kills.mobs", 1, "minecraft:cow")
                .put("at", base.plusSeconds(2).toString()).put("playerObservedAt", base.toString());
        var original = batch(kill);
        send(token, original).andExpect(status().isOk()).andExpect(jsonPath("$.acceptedEvents").value(1));
        send(token, original).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateBatch").value(true));
        send(token, batch(kill)).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateEvents").value(1));

        var stats = agent(AgentCredentials.Scope.STATS_READ);
        var context = agentGet(stats, "/servers/" + server + "/players/xuid:123456789/context");
        assertThat(context.at("/player/name").asText()).isEqualTo("Renamed");
        assertThat(context.at("/names/0/name").asText()).isEqualTo("Renamed");
        assertThat(context.at("/names/1/name").asText()).isEqualTo("Alice");
        assertThat(jdbc.queryForObject("SELECT current_name FROM players WHERE player_key = ?", String.class, "xuid:123456789"))
                .isEqualTo("Renamed");
        assertThat(metric(admin("/api/statistics/summary"), "kills.mobs")).isEqualTo("1");

        var future = kill.deepCopy().put("playerObservedAt", base.plusSeconds(3).toString());
        send(token, batch(future)).andExpect(status().isBadRequest());
        var nonKill = counter("blocks.mined", 1, "minecraft:stone").put("playerObservedAt", base.toString());
        send(token, batch(nonKill)).andExpect(status().isBadRequest());
        var changed = kill.deepCopy().put("playerObservedAt", base.minusSeconds(1).toString());
        send(token, batch(changed)).andExpect(status().isConflict());
    }
    @Test void publicChatIsIdempotentAndSeparateFromActivityAndCounterOnlyCollectors() throws Exception {
        ObjectNode message = chat("你好 Agent，今天挖了多少？ <script>玩家数据</script>");
        send(token, batch(message, counter("blocks.mined", 4, "minecraft:stone"))).andExpect(status().isOk());
        send(token, batch(message)).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateEvents").value(1));
        assertThat(metric(admin("/api/statistics/summary"), "chat.messages")).isEqualTo("1");
        assertThat(metric(admin("/api/statistics/summary"), "chat.contents")).isEqualTo("1");
        var messages = activity.read(server, 0, 10, true, false, null);
        assertThat(messages.items()).hasSize(1);
        assertThat(messages.items().getFirst().text()).isEqualTo(message.get("text").asText());
        assertThat(messages.items().getFirst().source()).isEqualTo("PLAYER");
        assertThat(messages.items().getFirst().occurredAt()).isEqualTo(base);
        assertThat(messages.items().getFirst().receivedAt()).isAfter(base);
        assertThat(activity.read(server, 0, 10, false, false, null).items()).hasSize(1).allMatch(row -> row.text() == null);
        assertThat(activity.read(server, Long.parseLong(messages.nextCursor()), 10, true, false, null).items()).isEmpty();
        ObjectNode countOnly = batch(counter("chat.messages", 2, null));
        countOnly.set("capabilities", json.createArrayNode().add(capability("chat.messages", "EXACT", "count-only", true)));
        send(token, countOnly).andExpect(status().isOk());
        assertThat(metric(admin("/api/statistics/summary"), "chat.messages")).isEqualTo("3");
        assertThat(activity.read(server, 0, 10, true, false, null).items()).hasSize(1);
    }
    @Test void sessionChatUsesStoredArchivePlayerAndCheckpointAndRequiresAdmin() throws Exception {
        UUID sessionId = UUID.randomUUID();
        var first = chat("会话内的第一条").put("at", base.plusMillis(100).toString());
        var second = chat("会话内的第二条").put("at", base.plusMillis(200).toString());
        var future = chat("尚未确认的时间").put("at", base.plusMillis(600).toString());
        var unrelated = chat("其他玩家").put("at", base.plusMillis(150).toString());
        var agentReply = chat("Agent 回复").put("at", base.plusMillis(300).toString());
        unrelated.set("player", player("999", "Other"));
        send(token, batch(session(sessionId, 0, 0, false, "minecraft:overworld"),
                session(sessionId, 1, 500, false, "minecraft:overworld"),
                chat("会话开始前").put("at", base.minusMillis(1).toString()),
                first, second, future, unrelated, agentReply)).andExpect(status().isOk());
        UUID other = archives.create("其他档案", "", LocalDate.of(2020, 1, 1)).id();
        send(credentials.rotate(other).token(), batch(chat("其他档案正文"))).andExpect(status().isOk());
        jdbc.update("UPDATE activity_feed SET source = 'AGENT' WHERE event_id = ?",
                UUID.fromString(agentReply.get("eventId").asText()));

        String path = "/api/activity/sessions/" + sessionId + "/chat?serverId=";
        var firstPage = admin(path + server + "&limit=1");
        assertThat(firstPage.at("/messages/items/0/text").asText()).isEqualTo("会话内的第一条");
        assertThat(firstPage.at("/messages/hasMore").asBoolean()).isTrue();
        var secondPage = admin(path + server + "&limit=1&after=" + firstPage.at("/messages/nextCursor").asText());
        assertThat(secondPage.at("/messages/items/0/text").asText()).isEqualTo("会话内的第二条");
        assertThat(secondPage.at("/messages/hasMore").asBoolean()).isFalse();
        assertThat(secondPage.at("/confirmedThrough").asText()).isEqualTo(base.plusMillis(500).toString());
        mvc.perform(get(path + other).with(user("admin").roles("ADMIN"))).andExpect(status().isNotFound());
        mvc.perform(get(path + server)).andExpect(status().isUnauthorized());
        var chatAgent = agent(AgentCredentials.Scope.CHAT_READ);
        mvc.perform(get(path + server).header("Authorization", "Bearer " + chatAgent.token())).andExpect(status().isUnauthorized());

        send(token, batch(session(sessionId, 2, 700, true, "minecraft:overworld"))).andExpect(status().isOk());
        assertThat(admin(path + server).at("/messages/items")).hasSize(3);
        jdbc.update("UPDATE activity_feed SET received_at = ? WHERE event_id = ?", TelemetryService.time(Instant.now().minus(Duration.ofDays(31))),
                UUID.fromString(first.get("eventId").asText()));
        assertThat(admin(path + server).at("/messages/items")).hasSize(2);
    }
    @Test void malformedChatAndMissingCapabilityRollBackEverything() throws Exception {
        for (String invalid : List.of(" ", "hello\nworld", "hello\u0000", "x".repeat(1025)))
            send(token, batch(counter("blocks.mined", 2, "minecraft:stone"), chat(invalid))).andExpect(status().isBadRequest());
        ObjectNode body = batch(chat("正常消息"));
        body.set("capabilities", json.createArrayNode().add(capability("chat.contents", "EXACT", "test-v1", true)));
        send(token, body).andExpect(status().isBadRequest());
        send(token, batch(counter("chat.contents", 1, null))).andExpect(status().isBadRequest());
        send(token, batch(counter("chat.messages", 1, null).put("text", "不能附带正文"))).andExpect(status().isBadRequest());
        send(token, batch(chat("合法"), session(UUID.randomUUID(), 1, 1000, false, "minecraft:overworld"))).andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_feed", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM player_server_names", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM telemetry_events", Integer.class)).isZero();
    }
    @Test void feedCursorsPaginationRetentionAndServerNamesStayScoped() throws Exception {
        ObjectNode one = chat("1"), two = chat("2"), three = chat("3");
        two.set("player", player("123456789", "Alice-new"));
        send(token, batch(one, two, three)).andExpect(status().isOk());
        UUID other = archives.create("另一个服", "", LocalDate.of(2020, 1, 1)).id();
        String otherToken = credentials.rotate(other).token();
        ObjectNode secret = chat("不能跨服读取"); secret.set("player", player("123456789", "Secret-name"));
        send(otherToken, batch(secret)).andExpect(status().isOk());
        var first = activity.read(server, 0, 2, true, false, null);
        assertThat(first.items()).extracting(ActivityFeed.Entry::text).containsExactly("1", "2");
        assertThat(first.hasMore()).isTrue();
        var second = activity.read(server, Long.parseLong(first.nextCursor()), 2, true, false, null);
        assertThat(second.items()).extracting(ActivityFeed.Entry::text).containsExactly("3");
        assertThat(second.hasMore()).isFalse();
        assertThat(second.nextCursor()).isEqualTo(second.highWatermark());
        assertThat(jdbc.queryForList("SELECT name FROM player_server_names WHERE server_id = ? ORDER BY name", String.class, server))
                .containsExactly("Alice", "Alice-new");
        jdbc.update("UPDATE activity_feed SET received_at = ? WHERE server_id = ?", TelemetryService.time(Instant.now().minus(Duration.ofDays(40))), server);
        assertThat(activity.read(server, 0, 10, true, false, null).items()).isEmpty();
        assertThat(activity.retention(30, null).removedEntries()).isEqualTo(3);
        assertThat(metric(admin("/api/statistics/summary?serverId=" + server), "chat.messages")).isEqualTo("3");
        send(token, batch(one)).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateEvents").value(1));
        assertThat(activity.read(server, 0, 10, true, false, null).items()).isEmpty();
        mvc.perform(get("/api/activity").param("serverId", server.toString()).header("Authorization", "Bearer " + token)).andExpect(status().isUnauthorized());
        mvc.perform(put("/api/activity/retention").with(user("admin").roles("ADMIN")).contentType("application/json").content("{\"days\":1}"))
                .andExpect(status().isForbidden());
    }

    @Test void retentionPreviewIsReadOnlyAndExtensionDoesNotRestoreExpiredRows() throws Exception {
        ObjectNode expiredChat = chat("旧发言"), freshChat = chat("新发言");
        ObjectNode behavior = counter("blocks.mined", 7, "minecraft:stone");
        send(token, batch(expiredChat, behavior, freshChat)).andExpect(status().isOk());
        var old = TelemetryService.time(Instant.now().minus(Duration.ofDays(3)));
        jdbc.update("UPDATE activity_feed SET received_at = ? WHERE event_id IN (?, ?)", old,
                UUID.fromString(expiredChat.get("eventId").asText()), UUID.fromString(behavior.get("eventId").asText()));
        long high = jdbc.queryForObject("SELECT last_cursor FROM activity_stream WHERE id=1", Long.class);
        var fixtures = new ArrayList<Object[]>();
        for (int i = 1; i <= 5001; i++) fixtures.add(new Object[]{high + i, server, UUID.randomUUID(), old, old});
        jdbc.batchUpdate("""
                INSERT INTO activity_feed(cursor_id, server_id, event_id, source, kind, occurred_at, received_at, actor_name)
                VALUES (?, ?, ?, 'PLAYER', 'COUNTER', ?, ?, 'Fixture')
                """, fixtures);
        jdbc.update("UPDATE activity_stream SET last_cursor = ? WHERE id = 1", high + fixtures.size());
        var policy = admin("/api/activity/retention");
        assertThat(policy.get("retentionDays").asInt()).isEqualTo(30);
        assertThat(policy.get("automaticCleanupEnabled").asBoolean()).isFalse();
        var preview = admin("/api/activity/retention-preview?days=1");
        assertThat(preview.get("chatEntries").asLong()).isEqualTo(1);
        assertThat(preview.get("behaviorEntries").asLong()).isEqualTo(5002);
        assertThat(activity.read(server, 0, 10, true, false, null).items()).hasSize(2);
        mvc.perform(put("/api/activity/retention").with(user("admin").roles("ADMIN")).with(csrf())
                .contentType("application/json").content("{\"days\":1,\"expectedDays\":30}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.removedEntries").value(5000))
                .andExpect(jsonPath("$.batchLimitReached").value(true));
        assertThat(activity.read(server, 0, 10, false, false, null).items()).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_feed", Long.class)).isEqualTo(4);
        mvc.perform(put("/api/activity/retention").with(user("admin").roles("ADMIN")).with(csrf())
                .contentType("application/json").content("{\"days\":365,\"expectedDays\":30}"))
                .andExpect(status().isConflict());
        assertThat(activity.retention(365, 1).removedEntries()).isEqualTo(3);
        assertThat(activity.read(server, 0, 10, true, false, null).items()).hasSize(1);
        assertThat(metric(admin("/api/statistics/summary"), "blocks.mined")).isEqualTo("7");
        assertThat(metric(admin("/api/statistics/summary"), "chat.messages")).isEqualTo("2");
        send(token, batch(expiredChat)).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateEvents").value(1));
        jdbc.update("UPDATE activity_feed SET received_at = ?", old);
        assertThat(activity.read(server, 0, 10, true, false, null).items()).isEmpty();
        assertThat(activity.pruneExpired()).isEqualTo(1);
        assertThat(activity.read(server, 0, 10, true, false, null).highWatermark()).isEqualTo(Long.toString(high + fixtures.size()));
        mvc.perform(get("/api/activity/retention-preview?days=1").header("Authorization", "Bearer " + token)).andExpect(status().isUnauthorized());
        var storage = admin("/api/backups/storage");
        assertThat(storage.get("readyCount").asInt()).isZero();
        assertThat(storage.get("readyArchiveBytes").asText()).isEqualTo("0");
        assertThat(Long.parseLong(storage.get("volume").get("totalBytes").asText())).isPositive();
    }

    @Test void credentialRotationRevocationAndRoleSeparation() throws Exception {
        mvc.perform(post("/api/ingest/v1/batches").with(user("admin").roles("ADMIN")).contentType("application/json").content("{}"))
                .andExpect(status().isUnauthorized());
        mvc.perform(get("/api/players").header("Authorization", "Bearer " + token)).andExpect(status().isUnauthorized());
        assertThat(admin("/api/servers/" + server + "/collector-credential").has("token")).isFalse();
        assertThat(jdbc.queryForObject("SELECT token_hash FROM collector_credentials WHERE server_id = ?", String.class, server)).doesNotContain(token);
        String next = json.readTree(mvc.perform(post("/api/servers/" + server + "/collector-credential").with(user("admin").roles("ADMIN")).with(csrf()))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray()).get("token").asText();
        send(token, batch()).andExpect(status().isUnauthorized());
        send(next, batch()).andExpect(status().isOk());
        mvc.perform(delete("/api/servers/" + server + "/collector-credential").with(user("admin").roles("ADMIN")).with(csrf())).andExpect(status().isNoContent());
        send(next, batch()).andExpect(status().isUnauthorized());
    }
    @Test void batchesAndEventsAreIdempotentAndConflictingReuseIsRejected() throws Exception {
        ObjectNode event = counter("blocks.mined", 7, "minecraft:oak_log"); ObjectNode batch = batch(event);
        send(token, batch).andExpect(status().isOk()).andExpect(jsonPath("$.acceptedEvents").value(1));
        send(token, batch).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateBatch").value(true)).andExpect(jsonPath("$.acceptedEvents").value(0));
        send(token, batch(event)).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateEvents").value(1));
        ObjectNode changed = batch.deepCopy(); ((ObjectNode) changed.get("collector")).put("version", "changed");
        send(token, changed).andExpect(status().isConflict());
        send(token, batch(event.deepCopy().put("value", 99))).andExpect(status().isConflict());
        assertThat(metric(admin("/api/statistics/summary"), "blocks.mined")).isEqualTo("7");
    }
    @Test void invalidLaterEventRollsBackTheWholeBatchAndCanBeRepaired() throws Exception {
        ObjectNode invalid = batch(counter("blocks.mined", 5, "minecraft:stone"), session(UUID.randomUUID(), 1, 1000, false, "minecraft:overworld"));
        send(token, invalid).andExpect(status().isConflict());
        for (String table : List.of("players", "daily_statistics", "telemetry_batches", "telemetry_events", "collector_state"))
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class)).as(table).isZero();
        ((ArrayNode) invalid.get("events")).remove(1);
        send(token, invalid).andExpect(status().isOk()).andExpect(jsonPath("$.acceptedEvents").value(1));
    }
    @Test void diagnosticReplayKeepsBootBoundariesAndReportsRecoveredDiskFaults() throws Exception {
        var legacy = batch();
        send(token, legacy).andExpect(status().isOk());
        assertThat(admin("/api/collectors?serverId=" + server).get(0).get("diagnostics").isNull()).isTrue();
        String oldBoot = UUID.randomUUID().toString(), newBoot = UUID.randomUUID().toString();
        var failed = diagnosticBatch(oldBoot, base.plusSeconds(1), 1, 7, 0, 0, true, 1, false);
        send(token, failed).andExpect(status().isOk());
        var recovery = diagnosticBatch(oldBoot, base.plusSeconds(2), 2, 0, 4, 2, false, 1, false);
        send(token, recovery).andExpect(status().isOk());
        send(token, failed.deepCopy().put("batchId", UUID.randomUUID().toString())).andExpect(status().isOk());
        // This new report must stay current when an earlier boot replays its shutdown report.
        var active = diagnosticBatch(newBoot, Instant.now().plusMillis(10).truncatedTo(ChronoUnit.MILLIS), 1, 0, 0, 0, false, 0, false);
        send(token, active).andExpect(status().isOk());
        var stopped = diagnosticBatch(oldBoot, base.plusSeconds(3), 3, 0, 4, 2, false, 1, true);
        send(token, stopped).andExpect(status().isOk());
        send(token, stopped).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateBatch").value(true));
        var result = admin("/api/collectors?serverId=" + server).get(0);
        assertThat(result.get("diagnostics").get("bootId").asText()).isEqualTo(newBoot);
        assertThat(result.get("diagnostics").get("captureGaps").asLong()).isZero();
        assertThat(result.get("previousAnomalies").size()).isEqualTo(1);
        var previous = result.get("previousAnomalies").get(0);
        assertThat(previous.get("bootId").asText()).isEqualTo(oldBoot);
        assertThat(previous.get("queuedEvents").asInt()).isZero();
        assertThat(previous.get("diskError").asBoolean()).isFalse();
        assertThat(previous.get("diskFaults").asLong()).isEqualTo(1);
        assertThat(previous.get("rejectedSubmissions").asLong()).isEqualTo(4);
        assertThat(previous.get("captureGaps").asLong()).isEqualTo(2);
        assertThat(previous.get("finalReport").asBoolean()).isTrue();
        send(token, diagnosticBatch(oldBoot, base.plusSeconds(4), 4, 7, 4, 2, true, 1, true)).andExpect(status().isBadRequest());
        mvc.perform(get("/api/collectors").header("Authorization", "Bearer " + token)).andExpect(status().isUnauthorized());
    }
    private ObjectNode diagnosticBatch(String boot, Instant at, long sequence, int queued, long rejected, long gaps, boolean diskError, long faults, boolean finalReport) {
        var batch = batch().put("reportedAt", at.toString());
        var collector = (ObjectNode) batch.get("collector");
        collector.put("bootId", boot).putObject("diagnostics").put("sequence", sequence).put("queuedEvents", queued)
                .put("rejectedSubmissions", rejected).put("captureGaps", gaps).put("diskError", diskError).put("diskFaults", faults).put("final", finalReport);
        return batch;
    }
    @Test void concurrentRetriesDoNotDuplicateStatistics() throws Exception {
        byte[] body = json.writeValueAsBytes(batch(counter("blocks.mined", 9, "minecraft:stone")));
        try (var pool = Executors.newFixedThreadPool(4)) {
            CountDownLatch start = new CountDownLatch(1); List<Future<Integer>> results = new ArrayList<>();
            for (int i = 0; i < 4; i++) results.add(pool.submit(() -> { start.await(); return mvc.perform(post("/api/ingest/v1/batches").header("Authorization", "Bearer " + token).contentType("application/json").content(body)).andReturn().getResponse().getStatus(); }));
            start.countDown(); for (var result : results) assertThat(result.get(20, TimeUnit.SECONDS)).isEqualTo(200);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM telemetry_batches", Long.class)).isEqualTo(1);
        assertThat(metric(admin("/api/statistics/summary"), "blocks.mined")).isEqualTo("9");
    }
    @Test void sessionsSplitAtLocalMidnightAndDimensionChangesWithoutExtrapolating() throws Exception {
        UUID session = UUID.randomUUID();
        send(token, batch(session(session, 0, 0, false, "minecraft:overworld"), session(session, 1, 20000, false, "minecraft:overworld"), session(session, 2, 30000, true, "minecraft:nether"))).andExpect(status().isOk());
        JsonNode summary = admin("/api/statistics/summary");
        assertThat(metric(summary, "online.millis")).isEqualTo("30000");
        assertThat(summary.get("sessionCount").asLong()).isEqualTo(1);
        assertThat(summary.get("confirmedJoinCount").isNull()).isTrue();
        assertThat(summary.get("longestSessionMillis").asText()).isEqualTo("30000");
        assertThat(metric(admin("/api/statistics/summary?dimension=minecraft:nether"), "online.millis")).isEqualTo("10000");
        LocalDate first = base.atZone(zone).toLocalDate();
        assertThat(metric(admin("/api/statistics/summary?fromDate=" + first + "&toDate=" + first), "online.millis")).isEqualTo("10000");
        JsonNode second = admin("/api/statistics/summary?fromDate=" + first.plusDays(1) + "&toDate=" + first.plusDays(1));
        assertThat(metric(second, "online.millis")).isEqualTo("20000");
        assertThat(second.get("playerCount").asLong()).isEqualTo(1);
        assertThat(admin("/api/statistics/daily?fromDate=" + first + "&toDate=" + first.plusDays(1)).size()).isEqualTo(2);
        JsonNode dimensionRows = admin("/api/statistics/dimensions?metric=online.millis");
        assertThat(dimensionRows.size()).isEqualTo(2);
        assertThat(dimensionRows.get(0).get("dimension").asText()).isEqualTo("minecraft:nether");
        assertThat(dimensionRows.get(0).get("value").asText()).isEqualTo("10000");
    }
    @Test void observedSessionsKeepTimeWithoutInventingJoins() throws Exception {
        UUID joined = UUID.randomUUID(), observed = UUID.randomUUID();
        var start = session(joined, 0, 0, false, "minecraft:overworld").put("sessionStart", "JOIN");
        var stop = session(joined, 1, 10000, true, "minecraft:overworld").put("sessionEnd", "CAPTURE_STOPPED");
        send(token, batch(start, stop)).andExpect(status().isOk());
        send(token, batch(start)).andExpect(status().isOk()).andExpect(jsonPath("$.duplicateEvents").value(1));
        send(token, batch(start.deepCopy().put("sessionStart", "OBSERVED"))).andExpect(status().isConflict());
        base = base.plusSeconds(20);
        send(token, batch(session(observed, 0, 0, false, "minecraft:overworld").put("sessionStart", "OBSERVED"))).andExpect(status().isOk());
        var finish = session(observed, 1, 5000, true, "minecraft:overworld");
        send(token, batch(finish.deepCopy().put("sessionStart", "JOIN"))).andExpect(status().isBadRequest());
        send(token, batch(finish.deepCopy().put("ended", false).put("sessionEnd", "CAPTURE_STOPPED"))).andExpect(status().isBadRequest());
        send(token, batch(finish)).andExpect(status().isOk());
        JsonNode summary = admin("/api/statistics/summary");
        assertThat(summary.get("sessionCount").asLong()).isEqualTo(2);
        assertThat(summary.get("confirmedJoinCount").asLong()).isEqualTo(1);
        assertThat(metric(summary, "online.millis")).isEqualTo("15000");
        var rows = admin("/api/sessions").get("items");
        assertThat(rows.get(0).get("startReason").asText()).isEqualTo("OBSERVED");
        assertThat(rows.get(1).get("endReason").asText()).isEqualTo("CAPTURE_STOPPED");
    }
    @Test void missingCheckpointsAndSessionIdentityChangesCannotSilentlyInventTime() throws Exception {
        UUID id = UUID.randomUUID();
        send(token, batch(session(id, 0, 0, false, "minecraft:overworld"))).andExpect(status().isOk());
        send(token, batch(session(id, 2, 20000, false, "minecraft:overworld"))).andExpect(status().isConflict());
        ObjectNode forged = session(id, 1, 10000, false, "minecraft:overworld").put("at", base.plusSeconds(100).toString());
        send(token, batch(forged)).andExpect(status().isBadRequest());
        ObjectNode switched = session(id, 1, 10000, false, "minecraft:overworld"); switched.set("player", player("123", "Other"));
        send(token, batch(switched)).andExpect(status().isConflict());
        send(token, batch(session(id, 1, 10000, false, "minecraft:overworld"))).andExpect(status().isOk());
        assertThat(metric(admin("/api/statistics/summary"), "online.millis")).isEqualTo("10000");
    }
    @Test void replacementClosesInterruptedSessionAtLastCheckpoint() throws Exception {
        UUID old = UUID.randomUUID();
        send(token, batch(session(old, 0, 0, false, "minecraft:overworld"), session(old, 1, 10000, false, "minecraft:overworld"))).andExpect(status().isOk());
        Instant original = base; base = base.plusSeconds(60);
        send(token, batch(session(UUID.randomUUID(), 0, 0, false, "minecraft:overworld"))).andExpect(status().isOk());
        base = original;
        assertThat(jdbc.queryForObject("SELECT end_reason FROM player_sessions WHERE session_id = ?", String.class, old)).isEqualTo("REPLACED");
        assertThat(metric(admin("/api/statistics/summary"), "online.millis")).isEqualTo("10000");
        assertThat(admin("/api/statistics/summary").get("sessionCount").asLong()).isEqualTo(2);
        send(token, batch(session(old, 2, 20000, true, "minecraft:overworld"))).andExpect(status().isConflict());
    }
    @Test void crossServerIdentityRenameMaximaAndArchivedHistoryArePreserved() throws Exception {
        send(token, batch(counter("blocks.mined", 5, "minecraft:stone"), counter("level.max", 10, null))).andExpect(status().isOk());
        UUID second = archives.create("第二期", "", LocalDate.of(2020, 1, 1)).id(); String secondToken = credentials.rotate(second).token();
        ObjectNode mined = counter("blocks.mined", 7, "minecraft:stone").put("at", base.plusSeconds(5).toString()); mined.set("player", player("123456789", "Alicia"));
        send(secondToken, batch(mined, counter("level.max", 25, null))).andExpect(status().isOk());
        ObjectNode oldName = counter("experience.gained", 1, null).put("at", base.minusSeconds(5).toString());
        send(token, batch(oldName)).andExpect(status().isOk());
        ObjectNode other = counter("blocks.mined", 1, "minecraft:stone"); other.set("player", player("987654321", "Alicia"));
        send(secondToken, batch(other)).andExpect(status().isOk());
        mvc.perform(post("/api/servers/" + server + "/archive").with(user("admin").roles("ADMIN")).with(csrf()).contentType("application/json").content("{\"endDate\":\"" + LocalDate.now(zone) + "\"}"))
                .andExpect(status().isOk());
        JsonNode summary = admin("/api/statistics/summary");
        assertThat(summary.get("playerCount").asLong()).isEqualTo(2);
        assertThat(metric(summary, "blocks.mined")).isEqualTo("13"); assertThat(metric(summary, "level.max")).isEqualTo("25");
        assertThat(admin("/api/players?search=Alice").get("total").asLong()).isEqualTo(1);
        JsonNode profile = admin("/api/players/xuid:123456789");
        assertThat(profile.get("player").get("name").asText()).isEqualTo("Alicia");
        assertThat(profile.get("names").size()).isEqualTo(2); assertThat(profile.get("servers").size()).isEqualTo(2);
        assertThat(admin("/api/statistics/servers").size()).isGreaterThanOrEqualTo(4);
        assertThat(metric(admin("/api/statistics/summary?serverId=" + server), "blocks.mined")).isEqualTo("5");
    }
    @Test void missingCapabilityIsNullWhileEnabledZeroIsZeroAndDimensionCoverageIsExplicit() throws Exception {
        assertThat(metric(admin("/api/statistics/summary"), "blocks.mined")).isNull();
        ObjectNode heartbeat = batch(); heartbeat.set("capabilities", json.createArrayNode().add(capability("blocks.mined", "EXACT", "test-v1", false)));
        send(token, heartbeat).andExpect(status().isOk());
        assertThat(metric(admin("/api/statistics/summary"), "blocks.mined")).isEqualTo("0");
        assertThat(metric(admin("/api/statistics/summary"), "deaths")).isNull();
        assertThat(metric(admin("/api/statistics/summary?dimension=minecraft:nether"), "blocks.mined")).isNull();
        JsonNode collector = admin("/api/collectors").get(0);
        assertThat(collector.get("connectionState").asText()).isEqualTo("CONNECTED");
        assertThat(collector.get("coverage").size()).isEqualTo(1);
        ObjectNode invalidChange = batch(); invalidChange.set("capabilities", json.createArrayNode().add(capability("blocks.mined", "EXACT", "test-v1", true)));
        send(token, invalidChange).andExpect(status().isConflict());
    }
    @Test void blockSubcategoriesAndDeathDetailsAreQueryableWithoutDoubleCounting() throws Exception {
        send(token, batch(counter("blocks.mined", 4, "minecraft:oak_log"), counter("blocks.mined", 7, "minecraft:diamond_ore"), counter("blocks.mined", 2, "minecraft:stone"), death("fall"), death("lava"))).andExpect(status().isOk());
        JsonNode summary = admin("/api/statistics/summary");
        assertThat(metric(summary, "blocks.mined")).isEqualTo("13");
        assertThat(summary.get("woodBlocks").asText()).isEqualTo("4"); assertThat(summary.get("oreBlocks").asText()).isEqualTo("7");
        JsonNode breakdown = admin("/api/statistics/breakdown?metric=blocks.mined&category=ORE&pageSize=1");
        assertThat(breakdown.get("items").get(0).get("subject").asText()).isEqualTo("minecraft:diamond_ore");
        JsonNode deaths = admin("/api/deaths?pageSize=1"); assertThat(deaths.get("total").asLong()).isEqualTo(2); assertThat(deaths.get("items").size()).isEqualTo(1);
        assertThat(deaths.get("items").get(0).get("killerType").asText()).isEqualTo("minecraft:zombie");
    }
    @Test void estimateVersionsRemainVisibleAndLevelUsesMaxAcrossVersions() throws Exception {
        ObjectNode first = batch(counter("travel.walk_millimeters", 1000, null));
        first.set("capabilities", json.createArrayNode().add(capability("travel.walk_millimeters", "ESTIMATED", "distance-v1", true)));
        send(token, first).andExpect(status().isOk());
        ObjectNode second = batch(counter("travel.walk_millimeters", 2000, null));
        second.set("capabilities", json.createArrayNode().add(capability("travel.walk_millimeters", "ESTIMATED", "distance-v2", true)));
        send(token, second).andExpect(status().isOk());
        JsonNode summary = admin("/api/statistics/summary"); assertThat(metric(summary, "travel.walk_millimeters")).isEqualTo("3000");
        JsonNode estimate = null; for (JsonNode row : summary.get("metrics")) if (row.get("key").asText().equals("travel.walk_millimeters")) estimate = row;
        assertThat(estimate.get("measurements").size()).isEqualTo(2);
        ObjectNode bad = second.deepCopy().put("batchId", UUID.randomUUID().toString()); ((ObjectNode) bad.get("capabilities").get(0)).put("quality", "EXACT");
        send(token, bad).andExpect(status().isBadRequest());
    }
    @Test void archivedServerAcceptsOnlyOldBacklogAndTelemetryLocksPeriodIdentity() throws Exception {
        send(token, batch(counter("blocks.mined", 1, "minecraft:stone"))).andExpect(status().isOk());
        mvc.perform(put("/api/servers/" + server).with(user("admin").roles("ADMIN")).with(csrf()).contentType("application/json")
                .content("{\"name\":\"Changed\",\"description\":\"\",\"startDate\":\"2021-01-01\"}"))
                .andExpect(status().isConflict());
        LocalDate day = base.atZone(zone).toLocalDate();
        mvc.perform(post("/api/servers/" + server + "/archive").with(user("admin").roles("ADMIN")).with(csrf()).contentType("application/json").content("{\"endDate\":\"" + day.minusDays(1) + "\"}"))
                .andExpect(status().isConflict());
        mvc.perform(post("/api/servers/" + server + "/archive").with(user("admin").roles("ADMIN")).with(csrf()).contentType("application/json").content("{\"endDate\":\"" + day + "\"}"))
                .andExpect(status().isOk());
        send(token, batch(counter("blocks.mined", 2, "minecraft:stone"))).andExpect(status().isOk());
        send(token, batch(counter("blocks.mined", 100, "minecraft:stone").put("at", base.plusSeconds(60).toString()))).andExpect(status().isBadRequest());
        assertThat(metric(admin("/api/statistics/summary"), "blocks.mined")).isEqualTo("3");
    }
    @Test void envelopeValidationIsBoundedAndRejectsUnknownOrFractionalFields() throws Exception {
        for (String body : List.of("null", "{}", json.writeValueAsString(batch()).replace("\"protocolVersion\":1", "\"protocolVersion\":1.5"),
                json.writeValueAsString(batch().put("inventory", "forbidden")), json.writeValueAsString(batch(counter("blocks.mined", -1, "minecraft:stone"))))) {
            mvc.perform(post("/api/ingest/v1/batches").header("Authorization", "Bearer " + token).contentType("application/json").content(body)).andExpect(status().isBadRequest());
        }
        ObjectNode duplicate = counter("blocks.mined", 1, "minecraft:stone"); send(token, batch(duplicate, duplicate)).andExpect(status().isBadRequest());
        ObjectNode malformed = counter("blocks.mined", 1, "minecraft:stone"); malformed.set("player", player("000123", "Alice")); send(token, batch(malformed)).andExpect(status().isBadRequest());
        ObjectNode many = batch(); ArrayNode events = (ArrayNode) many.get("events"); for (int i = 0; i < 1001; i++) events.add(counter("blocks.mined", 1, "minecraft:stone"));
        send(token, many).andExpect(status().isBadRequest());
        mvc.perform(post("/api/ingest/v1/batches").header("Authorization", "Bearer " + token).contentType("application/json").content(" ".repeat(1_048_577))).andExpect(status().isPayloadTooLarge());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM telemetry_events", Long.class)).isZero();
    }
    @Test void invalidQueryDatesPagesAndMetricsAreRejected() throws Exception {
        for (String url : List.of("/api/statistics/summary?fromDate=2026-10-20&toDate=2026-10-01", "/api/players?page=0", "/api/deaths?pageSize=101",
                "/api/statistics/breakdown?metric=not.real", "/api/statistics/summary?dimension=invalid", "/api/statistics/daily?fromDate=2020-01-01&toDate=2026-10-01"))
            mvc.perform(get(url).with(user("admin").roles("ADMIN"))).andExpect(status().isBadRequest());
        mvc.perform(get("/api/statistics/summary?serverId=" + UUID.randomUUID()).with(user("admin").roles("ADMIN"))).andExpect(status().isNotFound());
    }
    @Test void concurrentServersCanCreateTheSamePlayerWithoutIdentityRaces() throws Exception {
        UUID second = archives.create("并发服务器", "", LocalDate.of(2020, 1, 1)).id();
        String secondToken = credentials.rotate(second).token();
        try (var pool = Executors.newFixedThreadPool(2)) {
            CountDownLatch start = new CountDownLatch(1);
            var first = pool.submit(() -> { start.await(); return send(token, batch(counter("blocks.mined", 4, "minecraft:stone"))).andReturn().getResponse().getStatus(); });
            var other = pool.submit(() -> { start.await(); return send(secondToken, batch(counter("blocks.mined", 6, "minecraft:stone"))).andReturn().getResponse().getStatus(); });
            start.countDown(); assertThat(first.get(20, TimeUnit.SECONDS)).isEqualTo(200); assertThat(other.get(20, TimeUnit.SECONDS)).isEqualTo(200);
        }
        assertThat(admin("/api/statistics/summary").get("playerCount").asLong()).isEqualTo(1);
        assertThat(metric(admin("/api/statistics/summary"), "blocks.mined")).isEqualTo("10");
    }
    @Test void oldBacklogCannotOverwriteNewCapabilityStateOrCurrentNames() throws Exception {
        ObjectNode current = batch(); current.set("capabilities", json.createArrayNode().add(capability("chat.messages", "EXACT", "new-v2", true)));
        send(token, current).andExpect(status().isOk());
        ObjectNode old = batch(counter("chat.messages", 2, null)).put("reportedAt", base.plusSeconds(5).toString());
        old.set("capabilities", json.createArrayNode().add(capability("chat.messages", "EXACT", "old-v1", true)));
        send(token, old).andExpect(status().isOk());
        JsonNode collector = admin("/api/collectors").get(0);
        assertThat(collector.get("capabilities").get(0).get("algorithmVersion").asText()).isEqualTo("new-v2");
        assertThat(collector.get("coverage").size()).isEqualTo(2);
        assertThat(metric(admin("/api/statistics/summary"), "chat.messages")).isEqualTo("2");
    }
    @Test void sessionDetailsAndUnobservedPlayerDatesDoNotPretendToBeOnline() throws Exception {
        UUID id = UUID.randomUUID();
        send(token, batch(session(id, 0, 0, false, "minecraft:overworld"), session(id, 1, 10000, false, "minecraft:overworld"))).andExpect(status().isOk());
        JsonNode sessions = admin("/api/sessions?playerKey=xuid:123456789");
        assertThat(sessions.get("items").get(0).get("onlineMillis").asText()).isEqualTo("10000");
        assertThat(sessions.get("items").get(0).get("state").asText()).isEqualTo("STALE");
        assertThat(metric(admin("/api/statistics/summary?playerKey=xuid:123456789&fromDate=" + LocalDate.now(zone)), "online.millis")).isNull();
        UUID second = archives.create("未参与", "", LocalDate.of(2020, 1, 1)).id();
        mvc.perform(get("/api/statistics/summary?serverId=" + second + "&playerKey=xuid:123456789").with(user("admin").roles("ADMIN"))).andExpect(status().isNotFound());
        mvc.perform(get("/api/sessions?dimension=minecraft:nether").with(user("admin").roles("ADMIN"))).andExpect(status().isBadRequest());
    }
    @Test void tokenRotatedAfterAuthenticationCannotCommitAnInFlightBatch() throws Exception {
        var identity = credentials.authenticate("Bearer " + token);
        credentials.rotate(server);
        ObjectNode input = batch(counter("blocks.mined", 1, "minecraft:stone"));
        byte[] bytes = json.writeValueAsBytes(input);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.ingest(identity, json.treeToValue(input, TelemetryPayload.Batch.class), bytes))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                .satisfies(ex -> assertThat(((org.springframework.web.server.ResponseStatusException) ex).getStatusCode().value()).isEqualTo(401));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM telemetry_events", Long.class)).isZero();
    }
    @Test void sealingCutoffIsStableWhenMetadataIsEditedAndDuplicateJsonKeysFail() throws Exception {
        send(token, batch(counter("blocks.mined", 1, "minecraft:stone"))).andExpect(status().isOk());
        mvc.perform(post("/api/servers/" + server + "/archive").with(user("admin").roles("ADMIN")).with(csrf()).contentType("application/json").content("{\"endDate\":\"" + LocalDate.now(zone) + "\"}"))
                .andExpect(status().isOk());
        OffsetDateTime sealed = jdbc.queryForObject("SELECT sealed_at FROM server_archives WHERE id = ?", OffsetDateTime.class, server);
        mvc.perform(put("/api/servers/" + server).with(user("admin").roles("ADMIN")).with(csrf()).contentType("application/json").content("{\"name\":\"改名\",\"description\":\"\",\"startDate\":\"2020-01-01\"}"))
                .andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT sealed_at FROM server_archives WHERE id = ?", OffsetDateTime.class, server)).isEqualTo(sealed);
        Instant future = Instant.now().truncatedTo(ChronoUnit.MILLIS).plusSeconds(10);
        ObjectNode after = batch(counter("blocks.mined", 100, "minecraft:stone").put("at", future.toString())).put("reportedAt", future.toString());
        send(token, after).andExpect(status().isBadRequest());
        String duplicateKeys = json.writeValueAsString(batch()).replace("\"protocolVersion\":1", "\"protocolVersion\":1,\"protocolVersion\":1");
        mvc.perform(post("/api/ingest/v1/batches").header("Authorization", "Bearer " + token).contentType("application/json").content(duplicateKeys)).andExpect(status().isBadRequest());
    }
}
