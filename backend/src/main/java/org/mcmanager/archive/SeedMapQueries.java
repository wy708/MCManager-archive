package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.TelemetryValidation.check;

@Service
class SeedMapQueries {
    record Structures(String dimension,int x,int z,int radius,int limit,String structure,String seed,String generationVersion,String worldType) {}
    static final Set<String> OVERWORLD=Set.of("village","desert_pyramid","jungle_temple","swamp_hut","igloo","monument","pillager_outpost","ruined_portal","trial_chambers");
    static final Set<String> NETHER=Set.of("fortress","bastion_remnant","ruined_portal");
    static final Map<String,String> LABELS=Map.ofEntries(Map.entry("village","村庄"),Map.entry("desert_pyramid","沙漠神殿"),Map.entry("jungle_temple","丛林神庙"),Map.entry("swamp_hut","沼泽小屋"),Map.entry("igloo","雪屋"),Map.entry("monument","海底神殿"),Map.entry("pillager_outpost","掠夺者前哨站"),Map.entry("ruined_portal","废弃传送门"),Map.entry("trial_chambers","试炼密室"),Map.entry("fortress","下界要塞"),Map.entry("bastion_remnant","堡垒遗迹"));
    private final TerrainEngine engine;
    private final TerrainQueries terrain;
    private final Map<String,JsonNode> cache=Collections.synchronizedMap(new LinkedHashMap<>(128,.75f,true){protected boolean removeEldestEntry(Map.Entry<String,JsonNode> e){return size()>128;}});
    SeedMapQueries(TerrainEngine engine,TerrainQueries terrain){this.engine=engine;this.terrain=terrain;}
    static boolean overworld(String dimension){check(Set.of("minecraft:overworld","minecraft:nether").contains(dimension==null?"":dimension),"种子地图当前支持主世界和下界");return dimension.equals("minecraft:overworld");}
    Map<String,Object> structures(UUID server,Structures r) {
        check(r!=null,"查询参数不完整");boolean ow=overworld(r.dimension());terrain.exists(server);
        var supported=ow?OVERWORLD:NETHER;
        check(r.structure()!=null && (r.structure().equals("all") || supported.contains(r.structure())),"该维度不支持此结构类型");
        check(r.radius()>=0 && r.radius()<=4096 && r.limit()>=1 && r.limit()<=32,"结构查询范围或数量无效");
        check(Math.abs((long)r.x())<=30000000-r.radius() && Math.abs((long)r.z())<=30000000-r.radius(),"坐标超出范围");
        check(Set.of("DEFAULT","FLAT","CUSTOM").contains(r.worldType()==null?"":r.worldType()),"请指定世界类型");
        if(!r.worldType().equals("DEFAULT"))return Map.of("status","UNSUPPORTED_WORLD_TYPE","message","超平坦或自定义世界不能使用普通结构生成预测。");
        var stored=r.seed()==null && r.generationVersion()==null?terrain.profile(server):null;
        if(r.seed()==null && r.generationVersion()==null && (stored==null || !stored.enabled()))return Map.of("status","NOT_CONFIGURED","message","请提供数字种子和区块生成版本");
        String seed=stored==null?r.seed():stored.seed(),version=stored==null?r.generationVersion():stored.generationVersion();
        check(seed!=null && seed.matches("0|-?[1-9][0-9]{0,18}"),"种子须为完整的十进制数字字符串");
        try{Long.parseLong(seed);}catch(NumberFormatException ex){check(false,"种子超出范围");}
        check(Set.of("1.26.51.1","1.26.61.1").contains(version==null?"":version),"请提供支持的世界生成版本");
        String profile=version.equals("1.26.61.1")?"bedrock-26.60":"bedrock-26.50";
        String key=server+":"+UUID.nameUUIDFromBytes((version+":"+seed).getBytes(java.nio.charset.StandardCharsets.UTF_8))+":"+r.dimension()+":"+r.x()+":"+r.z()+":"+r.radius()+":"+r.limit()+":"+r.structure();
        var data=cache.get(key);boolean hit=data!=null;
        if(data==null){
            String input="structures "+profile+" "+seed+" "+(ow?"overworld":"nether")+" "+r.structure()+" "+r.x()+" "+r.z()+" "+r.radius()+" "+r.limit()+"\n";
            data=engine.execute(profile,input,value->{
                if(!value.path("mode").asText().equals("structures-v1") || !value.path("candidates").isArray() || value.path("candidates").size()>r.limit()
                    || !value.path("totalCandidates").isInt() || value.path("totalCandidates").asInt()<value.path("candidates").size()
                    || !value.path("truncated").isBoolean() || value.path("truncated").asBoolean()!=(value.path("totalCandidates").asInt()>value.path("candidates").size()))throw new IOException("invalid structures");
                long previous=-1;var seen=new HashSet<String>();
                for(var item:value.path("candidates")){
                    String type=item.path("structure").asText();
                    if(!item.path("x").isInt() || !item.path("z").isInt() || !supported.contains(type) || (!r.structure().equals("all")&&!r.structure().equals(type)))throw new IOException("invalid candidate");
                    long dx=(long)item.path("x").asInt()-r.x(),dz=(long)item.path("z").asInt()-r.z(),distance=dx*dx+dz*dz;
                    if(distance>(long)r.radius()*r.radius() || !item.path("distanceSquared").isIntegralNumber() || item.path("distanceSquared").asLong()!=distance || distance<previous || !seen.add(type+":"+item.path("x")+":"+item.path("z")))throw new IOException("invalid distance");
                    previous=distance;
                }
            });cache.put(key,data);
        }
        if(stored!=null){var current=terrain.profile(server);if(current==null || !current.enabled() || !current.revision().equals(stored.revision()))throw new ResponseStatusException(HttpStatus.CONFLICT,"世界配置已变化，请重新查询");}
        var candidates=new ArrayList<Map<String,Object>>();
        for(var item:data.path("candidates"))candidates.add(Map.of("structure",item.path("structure").asText(),"name",LABELS.get(item.path("structure").asText()),"x",item.path("x").asInt(),"z",item.path("z").asInt(),"chunkX",Math.floorDiv(item.path("x").asInt(),16),"chunkZ",Math.floorDiv(item.path("z").asInt(),16),"distanceBlocks",Math.sqrt(item.path("distanceSquared").asLong()),"positionKind","GENERATION_CANDIDATE","observed",false));
        var result=new LinkedHashMap<String,Object>();result.put("status","PREDICTED");result.put("source","SEED_PREDICTION");result.put("quality","EXPERIMENTAL");result.put("engine",TerrainEngine.ID);result.put("generatorProfile",profile);result.put("generationVersion",version);
        result.put("seedSource",stored==null?"REQUEST":"SERVER_PROFILE");result.put("worldIdentityVerified",false);result.put("requiresGameServer",false);result.put("cacheHit",hit);result.put("computedAt",Instant.now());
        result.put("search",Map.of("dimension",r.dimension(),"x",r.x(),"z",r.z(),"radius",r.radius(),"shape","HORIZONTAL_CIRCLE","structure",r.structure()));result.put("candidates",candidates);result.put("totalCandidates",data.path("totalCandidates").asInt());result.put("truncated",data.path("truncated").asBoolean());result.put("supportedStructures",supported.stream().sorted().toList());
        result.put("limitations",List.of("这是自然结构生成候选点，经过群系及近似地形筛选，不是已生成建筑实测。","坐标为生成参考点；实际定位点、入口、高度和建筑占地可能不同，试炼密室可跨相邻区块。","已知 1.26.61.1 实测存在丛林神庙及沙漠神殿候选点不被游戏定位确认的情况，不能承诺到达后一定存在。","群系边界、地形条件、旧版本区块、关闭结构生成及附加包可能导致预测不符。","不包含玩家建筑、拆除后的状态、箱子战利品或所有结构类型；范围内无候选点不代表世界中没有该结构。"));return result;
    }
    Map<String,Object> chunks(UUID server,String dimension,int x,int z,int radius) {
        boolean ow=overworld(dimension);terrain.exists(server);check(radius>=0 && radius<=8,"区块半径须在 0–8 之间");
        int cx=Math.floorDiv(x,16),cz=Math.floorDiv(z,16);
        check((long)cx-radius>=-1875000 && (long)cz-radius>=-1875000 && (long)cx+radius<1875000 && (long)cz+radius<1875000,"坐标超出范围");
        var data=engine.execute("bedrock-26.60","chunks bedrock-26.60 "+(ow?"overworld":"nether")+" "+x+" "+z+" "+radius+"\n",value->{
            int side=radius*2+1;
            if(!value.path("mode").asText().equals("chunks-v1") || !value.path("chunks").isArray() || value.path("chunks").size()!=side*side)throw new IOException("invalid chunks");
            int i=0;for(var c:value.path("chunks")){
                int px=cx-radius+i%side,pz=cz-radius+i/side;
                String[] names={"chunkX","chunkZ","minX","minZ","maxX","maxZ"};int[] expected={px,pz,px*16,pz*16,px*16+15,pz*16+15};
                for(int j=0;j<names.length;j++)if(!c.path(names[j]).isInt() || c.path(names[j]).asInt()!=expected[j])throw new IOException("invalid chunk bounds");
                if(ow?!c.path("slimeChunk").isBoolean():!c.path("slimeChunk").isNull())throw new IOException("invalid slime flag");i++;
            }
        });
        return Map.of("status","CALCULATED","source","BEDROCK_CHUNK_ALGORITHM","algorithm","cubiomes-bedrock-294c72ab-slime-v1","seedIndependent",true,"dimension",dimension,"centerChunk",Map.of("x",cx,"z",cz),"chunks",data.path("chunks"),"slimeApplicable",ow,"requiresGameServer",false,
            "limitations",List.of("区块坐标向下取整；每块为 16×16 格，边界为包含端点的方块坐标。","基岩版史莱姆区块按区块坐标计算，不依赖世界种子；下界标记为不适用。","史莱姆区块标记不证明现在会刷怪，仍受高度、空间、玩家距离及游戏规则影响；未验证现场刷怪。"));
    }
}
