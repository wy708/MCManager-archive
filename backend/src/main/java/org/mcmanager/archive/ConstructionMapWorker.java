package org.mcmanager.archive;

import com.fasterxml.jackson.databind.*;
import java.net.*;
import java.net.http.*;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;

@Component
class ConstructionMapWorker {
    private final JdbcTemplate jdbc; private final ObjectMapper json; private final TransactionTemplate transactions;
    private final AgentCredentials agents; private final Map<UUID,URI> sources=new HashMap<>();
    private final Map<UUID,Integer> cursors=new HashMap<>();
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build();
    ConstructionMapWorker(JdbcTemplate jdbc,ObjectMapper json,AgentCredentials agents,PlatformTransactionManager manager,
            @Value("${MCM_PROJECT_MAP_SOURCES:}") String configuration){
        this.jdbc=jdbc;this.json=json;this.agents=agents;this.transactions=new TransactionTemplate(manager);
        for(String entry:configuration.split(","))if(!entry.isBlank()){
            var pair=entry.strip().split("=",2);var uri=URI.create(pair[1]);
            if(!Set.of("http","https").contains(uri.getScheme()) || uri.getHost()==null || uri.getUserInfo()!=null || uri.getQuery()!=null || uri.getFragment()!=null)throw new IllegalArgumentException("Invalid project map source");
            sources.put(UUID.fromString(pair[0]),uri.resolve("/internal/project-map"));
        }
    }
    @Scheduled(fixedDelayString="${mcmanager.project-map-refresh-ms:60000}",initialDelay=5000)
    public void refresh(){
        for(var source:sources.entrySet()) {
            var rows=jdbc.queryForList("""
              SELECT r.project_id,r.revision,r.dimension,r.min_x,r.max_x,r.min_z,r.max_z FROM construction_phases r JOIN construction_projects p ON p.id=r.project_id
              WHERE p.server_id=? AND r.status IN ('ACTIVE','SAVING')
              ORDER BY r.project_id,r.revision
              """,source.getKey());
            if(rows.isEmpty())continue;
            int start=Math.floorMod(cursors.getOrDefault(source.getKey(),0),rows.size());
            int count=Math.min(20,rows.size());cursors.put(source.getKey(),(start+count)%rows.size());
            for(int index=0;index<count;index++)try{
                var row=rows.get((start+index)%rows.size());
                UUID id=(UUID)row.get("project_id");int revision=((Number)row.get("revision")).intValue();
                var body=Map.of("dimension",row.get("dimension"),"minX",row.get("min_x"),"maxX",row.get("max_x"),"minZ",row.get("min_z"),"maxZ",row.get("max_z"));
                var request=HttpRequest.newBuilder(source.getValue()).timeout(Duration.ofSeconds(15)).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
                var response=client.send(request,HttpResponse.BodyHandlers.ofInputStream());
                byte[] bytes;try(var input=response.body()){bytes=input.readNBytes(8*1024*1024+1);}
                if(response.statusCode()!=200 || bytes.length>8*1024*1024)continue;
                var result=json.readTree(bytes);byte[] png=Base64.getDecoder().decode(result.required("image").asText());
                if(png.length<8 || png[0]!=(byte)137 || png[1]!=80 || png[2]!=78 || png[3]!=71)continue;
                var metadata=result.required("metadata");if(metadata.path("foundTiles").asInt()==0)continue;
                String details=json.writeValueAsString(metadata);Instant at=Instant.now();
                transactions.executeWithoutResult(tx->{
                    agents.lock();
                    jdbc.update("UPDATE construction_phases SET map_image=?,map_metadata=?,map_at=?,status=CASE WHEN status='SAVING' THEN 'COMPLETE' ELSE status END WHERE project_id=? AND revision=? AND status IN ('ACTIVE','SAVING')",png,details,TelemetryService.time(at),id,revision);
                    jdbc.update("UPDATE construction_projects SET status='COMPLETE' WHERE id=? AND revision=? AND status='SAVING' AND EXISTS(SELECT 1 FROM construction_phases WHERE project_id=? AND revision=? AND status='COMPLETE')",id,revision,id,revision);
                });
            }catch(Exception error){org.slf4j.LoggerFactory.getLogger(getClass()).warn("Project map refresh unavailable for configured server {} ({})",source.getKey(),error.getClass().getSimpleName());}
        }
    }
}
