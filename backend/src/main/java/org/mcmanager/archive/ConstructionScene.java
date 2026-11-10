package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
import static org.mcmanager.archive.TelemetryValidation.check;

/** The public scene contract is intentionally smaller than Minecraft's private save NBT. */
final class ConstructionScene {
    private ConstructionScene() {}
    static final Set<String> BLOCK_FIELDS=Set.of("id","Text","FrontText","BackText","SignTextColor","IgnoreLighting","Item","ItemRotation","isMovable","Base","Patterns","SkullType","Rot","MouthMoving","MouthTickCount","color");
    static final Set<String> ENTITY_FIELDS=Set.of("identifier","Pos","Rotation","Variant","MarkVariant","Color","Color2","IsBaby","CustomName","CustomNameVisible","Armor","Mainhand","Offhand","Item","Pose","PoseIndex","SkinID","Saddled","Sheared","IsTamed","IsAngry","IsSitting","IsEating","IsStanding","IsSwimming","IsSleeping","definitions","BodyRot","HeadYaw","Invisible","ShowArms","NoBasePlate","Small","Art","Motive","Direction","Dir","TileX","TileY","TileZ");
    static void keys(JsonNode node,Set<String> allowed) {
        check(node!=null && node.isObject(),"场景数据格式无效");
        node.fieldNames().forEachRemaining(key->check(allowed.contains(key),"场景包含未授权字段"));
    }
    static void bounded(JsonNode node,int depth,int[] budget) {
        check(node!=null && depth<=10 && --budget[0]>=0,"场景数据过于复杂");
        if(node.isTextual())check(node.textValue().length()<=4096,"场景文字过长");
        if(node.isNumber())check(Double.isFinite(node.doubleValue()),"场景数值无效");
        if(node.isContainerNode())for(var child:node)bounded(child,depth+1,budget);
    }
    static void item(JsonNode node) {
        if(node==null || node.isNull())return;
        keys(node,Set.of("Name","Count","Damage","WasPickedUp","tag"));
        if(node.has("tag")){
            var tag=node.get("tag");keys(tag,Set.of("customColor","ench","Trim","CustomModelData"));
            if(tag.has("Trim"))keys(tag.get("Trim"),Set.of("Material","Pattern"));
            if(tag.has("ench")){check(tag.get("ench").isArray() && tag.get("ench").size()<=32,"附魔外观无效");for(var enchantment:tag.get("ench"))keys(enchantment,Set.of("id","lvl"));}
            if(tag.has("CustomModelData"))check(tag.get("CustomModelData").isValueNode(),"物品外观参数无效");
        }
    }
    static void visual(JsonNode data,boolean entity) {
        keys(data,entity?ENTITY_FIELDS:BLOCK_FIELDS);bounded(data,0,new int[]{4096});
        if(data.has("Item"))item(data.get("Item"));
        for(var field:List.of("Armor","Mainhand","Offhand"))if(data.has(field)){
            check(data.get(field).isArray() && data.get(field).size()<=8,"装备外观无效");for(var value:data.get(field))item(value);
        }
        for(var field:List.of("FrontText","BackText"))if(data.has(field)){var side=data.get(field);keys(side,Set.of("Text","SignTextColor","IgnoreLighting","PersistFormatting"));if(side.has("Text"))check(side.get("Text").isTextual(),"告示牌文字无效");for(var entry:List.of("SignTextColor","IgnoreLighting","PersistFormatting"))if(side.has(entry))check(side.get(entry).isNumber()||side.get(entry).isBoolean(),"告示牌外观参数无效");}
        if(data.has("Patterns")){check(data.get("Patterns").isArray() && data.get("Patterns").size()<=64,"旗帜外观无效");for(var pattern:data.get("Patterns"))keys(pattern,Set.of("Color","Pattern"));}
        // Remaining fields are visual scalar values or arrays; no arbitrary nested save compounds.
        var structured=Set.of("Item","Armor","Mainhand","Offhand","FrontText","BackText","Patterns","Pose");
        data.fields().forEachRemaining(entry->{if(!structured.contains(entry.getKey()))scalarOrArray(entry.getValue(),0);});
        if(data.has("Pose")){keys(data.get("Pose"),Set.of("Head","Body","LeftArm","RightArm","LeftLeg","RightLeg","PoseIndex","LastSignal"));for(var value:data.get("Pose"))scalarOrArray(value,0);}
    }
    static void scalarOrArray(JsonNode value,int depth){check(depth<=2 && !value.isObject(),"场景字段包含非外观数据");if(value.isArray()){check(value.size()<=128,"场景数组过长");for(var child:value)scalarOrArray(child,depth+1);}}
    static boolean validate(JsonNode scene,ConstructionModels.Section section,ConstructionModels.Plan plan) {
        if(scene==null || scene.isNull())return false;
        keys(scene,Set.of("version","extraRuns","blockEntities","entities","blocksComplete","entitiesComplete","biomePalette","biomeRuns"));
        check(scene.path("version").isIntegralNumber() && scene.path("version").intValue()==1,"未知场景版本");
        check(scene.path("blocksComplete").isBoolean() && scene.path("entitiesComplete").isBoolean(),"场景完整性标志缺失");
        bounded(scene,0,new int[]{65536});
        if(scene.has("biomePalette") || scene.has("biomeRuns")){
            var palette=scene.path("biomePalette");var runs=scene.path("biomeRuns");check(palette.isArray() && !palette.isEmpty() && palette.size()<=513,"群系列表无效");
            for(var biome:palette)check(biome.isTextual() && biome.textValue().length()<=128 && TelemetryValidation.resource(biome.textValue()),"群系标识无效");
            check(runs.isArray() && runs.size()<=1024 && runs.size()%2==0,"群系编码无效");int length=0;
            for(int n=0;n<runs.size();n+=2){var index=runs.get(n);var count=runs.get(n+1);check(index.isIntegralNumber() && index.canConvertToInt() && index.intValue()>=0 && index.intValue()<palette.size() && count.isIntegralNumber() && count.canConvertToInt() && count.intValue()>0 && count.intValue()<=512-length,"群系长度无效");length+=count.intValue();}
            check(length==512,"群系分段不完整");
        }
        var extra=scene.path("extraRuns");check(extra.isArray() && extra.size()<=1024 && extra.size()%2==0,"额外方块层无效");
        int cursor=0;boolean visible=false;
        for(int n=0;n<extra.size();n+=2){var a=extra.get(n);var b=extra.get(n+1);check(a.isIntegralNumber() && b.isIntegralNumber() && a.canConvertToInt() && b.canConvertToInt(),"额外方块编码无效");int index=a.intValue(),count=b.intValue();check(index>=0 && index<section.palette().size() && count>0 && count<=512-cursor,"额外方块长度无效");for(int i=0;i<count;i++,cursor++)if(index!=0){inside(section.x()+cursor%8,section.z()+cursor/8%8,plan);visible=true;}}
        check(cursor==512,"额外方块层不完整");
        var blocks=scene.path("blockEntities");check(blocks.isArray() && blocks.size()<=512,"特殊方块列表无效");var indices=new HashSet<Integer>();
        for(var block:blocks){keys(block,Set.of("index","data"));var index=block.path("index");check(index.isIntegralNumber() && index.canConvertToInt() && index.intValue()>=0 && index.intValue()<512 && indices.add(index.intValue()),"特殊方块坐标无效");inside(section.x()+index.intValue()%8,section.z()+index.intValue()/8%8,plan);visual(block.get("data"),false);visible=true;}
        var entities=scene.path("entities");check(entities.isArray() && entities.size()<=512,"实体列表无效");var ids=new HashSet<String>();
        for(var entity:entities){
            keys(entity,Set.of("id","type","x","y","z","pitch","yaw","data"));
            check(entity.path("id").isTextual() && entity.path("id").textValue().matches("-?[0-9]{1,20}") && ids.add(entity.path("id").textValue()),"实体标识无效");
            check(entity.path("type").isTextual() && entity.path("type").textValue().length()<=128 && TelemetryValidation.resource(entity.path("type").textValue()),"实体种类无效");
            check(!Set.of("minecraft:item","minecraft:player").contains(entity.path("type").textValue()),"建筑场景不记录掉落物或玩家实体");
            for(var field:List.of("x","y","z","pitch","yaw"))check(entity.path(field).isNumber() && Double.isFinite(entity.path(field).doubleValue()),"实体坐标无效");
            double x=entity.get("x").doubleValue(),y=entity.get("y").doubleValue(),z=entity.get("z").doubleValue();
            check(x>=section.x() && x<(double)section.x()+8 && y>=section.y() && y<(double)section.y()+8 && z>=section.z() && z<(double)section.z()+8,"实体不属于此分段");inside(x,z,plan);visual(entity.get("data"),true);visible=true;
        }
        return visible || !scene.path("blocksComplete").booleanValue() || !scene.path("entitiesComplete").booleanValue();
    }
    static void inside(double x,double z,ConstructionModels.Plan plan){check(x>=plan.minX() && x<(double)plan.maxX()+1 && z>=plan.minZ() && z<(double)plan.maxZ()+1,"场景超出施工范围");}
}
