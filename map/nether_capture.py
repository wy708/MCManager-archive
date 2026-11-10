"""Budgeted Nether column acquisition; connectivity/rendering run on the map server."""
from collections import deque
import hashlib
import json
import time
try:
    from .surface_layers import TRANSPARENT, INVISIBLE, MAX_LAYERS
except ImportError:
    from surface_layers import TRANSPARENT, INVISIBLE, MAX_LAYERS

AIR = {'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'}


def scan_column(world, x, z, blacklist):
    cavities, ceiling, low, overlays, complete = [], None, None, [], True
    for y in range(126, -1, -1):
        data = world.get_block_at(x, y, z).data
        if data.type in INVISIBLE or data.type in blacklist or data.type in TRANSPARENT:
            if ceiling is None: ceiling = y
            low = y
            if data.type not in INVISIBLE and data.type not in blacklist:
                if len(overlays) < MAX_LAYERS-1:
                    overlays.append({'name':data.type,'coordinates':[x,y,z],'states':dict(data.block_states)})
                else: complete = False
        else:
            if ceiling is not None and ceiling-low >= 1:
                layers = overlays + [{'name':data.type,'coordinates':[x,y,z],'states':dict(data.block_states)}]
                cavities.append({'low': low, 'high': ceiling, **layers[0], 'layers':layers[1:], 'layers_complete':complete})
            ceiling, low, overlays, complete = None, None, [], True
        yield None  # Yield after every native block query, even inside solid rock.
    yield {'name': 'minecraft:air', 'coordinates': [x,0,z], 'states': {}, 'cavities': cavities}


class NetherCapture:
    def __init__(self, plugin):
        self.plugin, self.pending, self.active = plugin, set(), None
        self.sent, self.scanned = {}, {}
        self.samples = deque(maxlen=4096)
        self.completed, self.reads, self.ticks, self.throttled = 0, 0, 0, 0
        self.budget = min(4.0, max(0.2, float(plugin.config.get('netherBudgetMs', 1.0)))) / 1000

    def enqueue(self, chunk):
        key = chunk.x, chunk.z
        if self.active is None or self.active['key'] != key: self.pending.add(key)

    def start(self):
        self.plugin.server.scheduler.run_task(self.plugin, self.step, delay=1, period=1)

    def step(self):
        self.ticks += 1
        tps = self.plugin.server.current_tps
        if 0 < tps < 18 and self.ticks % 4:
            self.throttled += 1
            return
        started = time.perf_counter()
        world = self.plugin.server.level.get_dimension('Nether')
        if self.active is None or self.ticks % 20 == 0:
            loaded = {(c.x,c.z) for c in world.loaded_chunks}
            self.pending.intersection_update(loaded)
            self.sent = {k:v for k,v in self.sent.items() if k in loaded}
            self.scanned = {k:v for k,v in self.scanned.items() if k in loaded}
            if self.active and self.active['key'] not in loaded: self.active = None
            if self.active is None:
                if not self.pending: return
                players = [p for p in self.plugin.server.online_players if p.dimension.name == 'Nether']
                centers = [(p.location.x//16,p.location.z//16) for p in players] or [(0,0)]
                key = min(self.pending,key=lambda k:(self.scanned.get(k,0),min((k[0]-x)**2+(k[1]-z)**2 for x,z in centers)))
                self.pending.remove(key)
                self.active = {'key': key, 'blocks': [], 'reader': None}
        # Recheck active chunk before any native reads; never read an unloaded chunk.
        key = self.active['key']
        if not any(c.x == key[0] and c.z == key[1] for c in world.loaded_chunks):
            self.active = None
            return
        for _ in range(512):
            if self.active['reader'] is None:
                i = len(self.active['blocks'])
                self.active['reader'] = scan_column(world,key[0]*16+i//16,key[1]*16+i%16,set(self.plugin.config.get('blacklist',{}).get('blocks',[])))
            result = next(self.active['reader'])
            if result is None:
                self.reads += 1
            else:
                self.active['blocks'].append(result)
                self.active['reader'] = None
                if len(self.active['blocks']) == 256:
                    data = {'chunk': {'dimension':'Nether','blocks':self.active['blocks']},'chunkX':key[0],'chunkZ':key[1]}
                    digest = hashlib.sha256(json.dumps(data,sort_keys=True).encode()).digest()
                    old, at = self.sent.get(key,(None,0))
                    now = time.monotonic()
                    self.scanned[key] = now
                    if old != digest or now-at >= 300:
                        self.plugin._chunksQueue.put(data)
                        self.sent[key] = digest, now
                    self.active = None
                    self.completed += 1
                    break
            if time.perf_counter()-started >= self.budget: break
        self.samples.append(((time.perf_counter()-started)*1000,tps,self.plugin.server.current_mspt))

    def report(self):
        samples = sorted(x[0] for x in self.samples)
        report = {'completedChunks':self.completed,'blockReads':self.reads,'budgetMs':self.budget*1000,
                  'samples':len(samples),'throttledTicks':self.throttled,
                  'p50Ms':samples[len(samples)//2] if samples else 0,
                  'p95Ms':samples[min(len(samples)-1,int(len(samples)*.95))] if samples else 0,
                  'maxMs':max(samples,default=0),
                  'minObservedTps':min((x[1] for x in self.samples),default=0)}
        (self.plugin.data_folder/'nether-performance.json').write_text(json.dumps(report,indent=2))
