package org.mcmanager.archive;

import db.migration.V28__daily_backup_schedule;
import java.sql.DriverManager;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.flywaydb.core.api.migration.Context;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class DailyBackupMigrationTest {
    @Test void existingSchedulesKeepTheirNextRunAndProtectionSettings() throws Exception {
        try(var connection=DriverManager.getConnection("jdbc:h2:mem:migration_"+UUID.randomUUID()+";MODE=PostgreSQL", "sa", "")) {
            try(var sql=connection.createStatement()) {
                sql.execute("CREATE TABLE backup_policies(server_id UUID PRIMARY KEY,next_run_at TIMESTAMP WITH TIME ZONE,interval_minutes INT,revision BIGINT,enabled BOOLEAN,retention_enabled BOOLEAN,keep_count INT)");
                sql.execute("INSERT INTO backup_policies VALUES('00000000-0000-0000-0000-000000000001','2026-11-08 19:30:23+00',60,4,true,true,7),('00000000-0000-0000-0000-000000000002',null,180,2,false,false,12)");
            }
            Context context=mock(Context.class);when(context.getConnection()).thenReturn(connection);
            new V28__daily_backup_schedule().migrate(context);
            try(var sql=connection.createStatement();var rows=sql.executeQuery("SELECT * FROM backup_policies ORDER BY server_id")) {
                assertThat(rows.next()).isTrue();assertThat(rows.getString("daily_time")).isEqualTo("03:30");
                assertThat(rows.getObject("next_run_at",OffsetDateTime.class).toInstant()).isEqualTo(OffsetDateTime.parse("2026-11-08T19:30:23Z").toInstant());
                assertThat(rows.getInt("interval_minutes")).isEqualTo(1440);assertThat(rows.getLong("revision")).isEqualTo(5);
                assertThat(rows.getBoolean("enabled")).isTrue();assertThat(rows.getBoolean("retention_enabled")).isTrue();assertThat(rows.getInt("keep_count")).isEqualTo(7);
                assertThat(rows.next()).isTrue();assertThat(rows.getString("daily_time")).isEqualTo("03:00");assertThat(rows.getObject("next_run_at")).isNull();
                assertThat(rows.getLong("revision")).isEqualTo(3);assertThat(rows.getBoolean("enabled")).isFalse();assertThat(rows.getBoolean("retention_enabled")).isFalse();assertThat(rows.getInt("keep_count")).isEqualTo(12);
            }
        }
    }
}
