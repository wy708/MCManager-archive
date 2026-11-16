package db.migration;

import org.flywaydb.core.api.migration.BaseJavaMigration;
import org.flywaydb.core.api.migration.Context;

/** Exact read indexes; no new aggregation work in the telemetry transaction. */
public class V32__Statistics_read_indexes extends BaseJavaMigration {
    @Override public void migrate(Context context) throws Exception {
        try (var statement = context.getConnection().createStatement()) {
            statement.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_population ON telemetry_events(player_key,server_id,occurred_at,dimension)");
            if (context.getConnection().getMetaData().getDatabaseProductName().equals("PostgreSQL")) {
                // Only building events pay for this covering index. Existing
                // deployments can create it CONCURRENTLY before upgrading.
                statement.execute("CREATE INDEX IF NOT EXISTS idx_activity_building_read ON activity_feed(server_id,occurred_at) INCLUDE (metric,dimension,block_x,block_y,block_z,event_value) WHERE metric IN ('blocks.placed','blocks.mined')");
            } else {
                statement.execute("CREATE INDEX IF NOT EXISTS idx_activity_building_read ON activity_feed(server_id,metric,occurred_at)");
            }
        }
    }
}
