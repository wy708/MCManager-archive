package org.mcmanager.scene;

import com.google.gson.*;
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import javax.imageio.ImageIO;
import nl.bramstout.mcworldexporter.*;
import nl.bramstout.mcworldexporter.commands.*;
import nl.bramstout.mcworldexporter.entity.*;
import nl.bramstout.mcworldexporter.export.BlendedBiome;
import nl.bramstout.mcworldexporter.image.ImageReader;
import nl.bramstout.mcworldexporter.model.*;
import nl.bramstout.mcworldexporter.molang.*;
import nl.bramstout.mcworldexporter.nbt.*;
import nl.bramstout.mcworldexporter.resourcepack.*;
import nl.bramstout.mcworldexporter.resourcepack.bedrock.EntityHandlerBedrockEdition;
import nl.bramstout.mcworldexporter.translation.*;
import nl.bramstout.mcworldexporter.world.*;

/** Pinned MiEx adapter. Reads captured project sections only, never opens the live game save. */
public final class SceneBaker extends Command {
    static final Gson JSON=new Gson();
    public static void main(String[] args){System.setProperty("mcm.preparedResources","true");CommandRegistry.registerCommand("mcmScene",SceneBaker.class);MCWorldExporter.main(args);}
    static NbtTag nbt(String name,JsonElement value){
        if(value==null || value.isJsonNull())return null;
        if(value.isJsonObject()){var tag=NbtTagCompound.newNonPooledInstance(name);value.getAsJsonObject().entrySet().forEach(e->tag.addElement(nbt(e.getKey(),e.getValue())));return tag;}
        if(value.isJsonArray()){var tags=new ArrayList<NbtTag>();for(var child:value.getAsJsonArray())tags.add(nbt("",child));return NbtTagList.newNonPooledInstance(name,tags.toArray(NbtTag[]::new));}
        var p=value.getAsJsonPrimitive();if(p.isBoolean())return NbtTagByte.newNonPooledInstance(name,p.getAsBoolean()?(byte)1:(byte)0);
        if(p.isNumber()){double d=p.getAsDouble();if(name.equals("ItemRotation"))return NbtTagFloat.newNonPooledInstance(name,(float)d);return d==Math.rint(d) && d>=Integer.MIN_VALUE && d<=Integer.MAX_VALUE?NbtTagInt.newNonPooledInstance(name,(int)d):NbtTagDouble.newNonPooledInstance(name,d);}
        return NbtTagString.newNonPooledInstance(name,p.getAsString());
    }
    static final class SnapshotWorld extends World {
        record Cell(int x,int y,int z,int layer){}
        final Map<Cell,Integer> cells=new LinkedHashMap<>();
        final List<JsonObject> entities=new ArrayList<>();
        final Map<Cell,Integer> biomes=new HashMap<>();
        SnapshotWorld(JsonArray sections){
            super(new File("."),"Captured project scene",null);
            blockConnectionsTranslation=new BlockConnectionsTranslation("bedrock");blockConnectionsTranslation.load();
            var translator=TranslationRegistry.BLOCK_BEDROCK.getTranslator(0);var chars=new Reference<char[]>();
            for(var entry:sections){var section=entry.getAsJsonObject();int x=section.get("x").getAsInt(),y=section.get("y").getAsInt(),z=section.get("z").getAsInt();var palette=section.getAsJsonArray("palette");
                var scene=section.has("scene")&&!section.get("scene").isJsonNull()?section.getAsJsonObject("scene"):new JsonObject();
                if(scene.has("biomeRuns")){var runs=scene.getAsJsonArray("biomeRuns");var names=scene.getAsJsonArray("biomePalette");int cursor=0;for(int n=0;n<runs.size();n+=2){int id=BiomeRegistry.getIdForName(TranslationRegistry.BIOME_BEDROCK.map(names.get(runs.get(n).getAsInt()).getAsString()));for(int i=0;i<runs.get(n+1).getAsInt();i++,cursor++)biomes.put(new Cell(x+cursor%8,y+cursor/64,z+cursor/8%8,0),id);}}
                var visuals=new HashMap<Integer,JsonObject>();if(scene.has("blockEntities"))for(var visual:scene.getAsJsonArray("blockEntities"))visuals.put(visual.getAsJsonObject().get("index").getAsInt(),visual.getAsJsonObject().getAsJsonObject("data"));
                if(scene.has("entities"))for(var entity:scene.getAsJsonArray("entities")){var data=entity.getAsJsonObject();if(!Set.of("minecraft:item","minecraft:player").contains(data.get("type").getAsString()))entities.add(data);}
                for(int layer=0;layer<2;layer++){
                    var runs=layer==0?section.getAsJsonArray("runs"):scene.getAsJsonArray("extraRuns");if(runs==null)continue;int cursor=0;
                    for(int r=0;r<runs.size();r+=2){int index=runs.get(r).getAsInt(),count=runs.get(r+1).getAsInt();var block=palette.get(index).getAsJsonObject();
                        for(int j=0;j<count;j++,cursor++){if(index==0)continue;int bx=x+cursor%8,by=y+cursor/64,bz=z+cursor/8%8;String name=block.get("name").getAsString(),snbt=block.get("states").getAsString();
                            var states=snbt.isEmpty()?new JsonObject():JsonParser.parseString(snbt).getAsJsonObject().getAsJsonObject("states");if(states==null)states=new JsonObject();else states=states.deepCopy();
                            // Numeric suffixes belong to SNBT block states, never to ordinary sign text or names.
                            for(var e:new ArrayList<>(states.entrySet()))if(e.getValue().isJsonPrimitive()&&e.getValue().getAsJsonPrimitive().isString()){String text=e.getValue().getAsString();if(text.matches("-?[0-9]+[bBsSlL]"))states.addProperty(e.getKey(),Long.parseLong(text.substring(0,text.length()-1)));}
                            if(layer==0 && visuals.containsKey(cursor))for(var e:visuals.get(cursor).entrySet())states.add(e.getKey(),e.getValue());
                            states.addProperty("x",bx);states.addProperty("y",by);states.addProperty("z",bz);
                            if(layer==0 && (name.equals("minecraft:frame")||name.equals("minecraft:glow_frame"))){
                                var entity=new JsonObject();entity.addProperty("type",name.equals("minecraft:frame")?"minecraft:item_frame":"minecraft:glow_item_frame");entity.addProperty("x",bx+.5);entity.addProperty("y",by);entity.addProperty("z",bz+.5);entity.add("data",states);entities.add(entity);continue;
                            }
                            var properties=(NbtTagCompound)nbt("",states);name=translator.map(name,properties);int id=BlockRegistry.getIdForName(name,properties,0,chars);cells.put(new Cell(bx,by,bz,layer),id);
                        }
                    }
                }
            }
        }
        @Override public int getBlockId(int x,int y,int z,int layer){return cells.getOrDefault(new Cell(x,y,z,layer),0);}
        @Override public void getBlockId(int x,int y,int z,LayeredBlock out){out.setLayerCount(2);out.setBlock(0,getBlockId(x,y,z,0));out.setBlock(1,getBlockId(x,y,z,1));}
        @Override public int getBiomeId(int x,int y,int z){return biomes.getOrDefault(new Cell(x,y,z,0),BiomeRegistry.getIdForName("minecraft:plains"));}
        @Override protected void loadWorldSettings(){} @Override protected void findDimensions(){} @Override protected void findRegions(){}
        @Override protected void _unload(){} @Override protected void _pause(){} @Override protected void _unpause(){}
        @Override public List<String> getRequiredResourcePacks(){return List.of("base_resource_pack");}
        @Override public List<ResourcePackSource> getDependentResourcePacks(){return List.of();}
    }
    final Map<String,String> textureFiles=new HashMap<>();final JsonObject animations=new JsonObject(),textureAlpha=new JsonObject(),exportTextures=new JsonObject();final JsonArray issues=new JsonArray();Path output;
    final Map<String,JsonObject> attachables=new HashMap<>();
    void checkSignText(JsonObject data){
        var font=ResourcePacks.getFont("minecraft:default");
        for(String side:List.of("FrontText","BackText"))if(data.has(side)&&data.get(side).isJsonObject()&&data.getAsJsonObject(side).has("Text")){
            boolean format=false;for(int codepoint:data.getAsJsonObject(side).get("Text").getAsString().codePoints().toArray()){
                if(format){format=false;continue;}if(codepoint=='§'){format=true;continue;}
                if(!Character.isWhitespace(codepoint)&&(font==null||font.getCharacterInfo(codepoint)==null))issues.add("告示牌缺少字形：U+"+Integer.toHexString(codepoint).toUpperCase());
            }
        }
    }
    void pose(Entity entity,Model model,JsonObject data){
        if(!entity.getId().equals("minecraft:armor_stand"))return;
        var properties=data.getAsJsonObject("data");int index=properties.has("PoseIndex")?properties.get("PoseIndex").getAsInt():0;
        if(properties.has("Pose")&&properties.getAsJsonObject("Pose").has("PoseIndex"))index=properties.getAsJsonObject("Pose").get("PoseIndex").getAsInt();
        String[] names={"default","no","solemn","athena","brandish","honor","entertain","salute","riposte","zombie","cancan_a","cancan_b","hero"};
        if(index<0||index>=names.length){issues.add("未知盔甲架姿态："+index);return;}
        var animation=ResourcePacks.getAnimation("animation.armor_stand."+names[index]+"_pose");if(animation==null){issues.add("缺少盔甲架姿态："+index);return;}
        var context=new MolangContext(new MolangQuery(entity.getId(),entity.getProperties(),entity.getX(),entity.getY(),entity.getZ()),entity.getRandom());context.setGlobal("variable",entity.getVariables());context.pushAnimationInfo();
        for(var channels:animation.getBones())for(var bone:model.getBones())if(bone.getName().equals(channels.getName())){
            bone.rotation.x=rotation(channels.rotX,bone.rotation.x,context);bone.rotation.y=rotation(channels.rotY,bone.rotation.y,context);bone.rotation.z=rotation(channels.rotZ,bone.rotation.z,context);
        }
        context.popAnimationInfo();
    }
    static float rotation(Animation.AnimationChannel channel,float current,MolangContext context){if(channel==null)return current;context.setGlobal("this",new MolangValue(current));return current+channel.eval(0,context);}
    void loadAttachables()throws Exception {
        var packs=new ArrayList<>(ResourcePacks.getActiveResourcePacks());Collections.reverse(packs);
        for(var pack:packs){var dir=pack.getFolder().toPath().resolve("attachables");if(!Files.isDirectory(dir))continue;
            try(var files=Files.walk(dir)){for(var file:files.filter(p->p.toString().endsWith(".json")).toList()){
                var root=Json.read(file.toFile());if(root==null || !root.isJsonObject() || !root.getAsJsonObject().has("minecraft:attachable"))continue;
                var data=root.getAsJsonObject().getAsJsonObject("minecraft:attachable");attachables.put(data.getAsJsonObject("description").get("identifier").getAsString(),data);
            }}
        }
    }
    static boolean moving(String type){return !Set.of("minecraft:armor_stand","minecraft:painting","minecraft:item_frame","minecraft:glow_item_frame").contains(type);}
    void equipment(JsonArray rendered,JsonObject data,Entity entity,Model parent)throws Exception {
        var armor=data.getAsJsonObject("data").getAsJsonArray("Armor");if(armor==null)return;
        for(var item:armor){if(!item.isJsonObject() || !item.getAsJsonObject().has("Name"))continue;String name=item.getAsJsonObject().get("Name").getAsString();if(name.isBlank())continue;
            var definition=attachables.get(name);if(definition==null){issues.add("missing wearable: "+name);continue;}
            var wearable=new Entity(name,entity.getProperties(),new EntityHandlerBedrockEdition(name,definition));
            var tag=item.getAsJsonObject().getAsJsonObject("tag");wearable.getVariables().getField("is_enchanted").set(new nl.bramstout.mcworldexporter.molang.MolangValue(tag!=null&&tag.has("ench")&&!tag.getAsJsonArray("ench").isEmpty()));
            var mesh=wearable.getModel();if(mesh==null){issues.add("missing wearable geometry: "+name);continue;}
            for(var bone:mesh.getBones())for(var source:parent.getBones())if(bone.getName().equalsIgnoreCase(source.getName())){bone.rotation.x=source.rotation.x;bone.rotation.y=source.rotation.y;bone.rotation.z=source.rotation.z;}
            mesh.applyBones();var result=model(mesh,data.get("x").getAsDouble(),data.get("y").getAsDouble(),data.get("z").getAsDouble(),true);result.addProperty("yaw",entity.getYaw());result.addProperty("type",name);result.addProperty("equipment",true);result.addProperty("moving",moving(entity.getId()));if(result.getAsJsonArray("faces").isEmpty())issues.add("empty geometry: "+name);rendered.add(result);
        }
    }
    String texture(String name)throws Exception {
        if(textureFiles.containsKey(name))return textureFiles.get(name);
        File source=ResourcePacks.getTexture(name);if(source==null || !source.isFile()){issues.add("missing texture: "+name);textureFiles.put(name,null);return null;}
        var image=ImageReader.readImage(source);if(image==null){issues.add("unreadable texture: "+name);textureFiles.put(name,null);return null;}
        boolean translucent=false,cutout=false;for(int y=0;y<image.getHeight();y++)for(int x=0;x<image.getWidth();x++){int alpha=image.getRGB(x,y)>>>24;if(alpha<255)cutout=true;if(alpha>0&&alpha<255)translucent=true;}
        var bytes=new ByteArrayOutputStream();ImageIO.write(image,"png",bytes);String hash=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray()));
        Files.write(output.resolve(hash+".png"),bytes.toByteArray());textureFiles.put(name,hash+".png");textureAlpha.addProperty(hash+".png",translucent?"BLEND":cutout?"MASK":"OPAQUE");
        var meta=ResourcePacks.getMCMeta(name);
        if(meta!=null && meta.isAnimate() && meta.getFrameCount()>1){
            int height=image.getWidth()*meta.getTileHeight()/meta.getTileWidth();
            if(height>0 && image.getHeight()%height==0){var animation=new JsonObject();animation.addProperty("height",height);animation.addProperty("interpolate",meta.isInterpolate());var frames=new JsonArray();var sequence=meta.getFrames();for(int i=0;i<sequence.length;i+=2){if(sequence[i]<0||sequence[i]>=image.getHeight()/height||sequence[i+1]<1)throw new IllegalArgumentException("Invalid animated texture frames: "+name);frames.add(sequence[i]);frames.add(sequence[i+1]);}animation.add("frames",frames);animations.add(hash+".png",animation);var firstBytes=new ByteArrayOutputStream();ImageIO.write(image.getSubimage(0,sequence[0]*height,image.getWidth(),height),"png",firstBytes);String firstHash=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(firstBytes.toByteArray()));Files.write(output.resolve(firstHash+".png"),firstBytes.toByteArray());exportTextures.addProperty(hash+".png",firstHash+".png");}
            else issues.add("动画贴图尺寸不匹配："+name);
        }
        return hash+".png";
    }
    JsonObject model(Model model,double x,double y,double z,boolean entity)throws Exception {return model(model,x,y,z,entity,null,null);}
    JsonObject model(Model model,double x,double y,double z,boolean entity,Tints.TintLayers tints,BlendedBiome biome)throws Exception {
        var result=new JsonObject();result.addProperty("x",x);result.addProperty("y",y);result.addProperty("z",z);result.addProperty("entity",entity);var faces=new JsonArray();
        for(var face:model.getFaces()){
            var value=face.toJson();String name=model.getTexture(face.getTexture());String file=texture(name);if(file==null)continue;
            // Grass sides have a separate tinted overlay. Tinting the base also turns dirt green
            // and applies the biome colour twice to the carried texture's already green fringe.
            if(tints!=null){int index=face.getTintIndex();if(index<0 && Config.forceBiomeColor.contains(name) && !name.equals("minecraft:block/grass_block_side"))index=0;var tint=tints.getLayer(index);if(tint!=null){var color=tint.getColor(biome);if(color!=null){var rgb=color.get(0);var existing=value.getAsJsonArray("vertexColor");var resultColor=new JsonArray();resultColor.add(rgb.getR()*(existing==null?1:existing.get(0).getAsFloat()));resultColor.add(rgb.getG()*(existing==null?1:existing.get(1).getAsFloat()));resultColor.add(rgb.getB()*(existing==null?1:existing.get(2).getAsFloat()));value.add("vertexColor",resultColor);}}}
            value.addProperty("texture",file);faces.add(value);
        }
        result.add("faces",faces);return result;
    }
    @Override public JsonObject run(JsonObject command){
        try{
            output=Path.of(command.get("output").getAsString());Files.createDirectories(output);
            System.setProperty("mcm.generatedTexturesDir",output.resolve("generated").toAbsolutePath().toString());
            var input=JsonParser.parseString(Files.readString(Path.of(command.get("input").getAsString()))).getAsJsonArray();
            int legacy=0,incomplete=0;for(var section:input){var raw=section.getAsJsonObject().get("scene");if(raw==null||raw.isJsonNull())legacy++;else {var s=raw.getAsJsonObject();if(!s.get("blocksComplete").getAsBoolean()||!s.get("entitiesComplete").getAsBoolean())incomplete++;}}
            if(legacy>0)issues.add("有 "+legacy+" 个分段来自旧版采集，尚无实体与方块附加内容");
            if(incomplete>0)issues.add("有 "+incomplete+" 个分段尚未完成附加内容采集");
            loadAttachables();
            for(var section:input){var raw=section.getAsJsonObject().get("scene");if(raw!=null&&raw.isJsonObject())for(var visual:raw.getAsJsonObject().getAsJsonArray("blockEntities"))checkSignText(visual.getAsJsonObject().getAsJsonObject("data"));}
            BlockRegistry.clearBlockRegistry();var world=new SnapshotWorld(input);
            // MiEx has no public setter for an in-memory World; this adapter is tied to the pinned source revision.
            var field=MCWorldExporter.class.getDeclaredField("world");field.setAccessible(true);field.set(MCWorldExporter.getApp(),world);
            var rendered=new JsonArray();
            for(var entry:world.cells.entrySet()){var p=entry.getKey();var baked=BlockStateRegistry.getBakedStateForBlock(entry.getValue(),p.x(),p.y(),p.z(),p.layer(),false);var models=new ArrayList<Model>();baked.getModels(p.x(),p.y(),p.z(),models);if(!world.biomes.containsKey(new SnapshotWorld.Cell(p.x(),p.y(),p.z(),0)) && baked.getTint()!=null)issues.add("部分区域尚无群系记录，植物与水面采用默认配色");var biome=new BlendedBiome();biome.addBiome(BiomeRegistry.getBiome(world.getBiomeId(p.x(),p.y(),p.z())),1,1,1,1,1,1,1,1);biome.normalise();for(var m:models)rendered.add(model(m,p.x(),p.y(),p.z(),false,Config.forceNoBiomeColor.contains(baked.getName())?null:baked.getTint(),biome));}
            var seen=new HashSet<String>();
            for(var data:world.entities){String type=data.get("type").getAsString();if(data.has("id")&&!seen.add(data.get("id").getAsString()))continue;
                var entity=EntityRegistry.getEntity(type,(NbtTagCompound)nbt("",data.get("data")));if(entity==null){issues.add("missing entity: "+type);continue;}
                if(data.has("yaw"))entity.setYaw(data.get("yaw").getAsFloat());if(data.has("pitch"))entity.setPitch(data.get("pitch").getAsFloat());
                var m=entity.getModel();if(m==null){issues.add("missing entity model: "+type);continue;}pose(entity,m,data);m.applyBones();
                var value=model(m,data.get("x").getAsDouble(),data.get("y").getAsDouble(),data.get("z").getAsDouble(),true);value.addProperty("yaw",entity.getYaw());value.addProperty("type",type);value.addProperty("moving",moving(type));if(value.getAsJsonArray("faces").isEmpty())issues.add("empty geometry: "+type);rendered.add(value);
                equipment(rendered,data,entity,m);
            }
            for(var missing:BlockStateRegistry.missingBlockStates)issues.add("missing block model: "+missing);
            var uniqueIssues=new JsonArray();var seenIssues=new LinkedHashSet<String>();for(var issue:issues)if(seenIssues.add(issue.getAsString()))uniqueIssues.add(issue);
            var scene=new JsonObject();scene.add("models",rendered);scene.add("animations",animations);scene.add("textureAlpha",textureAlpha);scene.add("exportTextures",exportTextures);scene.add("issues",uniqueIssues);scene.addProperty("format",1);scene.addProperty("renderer","MiEx");
            Files.writeString(output.resolve("scene.json"),JSON.toJson(scene));var result=new JsonObject();result.addProperty("models",rendered.size());result.addProperty("format",1);result.add("issues",uniqueIssues);Files.writeString(output.resolve("scene-info.json"),JSON.toJson(result));return result;
        }catch(Exception e){throw new RuntimeException(e);}
    }
}
