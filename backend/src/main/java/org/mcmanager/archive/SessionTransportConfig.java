package org.mcmanager.archive;

import java.net.URI;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.boot.web.servlet.server.AbstractServletWebServerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
class SessionTransportConfig {
    @Bean
    WebServerFactoryCustomizer<AbstractServletWebServerFactory> publicSessionCookies(
            @Value("${mcmanager.public-base-url:}") String publicBaseUrl) {
        boolean secure = isHttpsOrigin(publicBaseUrl);
        return factory -> {
            if (secure) factory.getSession().getCookie().setSecure(true);
        };
    }

    static boolean isHttpsOrigin(String value) {
        if (value.isBlank()) return false;
        URI uri;
        try { uri = URI.create(value.strip()); }
        catch (IllegalArgumentException ex) { throw invalidOrigin(); }
        boolean secure = "https".equalsIgnoreCase(uri.getScheme());
        if ((!secure && !"http".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null
                || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || (!uri.getRawPath().isEmpty() && !uri.getRawPath().equals("/"))
                || uri.getPort() == 0 || uri.getPort() > 65535) throw invalidOrigin();
        return secure;
    }

    private static IllegalArgumentException invalidOrigin() {
        return new IllegalArgumentException("MCM_PUBLIC_BASE_URL must be an HTTP or HTTPS origin without credentials, a path, a query, or a fragment");
    }
}
