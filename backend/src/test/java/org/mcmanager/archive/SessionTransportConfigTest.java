package org.mcmanager.archive;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class SessionTransportConfigTest {
    @Test void publicHttpsOriginRequiresSecureCookies() {
        assertThat(SessionTransportConfig.isHttpsOrigin(" https://example.test:443/ ")).isTrue();
        assertThat(SessionTransportConfig.isHttpsOrigin("HTTPS://[::1]:8443")).isTrue();
        assertThat(SessionTransportConfig.isHttpsOrigin("http://127.0.0.1:8088")).isFalse();
        assertThat(SessionTransportConfig.isHttpsOrigin("")).isFalse();
    }

    @Test void rejectsCredentialsAndNonOriginUrls() {
        for (String origin : new String[]{"example.test", "ftp://example.test", "https://",
                "https://admin:secret@example.test", "https://example.test/site", "https://example.test?token=secret",
                "https://example.test/#fragment", "https://example.test:0", "https://example.test:65536"}) {
            assertThatIllegalArgumentException().isThrownBy(() -> SessionTransportConfig.isHttpsOrigin(origin))
                    .withMessageContaining("MCM_PUBLIC_BASE_URL").withMessageNotContaining("secret");
        }
    }
}
