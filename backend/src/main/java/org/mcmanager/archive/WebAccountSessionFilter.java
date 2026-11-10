package org.mcmanager.archive;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;
final class WebAccountSessionFilter extends OncePerRequestFilter {
    private final WebAccounts accounts;
    WebAccountSessionFilter(WebAccounts accounts){this.accounts=accounts;}
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain)throws ServletException,IOException{
        var auth=SecurityContextHolder.getContext().getAuthentication();
        if(auth!=null&&auth.getPrincipal() instanceof WebAccounts.Principal principal&&!accounts.valid(principal)){
            var session=request.getSession(false);if(session!=null)session.invalidate();SecurityContextHolder.clearContext();
        }
        chain.doFilter(request,response);
    }
}
