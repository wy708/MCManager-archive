package org.mcmanager.archive;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import static org.mcmanager.archive.TelemetryValidation.check;

@Service
@DependsOnDatabaseInitialization
class WebAccounts implements UserDetailsService {
    record Account(UUID id,String username,String role,boolean enabled,Instant createdAt,Instant updatedAt) {}
    record Create(String username,String password,String role) {}
    record Password(String currentPassword,String newPassword) {}
    static final class Principal extends User {
        final UUID id;final long version;
        Principal(UUID id,String username,String hash,String role,boolean enabled,long version){super(username,hash,enabled,true,true,true,List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority("ROLE_"+role)));this.id=id;this.version=version;}
    }
    private final JdbcTemplate jdbc;private final TransactionTemplate tx;
    private final BCryptPasswordEncoder encoder=new BCryptPasswordEncoder();
    // Bound repeated password checks per account independently from network/proxy address handling.
    private final Map<UUID,ArrayDeque<Long>> attempts=new LinkedHashMap<>();
    WebAccounts(JdbcTemplate jdbc,PlatformTransactionManager manager,@Value("${mcmanager.admin-username}") String username,@Value("${mcmanager.admin-password:}") String password){
        this.jdbc=jdbc;this.tx=new TransactionTemplate(manager);
        tx.executeWithoutResult(s->{lock();if(jdbc.queryForObject("SELECT COUNT(*) FROM web_accounts",Integer.class)==0){
            check(username!=null&&!username.isBlank()&&username.length()<=80,"初始化管理员账号无效");validatePassword(password);
            insert(canonical(username),password,"ADMIN");
        }});
    }
    private static String canonical(String name){return name.strip().toLowerCase(Locale.ROOT);}
    private void lock(){jdbc.queryForObject("SELECT id FROM web_account_lock WHERE id=1 FOR UPDATE",Integer.class);}
    private Account row(java.sql.ResultSet rs,int i)throws java.sql.SQLException{return new Account(rs.getObject("id",UUID.class),rs.getString("username"),rs.getString("role"),rs.getBoolean("enabled"),TelemetryQueries.instant(rs,"created_at"),TelemetryQueries.instant(rs,"updated_at"));}
    List<Account> list(){return jdbc.query("SELECT id,username,role,enabled,created_at,updated_at FROM web_accounts ORDER BY created_at,id",this::row);}
    private Account insert(String username,String password,String role){
        var id=UUID.randomUUID();var at=TelemetryService.time(Instant.now());
        jdbc.update("INSERT INTO web_accounts(id,username,password_hash,role,enabled,session_version,created_at,updated_at) VALUES (?,?,?,?,TRUE,1,?,?)",id,username,"{bcrypt}"+encoder.encode(password),role,at,at);
        return jdbc.queryForObject("SELECT * FROM web_accounts WHERE id=?",this::row,id);
    }
    Account create(Create request){
        check(request!=null&&request.username()!=null&&request.username().matches("[A-Za-z0-9][A-Za-z0-9_.-]{2,39}"),"账号请使用 3–40 位字母、数字、点、横线或下划线");
        validatePassword(request.password());check(Set.of("ADMIN","VIEWER").contains(request.role()==null?"":request.role()),"请选择账号权限");
        return tx.execute(s->{lock();String name=canonical(request.username());
            if(jdbc.queryForObject("SELECT COUNT(*) FROM web_accounts WHERE username=?",Integer.class,name)>0)throw new ResponseStatusException(HttpStatus.CONFLICT,"这个账号已存在，请换一个名称");
            check(jdbc.queryForObject("SELECT COUNT(*) FROM web_accounts",Integer.class)<1000,"账号数量已达上限");return insert(name,request.password(),request.role());});
    }
    static void validatePassword(String value){check(value!=null&&value.length()>=12&&value.getBytes(StandardCharsets.UTF_8).length<=72,"密码至少 12 位，最多 72 字节（中文会占多个字节）");}
    @Override public UserDetails loadUserByUsername(String name){
        if(name==null)throw new UsernameNotFoundException("账号不存在");
        var rows=jdbc.query("SELECT * FROM web_accounts WHERE username=?",(rs,i)->new Principal(rs.getObject("id",UUID.class),rs.getString("username"),rs.getString("password_hash"),rs.getString("role"),rs.getBoolean("enabled"),rs.getLong("session_version")),canonical(name));
        if(rows.isEmpty())throw new UsernameNotFoundException("账号不存在");return rows.getFirst();
    }
    boolean valid(Principal principal){return jdbc.queryForObject("SELECT COUNT(*) FROM web_accounts WHERE id=? AND enabled=TRUE AND session_version=?",Integer.class,principal.id,principal.version)==1;}
    private synchronized void attempt(UUID id){
        long now=System.currentTimeMillis();attempts.entrySet().removeIf(e->e.getValue().isEmpty()||e.getValue().getLast()<now-600000);
        var times=attempts.computeIfAbsent(id,k->new ArrayDeque<>());while(!times.isEmpty()&&times.getFirst()<now-600000)times.removeFirst();
        if(times.size()>=5)throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"密码验证尝试较多，请 10 分钟后再试");times.addLast(now);
    }
    void password(Principal principal,Password request){
        check(request!=null&&request.currentPassword()!=null&&request.currentPassword().getBytes(StandardCharsets.UTF_8).length<=72,"请填写原密码");validatePassword(request.newPassword());attempt(principal.id);
        var current=(Principal)loadUserByUsername(principal.getUsername());
        if(!current.isEnabled()||current.version!=principal.version)throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"登录已失效，请重新登录");
        if(!encoder.matches(request.currentPassword(),current.getPassword().substring(8)))throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"原密码不正确");
        check(!encoder.matches(request.newPassword(),current.getPassword().substring(8)),"新密码不能与原密码相同");
        String hash="{bcrypt}"+encoder.encode(request.newPassword());
        int changed=jdbc.update("UPDATE web_accounts SET password_hash=?,session_version=session_version+1,updated_at=? WHERE id=? AND session_version=? AND enabled=TRUE",hash,TelemetryService.time(Instant.now()),principal.id,principal.version);
        if(changed!=1)throw new ResponseStatusException(HttpStatus.CONFLICT,"账号刚刚发生变化，请重新登录后再试");
        synchronized(this){attempts.remove(principal.id);}
    }
    void enabled(UUID actor,UUID id,boolean enabled){tx.executeWithoutResult(s->{lock();
        var rows=jdbc.query("SELECT * FROM web_accounts WHERE id=?",this::row,id);if(rows.isEmpty())throw new ResponseStatusException(HttpStatus.NOT_FOUND,"账号不存在");
        check(!actor.equals(id)||enabled,"不能停用当前登录的账号");var target=rows.getFirst();
        if(!enabled&&target.enabled()&&target.role().equals("ADMIN"))check(jdbc.queryForObject("SELECT COUNT(*) FROM web_accounts WHERE role='ADMIN' AND enabled=TRUE",Integer.class)>1,"至少保留一个可用的管理员账号");
        if(target.enabled()!=enabled)jdbc.update("UPDATE web_accounts SET enabled=?,session_version=session_version+1,updated_at=? WHERE id=?",enabled,TelemetryService.time(Instant.now()),id);
    });}
}
