package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.TelemetryValidation.check;

@Service
class TerrainQueries {
    record Profile(boolean enabled,String seed,String generationVersion,UUID revision,Instant updatedAt) {}
    record Input(boolean enabled,String seed,String generationVersion) {}
    record Coordinates(String dimension,int x,int y,int z,int radius,int step) {}
    record PredictionRequest(Coordinates at,String seed,String generationVersion,String worldType) {}
    private final JdbcTemplate jdbc;
    private final TerrainEngine engine;
    private final ObjectMapper mapper;
    private final Map<String,JsonNode> predictions=Collections.synchronizedMap(new LinkedHashMap<>(128,.75f,true) {
        protected boolean removeEldestEntry(Map.Entry<String,JsonNode> entry) { return size()>128; }
    });
    TerrainQueries(JdbcTemplate jdbc,TerrainEngine engine,ObjectMapper mapper) { this.jdbc=jdbc; this.engine=engine; this.mapper=mapper; }
    void exists(UUID server) {
        if(jdbc.queryForObject("SELECT COUNT(*) FROM server_archives WHERE id=?",Integer.class,server)==0)
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,"服务器档案不存在");
    }
    Profile profile(UUID server) {
        exists(server);
        var rows=jdbc.query("SELECT * FROM terrain_profiles WHERE server_id=?",(r,i)->new Profile(r.getBoolean("enabled"),r.getString("seed_value"),r.getString("generation_version"),r.getObject("revision",UUID.class),TelemetryQueries.instant(r,"updated_at")),server);
        return rows.isEmpty()?null:rows.getFirst();
    }
    Map<String,Object> settings(UUID server) {
        var result=new LinkedHashMap<String,Object>();result.put("profile",profile(server));result.put("engineAvailable",engine.available());
        result.put("supportedVersions",List.of("1.26.51.1","1.26.61.1"));return result;
    }
    @Transactional
    public Map<String,Object> save(UUID server,Input input) {
        check(input!=null && input.seed()!=null && input.seed().matches("0|-?[1-9][0-9]{0,18}"),"请填写有效的数字种子");
        try{Long.parseLong(input.seed());}catch(NumberFormatException ex){check(false,"种子超出范围");}
        check(Set.of("1.26.51.1","1.26.61.1").contains(input.generationVersion()==null?"":input.generationVersion()),"请选择支持的原版世界生成版本");
        // Serialize against other profile edits without holding any lock during prediction.
        exists(server);jdbc.queryForObject("SELECT id FROM server_archives WHERE id=? FOR UPDATE",UUID.class,server);
        var old=profile(server);var revision=UUID.randomUUID();
        if(old==null) jdbc.update("INSERT INTO terrain_profiles VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)",server,input.enabled(),input.seed(),input.generationVersion(),revision);
        else jdbc.update("UPDATE terrain_profiles SET enabled=?,seed_value=?,generation_version=?,revision=?,updated_at=CURRENT_TIMESTAMP WHERE server_id=?",input.enabled(),input.seed(),input.generationVersion(),revision,server);
        return settings(server);
    }
    static void validate(Coordinates at) {
        check(at!=null && Set.of("minecraft:overworld","minecraft:nether").contains(at.dimension()==null?"":at.dimension()),"当前支持主世界和地狱的群系预测");
        check(at.radius()>=0 && at.radius()<=128 && Set.of(16,32,64).contains(at.step()) && at.radius()%at.step()==0,"范围或采样间隔无效");
        check(Math.abs((long)at.x())<=30000000-at.radius() && Math.abs((long)at.z())<=30000000-at.radius(),"坐标超出范围");
        check(at.y()>=(at.dimension().equals("minecraft:overworld")?-64:0) && at.y()<=(at.dimension().equals("minecraft:overworld")?319:127),"高度超出维度范围");
    }
    Map<String,Object> predict(UUID server,Coordinates at) {
        validate(at);var profile=profile(server);
        if(profile==null || !profile.enabled()) return Map.of("status","NOT_CONFIGURED","message","请在 MCP 查询中提供数字种子、生成版本和世界类型");
        var result=calculate(server,at,profile,"SERVER_PROFILE");
        var current=profile(server);
        if(current==null || !current.enabled() || !current.revision().equals(profile.revision())) throw new ResponseStatusException(HttpStatus.CONFLICT,"世界配置已变化，请重新查询");
        return result;
    }
    Map<String,Object> predict(UUID server,PredictionRequest request) {
        check(request!=null,"查询参数不完整");validate(request.at());exists(server);
        check(Set.of("DEFAULT","FLAT","CUSTOM").contains(request.worldType()==null?"":request.worldType()),"请指定世界类型");
        if(!"DEFAULT".equals(request.worldType())) return Map.of("status","UNSUPPORTED_WORLD_TYPE","message","超平坦或自定义生成世界不能使用普通种子群系预测，请查询实际世界记录。");
        if(request.seed()==null && request.generationVersion()==null)return predict(server,request.at());
        check(request.seed()!=null && request.seed().matches("0|-?[1-9][0-9]{0,18}"),"种子须为完整的十进制数字字符串");
        try{Long.parseLong(request.seed());}catch(NumberFormatException ex){check(false,"种子超出范围");}
        check(Set.of("1.26.51.1","1.26.61.1").contains(request.generationVersion()==null?"":request.generationVersion()),"请提供支持的世界生成版本");
        // Request-supplied seeds are ephemeral. Do not persist them or return them to callers.
        UUID revision=UUID.nameUUIDFromBytes((request.generationVersion()+":"+request.seed()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return calculate(server,request.at(),new Profile(true,request.seed(),request.generationVersion(),revision,null),"REQUEST");
    }
    private Map<String,Object> calculate(UUID server,Coordinates at,Profile profile,String seedSource) {
        String generator=profile.generationVersion().equals("1.26.61.1")?"bedrock-26.60":"bedrock-26.50";
        String key=server+":"+profile.revision()+":"+at;
        JsonNode samples=predictions.get(key);boolean cacheHit=samples!=null;
        if(samples==null) { samples=engine.predict(generator,profile.seed(),at.dimension(),at.x(),at.y(),at.z(),at.radius(),at.step()); predictions.put(key,samples); }
        var result=new LinkedHashMap<String,Object>();
        result.put("status","PREDICTED");result.put("source","SEED_PREDICTION");result.put("quality","EXPERIMENTAL");
        result.put("generationVersion",profile.generationVersion());
        if(seedSource.equals("SERVER_PROFILE"))result.put("configurationRevision",profile.revision());
        result.put("seedSource",seedSource);result.put("worldIdentityVerified",false);
        result.put("engine",TerrainEngine.ID);result.put("generatorProfile",generator);result.put("at",at);
        result.put("chunk",Map.of("x",Math.floorDiv(at.x(),16),"z",Math.floorDiv(at.z(),16)));
        result.put("samples",samples.path("samples").deepCopy());result.put("cacheHit",cacheHit);
        result.put("computedAt",Instant.now());result.put("requiresGameServer",false);
        result.put("limitations",List.of("预测的是该高度的原版群系，不是逐方块地形或精确地表高度。","不包含玩家建筑、容器、当前光照、生物及设备运行状态。","群系边界和海岸可能存在偏差，应以现场观测为准。","旧区块生成版本不同或附加包改变生成规则时可能不匹配。","采样点之间没有逐格检查，不能据此判断刷怪或设备故障。"));
        return result;
    }
    Map<String,Object> recorded(UUID server,String dimension,int x,int y,int z,int radius) {
        exists(server);
        check(Set.of("minecraft:overworld","minecraft:nether","minecraft:the_end").contains(dimension==null?"":dimension),"维度无效");
        check(radius>=0 && radius<=128 && Math.abs((long)x)<=30000000-radius && Math.abs((long)z)<=30000000-radius && y>=-2048 && y<=4095,"坐标或范围无效");
        var rows=jdbc.query("""
            SELECT target_kind,observed_at,data_json FROM world_state_cache
            WHERE server_id=? AND dimension=? AND pos_x BETWEEN ? AND ? AND pos_z BETWEEN ? AND ? AND pos_y BETWEEN ? AND ?
            ORDER BY observed_at DESC,target_hash LIMIT 9
            """,(r,i)->{
                try{return Map.<String,Object>of("kind",r.getString("target_kind"),"source","OBSERVED_HISTORY","observedAt",TelemetryQueries.instant(r,"observed_at"),"data",mapper.readTree(r.getString("data_json")));}
                catch(java.io.IOException ex){throw new IllegalStateException(ex);}
            },server,dimension,x-radius,x+radius,z-radius,z+radius,y-radius,y+radius);
        return Map.of("status",rows.isEmpty()?"NO_RECORD":"HISTORY","records",rows.stream().limit(8).toList(),"truncated",rows.size()>8,
            "completeWorldCoverage",false,"message","仅包含该范围内查询中心的已保存观测；没有记录不代表没有建筑，历史状态不等于现在。");
    }
}
