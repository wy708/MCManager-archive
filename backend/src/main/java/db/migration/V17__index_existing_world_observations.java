package db.migration;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.*;
import java.util.Set;
import org.flywaydb.core.api.migration.BaseJavaMigration;
import org.flywaydb.core.api.migration.Context;

/** Adds lookup coordinates to previously validated observations, preserving their time and body. */
public class V17__index_existing_world_observations extends BaseJavaMigration {
    @Override public void migrate(Context context) throws Exception {
        var connection=context.getConnection();var mapper=new ObjectMapper();
        try(var select=connection.prepareStatement("SELECT server_id,target_hash,data_json FROM world_state_cache WHERE dimension IS NULL");
            var update=connection.prepareStatement("UPDATE world_state_cache SET target_kind=?,dimension=?,pos_x=?,pos_y=?,pos_z=? WHERE server_id=? AND target_hash=?")) {
            select.setFetchSize(128);
            try(var rows=select.executeQuery()) {
                while(rows.next()) {
                    var text=rows.getString("data_json");
                    if(text==null || text.length()>65536) continue;
                    com.fasterxml.jackson.databind.JsonNode data;
                    try{data=mapper.readTree(text);}catch(java.io.IOException ignored){continue;}
                    if(data==null || !data.isObject() || data.has("playerKey"))continue;
                    var dimension=data.path("dimension").asText();
                    if(!Set.of("minecraft:overworld","minecraft:nether","minecraft:the_end").contains(dimension))continue;
                    boolean nearby=data.path("center").isObject() && data.path("blocks").isArray();
                    if(!nearby && !data.path("block").isTextual())continue;
                    var at=nearby?data.path("center"):data;
                    if(!at.path("x").isInt() || !at.path("y").isInt() || !at.path("z").isInt())continue;
                    int x=at.path("x").asInt(),y=at.path("y").asInt(),z=at.path("z").asInt();
                    if(Math.abs((long)x)>30000000 || Math.abs((long)z)>30000000 || y < -2048 || y>4095)continue;
                    update.setString(1,nearby?"NEARBY":data.has("container")?"CONTAINER":"BLOCK");
                    update.setString(2,dimension);update.setInt(3,x);update.setInt(4,y);update.setInt(5,z);
                    update.setObject(6,rows.getObject("server_id"));update.setString(7,rows.getString("target_hash"));update.executeUpdate();
                }
            }
        }
    }
}
