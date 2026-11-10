package org.mcmanager.archive;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestBuilders.formLogin;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:web_accounts;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1","mcmanager.admin-password=test-admin-password-2026"})
@AutoConfigureMockMvc
class WebAccountsTest {
    @Autowired WebAccounts accounts;@Autowired MockMvc mvc;@Autowired JdbcTemplate jdbc;@Autowired ObjectMapper json;@Autowired PlatformTransactionManager manager;
    static final String OLD="start-password-2026",NEW="changed-password-2026";
    WebAccounts.Account create(String role){return accounts.create(new WebAccounts.Create("test-"+UUID.randomUUID().toString().substring(0,20),OLD,role));}
    MockHttpSession login(String name,String password)throws Exception{return (MockHttpSession)mvc.perform(formLogin("/api/auth/login").user(name).password(password)).andExpect(status().isNoContent()).andReturn().getRequest().getSession(false);}
    String password(String old,String next)throws Exception{return json.writeValueAsString(new WebAccounts.Password(old,next));}
    @Test void adminOnlyCreationCsrfValidationAndNoPasswordLeak()throws Exception{
        var request=json.writeValueAsString(new WebAccounts.Create("created-user",OLD,"VIEWER"));
        mvc.perform(post("/api/admin/accounts").with(csrf()).contentType("application/json").content(request)).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/admin/accounts").with(user("reader").roles("VIEWER")).with(csrf()).contentType("application/json").content(request)).andExpect(status().isForbidden());
        mvc.perform(post("/api/admin/accounts").with(user("admin").roles("ADMIN")).contentType("application/json").content(request)).andExpect(status().isForbidden());
        mvc.perform(post("/api/admin/accounts").with(user("admin").roles("ADMIN")).with(csrf()).contentType("application/json").content(request)).andExpect(status().isCreated()).andExpect(jsonPath("$.role").value("VIEWER")).andExpect(jsonPath("$.password").doesNotExist()).andExpect(jsonPath("$.password_hash").doesNotExist());
        mvc.perform(post("/api/admin/accounts").with(user("admin").roles("ADMIN")).with(csrf()).contentType("application/json").content(request.replace("created-user","CREATED-USER"))).andExpect(status().isConflict());
        for(var body:List.of(new WebAccounts.Create("bad name",OLD,"ADMIN"),new WebAccounts.Create("good-name","short","ADMIN"),new WebAccounts.Create("good-name","汉".repeat(25),"ADMIN"),new WebAccounts.Create("good-name",OLD,"SUPERADMIN")))
            mvc.perform(post("/api/admin/accounts").with(user("admin").roles("ADMIN")).with(csrf()).contentType("application/json").content(json.writeValueAsString(body))).andExpect(status().isBadRequest());
        mvc.perform(post("/api/auth/register").with(csrf()).contentType("application/json").content(request)).andExpect(status().isUnauthorized());
        var stored=jdbc.queryForObject("SELECT password_hash FROM web_accounts WHERE username='created-user'",String.class);assertThat(stored).startsWith("{bcrypt}$2").doesNotContain(OLD);
    }
    @Test void realViewerCanReadButCannotReachCredentialsExportsOrWrites()throws Exception{
        var a=create("VIEWER");var session=login(a.username().toUpperCase(Locale.ROOT),OLD);
        mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isOk()).andExpect(jsonPath("$.role").value("VIEWER"));
        for(var path:List.of("/api/servers","/api/collectors","/api/players","/api/metrics","/api/world-maps","/api/statistics/summary","/api/backups/summary"))mvc.perform(get(path).session(session)).andExpect(status().isOk());
        String id=UUID.randomUUID().toString();
        for(var path:List.of("/api/admin/accounts","/api/agents","/api/backups","/api/backups/"+id+"/content","/api/servers/"+id+"/collector-credential","/api/servers/"+id+"/console","/api/servers/"+id+"/projects/"+id+"/phases/1/scene-export/status"))mvc.perform(get(path).session(session)).andExpect(status().isForbidden());
        mvc.perform(post("/api/servers").session(session).with(csrf()).contentType("application/json").content("{}")).andExpect(status().isForbidden());
    }
    @Test void passwordChangeRejectsWrongPasswordAndInvalidatesEveryOldSession()throws Exception{
        var a=create("VIEWER");var first=login(a.username(),OLD);var other=login(a.username(),OLD);
        mvc.perform(post("/api/auth/password").session(first).contentType("application/json").content(password(OLD,NEW))).andExpect(status().isForbidden());
        mvc.perform(post("/api/auth/password").session(first).with(csrf()).contentType("application/json").content(password("wrong-password",NEW))).andExpect(status().isBadRequest());
        mvc.perform(post("/api/auth/password").session(first).with(csrf()).contentType("application/json").content(password(OLD,OLD))).andExpect(status().isBadRequest());
        mvc.perform(post("/api/auth/password").session(first).with(csrf()).contentType("application/json").content(password(OLD,NEW))).andExpect(status().isNoContent());assertThat(first.isInvalid()).isTrue();
        mvc.perform(get("/api/auth/me").session(other)).andExpect(status().isUnauthorized());assertThat(other.isInvalid()).isTrue();
        mvc.perform(formLogin("/api/auth/login").user(a.username()).password(OLD)).andExpect(status().isUnauthorized());login(a.username(),NEW);
        // Deployment values are bootstrap-only, never a reset or a second administrator backdoor.
        var restarted=new WebAccounts(jdbc,manager,"different-admin",OLD);assertThat(restarted.list()).noneMatch(row->row.username().equals("different-admin"));
        assertThat(new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder().matches(NEW,restarted.loadUserByUsername(a.username()).getPassword().substring(8))).isTrue();
    }
    @Test void disablingAccountRevokesSessionsAndDoesNotRestoreThemOnReenable()throws Exception{
        var a=create("VIEWER");var session=login(a.username(),OLD);var admin=login("admin","test-admin-password-2026");
        mvc.perform(put("/api/admin/accounts/"+a.id()+"/enabled").session(admin).with(csrf()).contentType("application/json").content("{\"enabled\":false}")).andExpect(status().isNoContent());
        mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isUnauthorized());mvc.perform(formLogin("/api/auth/login").user(a.username()).password(OLD)).andExpect(status().isUnauthorized());
        mvc.perform(put("/api/admin/accounts/"+a.id()+"/enabled").session(admin).with(csrf()).contentType("application/json").content("{\"enabled\":true}")).andExpect(status().isNoContent());login(a.username(),OLD);
        var main=accounts.list().stream().filter(u->u.username().equals("admin")).findFirst().orElseThrow();
        mvc.perform(put("/api/admin/accounts/"+main.id()+"/enabled").session(admin).with(csrf()).contentType("application/json").content("{\"enabled\":false}")).andExpect(status().isBadRequest());
        assertThatThrownBy(()->accounts.enabled(UUID.randomUUID(),main.id(),false)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
    }
    @Test void repeatedPasswordGuessingIsBounded()throws Exception{
        var a=create("VIEWER");var session=login(a.username(),OLD);
        for(int n=0;n<5;n++)mvc.perform(post("/api/auth/password").session(session).with(csrf()).contentType("application/json").content(password("wrong-password",NEW))).andExpect(status().isBadRequest());
        mvc.perform(post("/api/auth/password").session(session).with(csrf()).contentType("application/json").content(password(OLD,NEW))).andExpect(status().isTooManyRequests());
    }
}
