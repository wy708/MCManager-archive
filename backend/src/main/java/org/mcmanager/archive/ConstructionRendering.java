package org.mcmanager.archive;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/** One bounded offline baker for all viewers; never runs inside the game tick or an HTTP request. */
@Service
class ConstructionRendering {
    record Phase(UUID id,int revision) {}
    record State(String state,String message,UUID build,long version,long latestVersion,Instant observedAt,List<String> issues) {}
    static final class Job {
        final Phase phase;final UUID id;final Path directory;
        volatile String state="QUEUED",message="正在排队生成场景";
        volatile long version=-1;volatile Instant observedAt;volatile List<String> issues=List.of();
        volatile long finishedAt;volatile Process process;UUID snapshot;
        Job(Phase phase,Path root,UUID id){this.phase=phase;this.id=id;this.directory=root.resolve(phase.id().toString()).resolve(Integer.toString(phase.revision())).resolve(id.toString());}
    }
    private final ConstructionModels models;private final JdbcTemplate jdbc;private final ObjectMapper json;private final TransactionTemplate transaction;private final ConstructionHistory history;
    private final String runner,node;private final Path root;
    private final Map<Phase,Job> latest=new LinkedHashMap<>();private final Map<UUID,Job> builds=new LinkedHashMap<>();
    record HeightRange(int minY,int maxY,int suggestedMinY,String basis) {}
    private final Map<UUID,HeightRange> heightRanges=new ConcurrentHashMap<>();
    private final Map<Path,RangeExport> exports=new ConcurrentHashMap<>();
    private static final class RangeExport {
        volatile String state="QUEUED",message="正在排队导出所选高度";volatile long finishedAt;volatile Process process;
    }
    private final ThreadPoolExecutor executor=new ThreadPoolExecutor(1,1,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(4),r->{var t=new Thread(r,"construction-scene-baker");t.setDaemon(true);return t;},new ThreadPoolExecutor.AbortPolicy());
    ConstructionRendering(ConstructionModels models,JdbcTemplate jdbc,ObjectMapper json,PlatformTransactionManager manager,
        @Value("${MCM_SCENE_RUNNER:}") String runner,@Value("${MCM_SCENE_DIR:data/scenes}") String directory,@Value("${MCM_NODE:node}") String node){
        this.models=models;this.jdbc=jdbc;this.json=json;this.runner=runner;this.root=Path.of(directory).toAbsolutePath().normalize();this.node=node;
        this.history=new ConstructionHistory(jdbc,json,models,manager);
        transaction=new TransactionTemplate(manager);transaction.setReadOnly(true);transaction.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
    }
    synchronized State status(UUID id,int revision){
        var source=models.status(id,revision);var phase=new Phase(id,revision);
        if(runner.isBlank()||!Files.isRegularFile(Path.of(runner)))return new State("UNAVAILABLE","完整场景转换服务尚未安装；采集记录会保留",null,-1,source.version(),source.lastObservedAt(),List.of());
        if(source.sections()==0)return new State("WAITING","等待游戏加载工程区域并上传场景",null,-1,source.version(),source.lastObservedAt(),List.of());
        var job=latest.get(phase);if(job==null){job=restore(phase);if(job!=null){latest.put(phase,job);builds.put(job.id,job);}}long now=System.currentTimeMillis();
        // Repeated public reads cannot enqueue duplicates or continuously restart a failed bake.
        boolean active=job!=null && (job.state.equals("QUEUED")||job.state.equals("BUILDING"));
        boolean stale=job==null || job.version!=source.version() || !Files.isRegularFile(job.directory.resolve("observations.json"));
        boolean retry=job!=null && job.state.equals("FAILED") && now-job.finishedAt>=60000;
        if(!active && (job==null || retry || (job.state.equals("READY") && stale && (source.status().equals("COMPLETE") || now-job.finishedAt>=30000)))){
            var next=new Job(phase,root,UUID.randomUUID());
            try{executor.execute(()->bake(next));latest.put(phase,next);builds.put(next.id,next);job=next;}
            catch(RejectedExecutionException busy){if(job==null)return new State("BUSY","其他工程正在生成，请稍后再试",null,-1,source.version(),source.lastObservedAt(),List.of());}
        }
        return new State(job.state,job.message,job.id,job.version,source.version(),job.observedAt,job.issues);
    }
    private void snapshot(Job job)throws IOException {
        Files.createDirectories(job.directory);
        if(job.snapshot!=null){
            var frame=history.get(job.phase.id(),job.phase.revision(),job.snapshot);job.version=frame.version();job.observedAt=frame.observedAt();
            try(var writer=Files.newBufferedWriter(job.directory.resolve("input.json"),StandardCharsets.UTF_8)){history.write(job.phase.id(),job.phase.revision(),job.snapshot,writer);}
            json.writeValue(job.directory.resolve("observations.json").toFile(),history.observations(job.snapshot));return;
        }
        transaction.executeWithoutResult(tx->{
            var status=models.status(job.phase.id(),job.phase.revision());job.version=status.version();job.observedAt=status.lastObservedAt();
            try(var writer=Files.newBufferedWriter(job.directory.resolve("input.json"),StandardCharsets.UTF_8)){
                writer.write('[');boolean[] first={true};
                // Newest observation wins if a moving entity appears in two independently scanned sections.
                jdbc.query("SELECT data_json FROM construction_model_sections WHERE project_id=? AND revision=? ORDER BY observed_at DESC,sx,sy,sz",rs->{
                    try{if(!first[0])writer.write(',');first[0]=false;writer.write(rs.getString("data_json"));}catch(IOException e){throw new UncheckedIOException(e);}
                },job.phase.id(),job.phase.revision());writer.write(']');
                var times=jdbc.query("SELECT sx,sy,sz,observed_at FROM construction_model_sections WHERE project_id=? AND revision=?",(rs,i)->Map.of("x",rs.getInt(1),"y",rs.getInt(2),"z",rs.getInt(3),"observedAt",TelemetryQueries.instant(rs,"observed_at").toString()),job.phase.id(),job.phase.revision());
                json.writeValue(job.directory.resolve("observations.json").toFile(),times);
            }catch(IOException e){throw new UncheckedIOException(e);}
        });
    }
    private void bake(Job job){
        job.state="BUILDING";job.message="正在转换原版模型和贴图";
        try{
            snapshot(job);
            var output=job.directory.resolve("output");Files.createDirectories(output);
            var builder=new ProcessBuilder(node,Path.of(runner).toAbsolutePath().toString(),job.directory.resolve("input.json").toString(),output.toString());
            builder.directory(job.directory.toFile()).redirectErrorStream(true).redirectOutput(job.directory.resolve("render.log").toFile());
            job.process=builder.start();
            if(!job.process.waitFor(135,TimeUnit.SECONDS)){terminate(job.process);throw new IOException("Scene conversion timed out");}
            if(job.process.exitValue()!=0)throw new IOException("Scene conversion failed");
            var result=json.readTree(output.resolve("scene-info.json").toFile());
            if(result.path("format").asInt()!=1||!result.path("models").isNumber()||!result.path("issues").isArray()||!Files.isRegularFile(output.resolve("scene.json")))throw new IOException("Invalid scene output");
            var issues=new ArrayList<String>();for(var issue:result.path("issues"))issues.add(issue.asText());job.issues=List.copyOf(issues);
            models.status(job.phase.id(),job.phase.revision()); // A deleted project must never become publicly visible again.
            job.message=issues.isEmpty()?"场景已生成":"场景已生成，仍有内容需要补充";
            var saved=new State("READY",job.message,job.id,job.version,job.version,job.observedAt,job.issues);
            json.writeValue(job.directory.resolve("ready.json").toFile(),saved);
            if(job.snapshot==null){var pointer=job.directory.getParent().resolve("latest.json.tmp");json.writeValue(pointer.toFile(),Map.of("build",job.id));
            Files.move(pointer,job.directory.getParent().resolve("latest.json"),StandardCopyOption.REPLACE_EXISTING);}
            job.state="READY";
        }catch(Exception e){
            job.state="FAILED";job.message="场景转换未完成，请稍后重试；管理员可查看转换日志";
            org.slf4j.LoggerFactory.getLogger(getClass()).warn("Scene bake {} failed: {}",job.id,e.toString());
            if(e instanceof InterruptedException)Thread.currentThread().interrupt();
        }finally{if(job.process!=null&&job.process.isAlive())terminate(job.process);job.process=null;job.finishedAt=System.currentTimeMillis();}
    }
    synchronized Path asset(UUID id,int revision,UUID build,String file){
        models.status(id,revision);
        if(!file.equals("scene.json")&&!file.matches("[a-f0-9]{64}\\.png"))throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        var job=builds.get(build);if(job==null)job=restore(new Phase(id,revision),build);
        if(job==null||!job.phase.equals(new Phase(id,revision))||!job.state.equals("READY"))throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        var path=job.directory.resolve("output").resolve(file);
        if(!Files.isRegularFile(path))throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        return path;
    }
    synchronized State historical(UUID id,int revision,UUID snapshot){
        var frame=history.get(id,revision,snapshot);var phase=new Phase(id,revision);
        if(runner.isBlank()||!Files.isRegularFile(Path.of(runner)))return new State("UNAVAILABLE","完整场景转换服务尚未安装",null,-1,frame.version(),frame.observedAt(),List.of());
        var job=builds.get(snapshot);if(job==null)job=restore(phase,snapshot);
        if(job==null || job.state.equals("FAILED")&&System.currentTimeMillis()-job.finishedAt>=60000){
            var next=new Job(phase,root,snapshot);next.snapshot=snapshot;
            try{executor.execute(()->bake(next));builds.put(snapshot,next);job=next;}catch(RejectedExecutionException e){return new State("BUSY","其他画面正在生成，请稍后再试",null,-1,frame.version(),frame.observedAt(),List.of());}
        }
        return new State(job.state,job.message,job.id,job.version,frame.version(),job.observedAt,job.issues);
    }
    record BlockEvent(Instant occurredAt,String player,String operation,String block) {}
    record BlockInfo(int x,int y,int z,boolean known,ConstructionModels.Block block,ConstructionModels.Block extra,Instant observedAt,List<BlockEvent> events,boolean more,String notice) {}
    BlockInfo inspect(UUID id,int revision,UUID build,int x,int y,int z)throws IOException{
        var asset=asset(id,revision,build,"scene.json");
        var range=jdbc.queryForMap("SELECT min_x,max_x,min_z,max_z FROM construction_phases WHERE project_id=? AND revision=?",id,revision);
        TelemetryValidation.check(x>=((Number)range.get("min_x")).intValue()&&x<=((Number)range.get("max_x")).intValue()&&z>=((Number)range.get("min_z")).intValue()&&z<=((Number)range.get("max_z")).intValue()&&y>=-2048&&y<=4095,"坐标超出工程范围");
        int sx=Math.floorDiv(x,8)*8,sy=Math.floorDiv(y,8)*8,sz=Math.floorDiv(z,8)*8;ConstructionModels.Section section=null;
        // Stream the immutable source; never substitute the live section for a historical selection.
        try(var parser=json.getFactory().createParser(asset.getParent().getParent().resolve("input.json").toFile())){
            parser.nextToken();while(parser.nextToken()!=com.fasterxml.jackson.core.JsonToken.END_ARRAY){var value=json.readValue(parser,ConstructionModels.Section.class);if(value.x()==sx&&value.y()==sy&&value.z()==sz){section=value;break;}}
        }
        Instant observed=null;var times=asset.getParent().getParent().resolve("observations.json");
        if(Files.isRegularFile(times))for(var entry:json.readTree(times.toFile()))if(entry.path("x").asInt()==sx&&entry.path("y").asInt()==sy&&entry.path("z").asInt()==sz){observed=Instant.parse(entry.path("observedAt").asText());break;}
        var events=observed==null?List.<BlockEvent>of():jdbc.query("SELECT occurred_at,player_name,operation,block FROM construction_events WHERE project_id=? AND revision<=? AND x=? AND y=? AND z=? AND occurred_at<=? ORDER BY occurred_at DESC,event_id DESC LIMIT 51",(rs,i)->new BlockEvent(TelemetryQueries.instant(rs,"occurred_at"),rs.getString("player_name"),rs.getString("operation"),rs.getString("block")),id,revision,x,y,z,TelemetryService.time(observed));
        int index=(y-sy)*64+(z-sz)*8+x-sx;
        ConstructionModels.Block block=section==null?null:blockAt(section,section.runs(),index),extra=null;
        if(section!=null&&section.scene()!=null&&section.scene().path("extraRuns").isArray()){var runs=new ArrayList<Integer>();for(var n:section.scene().path("extraRuns"))runs.add(n.asInt());extra=blockAt(section,runs,index);}
        return new BlockInfo(x,y,z,section!=null,block,extra,observed,events.stream().limit(50).toList(),events.size()>50,"记录截至该分段采集时间；放置记录不等于当前方块的归属，无记录不能推断建造者。旧画面缺少分段时间时不混入当前记录。不公开箱内库存。");
    }
    private static ConstructionModels.Block blockAt(ConstructionModels.Section section,List<Integer> runs,int index){int cursor=0;for(int i=0;i<runs.size();i+=2){cursor+=runs.get(i+1);if(index<cursor)return section.palette().get(runs.get(i));}return null;}
    String projectName(UUID server,UUID id){
        var names=jdbc.queryForList("SELECT name FROM construction_projects WHERE id=? AND server_id=?",String.class,id,server);
        if(names.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND);return names.getFirst();
    }
    Path export(UUID server,UUID id,int revision,UUID build,boolean includeCreatures){
        projectName(server,id);var source=asset(id,revision,build,"scene.json");
        var file=source.resolveSibling(includeCreatures?"scene-all.glb":"scene-building.glb");
        if(!Files.isRegularFile(file))throw new ResponseStatusException(HttpStatus.CONFLICT,"此场景的导出文件尚未生成，请重新生成场景");return file;
    }
    HeightRange heightRange(UUID id,int revision,UUID build)throws IOException {
        var source=asset(id,revision,build,"scene.json");var cached=heightRanges.get(build);if(cached!=null)return cached;
        var bounds=ConstructionSceneRanges.bounds(json,source);
        var phase=jdbc.queryForMap("SELECT min_x,max_x,min_z,max_z FROM construction_phases WHERE project_id=? AND revision=?",id,revision);
        var observed=json.readTree(source.getParent().getParent().resolve("ready.json").toFile()).path("observedAt").asText(null);
        Integer placed=observed==null?null:jdbc.queryForObject("SELECT MIN(y) FROM construction_events WHERE project_id=? AND revision<=? AND operation='PLACE' AND x BETWEEN ? AND ? AND z BETWEEN ? AND ? AND occurred_at<=?",Integer.class,
                id,revision,phase.get("min_x"),phase.get("max_x"),phase.get("min_z"),phase.get("max_z"),TelemetryService.time(Instant.parse(observed)));
        var result=new HeightRange(bounds.minY(),bounds.maxY(),Math.max(bounds.minY(),Math.min(bounds.maxY(),placed==null?bounds.surfaceY():placed)),placed==null?"SURFACE_ESTIMATE":"PLAYER_PLACEMENT");
        heightRanges.put(build,result);return result;
    }
    void writeRange(Path source,OutputStream output,int minY,int maxY)throws IOException {ConstructionSceneRanges.write(json,source,output,minY,maxY);}
    private static Path rangeFile(Path source,int minY,int maxY,boolean creatures){return source.resolveSibling("range-"+minY+"-"+maxY+"-"+(creatures?"all":"building")+".glb");}
    synchronized State rangeExportStatus(UUID server,UUID id,int revision,UUID build,int minY,int maxY,boolean creatures) {
        ConstructionSceneRanges.validate(minY,maxY);projectName(server,id);var source=asset(id,revision,build,"scene.json");var file=rangeFile(source,minY,maxY,creatures);
        if(Files.isRegularFile(file))return new State("READY","所选高度的模型已准备好",build,0,0,null,List.of());
        var task=exports.get(file);long now=System.currentTimeMillis();
        if(task==null||task.state.equals("FAILED")&&now-task.finishedAt>=60000) {
            var next=new RangeExport();exports.put(file,next);
            try {executor.execute(()->{
                next.state="BUILDING";next.message="正在整理所选高度的模型和贴图";
                Path input=file.resolveSibling(file.getFileName()+".json"),log=file.resolveSibling(file.getFileName()+".log");
                try {
                    try(var output=Files.newOutputStream(input)){writeRange(source,output,minY,maxY);}
                    var script=Path.of(runner).toAbsolutePath().resolveSibling("export-range.mjs");
                    next.process=new ProcessBuilder(node,script.toString(),input.toString(),file.getParent().toString(),Integer.toString(minY),Integer.toString(maxY),Boolean.toString(creatures),file.getFileName().toString()).redirectErrorStream(true).redirectOutput(log.toFile()).start();
                    if(!next.process.waitFor(135,TimeUnit.SECONDS)){terminate(next.process);throw new IOException("Range export timed out");}
                    if(next.process.exitValue()!=0||!Files.isRegularFile(file))throw new IOException("Range export failed or empty");
                    models.status(id,revision);next.state="READY";next.message="所选高度的模型已准备好";
                } catch(Exception e) {
                    next.state="FAILED";next.message="所选高度没有可导出的模型，或导出未完成；请核对范围后重试";
                    org.slf4j.LoggerFactory.getLogger(getClass()).warn("Range export {} failed: {}",build,e.toString());if(e instanceof InterruptedException)Thread.currentThread().interrupt();
                    try{Files.deleteIfExists(file);}catch(IOException ignored){}
                } finally {
                    if(next.process!=null&&next.process.isAlive())terminate(next.process);next.process=null;next.finishedAt=System.currentTimeMillis();
                    try{Files.deleteIfExists(input);}catch(IOException ignored){}
                }
            });task=next;}catch(RejectedExecutionException e){exports.remove(file,next);return new State("BUSY","其他模型正在处理，请稍后再试",build,0,0,null,List.of());}
        }
        return new State(task.state,task.message,build,0,0,null,List.of());
    }
    Path exportRange(UUID server,UUID id,int revision,UUID build,int minY,int maxY,boolean creatures) {
        ConstructionSceneRanges.validate(minY,maxY);projectName(server,id);var source=asset(id,revision,build,"scene.json");var file=rangeFile(source,minY,maxY,creatures);
        if(!Files.isRegularFile(file))throw new ResponseStatusException(HttpStatus.CONFLICT,"所选高度的导出文件尚未准备好，请重新点击导出");return file;
    }
    private Job restore(Phase phase){
        try{var pointer=root.resolve(phase.id().toString()).resolve(Integer.toString(phase.revision())).resolve("latest.json");if(!Files.isRegularFile(pointer))return null;return restore(phase,UUID.fromString(json.readTree(pointer.toFile()).path("build").asText()));}catch(Exception e){return null;}
    }
    private Job restore(Phase phase,UUID build){
        try{var job=new Job(phase,root,build);var file=job.directory.resolve("ready.json");if(!Files.isRegularFile(file))return null;var saved=json.readValue(file.toFile(),State.class);if(!saved.state().equals("READY")||!build.equals(saved.build())||!Files.isRegularFile(job.directory.resolve("output/scene.json")))return null;job.state="READY";job.message=saved.message();job.version=saved.version();job.observedAt=saved.observedAt();job.issues=saved.issues();job.finishedAt=Files.getLastModifiedTime(file).toMillis();return job;}catch(Exception e){return null;}
    }
    @Scheduled(initialDelay=600000,fixedDelay=600000)
    synchronized void cleanup(){
        if(!Files.isDirectory(root))return;long cutoff=System.currentTimeMillis()-3600000;
        for(var entry:exports.entrySet())if(entry.getValue().finishedAt>0&&entry.getValue().finishedAt<cutoff){
            try{Files.deleteIfExists(entry.getKey());Files.deleteIfExists(entry.getKey().resolveSibling(entry.getKey().getFileName()+".log"));exports.remove(entry.getKey(),entry.getValue());}catch(IOException ignored){}
        }
        try(var projects=Files.list(root)){
            for(var project:projects.filter(p->Files.isDirectory(p,LinkOption.NOFOLLOW_LINKS)).toList()){
                UUID id;try{id=UUID.fromString(project.getFileName().toString());}catch(IllegalArgumentException ignored){continue;}
                try(var phases=Files.list(project)){
                    for(var phasePath:phases.filter(p->Files.isDirectory(p,LinkOption.NOFOLLOW_LINKS)).toList()){
                        int revision;try{revision=Integer.parseInt(phasePath.getFileName().toString());}catch(NumberFormatException ignored){continue;}
                        boolean exists=jdbc.queryForObject("SELECT COUNT(*) FROM construction_phases WHERE project_id=? AND revision=?",Integer.class,id,revision)>0;
                        var current=restore(new Phase(id,revision));
                        try(var directories=Files.list(phasePath)){
                            for(var directory:directories.filter(p->Files.isDirectory(p,LinkOption.NOFOLLOW_LINKS)).toList()){
                                UUID build;try{build=UUID.fromString(directory.getFileName().toString());}catch(IllegalArgumentException ignored){continue;}
                                var running=builds.get(build);if(running!=null&&(running.state.equals("BUILDING")||running.state.equals("QUEUED")))continue;
                                if(exports.entrySet().stream().anyMatch(e->e.getKey().startsWith(directory)&&e.getValue().finishedAt==0))continue;
                                try(var rangeFiles=Files.list(directory.resolve("output"))){for(var range:rangeFiles.filter(p->p.getFileName().toString().matches("range--?[0-9]+--?[0-9]+-(building|all)\\.glb(\\.log)?")).toList())if(Files.getLastModifiedTime(range).toMillis()<cutoff)Files.deleteIfExists(range);}catch(IOException ignored){}
                                if(exists&&(current!=null&&current.id.equals(build)||Files.getLastModifiedTime(directory).toMillis()>=cutoff))continue;
                                // A corrupt pointer is not permission to discard the only durable scene.
                                if(exists&&current==null&&Files.exists(directory.resolve("ready.json")))continue;
                                removeOwnedBuild(directory);builds.remove(build);
                            }
                        }
                        if(!exists){latest.remove(new Phase(id,revision));Files.deleteIfExists(phasePath.resolve("latest.json"));}
                    }
                }
            }
            builds.entrySet().removeIf(e->e.getValue().finishedAt>0&&e.getValue().finishedAt<cutoff);
            latest.entrySet().removeIf(e->e.getValue().finishedAt>0&&e.getValue().finishedAt<cutoff);
            heightRanges.keySet().removeIf(id->!builds.containsKey(id));
        }catch(IOException e){org.slf4j.LoggerFactory.getLogger(getClass()).warn("Scene cache cleanup failed: {}",e.toString());}
    }
    private void removeOwnedBuild(Path directory)throws IOException {
        Path absolute=directory.toAbsolutePath().normalize();
        if(!absolute.startsWith(root)||absolute.equals(root)||absolute.getNameCount()!=root.getNameCount()+3)throw new IOException("Refusing to remove an unexpected scene cache path");
        try(var files=Files.walk(absolute)){for(var file:files.sorted(Comparator.reverseOrder()).toList())Files.delete(file);}
    }
    private static void terminate(Process process){process.descendants().forEach(ProcessHandle::destroyForcibly);process.destroyForcibly();}
    @PreDestroy void close(){executor.shutdownNow();synchronized(this){for(var job:builds.values())if(job.process!=null)terminate(job.process);for(var job:exports.values())if(job.process!=null)terminate(job.process);}}
}
