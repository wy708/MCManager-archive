package org.mcmanager.archive;
import jakarta.servlet.http.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.authentication.logout.SecurityContextLogoutHandler;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
@RestController
class WebAccountController {
    private final WebAccounts accounts;
    WebAccountController(WebAccounts accounts){this.accounts=accounts;}
    private WebAccounts.Principal principal(Authentication auth){if(auth.getPrincipal() instanceof WebAccounts.Principal p)return p;throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"请重新登录");}
    @GetMapping("/api/admin/accounts") List<WebAccounts.Account> list(){return accounts.list();}
    @PostMapping("/api/admin/accounts") @ResponseStatus(HttpStatus.CREATED)
    WebAccounts.Account create(@RequestBody WebAccounts.Create request){return accounts.create(request);}
    record Enabled(boolean enabled){}
    @PutMapping("/api/admin/accounts/{id}/enabled") @ResponseStatus(HttpStatus.NO_CONTENT)
    void enabled(Authentication auth,@PathVariable UUID id,@RequestBody Enabled request){accounts.enabled(principal(auth).id,id,request.enabled());}
    @PostMapping("/api/auth/password") @ResponseStatus(HttpStatus.NO_CONTENT)
    void password(Authentication auth,@RequestBody WebAccounts.Password body,HttpServletRequest request,HttpServletResponse response){
        accounts.password(principal(auth),body);new SecurityContextLogoutHandler().logout(request,response,auth);
    }
}
