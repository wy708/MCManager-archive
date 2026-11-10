"""Bounded map-server cache and connected-cavity projection. No game API calls."""
from collections import OrderedDict, deque
import hashlib
import json
from pathlib import Path
import time

HEIGHTS = (32, 64, 96)


def connected_floors(columns, height):
    nodes, queue, seen, chosen = {}, deque(), set(), {}
    for pos, cavities in sorted(columns.items()):
        for i, cave in enumerate(cavities):
            key = (*pos, i)
            nodes[key] = cave
            if cave['low'] <= height <= cave['high']:
                queue.append(key)
                seen.add(key)
    while queue:
        key = queue.popleft()
        x, z, _ = key
        cave = nodes[key]
        chosen.setdefault((x,z), cave)
        for pos in ((x-1,z),(x+1,z),(x,z-1),(x,z+1)):
            for i, neighbor in enumerate(columns.get(pos, ())):
                nxt = (*pos,i)
                if nxt not in seen and min(cave['high'],neighbor['high'])-max(cave['low'],neighbor['low']) >= 1:
                    seen.add(nxt)
                    queue.append(nxt)
    return chosen


class CaveLayers:
    def __init__(self, renderer, limit=256):
        self.renderer, self.limit = renderer, limit
        self.chunks, self.hashes = OrderedDict(), {}
        self.dirty, self.last = False, time.monotonic()
        self.directory = Path('data/nether-columns')
        self.directory.mkdir(parents=True, exist_ok=True)
        # Disk is authoritative across renderer restarts; bound the active graph.
        for file in sorted(self.directory.glob('*.json'), key=lambda p:p.stat().st_mtime)[-limit:]:
            data = json.loads(file.read_text())
            self._remember(data)
        self.dirty = bool(self.chunks)

    def _remember(self, data):
        first = data['blocks'][0]['coordinates']
        key = first[0]//16, first[2]//16
        self.chunks[key] = data
        self.chunks.move_to_end(key)
        while len(self.chunks)>self.limit:
            old,_ = self.chunks.popitem(last=False)
            for height in HEIGHTS: self.hashes.pop((old,height),None)
        return key

    def add(self, chunk):
        data = chunk.model_dump()
        key = self._remember(data)
        path = self.directory/f'{key[0]}_{key[1]}.json'
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(data))
        temp.replace(path)
        self.dirty = True

    def flush(self, force=False):
        if not self.dirty or (not force and time.monotonic()-self.last<2): return
        from models.chunk import ChunkData
        columns = {(b['coordinates'][0],b['coordinates'][2]):b.get('cavities') or []
                   for c in self.chunks.values() for b in c['blocks']}
        for height in HEIGHTS:
            floors = connected_floors(columns,height)
            for key, chunk in self.chunks.items():
                blocks = []
                for b in chunk['blocks']:
                    x,_,z = b['coordinates']
                    floor = floors.get((x,z))
                    blocks.append({k:v for k,v in floor.items() if k in ('name','coordinates','states','layers','layers_complete')} if floor else
                                  {'name':'minecraft:air','coordinates':[x,0,z]})
                digest = hashlib.sha256(json.dumps(blocks,sort_keys=True).encode()).digest()
                if self.hashes.get((key,height)) != digest:
                    self.renderer.generateTile(ChunkData(dimension=f'Nether_{height}',blocks=blocks))
                    self.hashes[key,height] = digest
        self.dirty, self.last = False, time.monotonic()
