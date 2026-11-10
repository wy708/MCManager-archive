package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.concurrent.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
class TerrainEngine {
    static final String ID="cubiomes-bedrock-294c72ab-mcarchive1";
    private final Path executable;
    private final ObjectMapper mapper;
    private final Semaphore slots=new Semaphore(2);
    TerrainEngine(@Value("${mcmanager.terrain-engine:}") String configured,ObjectMapper mapper) {
        this.mapper=mapper;
        executable=Path.of(configured.isBlank()?"../terrain/bin/mcarchive-terrain"+(System.getProperty("os.name").startsWith("Windows")?".exe":""):configured).toAbsolutePath().normalize();
    }
    boolean available() { return Files.isRegularFile(executable) && Files.isExecutable(executable); }
    JsonNode predict(String profile,String seed,String dimension,int x,int y,int z,int radius,int step) {
        var input=profile+" "+seed+" "+dimension.replace("minecraft:","")+" "+x+" "+y+" "+z+" "+radius+" "+step+"\n";
        return execute(profile,input,result->{
            int side=2*radius/step+1;
            if(!result.path("samples").isArray() || result.path("samples").size()!=side*side)throw new IOException("invalid samples");
            int i=0;
            for(var sample:result.path("samples")) {
                if(!sample.path("x").isInt() || sample.path("x").asInt()!=x-radius+(i%side)*step
                    || !sample.path("y").isInt() || sample.path("y").asInt()!=y
                    || !sample.path("z").isInt() || sample.path("z").asInt()!=z-radius+(i/side)*step
                    || !sample.path("biome").asText().matches("[a-z][a-z0-9_]{0,79}"))throw new IOException("invalid sample");
                i++;
            }
        });
    }
    interface ResultCheck { void validate(JsonNode value) throws IOException; }
    JsonNode execute(String profile,String input,ResultCheck check) {
        if(!available()) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"地形推算程序尚未安装");
        if(!slots.tryAcquire()) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"地形推算繁忙，请稍后重试");
        Process process=null;
        try {
            process=new ProcessBuilder(executable.toString()).redirectError(ProcessBuilder.Redirect.DISCARD).start();
            try(var writer=process.getOutputStream()) { writer.write(input.getBytes(StandardCharsets.US_ASCII)); }
            InputStream stream=process.getInputStream();
            var bytes=new FutureTask<byte[]>(()->stream.readNBytes(65537));
            Thread.ofVirtual().start(bytes);
            if(!process.waitFor(3,TimeUnit.SECONDS)) throw new IOException("timeout");
            byte[] body=bytes.get(1,TimeUnit.SECONDS);
            if(process.exitValue()!=0 || body.length>65536) throw new IOException("engine failed");
            var result=mapper.readTree(body);
            if(result==null || !ID.equals(result.path("engine").asText()) || !profile.equals(result.path("profile").asText())) throw new IOException("invalid engine result");
            check.validate(result);
            return result;
        } catch(InterruptedException ex) {
            Thread.currentThread().interrupt(); throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"地形推算已中断");
        } catch(IOException|ExecutionException|TimeoutException ex) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"地形推算暂时不可用");
        } finally {
            if(process!=null) { if(process.isAlive()) process.destroyForcibly(); try{process.getInputStream().close();}catch(IOException ignored){} }
            slots.release();
        }
    }
}
