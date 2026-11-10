package org.mcmanager.archive;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayOutputStream;
import java.nio.file.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.assertj.core.api.Assertions.*;

class ConstructionSceneRangesTest {
    @TempDir Path directory;
    final ObjectMapper json=new ObjectMapper();
    @Test void filteringRetainsCrossingModelsAndMetadataWithoutUndergroundGeometry()throws Exception {
        var source=directory.resolve("scene.json");Files.writeString(source,"""
          {"format":1,"models":[
           {"x":0,"y":-64,"z":0,"faces":[{"points":[0,0,0,16,0,0,16,16,0,0,16,0]}]},
           {"x":0,"y":63,"z":0,"faces":[{"points":[0,0,0,16,0,0,16,32,0,0,32,0]}]},
           {"x":1,"y":70,"z":0,"faces":[{"points":[0,0,0,16,0,0,16,16,0,0,16,0]}]},
           {"x":2,"y":80,"z":0,"entity":true,"faces":[{"points":[0,0,0,16,0,0,16,32,0,0,32,0]}]}
          ],"animations":{"sample":{"frames":[0,1]}},"issues":["test issue"],"exportTextures":{"a":"b"}}
          """);
        var bounds=ConstructionSceneRanges.bounds(json,source);assertThat(bounds.minY()).isEqualTo(-64);assertThat(bounds.maxY()).isEqualTo(81);assertThat(bounds.surfaceY()).isEqualTo(63);
        var out=new ByteArrayOutputStream();ConstructionSceneRanges.write(json,source,out,64,70);var filtered=json.readTree(out.toByteArray());
        assertThat(filtered.path("models")).hasSize(2);assertThat(filtered.path("models").get(0).path("y").asInt()).isEqualTo(63);
        assertThat(filtered.path("animations").path("sample").path("frames")).hasSize(2);assertThat(filtered.path("issues").get(0).asText()).isEqualTo("test issue");assertThat(filtered.path("exportTextures").path("a").asText()).isEqualTo("b");
        assertThat(Files.readString(source)).contains("-64");
        assertThatThrownBy(()->ConstructionSceneRanges.validate(70,64)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThatThrownBy(()->ConstructionSceneRanges.validate(null,64)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThatThrownBy(()->ConstructionSceneRanges.validate(-2049,64)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
    }
}
