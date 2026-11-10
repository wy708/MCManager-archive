package org.mcmanager.archive;

import com.fasterxml.jackson.databind.*;
import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.TelemetryValidation.check;

/** Small, independently observed sections, not an atomic snapshot of a whole world. */
@Service
class ConstructionModels {
    record Boot(UUID bootId) {}
    record Block(String name,String states) {}
    record Section(int x,int y,int z,List<Block> palette,List<Integer> runs,JsonNode scene) {
        Section(int x,int y,int z,List<Block> palette,List<Integer> runs){this(x,y,z,palette,runs,null);}
    }
    record Capture(UUID bootId,UUID projectId,int revision,Instant observedAt,Section section) {}
    record Plan(UUID id,int revision,String dimension,int minX,int maxX,int minZ,int maxZ) {}
    record Part(int x,int y,int z,Instant observedAt,Section data) {}
    record Status(long version,long sections,long blocks,Instant lastObservedAt,String status,String notice) {}
    record Page(List<Part> sections,String next,Status model) {}
    private final JdbcTemplate jdbc; private final ObjectMapper json;
    private final CollectorCredentials collectors; private final AgentCredentials agents;
    ConstructionModels(JdbcTemplate jdbc,ObjectMapper json,CollectorCredentials collectors,AgentCredentials agents) {
        this.jdbc=jdbc;this.json=json;this.collectors=collectors;this.agents=agents;
    }
    private void collector(CollectorCredentials.Identity identity,UUID boot) {
        collectors.check(identity);
        check(boot!=null && jdbc.queryForObject("SELECT COUNT(*) FROM collector_state c JOIN server_archives s ON s.id=c.server_id WHERE c.server_id=? AND c.boot_id=? AND c.last_seen_at>? AND s.status='RECORDING'",Integer.class,
            identity.serverId(),boot,TelemetryService.time(Instant.now().minusSeconds(120)))==1,"采集器尚未连接或服务器已封存");
    }
    @Transactional
    public List<Plan> plan(CollectorCredentials.Identity identity,Boot request) {
        check(request!=null,"采集参数不完整");agents.lock();collector(identity,request.bootId());
        return jdbc.query("SELECT id,revision,dimension,min_x,max_x,min_z,max_z FROM construction_projects WHERE server_id=? AND status='ACTIVE' ORDER BY created_at,id LIMIT 100",
            (rs,i)->new Plan(rs.getObject("id",UUID.class),rs.getInt("revision"),rs.getString("dimension"),rs.getInt("min_x"),rs.getInt("max_x"),rs.getInt("min_z"),rs.getInt("max_z")),identity.serverId());
    }
    private String encode(Object object){try{return json.writeValueAsString(object);}catch(Exception e){throw new IllegalStateException(e);}}
    private Section decode(String value){try{return json.readValue(value,Section.class);}catch(Exception e){throw new IllegalStateException(e);}}
    @Transactional
    public Map<String,Boolean> capture(CollectorCredentials.Identity identity,Capture request) {
        check(request!=null && request.projectId()!=null && request.section()!=null && request.observedAt()!=null,"模型参数不完整");
        agents.lock();collector(identity,request.bootId());
        var plans=jdbc.query("SELECT p.id,p.revision,p.dimension,p.min_x,p.max_x,p.min_z,p.max_z FROM construction_projects p JOIN construction_phases r ON r.project_id=p.id AND r.revision=p.revision WHERE p.id=? AND p.server_id=? AND p.revision=? AND p.status='ACTIVE' AND r.status='ACTIVE' AND r.started_at<=?",
            (rs,i)->new Plan(rs.getObject("id",UUID.class),rs.getInt("revision"),rs.getString("dimension"),rs.getInt("min_x"),rs.getInt("max_x"),rs.getInt("min_z"),rs.getInt("max_z")),request.projectId(),identity.serverId(),request.revision(),TelemetryService.time(request.observedAt()));
        if(plans.isEmpty())throw new ResponseStatusException(HttpStatus.CONFLICT,"工程已封存、范围已改变或不属于此服务器");
        check(!request.observedAt().isAfter(Instant.now().plusSeconds(30)) && request.observedAt().isAfter(Instant.now().minusSeconds(300)),"模型采集时间无效");
        var plan=plans.getFirst();var section=request.section();
        check(section.x()%8==0 && section.y()%8==0 && section.z()%8==0 && section.y()>=-2048 && section.y()<=4088,"模型分段坐标无效");
        check((long)section.x()+7>=plan.minX() && section.x()<=plan.maxX() && (long)section.z()+7>=plan.minZ() && section.z()<=plan.maxZ(),"模型超出施工范围");
        check(section.palette()!=null && !section.palette().isEmpty() && section.palette().size()<=1025 && section.runs()!=null && section.runs().size()<=1024 && section.runs().size()%2==0,"模型编码无效");
        check(section.palette().getFirst()!=null && "minecraft:air".equals(section.palette().getFirst().name()) && "".equals(section.palette().getFirst().states()),"模型空气定义无效");
        for(var block:section.palette())check(block!=null && block.name()!=null && block.name().length()<=128 && TelemetryValidation.resource(block.name()) && block.states()!=null && block.states().length()<=1024,"方块状态无效");
        int cursor=0,nonAir=0;
        for(int i=0;i<section.runs().size();i+=2) {
            Integer index=section.runs().get(i),length=section.runs().get(i+1);
            check(index!=null && length!=null && index>=0 && index<section.palette().size() && length>0 && length<=512-cursor,"模型长度无效");
            for(int n=0;n<length;n++,cursor++)if(index!=0) {
                int x=section.x()+cursor%8,z=section.z()+(cursor/8)%8;
                check(x>=plan.minX() && x<=plan.maxX() && z>=plan.minZ() && z<=plan.maxZ(),"模型含范围外方块");nonAir++;
            }
        }
        check(cursor==512,"模型必须完整覆盖一个分段");
        boolean hasScene=ConstructionScene.validate(section.scene(),section,plan);
        String data=encode(section),hash=CollectorCredentials.hash(data.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        record Previous(Instant time,String hash){}
        var old=jdbc.query("SELECT observed_at,payload_hash FROM construction_model_sections WHERE project_id=? AND revision=? AND sx=? AND sy=? AND sz=?",(rs,i)->new Previous(TelemetryQueries.instant(rs,"observed_at"),rs.getString("payload_hash")),plan.id(),plan.revision(),section.x(),section.y(),section.z());
        if(!old.isEmpty()) {
            Instant previous=old.getFirst().time();
            if(!request.observedAt().isAfter(previous))return Map.of("accepted",true,"changed",false);
        }
        boolean changed=old.isEmpty() || !hash.equals(old.getFirst().hash());
        if(old.isEmpty())jdbc.update("INSERT INTO construction_model_sections(project_id,revision,sx,sy,sz,observed_at,payload_hash,data_json,non_air) VALUES (?,?,?,?,?,?,?,?,?)",plan.id(),plan.revision(),section.x(),section.y(),section.z(),TelemetryService.time(request.observedAt()),hash,data,nonAir);
        else jdbc.update("UPDATE construction_model_sections SET observed_at=?,payload_hash=?,data_json=?,non_air=? WHERE project_id=? AND revision=? AND sx=? AND sy=? AND sz=?",TelemetryService.time(request.observedAt()),hash,data,nonAir,plan.id(),plan.revision(),section.x(),section.y(),section.z());
        if(changed)jdbc.update("UPDATE construction_phases SET model_version=model_version+1 WHERE project_id=? AND revision=?",plan.id(),plan.revision());
        jdbc.update("UPDATE construction_model_sections SET has_scene=? WHERE project_id=? AND revision=? AND sx=? AND sy=? AND sz=?",hasScene,plan.id(),plan.revision(),section.x(),section.y(),section.z());
        return Map.of("accepted",true,"changed",changed);
    }
    Status status(UUID project,int revision) {
        var phases=jdbc.queryForList("SELECT model_version,status FROM construction_phases WHERE project_id=? AND revision=?",project,revision);
        if(phases.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"工程阶段不存在");
        return jdbc.queryForObject("SELECT COUNT(*) AS sections,COALESCE(SUM(non_air),0) AS blocks,MAX(observed_at) AS latest FROM construction_model_sections WHERE project_id=? AND revision=?",
            (rs,i)->new Status(((Number)phases.getFirst().get("model_version")).longValue(),rs.getLong("sections"),rs.getLong("blocks"),TelemetryQueries.instant(rs,"latest"),(String)phases.getFirst().get("status"),
                "仅扫描游戏已加载区域，分段保存，未采集不等于空气；不是同一瞬间的世界快照。包含全部高度及原有建筑；新版场景还记录可见实体、装备和特殊方块外观，不公开箱内库存。封存保留已收到的数据，不再补采。"),project,revision);
    }
    Page page(UUID project,int revision,String after) {return page(project,revision,after,-2048,4095);}
    Page page(UUID project,int revision,String after,int minY,int maxY) {
        check(minY>=-2048 && maxY<=4095 && minY<=maxY,"显示高度无效");
        Status status=status(project,revision);String suffix=" AND (non_air>0 OR has_scene=TRUE) AND sy<=? AND sy+7>=?";var args=new ArrayList<Object>(List.of(project,revision,maxY,minY));
        if(after!=null) {
            check(after.matches("-?[0-9]{1,9},-?[0-9]{1,9},-?[0-9]{1,9}"),"模型分页位置无效");var parts=after.split(",");int x=Integer.parseInt(parts[0]),y=Integer.parseInt(parts[1]),z=Integer.parseInt(parts[2]);
            suffix+=" AND (sx>? OR (sx=? AND sy>?) OR (sx=? AND sy=? AND sz>?))";args.addAll(List.of(x,x,y,x,y,z));
        }
        var rows=jdbc.query("SELECT sx,sy,sz,observed_at,data_json FROM construction_model_sections WHERE project_id=? AND revision=?"+suffix+" ORDER BY sx,sy,sz LIMIT 17",
            (rs,i)->new Part(rs.getInt("sx"),rs.getInt("sy"),rs.getInt("sz"),TelemetryQueries.instant(rs,"observed_at"),decode(rs.getString("data_json"))),args.toArray());
        String next=null;if(rows.size()>16){rows=new ArrayList<>(rows.subList(0,16));var last=rows.getLast();next=last.x()+","+last.y()+","+last.z();}
        return new Page(rows,next,status);
    }
}
