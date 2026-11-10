package org.mcmanager.archive;

import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.nio.file.Path;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Stream one baked model at a time; never materialize the full scene on an HTTP request. */
final class ConstructionSceneRanges {
    record Bounds(int minY,int maxY,int surfaceY) {}
    static void validate(Integer minY,Integer maxY) {
        if(minY==null||maxY==null||minY < -2048||maxY>4095||minY>maxY)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"请填写有效的最低和最高高度（-2048 至 4095）");
    }
    static double[] vertical(JsonNode model) {
        double min=Double.POSITIVE_INFINITY,max=Double.NEGATIVE_INFINITY,y=model.path("y").asDouble();
        for(var face:model.path("faces")) {var points=face.path("points");for(int i=1;i<points.size();i+=3){double value=y+points.get(i).asDouble()/16;min=Math.min(min,value);max=Math.max(max,value);}}
        return new double[]{min,max};
    }
    static boolean intersects(JsonNode model,int minY,int maxY) {
        var bounds=vertical(model);
        return bounds[1]>=minY && bounds[0]<maxY+1d;
    }
    static Bounds bounds(ObjectMapper json,Path source)throws IOException {
        double min=Double.POSITIVE_INFINITY,max=Double.NEGATIVE_INFINITY;var columns=new HashMap<Long,Integer>();
        try(var parser=json.getFactory().createParser(source.toFile())) {
            while(parser.nextToken()!=null) if(parser.currentToken()==JsonToken.FIELD_NAME&&parser.currentName().equals("models")) {
                parser.nextToken();while(parser.nextToken()!=JsonToken.END_ARRAY) {
                    JsonNode model=json.readTree(parser);var span=vertical(model);min=Math.min(min,span[0]);max=Math.max(max,span[1]);
                    if(!model.path("entity").asBoolean()&&Double.isFinite(span[0])) {
                        int x=(int)Math.floor(model.path("x").asDouble()),z=(int)Math.floor(model.path("z").asDouble()),y=(int)Math.floor(model.path("y").asDouble());
                        columns.merge(((long)x<<32)^(z&0xffffffffL),y,Math::max);
                    }
                }
            } else if(parser.currentToken()==JsonToken.START_ARRAY) parser.skipChildren();
        }
        if(!Double.isFinite(min)||!Double.isFinite(max))return new Bounds(0,0,0);
        int low=Math.max(-2048,Math.min(4095,(int)Math.floor(min))),high=Math.max(low,Math.min(4095,(int)Math.ceil(max)-1));
        int surface=columns.values().stream().mapToInt(Integer::intValue).min().orElse(low);
        return new Bounds(low,high,Math.max(low,Math.min(high,surface)));
    }
    static void write(ObjectMapper json,Path source,OutputStream output,int minY,int maxY)throws IOException {
        validate(minY,maxY);
        try(var parser=json.getFactory().createParser(source.toFile());var generator=json.getFactory().createGenerator(output)) {
            if(parser.nextToken()!=JsonToken.START_OBJECT)throw new IOException("Invalid scene");generator.writeStartObject();
            while(parser.nextToken()!=JsonToken.END_OBJECT) {
                String field=parser.currentName();parser.nextToken();generator.writeFieldName(field);
                if(field.equals("models")) {
                    generator.writeStartArray();while(parser.nextToken()!=JsonToken.END_ARRAY){JsonNode model=json.readTree(parser);if(intersects(model,minY,maxY))generator.writeTree(model);}generator.writeEndArray();
                } else generator.copyCurrentStructure(parser);
            }
            generator.writeObjectFieldStart("heightRange");generator.writeNumberField("minY",minY);generator.writeNumberField("maxY",maxY);generator.writeEndObject();generator.writeEndObject();
        }
    }
}
