package org.mcmanager.archive;

import java.util.UUID;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

@RestController
class ConstructionRenderingController {
    private final ConstructionRendering rendering;
    ConstructionRenderingController(ConstructionRendering rendering){this.rendering=rendering;}
    @GetMapping("/api/public/projects/{id}/phases/{revision}/scene/history/{snapshot}/status")
    ResponseEntity<ConstructionRendering.State> historical(@PathVariable UUID id,@PathVariable int revision,@PathVariable UUID snapshot){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(rendering.historical(id,revision,snapshot));}
    @GetMapping("/api/public/projects/{id}/phases/{revision}/scene/{build}/block")
    ResponseEntity<ConstructionRendering.BlockInfo> block(@PathVariable UUID id,@PathVariable int revision,@PathVariable UUID build,@RequestParam int x,@RequestParam int y,@RequestParam int z)throws java.io.IOException{return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(rendering.inspect(id,revision,build,x,y,z));}
    @GetMapping("/api/public/projects/{id}/phases/{revision}/scene/status")
    ResponseEntity<ConstructionRendering.State> status(@PathVariable UUID id,@PathVariable int revision){
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(rendering.status(id,revision));
    }
    @GetMapping("/api/public/projects/{id}/phases/{revision}/scene/{build}/{file}")
    ResponseEntity<StreamingResponseBody> asset(@PathVariable UUID id,@PathVariable int revision,@PathVariable UUID build,@PathVariable String file,@RequestParam(required=false) Integer minY,@RequestParam(required=false) Integer maxY)throws java.io.IOException{
        if(minY!=null||maxY!=null)ConstructionSceneRanges.validate(minY,maxY);
        var asset=rendering.asset(id,revision,build,file);
        if(file.equals("scene.json")&&minY!=null){StreamingResponseBody body=output->rendering.writeRange(asset,output,minY,maxY);return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.APPLICATION_JSON).body(body);}
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentLength(java.nio.file.Files.size(asset)).contentType(file.endsWith(".png")?MediaType.IMAGE_PNG:MediaType.APPLICATION_JSON).body(output->java.nio.file.Files.copy(asset,output));
    }
    @GetMapping("/api/public/projects/{id}/phases/{revision}/scene/{build}/height-range")
    ConstructionRendering.HeightRange heightRange(@PathVariable UUID id,@PathVariable int revision,@PathVariable UUID build)throws java.io.IOException{return rendering.heightRange(id,revision,build);}
    @GetMapping("/api/servers/{server}/projects/{id}/phases/{revision}/scene-export/{build}/range-status")
    ConstructionRendering.State rangeStatus(@PathVariable UUID server,@PathVariable UUID id,@PathVariable int revision,@PathVariable UUID build,@RequestParam int minY,@RequestParam int maxY,@RequestParam(defaultValue="false") boolean includeCreatures){return rendering.rangeExportStatus(server,id,revision,build,minY,maxY,includeCreatures);}
    @GetMapping("/api/servers/{server}/projects/{id}/phases/{revision}/scene-export/status")
    ResponseEntity<ConstructionRendering.State> exportStatus(@PathVariable UUID server,@PathVariable UUID id,@PathVariable int revision){
        rendering.projectName(server,id);return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(rendering.status(id,revision));
    }
    @GetMapping("/api/servers/{server}/projects/{id}/phases/{revision}/scene-export/{build}")
    ResponseEntity<FileSystemResource> export(@PathVariable UUID server,@PathVariable UUID id,@PathVariable int revision,@PathVariable UUID build,@RequestParam(defaultValue="false") boolean includeCreatures,@RequestParam(required=false) Integer minY,@RequestParam(required=false) Integer maxY)throws java.io.IOException{
        if(minY!=null||maxY!=null)ConstructionSceneRanges.validate(minY,maxY);
        var file=minY==null?rendering.export(server,id,revision,build,includeCreatures):rendering.exportRange(server,id,revision,build,minY,maxY,includeCreatures);
        var name=rendering.projectName(server,id).replaceAll("[\\p{Cntrl}\\\\/:*?\"<>|]","_")+"-阶段"+revision+(minY==null?"":"-Y"+minY+"至"+maxY)+".glb";
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.parseMediaType("model/gltf-binary"))
            .header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.attachment().filename(name,java.nio.charset.StandardCharsets.UTF_8).build().toString())
            .contentLength(java.nio.file.Files.size(file)).body(new FileSystemResource(file));
    }
}
