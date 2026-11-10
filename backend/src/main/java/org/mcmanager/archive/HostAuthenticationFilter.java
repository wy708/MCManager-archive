package org.mcmanager.archive;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.util.List;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.server.ResponseStatusException;

final class HostAuthenticationFilter extends OncePerRequestFilter {
    private final BackupHosts hosts;
    HostAuthenticationFilter(BackupHosts hosts) { this.hosts = hosts; }
    @Override protected boolean shouldNotFilterAsyncDispatch() { return false; }
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws IOException, ServletException {
        try {
            var identity = hosts.authenticate(request.getHeader("Authorization"));
            var context = SecurityContextHolder.createEmptyContext();
            context.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(identity, null, List.of(new SimpleGrantedAuthority("ROLE_BACKUP_HOST"))));
            SecurityContextHolder.setContext(context);
        } catch (ResponseStatusException ex) {
            response.setStatus(401); response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write("{\"message\":\"备份执行端凭据无效或已撤销\"}"); return;
        }
        chain.doFilter(request, response);
    }
}
