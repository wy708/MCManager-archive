"""Read real underlays, yielding after each native query. Never invent a ground tile."""
import json
from pathlib import Path

TRANSPARENT = frozenset(json.loads(Path(__file__).with_name('transparent_blocks.json').read_text())['blocks'])
INVISIBLE = frozenset('minecraft:'+name for name in ('air','cave_air','void_air','structure_void','light_block','barrier','chemical_heat'))
MAX_LAYERS = 64

def record(block):
    data = block.data
    return {'name': data.type, 'coordinates': [block.x, block.y, block.z], 'states': dict(data.block_states)}

def column(world, x, z, blacklist):
    first = record(world.get_highest_block_at(x, z))
    yield None
    layers = []
    complete = False
    minimum = -64 if world.name == 'Overworld' else 0
    for y in range(first['coordinates'][1], minimum-1, -1):
        if y == first['coordinates'][1]:
            block = first
        else:
            block = record(world.get_block_at(x, y, z))
            yield None
        if block['name'] in INVISIBLE or block['name'] in blacklist:
            continue
        layers.append(block)
        if block['name'] not in TRANSPARENT:
            complete = True
            break
        if len(layers) >= MAX_LAYERS:
            break
    if not layers:
        layers = [{'name':'minecraft:air','coordinates':[x,minimum,z],'states':{}}]
    yield {**layers[0], 'layers':layers[1:], 'layers_complete':complete}

def chunk(world, chunk_x, chunk_z, blacklist):
    blocks = []
    for x in range(chunk_x*16, chunk_x*16+16):
        for z in range(chunk_z*16, chunk_z*16+16):
            for result in column(world, x, z, blacklist):
                if result is None: yield None
                else: blocks.append(result)
    yield {'chunk':{'dimension':world.name,'blocks':blocks}, 'chunkX':chunk_x,'chunkZ':chunk_z}
