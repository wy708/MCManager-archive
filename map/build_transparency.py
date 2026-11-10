"""Compile acquisition hints from every declared state of the pinned map materials."""
import itertools
import json
from pathlib import Path
from types import SimpleNamespace
from services.block_materials import CATALOG, texture_for

properties = {p['name']: [v['value'] for v in p['values']] for p in CATALOG['properties']}
transparent = set()
for block in CATALOG['blocks']:
    keys = [p['name'] for p in block.get('properties', [])]
    for values in itertools.product(*(properties[k] for k in keys)):
        texture = texture_for(SimpleNamespace(name=block['name'], states=dict(zip(keys, values))))
        if texture is not None and texture.getchannel('A').getextrema()[0] < 255:
            transparent.add(block['name'])
            break
Path('/output/transparent_blocks.json').write_text(json.dumps({'resourceRevision': CATALOG['revision'], 'blocks': sorted(transparent)}, indent=2)+'\n')
print('Transparent block types:', len(transparent))
