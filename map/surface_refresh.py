"""Budgeted loaded-chunk capture, change detection and retry. No chunk loading."""
from collections import deque
import hashlib
import json
import time
try:
    from .surface_layers import chunk as scan_chunk
except ImportError:
    from surface_layers import chunk as scan_chunk

class SurfaceRefresh:
    def __init__(self, plugin):
        self.plugin = plugin
        self.pending, self.queued, self.forced = deque(), set(), set()
        self.sent, self.active, self.ticks = {}, None, 0
        self.period = max(0, int(plugin.config.get('surfaceRefreshTicks', 10)))
        self.budget = min(4, max(.2, float(plugin.config.get('surfaceBudgetMs', 1)))) / 1000
        self.reads = self.completed = 0
        self.samples = deque(maxlen=4096)

    def enqueue(self, chunk, force=False):
        key = chunk.dimension.name, chunk.x, chunk.z
        if key[0] == 'Nether' and self.plugin.config.get('netherInterior', True):
            self.plugin._netherCapture.enqueue(chunk)
            return
        if force: self.forced.add(key)
        if key not in self.queued and (not self.active or self.active[0] != key):
            self.pending.append(key)
            self.queued.add(key)

    def start(self):
        self.plugin.server.scheduler.run_task(self.plugin, self.step, delay=1, period=1)

    def step(self):
        self.ticks += 1
        if 0 < self.plugin.server.current_tps < 18 and self.ticks % 4: return
        if self.period and not self.pending and (self.ticks == 1 or self.ticks % self.period == 0):
            loaded = [c for d in self.plugin.server.level.dimensions for c in d.loaded_chunks]
            live = {(c.dimension.name,c.x,c.z) for c in loaded}
            self.sent = {k:v for k,v in self.sent.items() if k in live}
            for c in loaded: self.enqueue(c)
        if not self.active:
            if not self.pending: return
            key = self.pending.popleft(); self.queued.discard(key)
            world = self.plugin.server.level.get_dimension(key[0])
            if not any(c.x == key[1] and c.z == key[2] for c in world.loaded_chunks):
                self.sent.pop(key, None); self.forced.discard(key); return
            blacklist = set(self.plugin.config.get('blacklist', {}).get('blocks', []))
            self.active = key, scan_chunk(world, key[1], key[2], blacklist)
        key, reader = self.active
        world = self.plugin.server.level.get_dimension(key[0])
        if not any(c.x == key[1] and c.z == key[2] for c in world.loaded_chunks):
            self.active = None; self.forced.discard(key); return
        started = time.perf_counter()
        for _ in range(256):
            result = next(reader)
            if result is None: self.reads += 1
            else:
                digest = hashlib.sha256(json.dumps(result,sort_keys=True).encode()).digest()
                previous, at = self.sent.get(key, (None, 0)); now = time.monotonic()
                if key in self.forced or digest != previous or now-at >= 300:
                    self.plugin._chunksQueue.put(result); self.sent[key] = digest, now
                self.forced.discard(key); self.active = None; self.completed += 1
                break
            if time.perf_counter()-started >= self.budget: break
        self.samples.append((time.perf_counter()-started)*1000)

    def report(self):
        values = sorted(self.samples)
        data = {'completedChunks':self.completed,'blockReads':self.reads,'budgetMs':self.budget*1000,
                'samples':len(values),'p95Ms':values[min(len(values)-1,int(len(values)*.95))] if values else 0,
                'maxMs':max(values,default=0)}
        (self.plugin.data_folder/'surface-performance.json').write_text(json.dumps(data,indent=2))
