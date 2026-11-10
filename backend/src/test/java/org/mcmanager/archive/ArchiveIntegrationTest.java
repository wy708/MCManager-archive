package org.mcmanager.archive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.test.context.support.WithAnonymousUser;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.web.servlet.MockMvc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestBuilders.formLogin;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:archive_test;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "mcmanager.admin-password=test-admin-password-2026"
})
@AutoConfigureMockMvc
@WithMockUser(roles = "ADMIN")
class ArchiveIntegrationTest {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach void clear() { jdbc.update("DELETE FROM server_archives"); }

    private String create(String name, String date) throws Exception {
        String request = json.writeValueAsString(java.util.Map.of("name", name, "description", "服务器介绍", "startDate", date));
        String response = mvc.perform(post("/api/servers").with(csrf()).contentType("application/json").content(request))
                .andExpect(status().isCreated()).andExpect(header().exists("Location"))
                .andReturn().getResponse().getContentAsString();
        return json.readTree(response).get("id").asText();
    }

    @Test @WithAnonymousUser
    void managementRequiresLoginButHealthIsPublic() throws Exception {
        mvc.perform(get("/api/servers")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/auth/me")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/health")).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("UP"));
    }

    @Test void mutationsRequireCsrfEvenForAnAdmin() throws Exception {
        mvc.perform(post("/api/servers").contentType("application/json")
                .content("{\"name\":\"abc\",\"description\":\"\",\"startDate\":\"2026-10-01\"}"))
                .andExpect(status().isForbidden());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM server_archives", Integer.class)).isZero();
    }

    @Test void identityDoesNotDependOnNameAndCreateIsPersisted() throws Exception {
        String first = create("  同名世界  ", "2026-10-01");
        String second = create("同名世界", "2026-10-02");
        assertThat(first).isNotEqualTo(second);
        mvc.perform(get("/api/servers/" + first)).andExpect(status().isOk())
                .andExpect(jsonPath("$.name").value("同名世界")).andExpect(jsonPath("$.status").value("RECORDING"))
                .andExpect(jsonPath("$.endDate").isEmpty());
        mvc.perform(get("/api/servers")).andExpect(jsonPath("$.length()").value(2));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM server_archives", Integer.class)).isEqualTo(2);
    }

    @Test void editKeepsStableIdentityAndArchiveRetainsItInAllServers() throws Exception {
        String id = create("旧名", "2026-10-01");
        mvc.perform(put("/api/servers/" + id).with(csrf()).contentType("application/json")
                .content("{\"name\":\"新名\",\"description\":\"珍藏\",\"startDate\":\"2026-09-30\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(id)).andExpect(jsonPath("$.name").value("新名"));
        mvc.perform(post("/api/servers/" + id + "/archive").with(csrf()).contentType("application/json").content("{\"endDate\":\"2026-10-26\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ARCHIVED")).andExpect(jsonPath("$.endDate").value("2026-10-26"));
        mvc.perform(get("/api/servers")).andExpect(jsonPath("$[0].id").value(id)).andExpect(jsonPath("$[0].status").value("ARCHIVED"));
        mvc.perform(delete("/api/servers/" + id).with(csrf())).andExpect(status().isMethodNotAllowed());
    }

    @Test void badSealDateAndRepeatedArchiveDoNotOverwriteHistory() throws Exception {
        String id = create("测试世界", "2026-10-01");
        mvc.perform(post("/api/servers/" + id + "/archive").with(csrf()).contentType("application/json").content("{\"endDate\":\"2026-09-01\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/servers/" + id + "/archive").with(csrf()).contentType("application/json").content("{\"endDate\":\"2026-10-15\"}"))
                .andExpect(status().isOk());
        mvc.perform(post("/api/servers/" + id + "/archive").with(csrf()).contentType("application/json").content("{\"endDate\":\"2026-10-26\"}"))
                .andExpect(status().isConflict());
        mvc.perform(put("/api/servers/" + id).with(csrf()).contentType("application/json")
                .content("{\"name\":\"新名\",\"description\":\"\",\"startDate\":\"2026-10-20\"}"))
                .andExpect(status().isConflict());
        mvc.perform(get("/api/servers/" + id)).andExpect(jsonPath("$.endDate").value("2026-10-15"))
                .andExpect(jsonPath("$.startDate").value("2026-10-01"));
    }

    @Test void invalidFieldsAndUnknownIdsAreHandled() throws Exception {
        for (String request : new String[]{"{}", "{\"name\":\"  \",\"description\":\"\",\"startDate\":\"2026-10-01\"}",
                "{\"name\":\"a\",\"description\":\"\",\"startDate\":\"2026-02-30\"}",
                json.writeValueAsString(java.util.Map.of("name", "x".repeat(81), "description", "", "startDate", "2026-10-01")),
                json.writeValueAsString(java.util.Map.of("name", "x", "description", "x".repeat(2001), "startDate", "2026-10-01"))}) {
            mvc.perform(post("/api/servers").with(csrf()).contentType("application/json").content(request))
                    .andExpect(status().isBadRequest()).andExpect(jsonPath("$.message").exists());
        }
        mvc.perform(get("/api/servers/not-a-uuid")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/servers/" + java.util.UUID.randomUUID())).andExpect(status().isNotFound());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM server_archives", Integer.class)).isZero();
    }

    @Test @WithAnonymousUser
    void actualLoginCsrfAndLogoutLifecycle() throws Exception {
        org.springframework.security.test.context.TestSecurityContextHolder.clearContext();
        mvc.perform(formLogin("/api/auth/login").user("admin").password("wrong-password"))
                .andExpect(status().isUnauthorized());
        var result = mvc.perform(formLogin("/api/auth/login").user("admin").password("test-admin-password-2026"))
                .andExpect(status().isNoContent()).andReturn();
        MockHttpSession session = (MockHttpSession) result.getRequest().getSession(false);
        mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isOk()).andExpect(jsonPath("$.username").value("admin"));
        JsonNode csrfResponse = json.readTree(mvc.perform(get("/api/auth/csrf").session(session))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        mvc.perform(post("/api/auth/logout").session(session).header(csrfResponse.get("headerName").asText(), csrfResponse.get("token").asText()))
                .andExpect(status().isNoContent());
        assertThat(session.isInvalid()).isTrue();
        mvc.perform(get("/api/servers")).andExpect(status().isUnauthorized());
    }
}
