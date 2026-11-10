package org.mcmanager.archive;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.*;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
class ConstructionModelController {
    private final ConstructionModels models;private final ObjectMapper json;
    ConstructionModelController(ConstructionModels models,ObjectMapper json){this.models=models;this.json=json;}
    @PostMapping("/api/ingest/v1/project-models/plan")
    List<ConstructionModels.Plan> plan(@AuthenticationPrincipal CollectorCredentials.Identity identity,@RequestBody ConstructionModels.Boot boot){return models.plan(identity,boot);}
    @PostMapping("/api/ingest/v1/project-models/capture")
    Map<String,Boolean> capture(@AuthenticationPrincipal CollectorCredentials.Identity identity,HttpServletRequest request) throws IOException {
        byte[] body=request.getInputStream().readNBytes(1_048_577);
        if(body.length>1_048_576)throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,"模型分段超过大小限制");
        ConstructionModels.Capture capture;
        try{capture=json.readValue(body,ConstructionModels.Capture.class);}catch(IOException e){throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"模型格式无效");}
        return models.capture(identity,capture);
    }
    @GetMapping("/api/public/projects/{id}/phases/{revision}/model/status")
    ResponseEntity<ConstructionModels.Status> status(@PathVariable UUID id,@PathVariable int revision){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(models.status(id,revision));}
    @GetMapping("/api/public/projects/{id}/phases/{revision}/model")
    ResponseEntity<ConstructionModels.Page> page(@PathVariable UUID id,@PathVariable int revision,@RequestParam(required=false) String after,@RequestParam(defaultValue="-2048") int minY,@RequestParam(defaultValue="4095") int maxY){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(models.page(id,revision,after,minY,maxY));}
}
