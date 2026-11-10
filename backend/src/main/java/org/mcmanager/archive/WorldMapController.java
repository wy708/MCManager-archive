package org.mcmanager.archive;

import java.net.URI;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/** Registry only: original MipMap runs on its own origin with its own APIs. */
@RestController
class WorldMapController {
    record MapInfo(UUID serverId, String serverName, boolean configured, String viewerUrl) {}
    private final Map<UUID, URI> viewers = new HashMap<>();
    private final ArchiveRepository archives;
    WorldMapController(ArchiveRepository archives, @Value("${MCM_MAP_PUBLIC_URLS:}") String configuration) {
        this.archives=archives;
        for(String entry:configuration.split(",")) {
            if(entry.isBlank()) continue;
            String[] pair=entry.trim().split("=",2);
            if(pair.length!=2) throw new IllegalArgumentException("Invalid MCM_MAP_PUBLIC_URLS entry");
            URI uri=URI.create(pair[1]);
            boolean mapPath=Set.of("","/").contains(uri.getPath()) || uri.getPath().matches("/maps/[0-9a-f-]{36}/?");
            if(!Set.of("http","https").contains(uri.getScheme()) || uri.getHost()==null || uri.getUserInfo()!=null
                || uri.getRawQuery()!=null || uri.getFragment()!=null || !mapPath)
                throw new IllegalArgumentException("Original map viewer URL is invalid");
            viewers.put(UUID.fromString(pair[0]),URI.create(pair[1].replaceAll("/+$","")+"/"));
        }
    }
    @GetMapping("/api/world-maps")
    List<MapInfo> list() {
        return archives.list().stream().map(s->new MapInfo(s.id(),s.name(),viewers.containsKey(s.id()),
            viewers.containsKey(s.id())?viewers.get(s.id()).toString():null)).toList();
    }
    @GetMapping({"/api/world-maps/{server}/view/", "/api/world-maps/{server}/view"})
    ResponseEntity<Void> view(@PathVariable UUID server) {
        if(archives.find(server).isEmpty() || !viewers.containsKey(server))
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,"该服务器尚未连接原版地图");
        return ResponseEntity.status(HttpStatus.FOUND).location(viewers.get(server)).cacheControl(CacheControl.noStore()).build();
    }
}
