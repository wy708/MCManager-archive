package org.mcmanager.archive;
import db.migration.V17__index_existing_world_observations;
import java.sql.DriverManager;
import org.flywaydb.core.api.migration.Context;
import org.junit.jupiter.api.Test;
import static org.mockito.Mockito.*;
import static org.assertj.core.api.Assertions.*;
class TerrainMigrationTest {
    @Test void previousRecordsAreIndexedWithoutInventingCoverageOrRefreshingTheirTimestamp() throws Exception {
        try(var c=DriverManager.getConnection("jdbc:h2:mem:terrain_backfill")) {
            c.createStatement().execute("CREATE TABLE world_state_cache(server_id VARCHAR,target_hash VARCHAR,data_json VARCHAR,target_kind VARCHAR,dimension VARCHAR,pos_x INTEGER,pos_y INTEGER,pos_z INTEGER)");
            var input=c.prepareStatement("INSERT INTO world_state_cache(server_id,target_hash,data_json) VALUES ('server',?,?)");
            input.setString(1,"block");input.setString(2,"{\"dimension\":\"minecraft:overworld\",\"x\":-1,\"y\":64,\"z\":2,\"block\":\"minecraft:chest\",\"container\":{}}");input.executeUpdate();
            input.setString(1,"player");input.setString(2,"{\"playerKey\":\"xuid:1\",\"dimension\":\"minecraft:overworld\",\"position\":{\"x\":1}}");input.executeUpdate();
            input.setString(1,"broken");input.setString(2,"not json");input.executeUpdate();
            var context=mock(Context.class);when(context.getConnection()).thenReturn(c);
            new V17__index_existing_world_observations().migrate(context);
            try(var r=c.createStatement().executeQuery("SELECT * FROM world_state_cache WHERE dimension IS NOT NULL")) {
                assertThat(r.next()).isTrue();assertThat(r.getString("target_kind")).isEqualTo("CONTAINER");assertThat(r.getInt("pos_x")).isEqualTo(-1);assertThat(r.next()).isFalse();
            }
        }
    }
}
