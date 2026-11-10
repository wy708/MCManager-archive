package org.mcmanager.archive;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.authentication.session.NullAuthenticatedSessionStrategy;
import org.springframework.security.web.context.NullSecurityContextRepository;

@Configuration
class SecurityConfig {
    @Bean
    @Order(1)
    SecurityFilterChain collectorSecurity(HttpSecurity http, CollectorCredentials credentials) throws Exception {
        http.securityMatcher("/api/ingest/**")
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS)
                        .sessionAuthenticationStrategy(new NullAuthenticatedSessionStrategy()))
                .securityContext(context -> context.securityContextRepository(new NullSecurityContextRepository()))
                .requestCache(cache -> cache.disable())
                .authorizeHttpRequests(auth -> auth.anyRequest().hasRole("COLLECTOR"))
                .exceptionHandling(errors -> errors.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)))
                .addFilterBefore(new CollectorAuthenticationFilter(credentials), UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }

    @Bean
    @Order(2)
    SecurityFilterChain agentSecurity(HttpSecurity http, AgentCredentials credentials) throws Exception {
        http.securityMatcher("/api/agent/**")
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS)
                        .sessionAuthenticationStrategy(new NullAuthenticatedSessionStrategy()))
                .securityContext(context -> context.securityContextRepository(new NullSecurityContextRepository()))
                .requestCache(cache -> cache.disable())
                .authorizeHttpRequests(auth -> auth.anyRequest().hasRole("AGENT"))
                .exceptionHandling(errors -> errors.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)))
                .addFilterBefore(new AgentAuthenticationFilter(credentials), UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }
    @Bean
    @Order(3)
    SecurityFilterChain hostSecurity(HttpSecurity http, BackupHosts hosts) throws Exception {
        http.securityMatcher("/api/host/**")
                .csrf(csrf -> csrf.disable())
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS)
                        .sessionAuthenticationStrategy(new NullAuthenticatedSessionStrategy()))
                .securityContext(context -> context.securityContextRepository(new NullSecurityContextRepository()))
                .requestCache(cache -> cache.disable())
                .authorizeHttpRequests(auth -> auth.anyRequest().hasRole("BACKUP_HOST"))
                .exceptionHandling(errors -> errors.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)))
                .addFilterBefore(new HostAuthenticationFilter(hosts), UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }
    @Bean
    @Order(4)
    SecurityFilterChain security(HttpSecurity http,WebAccounts accounts) throws Exception {
        http.authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/health", "/api/auth/csrf", "/error").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/world-maps/*/view/**", "/api/public/projects/**").permitAll()
                .requestMatchers("/api/auth/me", "/api/auth/password").hasAnyRole("ADMIN","VIEWER")
                .requestMatchers(HttpMethod.GET,"/api/servers","/api/servers/*","/api/metrics","/api/statistics/**","/api/players","/api/players/*","/api/deaths","/api/sessions","/api/collectors","/api/activity","/api/activity/sessions/*/chat","/api/world-maps","/api/servers/*/projects","/api/servers/*/runtime","/api/servers/*/daily-report","/api/backups/summary").hasAnyRole("ADMIN","VIEWER")
                .anyRequest().hasRole("ADMIN"));
        http.addFilterBefore(new WebAccountSessionFilter(accounts),org.springframework.security.web.access.intercept.AuthorizationFilter.class);
        http.exceptionHandling(errors -> errors.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)));
        http.formLogin(login -> login.loginProcessingUrl("/api/auth/login")
                .successHandler((req, res, auth) -> res.setStatus(204))
                .failureHandler((req, res, ex) -> res.setStatus(401)).permitAll());
        http.logout(logout -> logout.logoutUrl("/api/auth/logout")
                .logoutSuccessHandler((req, res, auth) -> res.setStatus(204)));
        http.requestCache(cache -> cache.disable());
        return http.build();
    }
}
