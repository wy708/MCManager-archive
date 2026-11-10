"""Exhaust all declared vanilla property combinations, not only a sample screenshot."""
import itertools
import json
from pathlib import Path
from types import SimpleNamespace
from services.block_materials import CATALOG, material, texture_for


def audit():
    properties = {p['name']: [v['value'] for v in p['values']] for p in CATALOG['properties']}
    report = {'resourceRevision': CATALOG['revision'], 'blocks': [], 'unresolved': [],
              'excluded': [], 'combinations': 0, 'note': 'Declared property Cartesian products; not a claim of 3D model or biome parity.'}
    for block in CATALOG['blocks']:
        name = block['name']
        bare = name.removeprefix('minecraft:')
        # These resources are not included in Mojang's vanilla sample pack.
        if bare.startswith('element_') or bare in ('compound_creator', 'lab_table', 'material_reducer', 'unknown'):
            report['excluded'].append({'name': name, 'reason': 'education-only resource or internal unknown identifier'})
            continue
        keys = [p['name'] for p in block.get('properties', [])]
        cases, variants = 0, set()
        for values in itertools.product(*(properties[k] for k in keys)):
            states = dict(zip(keys, values))
            texture = texture_for(SimpleNamespace(name=name, states=states))
            cases += 1
            if texture is None or texture.size != (16, 16):
                report['unresolved'].append({'name': name, 'states': states, 'material': material(name, states)})
            else:
                variants.add(texture.tobytes())
        report['combinations'] += cases
        report['blocks'].append({'name': name, 'combinations': cases, 'topViewVariants': len(variants)})
    return report


if __name__ == '__main__':
    report = audit()
    Path('material-coverage.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: len(v) if isinstance(v, list) else v for k, v in report.items() if k != 'note'}))
    if report['unresolved']:
        raise SystemExit('Unresolved vanilla material combinations; see material-coverage.json')
