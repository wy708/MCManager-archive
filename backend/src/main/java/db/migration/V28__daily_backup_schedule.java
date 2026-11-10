package db.migration;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import org.flywaydb.core.api.migration.BaseJavaMigration;
import org.flywaydb.core.api.migration.Context;

/** Preserve the existing next run; subsequent slots use its UTC+8 wall-clock time. */
public class V28__daily_backup_schedule extends BaseJavaMigration {
    @Override public void migrate(Context context) throws Exception {
        var connection=context.getConnection();
        try(var statement=connection.createStatement()) { statement.execute("ALTER TABLE backup_policies ADD COLUMN daily_time VARCHAR(5)"); }
        try(var query=connection.prepareStatement("SELECT server_id,next_run_at FROM backup_policies");var rows=query.executeQuery();
            var update=connection.prepareStatement("UPDATE backup_policies SET daily_time=?,interval_minutes=1440,revision=revision+1 WHERE server_id=?")) {
            while(rows.next()) {
                OffsetDateTime next=rows.getObject("next_run_at",OffsetDateTime.class);
                String time=next==null?"03:00":next.withOffsetSameInstant(ZoneOffset.ofHours(8)).toLocalTime().withSecond(0).withNano(0).toString();
                update.setString(1,time);update.setObject(2,rows.getObject("server_id"));update.executeUpdate();
            }
        }
    }
}
