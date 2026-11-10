package org.mcmanager.archive;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.time.Instant;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/** Immutable section manifests share unchanged payloads within a project. No game scans or baking here. */
@Service
class ConstructionHistory {
    record Frame(UUID id,long version,Instant savedAt,Instant observedAt,long sections) {}
    record Frames(List<Frame> frames,boolean more) {}
    final JdbcTemplate jdbc; final ObjectMapper json; final ConstructionModels models; final TransactionTemplate tx;
    ConstructionHistory(JdbcTemplate jdbc,ObjectMapper json,ConstructionModels models,PlatformTransactionManager manager){
        this.jdbc=jdbc;this.json=json;this.models=models;tx=new TransactionTemplate(manager);
        tx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
    }
    Frame row(java.sql.ResultSet rs,int i)throws java.sql.SQLException{return new Frame(rs.getObject("id",UUID.class),rs.getLong("version"),TelemetryQueries.instant(rs,"saved_at"),TelemetryQueries.instant(rs,"observed_at"),rs.getLong("sections"));}
    Frame get(UUID project,int revision,UUID id){
        var rows=jdbc.query("SELECT * FROM construction_scene_snapshots WHERE project_id=? AND revision=? AND id=?",this::row,project,revision,id);
        if(rows.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"历史画面不存在");return rows.getFirst();
    }
    Frames list(UUID project,int revision,Instant before){
        models.status(project,revision);
        var rows=before==null?jdbc.query("SELECT * FROM construction_scene_snapshots WHERE project_id=? AND revision=? ORDER BY saved_at DESC,id DESC LIMIT 101",this::row,project,revision):jdbc.query("SELECT * FROM construction_scene_snapshots WHERE project_id=? AND revision=? AND saved_at<? ORDER BY saved_at DESC,id DESC LIMIT 101",this::row,project,revision,TelemetryService.time(before));
        return new Frames(rows.stream().limit(100).toList(),rows.size()>100);
    }
    UUID save(UUID project,int revision){return tx.execute(s->{
        // Serialize workers for this phase, without acquiring the global collector/agent lock.
        jdbc.queryForList("SELECT revision FROM construction_phases WHERE project_id=? AND revision=? FOR UPDATE",project,revision);
        var status=models.status(project,revision);if(status.sections()==0)return null;
        var existing=jdbc.queryForList("SELECT id FROM construction_scene_snapshots WHERE project_id=? AND revision=? AND version=?",UUID.class,project,revision,status.version());
        if(!existing.isEmpty())return existing.getFirst();
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO construction_scene_snapshots(id,project_id,revision,version,saved_at,observed_at,sections) VALUES (?,?,?,?,?,?,?)",id,project,revision,status.version(),TelemetryService.time(Instant.now()),TelemetryService.time(status.lastObservedAt()),status.sections());
        jdbc.update("INSERT INTO construction_scene_blobs(project_id,hash,data_json) SELECT s.project_id,s.payload_hash,s.data_json FROM construction_model_sections s WHERE s.project_id=? AND s.revision=? AND NOT EXISTS (SELECT 1 FROM construction_scene_blobs b WHERE b.project_id=s.project_id AND b.hash=s.payload_hash)",project,revision);
        jdbc.update("INSERT INTO construction_scene_snapshot_parts(snapshot_id,project_id,hash,sx,sy,sz,observed_at) SELECT ?,project_id,payload_hash,sx,sy,sz,observed_at FROM construction_model_sections WHERE project_id=? AND revision=?",id,project,revision);
        return id;
    });}
    @Scheduled(initialDelay=30000,fixedDelay=300000)
    void recordChanges(){
        var phases=jdbc.queryForList("SELECT p.project_id,p.revision FROM construction_phases p WHERE p.model_version>0 AND NOT EXISTS (SELECT 1 FROM construction_scene_snapshots s WHERE s.project_id=p.project_id AND s.revision=p.revision AND s.version=p.model_version) ORDER BY p.started_at");
        for(var phase:phases)try{save((UUID)phase.get("project_id"),((Number)phase.get("revision")).intValue());}catch(Exception e){org.slf4j.LoggerFactory.getLogger(getClass()).warn("Scene history save failed for {}: {}",phase.get("project_id"),e.toString());}
    }
    void write(UUID project,int revision,UUID id,Writer writer)throws IOException{
        get(project,revision,id);writer.write('[');boolean[] first={true};
        jdbc.query("SELECT b.data_json FROM construction_scene_snapshot_parts p JOIN construction_scene_blobs b ON b.project_id=p.project_id AND b.hash=p.hash WHERE p.snapshot_id=? ORDER BY p.observed_at DESC,p.sx,p.sy,p.sz",rs->{try{if(!first[0])writer.write(',');first[0]=false;writer.write(rs.getString(1));}catch(IOException e){throw new UncheckedIOException(e);}},id);
        writer.write(']');
    }
    List<Map<String,Object>> observations(UUID snapshot){return jdbc.query("SELECT sx,sy,sz,observed_at FROM construction_scene_snapshot_parts WHERE snapshot_id=?",(rs,i)->Map.<String,Object>of("x",rs.getInt(1),"y",rs.getInt(2),"z",rs.getInt(3),"observedAt",TelemetryQueries.instant(rs,"observed_at").toString()),snapshot);}
}
