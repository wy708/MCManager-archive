package org.mcmanager.archive;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.test.context.support.*;
import org.springframework.test.web.servlet.MockMvc;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:terrain_test;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1","mcmanager.admin-password=terrain-test-password-2026"})
@AutoConfigureMockMvc
@WithMockUser(roles="ADMIN")
class TerrainIntegrationTest {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired ArchiveRepository archives;
    @Autowired TerrainQueries terrain;
    @Autowired TerrainEngine engine;
    @Autowired AgentCredentials agents;
    @Autowired JdbcTemplate jdbc;
    UUID server;
    @BeforeEach void prepare(){server=archives.create("Terrain QA","",LocalDate.of(2026,1,1)).id();}
    private String profilePath(){return "/api/servers/"+server+"/terrain-profile";}
    private String queryPath(){return "/api/servers/"+server+"/terrain-prediction?dimension=minecraft:overworld&x=-1&y=64&z=-17&radius=16&step=16";}
    @Test void profilesValidateFullPrecisionAndRequireCsrf() throws Exception {
        String valid="{\"enabled\":true,\"seed\":\"-9007199254740993\",\"generationVersion\":\"1.26.61.1\"}";
        mvc.perform(put(profilePath()).contentType("application/json").content(valid)).andExpect(status().isForbidden());
        mvc.perform(put(profilePath()).with(csrf()).contentType("application/json").content(valid)).andExpect(status().isOk()).andExpect(jsonPath("$.profile.seed").value("-9007199254740993"));
        mvc.perform(put(profilePath()).with(csrf()).contentType("application/json").content(valid.replace("-9007199254740993","9223372036854775808"))).andExpect(status().isBadRequest());
        mvc.perform(put(profilePath()).with(csrf()).contentType("application/json").content(valid.replace("1.26.61.1","java-1.21"))).andExpect(status().isBadRequest());
        mvc.perform(get(profilePath())).andExpect(jsonPath("$.profile.seed").value("-9007199254740993"));
    }
    @Test void predictionWorksWithoutCollectorAndInvalidatesWhenWorldChanges() throws Exception {
        Assumptions.assumeTrue(engine.available(),"Build the optional native terrain engine to run its real integration test");
        mvc.perform(get(queryPath())).andExpect(jsonPath("$.status").value("NOT_CONFIGURED"));
        terrain.save(server,new TerrainQueries.Input(true,"1","1.26.61.1"));
        String first=mvc.perform(get(queryPath())).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("PREDICTED"))
            .andExpect(jsonPath("$.source").value("SEED_PREDICTION")).andExpect(jsonPath("$.seed").doesNotExist())
            .andExpect(jsonPath("$.samples.length()").value(9)).andExpect(jsonPath("$.chunk.x").value(-1)).andExpect(jsonPath("$.chunk.z").value(-2))
            .andExpect(jsonPath("$.cacheHit").value(false)).andReturn().getResponse().getContentAsString();
        mvc.perform(get(queryPath())).andExpect(jsonPath("$.cacheHit").value(true));
        terrain.save(server,new TerrainQueries.Input(true,"-9007199254740993","1.26.61.1"));
        String next=mvc.perform(get(queryPath())).andExpect(jsonPath("$.cacheHit").value(false)).andReturn().getResponse().getContentAsString();
        assertThat(json.readTree(next).path("configurationRevision")).isNotEqualTo(json.readTree(first).path("configurationRevision"));
        terrain.save(server,new TerrainQueries.Input(false,"1","1.26.61.1"));
        mvc.perform(get(queryPath())).andExpect(jsonPath("$.status").value("NOT_CONFIGURED"));
    }
    @Test void rangeAndDimensionsDoNotReachEngine() throws Exception {
        for(String path:List.of(queryPath().replace("radius=16","radius=129"),queryPath().replace("radius=16","radius=17"),queryPath().replace("minecraft:overworld","minecraft:the_end"),queryPath().replace("x=-1","x=30000000")))
            mvc.perform(get(path)).andExpect(status().isBadRequest());
    }
    @Test @WithAnonymousUser void directMcpSeedNeedsNoSavedProfileAndFlatWorldsAreNotMisrepresented() throws Exception {
        Assumptions.assumeTrue(engine.available());
        var issued=agents.create("direct-terrain",List.of(new AgentCredentials.Grant(server,Set.of(AgentCredentials.Scope.WORLD_READ))));
        String endpoint="/api/agent/servers/"+server+"/terrain-prediction";
        String body="{\"seed\":\"-9007199254740993\",\"generationVersion\":\"1.26.61.1\",\"worldType\":\"DEFAULT\",\"at\":{\"dimension\":\"minecraft:overworld\",\"x\":-1,\"y\":64,\"z\":-17,\"radius\":0,\"step\":16}}";
        mvc.perform(post(endpoint).header("Authorization","Bearer "+issued.token()).contentType("application/json").content(body))
            .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("PREDICTED")).andExpect(jsonPath("$.seedSource").value("REQUEST"))
            .andExpect(jsonPath("$.seed").doesNotExist()).andExpect(jsonPath("$.configurationRevision").doesNotExist());
        assertThat(terrain.profile(server)).isNull();
        mvc.perform(post(endpoint).header("Authorization","Bearer "+issued.token()).contentType("application/json").content(body.replace("DEFAULT","FLAT")))
            .andExpect(jsonPath("$.status").value("UNSUPPORTED_WORLD_TYPE")).andExpect(jsonPath("$.samples").doesNotExist());
        agents.revoke(issued.account().id());
        mvc.perform(post(endpoint).header("Authorization","Bearer "+issued.token()).contentType("application/json").content(body)).andExpect(status().isUnauthorized());
    }
    @Test @WithAnonymousUser void serverIsolationAndRevocationApplyToOfflineReads() throws Exception {
        var granted=agents.create("terrain-reader",List.of(new AgentCredentials.Grant(server,Set.of(AgentCredentials.Scope.WORLD_READ))));
        var stats=agents.create("stats-only",List.of(new AgentCredentials.Grant(server,Set.of(AgentCredentials.Scope.STATS_READ))));
        String endpoint=queryPath().replace("/api/servers/","/api/agent/servers/");
        mvc.perform(get(endpoint)).andExpect(status().isUnauthorized());
        mvc.perform(get(profilePath()).header("Authorization","Bearer "+granted.token())).andExpect(status().isUnauthorized());
        mvc.perform(get(endpoint).header("Authorization","Bearer "+stats.token())).andExpect(status().isForbidden());
        mvc.perform(get(endpoint).header("Authorization","Bearer "+granted.token())).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("NOT_CONFIGURED"));
        mvc.perform(get(endpoint.replace(server.toString(),UUID.randomUUID().toString())).header("Authorization","Bearer "+granted.token())).andExpect(status().isForbidden());
        agents.revoke(granted.account().id());
        mvc.perform(get(endpoint).header("Authorization","Bearer "+granted.token())).andExpect(status().isUnauthorized());
    }
    @Test @WithAnonymousUser void seedMapStructuresAndChunksRemainScopedAndBounded() throws Exception {
        Assumptions.assumeTrue(engine.available());
        var issued=agents.create("seedmap",List.of(new AgentCredentials.Grant(server,Set.of(AgentCredentials.Scope.WORLD_READ))));
        var stats=agents.create("seedmap-stats",List.of(new AgentCredentials.Grant(server,Set.of(AgentCredentials.Scope.STATS_READ))));
        String endpoint="/api/agent/servers/"+server+"/structure-predictions";
        String body="{\"seed\":\"1\",\"generationVersion\":\"1.26.61.1\",\"worldType\":\"DEFAULT\",\"dimension\":\"minecraft:overworld\",\"x\":0,\"z\":0,\"radius\":2048,\"limit\":1,\"structure\":\"village\"}";
        mvc.perform(post(endpoint).header("Authorization","Bearer "+issued.token()).contentType("application/json").content(body)).andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("PREDICTED")).andExpect(jsonPath("$.candidates[0].x").value(152)).andExpect(jsonPath("$.candidates[0].z").value(808))
            .andExpect(jsonPath("$.truncated").value(true)).andExpect(jsonPath("$.candidates[0].observed").value(false)).andExpect(jsonPath("$.seed").doesNotExist());
        assertThat(terrain.profile(server)).isNull();
        mvc.perform(post(endpoint).header("Authorization","Bearer "+stats.token()).contentType("application/json").content(body)).andExpect(status().isForbidden());
        mvc.perform(post(endpoint.replace(server.toString(),UUID.randomUUID().toString())).header("Authorization","Bearer "+issued.token()).contentType("application/json").content(body)).andExpect(status().isForbidden());
        for(String invalid:List.of(body.replace("2048","4097"),body.replace("\"limit\":1","\"limit\":33"),body.replace("village","fortress"),body.replace("\"seed\":\"1\"","\"seed\":\"9223372036854775808\"")))
            mvc.perform(post(endpoint).header("Authorization","Bearer "+issued.token()).contentType("application/json").content(invalid)).andExpect(status().isBadRequest());
        mvc.perform(post(endpoint).header("Authorization","Bearer "+issued.token()).contentType("application/json").content(body.replace("DEFAULT","FLAT"))).andExpect(jsonPath("$.status").value("UNSUPPORTED_WORLD_TYPE"));
        String chunk="/api/agent/servers/"+server+"/chunk-info?dimension=minecraft:overworld&x=-1&z=-17&radius=0";
        mvc.perform(get(chunk).header("Authorization","Bearer "+issued.token())).andExpect(status().isOk()).andExpect(jsonPath("$.centerChunk.x").value(-1)).andExpect(jsonPath("$.centerChunk.z").value(-2))
            .andExpect(jsonPath("$.chunks[0].minX").value(-16)).andExpect(jsonPath("$.chunks[0].maxX").value(-1)).andExpect(jsonPath("$.seedIndependent").value(true));
        mvc.perform(get(chunk.replace("overworld","nether")).header("Authorization","Bearer "+issued.token())).andExpect(jsonPath("$.slimeApplicable").value(false)).andExpect(jsonPath("$.chunks[0].slimeChunk").isEmpty());
        for(String invalid:List.of(chunk.replace("radius=0","radius=9"),chunk.replace("x=-1","x=-2147483648"),chunk.replace("x=-1","x=30000000")))
            mvc.perform(get(invalid).header("Authorization","Bearer "+issued.token())).andExpect(status().isBadRequest());
        mvc.perform(get(chunk).header("Authorization","Bearer "+stats.token())).andExpect(status().isForbidden());
        agents.revoke(issued.account().id());
        mvc.perform(get(chunk).header("Authorization","Bearer "+issued.token())).andExpect(status().isUnauthorized());
        mvc.perform(post(endpoint).header("Authorization","Bearer "+issued.token()).contentType("application/json").content(body)).andExpect(status().isUnauthorized());
    }
    @Test void historicalRecordsRemainPartialBoundedAndDimensionSpecific() throws Exception {
        var observed=Instant.parse("2026-01-01T00:00:00Z");
        for(int i=0;i<10;i++)jdbc.update("INSERT INTO world_state_cache(server_id,target_hash,observed_at,data_json,target_kind,dimension,pos_x,pos_y,pos_z) VALUES (?,?,?,?,?,?,?,?,?)",
            server,"test"+i,TelemetryService.time(observed),"{\"block\":\"minecraft:chest\"}","BLOCK","minecraft:overworld",i,64,0);
        String endpoint="/api/servers/"+server+"/recorded-environment?dimension=minecraft:overworld&x=0&y=64&z=0&radius=16";
        mvc.perform(get(endpoint)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("HISTORY"))
            .andExpect(jsonPath("$.records.length()").value(8)).andExpect(jsonPath("$.truncated").value(true))
            .andExpect(jsonPath("$.completeWorldCoverage").value(false)).andExpect(jsonPath("$.records[0].observedAt").value(observed.toString()));
        mvc.perform(get(endpoint.replace("overworld","nether"))).andExpect(jsonPath("$.status").value("NO_RECORD"));
    }
}
