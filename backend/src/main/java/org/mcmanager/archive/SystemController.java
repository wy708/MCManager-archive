package org.mcmanager.archive;

import java.security.Principal;
import java.util.Map;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class SystemController {
    @GetMapping("/api/health")
    Map<String, String> health() { return Map.of("status", "UP"); }

    @GetMapping("/api/auth/csrf")
    Map<String, String> csrf(CsrfToken token) {
        return Map.of("headerName", token.getHeaderName(), "token", token.getToken());
    }

    @GetMapping("/api/auth/me")
    Map<String, String> me(org.springframework.security.core.Authentication principal) { return Map.of("username", principal.getName(),"role",principal.getAuthorities().stream().anyMatch(a->a.getAuthority().equals("ROLE_ADMIN"))?"ADMIN":"VIEWER"); }
}
