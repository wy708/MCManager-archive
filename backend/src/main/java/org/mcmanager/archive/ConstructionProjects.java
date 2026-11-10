package org.mcmanager.archive;

import com.fasterxml.jackson.databind.*;
import jakarta.validation.constraints.*;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import static org.mcmanager.archive.TelemetryValidation.*;

@Service
class ConstructionProjects {
    record Position(@NotNull @Min(-30000000) @Max(30000000) Integer x,
                    @NotNull @Min(-2048) @Max(2048) Integer y,
                    @NotNull @Min(-30000000) @Max(30000000) Integer z) {}
    record Request(UUID requestId,String action,UUID projectId,String name,String dimension,Integer x1,Integer z1,Integer x2,Integer z2) {}
    record Project(UUID id,UUID serverId,String serverName,String name,String creator,String dimension,int minX,int maxX,int minZ,int maxZ,
                   int revision,String status,Instant createdAt,String publicUrl,String mapUrl) {}
    record Receipt(UUID requestId,UUID projectId,int revision,String action,String message,String publicUrl,String mapUrl) {}
    record Detail(Project project, int revision, Instant startedAt, Instant endedAt, JsonNode statistics,
                  Instant mapAt, JsonNode mapMetadata, boolean mapAvailable, List<Integer> revisions, String notice) {}
    private final JdbcTemplate jdbc; private final ObjectMapper json; private final AgentCredentials agents;
    private final CollectorCredentials collectors; private final QqBindings bindings; private final String publicOrigin;
    ConstructionProjects(JdbcTemplate jdbc,ObjectMapper json,AgentCredentials agents,CollectorCredentials collectors,QqBindings bindings,@org.springframework.beans.factory.annotation.Value("${mcmanager.public-base-url:}") String publicOrigin) {
        this.jdbc=jdbc;this.json=json;this.agents=agents;this.collectors=collectors;this.bindings=bindings;
        SessionTransportConfig.isHttpsOrigin(publicOrigin);this.publicOrigin=publicOrigin.strip().replaceAll("/+$", "");
    }
    String encode(Object value) { try{return json.writeValueAsString(value);}catch(Exception e){throw new IllegalStateException(e);} }
    JsonNode decode(String value) { try{return value==null?null:json.readTree(value);}catch(Exception e){throw new IllegalStateException(e);} }
    static String link(UUID id){return "/projects/"+id;}
    private String mapLink(UUID id){return publicOrigin.isEmpty()?null:publicOrigin+link(id);}
    private Project row(java.sql.ResultSet rs,int i) throws java.sql.SQLException {
        UUID id=rs.getObject("id",UUID.class);
        return new Project(id,rs.getObject("server_id",UUID.class),rs.getString("server_name"),rs.getString("name"),rs.getString("owner_name"),
            rs.getString("dimension"),rs.getInt("min_x"),rs.getInt("max_x"),rs.getInt("min_z"),rs.getInt("max_z"),
            rs.getInt("revision"),rs.getString("status"),TelemetryQueries.instant(rs,"created_at"),link(id),mapLink(id));
    }
    private static final String SELECT="SELECT p.*,s.name AS server_name FROM construction_projects p JOIN server_archives s ON s.id=p.server_id ";
    Project project(UUID id) {
        var rows=jdbc.query(SELECT+"WHERE p.id=?",this::row,id);
        if(rows.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"工程不存在");return rows.getFirst();
    }
    List<Project> list(UUID server) {return jdbc.query(SELECT+"WHERE p.server_id=? ORDER BY p.created_at DESC LIMIT 200",this::row,server);}
    List<Project> list(UUID server,String name) {
        if(name==null)return list(server);
        check(!name.isBlank() && name.length()<=80,"工程名称无效");
        return jdbc.query(SELECT+"WHERE p.server_id=? AND p.name=? ORDER BY p.created_at DESC LIMIT 200",this::row,server,name);
    }
    @Transactional
    public Receipt collector(CollectorCredentials.Identity identity,String player,Request request) {
        agents.lock();collectors.check(identity);return mutate(identity.serverId(),player,false,request);
    }
    @Transactional
    public Receipt agent(AgentCredentials.Identity identity,UUID server,String qqId,Request request) {
        agents.lock();agents.require(identity,server,AgentCredentials.Scope.PROJECT_WRITE);
        var bound=bindings.get(identity,server,qqId);check(bound.bound(),"请先绑定 QQ 与游戏角色");
        return mutate(server,bound.binding().playerKey(),false,request);
    }
    @Transactional
    public Receipt admin(UUID server,Request request) {agents.lock();return mutate(server,"admin",true,request);}
    @Transactional
    public void delete(UUID server,UUID id) {
        agents.lock();
        var servers=jdbc.queryForList("SELECT server_id FROM construction_projects WHERE id=?",UUID.class,id);
        if(servers.isEmpty())return;
        check(servers.getFirst().equals(server),"工程不属于该服务器");
        jdbc.update("INSERT INTO construction_deleted_requests(server_id,request_id,deleted_at) SELECT server_id,request_id,CURRENT_TIMESTAMP FROM construction_requests WHERE project_id=?",id);
        jdbc.update("DELETE FROM construction_requests WHERE project_id=?",id);
        jdbc.update("DELETE FROM construction_events WHERE project_id=?",id);
        jdbc.update("DELETE FROM construction_phases WHERE project_id=?",id);
        jdbc.update("DELETE FROM construction_projects WHERE id=?",id);
    }
    private Receipt receipt(Request request,UUID id,int revision){return new Receipt(request.requestId(),id,revision,request.action(),
        switch(request.action()){case "CREATE"->"工程已创建，开始记录施工";case "COMPLETE"->"已封存统计和最近保存的地图；尚未采集的区域保留空白";case "UPDATE"->"施工范围已修改，旧阶段保留，新范围从现在开始记录";default->"已继续施工，上一轮封存结果仍可查看";},link(id),mapLink(id));}
    private Receipt mutate(UUID server,String actor,boolean admin,Request request) {
        check(request!=null && request.requestId()!=null && request.action()!=null && Set.of("CREATE","COMPLETE","RESUME","UPDATE").contains(request.action()),"工程操作无效");
        check(actor!=null && actor.length()<=80,"玩家身份无效");
        if(jdbc.queryForObject("SELECT COUNT(*) FROM construction_deleted_requests WHERE server_id=? AND request_id=?",Integer.class,server,request.requestId())>0)
            throw new ResponseStatusException(HttpStatus.GONE,"工程已被管理员删除，该请求不可重放");
        String hash=CollectorCredentials.hash(encode(request).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        var prior=jdbc.queryForList("SELECT * FROM construction_requests WHERE server_id=? AND request_id=?",server,request.requestId());
        if(!prior.isEmpty()) {
            var p=prior.getFirst();check(actor.equals(p.get("actor_key")) && hash.equals(p.get("payload_hash")),"请求编号已用于不同操作");
            return receipt(request,(UUID)p.get("project_id"),((Number)p.get("revision")).intValue());
        }
        var statuses=jdbc.queryForList("SELECT status FROM server_archives WHERE id=?",String.class,server);
        check(statuses.size()==1 && (request.action().equals("COMPLETE") || "RECORDING".equals(statuses.getFirst())),"服务器不存在或档案已封存");
        Instant now=Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS);UUID id=request.projectId();int revision;
        if(request.action().equals("CREATE")) {
            check(request.name()!=null && !request.name().isBlank() && request.name().equals(request.name().strip()) && request.name().length()<=80
                && request.name().codePoints().noneMatch(Character::isISOControl),"工程名须为 1–80 字且不含控制字符");
            check(request.dimension()!=null && Set.of("minecraft:overworld","minecraft:nether","minecraft:the_end").contains(request.dimension()),"维度无效");
            for(Integer coordinate:Arrays.asList(request.x1(),request.z1(),request.x2(),request.z2()))check(coordinate!=null && Math.abs((long)coordinate)<=30000000,"请提供两个点的 X/Z 坐标");
            check(jdbc.queryForObject("SELECT COUNT(*) FROM construction_projects WHERE server_id=? AND owner_key=? AND name=?",Integer.class,server,actor,request.name())==0,"你已创建同名工程，请改名或继续原工程");
            check(jdbc.queryForObject("SELECT COUNT(*) FROM construction_projects WHERE server_id=? AND status<>'COMPLETE'",Integer.class,server)<100,"该服务器进行中的工程过多，请先完成部分工程");
            String creator="管理员";
            if(!admin) {
                var names=jdbc.queryForList("SELECT name FROM player_server_names WHERE server_id=? AND player_key=? ORDER BY last_seen_at DESC LIMIT 1",String.class,server,actor);
                check(!names.isEmpty(),"玩家尚未上传，请稍后重试");creator=names.getFirst();
            }
            id=UUID.randomUUID();revision=1;
            jdbc.update("INSERT INTO construction_projects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",id,server,request.name(),actor,creator,request.dimension(),Math.min(request.x1(),request.x2()),Math.max(request.x1(),request.x2()),Math.min(request.z1(),request.z2()),Math.max(request.z1(),request.z2()),revision,"ACTIVE",TelemetryService.time(now));
        } else {
            if(id==null) {
                var ids=jdbc.queryForList("SELECT id FROM construction_projects WHERE server_id=? AND owner_key=? AND name=?",UUID.class,server,actor,request.name());
                check(ids.size()==1,"没有找到你创建的该工程，请检查工程名或编号");id=ids.getFirst();
            }
            Project old=project(id);check(old.serverId().equals(server),"工程不属于该服务器");
            String owner=jdbc.queryForObject("SELECT owner_key FROM construction_projects WHERE id=?",String.class,id);
            if(!admin && !actor.equals(owner))throw new ResponseStatusException(HttpStatus.FORBIDDEN,"只有工程创建者可以管理此工程");
            revision=old.revision();
            if(request.action().equals("COMPLETE") || request.action().equals("UPDATE")) {
                check(old.status().equals("ACTIVE"),"工程当前不在施工中");
                jdbc.update("UPDATE construction_phases SET ended_at=?,summary=?,status='COMPLETE' WHERE project_id=? AND revision=?",TelemetryService.time(now),encode(statistics(id,revision)),id,revision);
                if(request.action().equals("UPDATE")) {
                    for(Integer coordinate:Arrays.asList(request.x1(),request.z1(),request.x2(),request.z2()))check(coordinate!=null && Math.abs((long)coordinate)<=30000000,"请提供两个点的 X/Z 坐标");
                    check(request.dimension()==null || old.dimension().equals(request.dimension()),"修改范围不能跨维度，请新建工程");revision++;
                    jdbc.update("UPDATE construction_projects SET revision=?,min_x=?,max_x=?,min_z=?,max_z=? WHERE id=?",revision,Math.min(request.x1(),request.x2()),Math.max(request.x1(),request.x2()),Math.min(request.z1(),request.z2()),Math.max(request.z1(),request.z2()),id);
                } else jdbc.update("UPDATE construction_projects SET status=(SELECT status FROM construction_phases WHERE project_id=? AND revision=?) WHERE id=?",id,revision,id);
            } else {
                check(old.status().equals("COMPLETE"),"请等待工程封存完成后再继续");revision++;
                jdbc.update("UPDATE construction_projects SET status='ACTIVE',revision=? WHERE id=?",revision,id);
            }
        }
        if(!request.action().equals("COMPLETE"))jdbc.update("INSERT INTO construction_phases(project_id,revision,started_at,status,dimension,min_x,max_x,min_z,max_z) SELECT id,revision,?,'ACTIVE',dimension,min_x,max_x,min_z,max_z FROM construction_projects WHERE id=?",TelemetryService.time(now),id);
        jdbc.update("INSERT INTO construction_requests VALUES (?,?,?,?,?,?,?)",server,request.requestId(),actor,hash,id,revision,request.action());
        return receipt(request,id,revision);
    }
    // Called inside the same deduplicated ingestion transaction. Overlapping
    // projects intentionally each receive one copy; server totals use telemetry.
    void record(UUID server,TelemetryPayload.Event event) {
        var p=event.position();if(p==null)return;
        var ids=jdbc.queryForList("""
          SELECT p.id FROM construction_projects p JOIN construction_phases r ON r.project_id=p.id AND r.revision=p.revision
          WHERE p.server_id=? AND p.status='ACTIVE' AND p.dimension=? AND ? BETWEEN p.min_x AND p.max_x
          AND ? BETWEEN p.min_z AND p.max_z AND r.started_at<=?
          """,UUID.class,server,event.dimension(),p.x(),p.z(),TelemetryService.time(event.at()));
        for(var id:ids)jdbc.update("""
          INSERT INTO construction_events(project_id,revision,event_id,occurred_at,player_key,player_name,operation,block,x,y,z)
          SELECT id,revision,?,?,?,?,?,?,?,?,? FROM construction_projects WHERE id=?
          """,event.eventId(),TelemetryService.time(event.at()),event.player().key(),event.player().name(),event.metric().equals("blocks.placed")?"PLACE":"BREAK",event.subject(),p.x(),p.y(),p.z(),id);
    }
    JsonNode statistics(UUID id,int revision) {
        var materials=jdbc.query("SELECT block,operation,COUNT(*) AS n FROM construction_events WHERE project_id=? AND revision<=? GROUP BY block,operation ORDER BY COUNT(*) DESC,block",(rs,i)->Map.of("block",rs.getString("block"),"operation",rs.getString("operation"),"count",Long.toString(rs.getLong("n"))),id,revision);
        var people=jdbc.query("SELECT player_key,MAX(player_name) AS name,operation,COUNT(*) AS n FROM construction_events WHERE project_id=? AND revision<=? GROUP BY player_key,operation ORDER BY COUNT(*) DESC",(rs,i)->Map.of("name",rs.getString("name"),"contributorId",CollectorCredentials.hash((id+":"+rs.getString("player_key")).getBytes(java.nio.charset.StandardCharsets.UTF_8)).substring(0,16),"operation",rs.getString("operation"),"count",Long.toString(rs.getLong("n"))),id,revision);
        return json.valueToTree(Map.of("materials",materials,"contributors",people));
    }
    Detail detail(UUID id,Integer revision) {
        var project=project(id);int rev=revision==null?project.revision():revision;
        var rows=jdbc.query("SELECT revision,started_at,ended_at,status,dimension,min_x,max_x,min_z,max_z,summary,map_at,map_metadata,(map_image IS NOT NULL) AS has_map FROM construction_phases WHERE project_id=? AND revision=?",(rs,i)->new Detail(new Project(project.id(),project.serverId(),project.serverName(),project.name(),project.creator(),rs.getString("dimension"),rs.getInt("min_x"),rs.getInt("max_x"),rs.getInt("min_z"),rs.getInt("max_z"),rev,rs.getString("status"),project.createdAt(),project.publicUrl(),project.mapUrl()),rev,TelemetryQueries.instant(rs,"started_at"),TelemetryQueries.instant(rs,"ended_at"),
            rs.getString("summary")==null?statistics(id,rev):decode(rs.getString("summary")),TelemetryQueries.instant(rs,"map_at"),decode(rs.getString("map_metadata")),rs.getBoolean("has_map"),
            jdbc.queryForList("SELECT revision FROM construction_phases WHERE project_id=? ORDER BY revision DESC",Integer.class,id),
            "水平矩形包含所有高度。图例是记录期间成功放置/拆除次数，不是材料消耗或当前存量。重叠工程各自记录；封存不再接收补传事件。地图来自最近保存的采集结果，未采集区域留空；完成后不会补采或更新。统计累计包含此前阶段，各阶段保留自己的范围。贡献只反映记录到的行为。"),id,rev);
        if(rows.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"施工轮次不存在");return rows.getFirst();
    }
    byte[] image(UUID id,int revision){project(id);var rows=jdbc.queryForList("SELECT map_image FROM construction_phases WHERE project_id=? AND revision=?",byte[].class,id,revision);if(rows.isEmpty()||rows.getFirst()==null)throw new ResponseStatusException(HttpStatus.NOT_FOUND,"地图正在准备");return rows.getFirst();}
}
