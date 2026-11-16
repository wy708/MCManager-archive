package org.mcmanager.archive;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.web.servlet.*;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class ConstructionAssetAccessTest {
    @TempDir Path root;
    final UUID project=UUID.randomUUID(),build=UUID.randomUUID();
    final String texture="a".repeat(64)+".png";
    JdbcTemplate jdbc;
    ConstructionModels models;
    ObjectMapper json;
    ConstructionRendering rendering;
    MockMvc mvc;
    Path buildDirectory;

    @BeforeEach void setUp()throws Exception {
        var source=new DriverManagerDataSource("jdbc:h2:mem:asset_"+UUID.randomUUID()+";DB_CLOSE_DELAY=-1","sa","");
        jdbc=new JdbcTemplate(source);
        // Deliberately omit section storage: immutable asset reads must not touch it.
        jdbc.execute("CREATE TABLE construction_phases(project_id UUID,revision INTEGER,model_version BIGINT,status VARCHAR(20),PRIMARY KEY(project_id,revision))");
        jdbc.update("INSERT INTO construction_phases VALUES (?,1,1,'COMPLETE')",project);
        json=spy(new ObjectMapper().findAndRegisterModules());
        models=spy(new ConstructionModels(jdbc,json,mock(CollectorCredentials.class),mock(AgentCredentials.class)));
        rendering=new ConstructionRendering(models,jdbc,json,new DataSourceTransactionManager(source),"",root.toString(),"node");
        buildDirectory=root.resolve(project.toString()).resolve("1").resolve(build.toString());
        var output=Files.createDirectories(buildDirectory.resolve("output"));
        Files.writeString(output.resolve("scene.json"),"""
            {"format":1,"models":[{"x":0,"y":64,"z":0,"faces":[{"points":[0,0,0,16,0,0,16,16,0,0,16,0]}]}],"issues":[]}
            """);
        Files.write(output.resolve(texture),new byte[]{1,2,3,4});
        json.writeValue(buildDirectory.resolve("ready.json").toFile(),new ConstructionRendering.State("READY","ready",build,1,1,Instant.now(),List.of()));
        mvc=MockMvcBuilders.standaloneSetup(new ConstructionRenderingController(rendering)).build();
    }
    @AfterEach void close(){rendering.close();jdbc.execute("DROP ALL OBJECTS");}
    String url(String file){return "/api/public/projects/"+project+"/phases/1/scene/"+build+"/"+file;}
    ResultActions streamed(String url,String etag)throws Exception{
        var request=get(url);if(etag!=null)request.header(HttpHeaders.IF_NONE_MATCH,etag);
        var result=mvc.perform(request).andExpect(request().asyncStarted()).andReturn();
        return mvc.perform(asyncDispatch(result));
    }
    @Test void texturesUseOneExistenceLookupAndReuseRestoredMetadata()throws Exception {
        for(int i=0;i<20;i++)assertThat(rendering.asset(project,1,build,texture)).isEqualTo(buildDirectory.resolve("output").resolve(texture));
        verify(models,times(20)).requirePhase(project,1);
        verify(models,never()).status(any(),anyInt());
        verify(json,times(1)).readValue(buildDirectory.resolve("ready.json").toFile(),ConstructionRendering.State.class);
    }
    @Test void assetReadsDoNotWaitForTheGlobalBakerMonitor()throws Exception {
        var locked=new CountDownLatch(1);var release=new CountDownLatch(1);
        try(var executor=Executors.newFixedThreadPool(2)){
            var lockHolder=executor.submit(()->{synchronized(rendering){locked.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}}});
            assertThat(locked.await(2,TimeUnit.SECONDS)).isTrue();
            try{
                var asset=executor.submit(()->rendering.asset(project,1,build,texture));
                assertThat(asset.get(2,TimeUnit.SECONDS)).isEqualTo(buildDirectory.resolve("output").resolve(texture));
            }finally{release.countDown();lockHolder.get(2,TimeUnit.SECONDS);}
        }
    }
    @Test void conditionalTexturesRevalidateExistenceAndRejectDeletedPhases()throws Exception {
        var first=streamed(url(texture),null).andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL,"no-cache"))
            .andExpect(content().bytes(new byte[]{1,2,3,4})).andReturn();
        String etag=first.getResponse().getHeader(HttpHeaders.ETAG);assertThat(etag).isNotBlank();
        mvc.perform(get(url(texture)).header(HttpHeaders.IF_NONE_MATCH,etag)).andExpect(status().isNotModified()).andExpect(content().bytes(new byte[0]));
        mvc.perform(get(url(texture)).header(HttpHeaders.IF_NONE_MATCH,"\"another-tag\", W/"+etag)).andExpect(status().isNotModified());
        mvc.perform(get(url(texture).replace("/phases/1/","/phases/2/")).header(HttpHeaders.IF_NONE_MATCH,"*")).andExpect(status().isNotFound());
        jdbc.update("DELETE FROM construction_phases WHERE project_id=?",project);
        mvc.perform(get(url(texture)).header(HttpHeaders.IF_NONE_MATCH,etag)).andExpect(status().isNotFound());
        mvc.perform(get(url("scene.json")).header(HttpHeaders.IF_NONE_MATCH,"*")).andExpect(status().isNotFound());
    }
    @Test void heightRangesHaveDistinctValidatorsAndKeepOriginalGeometry()throws Exception {
        var first=streamed(url("scene.json")+"?minY=64&maxY=64",null).andExpect(status().isOk()).andReturn();
        String etag=first.getResponse().getHeader(HttpHeaders.ETAG);
        assertThat(json.readTree(first.getResponse().getContentAsByteArray()).path("models")).hasSize(1);
        mvc.perform(get(url("scene.json")).param("minY","64").param("maxY","64").header(HttpHeaders.IF_NONE_MATCH,etag)).andExpect(status().isNotModified());
        var other=streamed(url("scene.json")+"?minY=128&maxY=128",etag).andExpect(status().isOk()).andReturn();
        assertThat(other.getResponse().getHeader(HttpHeaders.ETAG)).isNotEqualTo(etag);
        assertThat(json.readTree(other.getResponse().getContentAsByteArray()).path("models")).isEmpty();
        var all=streamed(url("scene.json"),etag).andExpect(status().isOk()).andReturn();
        assertThat(all.getResponse().getHeader(HttpHeaders.ETAG)).isNotEqualTo(etag);
        assertThat(all.getResponse().getContentAsByteArray()).isEqualTo(Files.readAllBytes(buildDirectory.resolve("output/scene.json")));
        mvc.perform(get(url("scene.json")).param("minY","128").param("maxY","64").header(HttpHeaders.IF_NONE_MATCH,etag)).andExpect(status().isBadRequest());
    }
}
