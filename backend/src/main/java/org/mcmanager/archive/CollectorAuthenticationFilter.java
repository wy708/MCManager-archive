package org.mcmanager.archive;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.server.ResponseStatusException;

final class CollectorAuthenticationFilter extends OncePerRequestFilter {
    private final CollectorCredentials credentials;
    CollectorAuthenticationFilter(CollectorCredentials credentials) { this.credentials = credentials; }
    // Stateless long polls are dispatched again when their result is ready.
    // Authenticate that dispatch too; never turn a revoked credential into a cached permission.
    @Override protected boolean shouldNotFilterAsyncDispatch() { return false; }
    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws IOException, ServletException {
        try {
            var identity = credentials.authenticate(request.getHeader("Authorization"));
            var context = SecurityContextHolder.createEmptyContext();
            context.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(identity, null, List.of(new SimpleGrantedAuthority("ROLE_COLLECTOR"))));
            SecurityContextHolder.setContext(context);
        } catch (ResponseStatusException ex) {
            response.setStatus(401);
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write("{\"message\":\"采集凭据无效或已撤销\"}");
            return;
        }
        chain.doFilter(request, response);
    }
}
