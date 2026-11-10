package org.mcmanager.archive;

import java.time.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.security.test.context.support.WithAnonymousUser;
import org.springframework.test.web.servlet.MockMvc;
import com.fasterxml.jackson.databind.ObjectMapper;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:console_test;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1","mcmanager.admin-password=test-admin-password-2026"})
@AutoConfigureMockMvc @WithMockUser(roles="ADMIN")
class ServerConsoleIntegrationTest {
    @Autowired ServerConsoles consoles;@Autowired BackupHosts hosts;@Autowired ArchiveRepository archives;
    @Autowired JdbcTemplate jdbc;@Autowired MockMvc mvc;@Autowired ObjectMapper json;
    record Owner(UUID server,BackupHosts.Issued issued,BackupHosts.Identity identity,UUID run){}
    Owner owner(){var server=archives.create("控制台协议测试","isolated protocol fixture",LocalDate.now()).id();var issued=hosts.create(server,"控制台");return new Owner(server,issued,hosts.authenticate("Bearer "+issued.token()),UUID.randomUUID());}
    ServerConsoleController.Sync sync(Owner o,String state){return new ServerConsoleController.Sync(o.run(),state,null,List.of(),null);}
    ServerConsoleController.Request request(Owner o,String action,String text){return new ServerConsoleController.Request(UUID.randomUUID(),o.issued().host().id(),o.run(),action,text);}
    @Test void exactServerRunAndCredentialAreRequired(){
        var a=owner();var b=owner();consoles.sync(a.identity(),sync(a,"RUNNING"));var command=request(a,"COMMAND","list");
        assertThatThrownBy(()->consoles.enqueue(b.server(),command,"admin")).hasMessageContaining("不属于");
        assertThatThrownBy(()->consoles.enqueue(a.server(),new ServerConsoleController.Request(command.requestId(),command.hostId(),UUID.randomUUID(),"COMMAND","list"),"admin")).hasMessageContaining("重新连接");
        assertThatThrownBy(()->consoles.sync(a.identity(),new ServerConsoleController.Sync(UUID.randomUUID(),"STOPPED",null,List.of(),null))).hasMessageContaining("已有控制台");
        hosts.revoke(a.issued().host().id());assertThatThrownBy(()->consoles.sync(a.identity(),sync(a,"RUNNING"))).hasMessageContaining("凭据无效");assertThat(consoles.view(a.server(),0).online()).isFalse();
    }
    @Test void requestRetryNeverExecutesTwiceAndLateReceiptIsAccepted(){
        var o=owner();consoles.sync(o.identity(),sync(o,"RUNNING"));var request=request(o,"COMMAND","list");
        var job=consoles.enqueue(o.server(),request,"admin");assertThat(consoles.enqueue(o.server(),request,"admin").id()).isEqualTo(job.id());
        assertThat(consoles.sync(o.identity(),sync(o,"RUNNING")).command().id()).isEqualTo(job.id());
        assertThat(consoles.sync(o.identity(),sync(o,"RUNNING")).command()).isNull();
        assertThatThrownBy(()->consoles.enqueue(o.server(),request(o,"COMMAND","list"),"admin")).hasMessageContaining("前一个");
        jdbc.update("UPDATE server_console_commands SET delivered_at=? WHERE id=?",OffsetDateTime.now().minusMinutes(4),job.id());
        assertThat(consoles.view(o.server(),0).commands().getFirst().status()).isEqualTo("UNCERTAIN");
        var receipt=new ServerConsoleController.Receipt(job.id(),"SUBMITTED","已发送");
        consoles.sync(o.identity(),new ServerConsoleController.Sync(o.run(),"RUNNING",123L,List.of(),receipt));
        consoles.sync(o.identity(),new ServerConsoleController.Sync(o.run(),"RUNNING",123L,List.of(),receipt));
        assertThat(consoles.view(o.server(),0).commands().getFirst().status()).isEqualTo("SUBMITTED");
    }
    @Test void disconnectedQueueExpiresAndOldSessionCannotReplay(){
        var o=owner();consoles.sync(o.identity(),sync(o,"RUNNING"));var job=consoles.enqueue(o.server(),request(o,"COMMAND","list"),"admin");
        jdbc.update("UPDATE server_console_commands SET created_at=? WHERE id=?",OffsetDateTime.now().minusMinutes(1),job.id());
        assertThat(consoles.sync(o.identity(),sync(o,"RUNNING")).command()).isNull();assertThat(consoles.view(o.server(),0).commands().getFirst().status()).isEqualTo("EXPIRED");
        var second=consoles.enqueue(o.server(),request(o,"COMMAND","list"),"admin");consoles.sync(o.identity(),sync(o,"RUNNING"));
        jdbc.update("UPDATE server_consoles SET heartbeat_at=? WHERE host_id=?",OffsetDateTime.now().minusMinutes(1),o.issued().host().id());
        consoles.sync(o.identity(),new ServerConsoleController.Sync(UUID.randomUUID(),"STOPPED",null,List.of(),null));
        assertThat(consoles.view(o.server(),0).commands().stream().filter(c->c.id().equals(second.id())).findFirst().orElseThrow().status()).isEqualTo("UNCERTAIN");
    }
    @Test void boundedLogsRedactedAndRetriesDoNotDuplicate(){
        var o=owner();var other=owner();var line=new ServerConsoleController.Line(1,Instant.now(),"token mcmhost.abc.def /upload/"+"a".repeat(64));
        var packet=new ServerConsoleController.Sync(o.run(),"RUNNING",123L,List.of(line),null);consoles.sync(o.identity(),packet);consoles.sync(o.identity(),packet);
        var view=consoles.view(o.server(),0);assertThat(view.lines()).hasSize(1);assertThat(view.lines().getFirst().line()).doesNotContain("abc.def","a".repeat(64));assertThat(consoles.view(other.server(),0).lines()).isEmpty();
        for(int batch=0;batch<21;batch++){List<ServerConsoleController.Line> entries=new ArrayList<>();for(int n=1;n<=100;n++)entries.add(new ServerConsoleController.Line(2+batch*100+n,Instant.now(),"line"));consoles.sync(o.identity(),new ServerConsoleController.Sync(o.run(),"RUNNING",123L,entries,null));}
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM server_console_logs WHERE host_id=?",Integer.class,o.issued().host().id())).isEqualTo(2000);
        view=consoles.view(o.server(),0);assertThat(view.lines()).hasSize(300);assertThat(view.truncated()).isTrue();assertThat(consoles.view(o.server(),Long.parseLong(view.cursor())).lines()).isEmpty();
    }
    @Test void rejectsMultilineReservedCommandsAndInvalidLifecycle(){
        var o=owner();consoles.sync(o.identity(),sync(o,"RUNNING"));
        for(String command:List.of("list\nstop","list\rstop","stop","/stop","save hold","archivebackup status"," list","\u001blist"))assertThatThrownBy(()->consoles.enqueue(o.server(),request(o,"COMMAND",command),"admin")).isInstanceOf(Exception.class);
        assertThatThrownBy(()->consoles.enqueue(o.server(),request(o,"START",""),"admin")).hasMessageContaining("当前状态");
        var job=consoles.enqueue(o.server(),request(o,"STOP",""),"admin");consoles.sync(o.identity(),sync(o,"STOPPING"));
        consoles.sync(o.identity(),new ServerConsoleController.Sync(o.run(),"STOPPED",null,List.of(),new ServerConsoleController.Receipt(job.id(),"SUCCEEDED","正常停止")));
        assertThat(consoles.enqueue(o.server(),request(o,"START",""),"admin").status()).isEqualTo("QUEUED");
    }
    @Test void adminWritesRequireCsrf()throws Exception{var o=owner();consoles.sync(o.identity(),sync(o,"RUNNING"));String body=json.writeValueAsString(request(o,"COMMAND","list"));mvc.perform(post("/api/servers/"+o.server()+"/console/commands").contentType("application/json").content(body)).andExpect(status().isForbidden());mvc.perform(post("/api/servers/"+o.server()+"/console/commands").with(csrf()).contentType("application/json").content(body)).andExpect(status().isOk());}
    @Test @WithAnonymousUser void consoleIsPrivateAndHostCannotUseAdminRoutes()throws Exception{var o=owner();String auth="Bearer "+o.issued().token();mvc.perform(get("/api/servers/"+o.server()+"/console")).andExpect(status().isUnauthorized());mvc.perform(get("/api/servers/"+o.server()+"/console").header("Authorization",auth)).andExpect(status().isUnauthorized());mvc.perform(post("/api/host/v1/console/sync").header("Authorization",auth).contentType("application/json").content(json.writeValueAsString(sync(o,"STOPPED")))).andExpect(status().isOk());}
}
