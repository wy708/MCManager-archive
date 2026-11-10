"""Correct inverted-Y chest cuboids in the pinned MiEx builtin resource.

Keep the original geometry and side UVs. Its inverted Y bounds swap the final
UP/DOWN faces, so their atlas rectangles must be swapped before baking too.
"""
import json
from pathlib import Path


def fix_chest_uvs(base: Path):
    file = base / 'builtins/minecraft/blockstates/chest.json'
    data = json.loads(file.read_text(encoding='utf-8'))
    for variant in data['handler']['children']['children']:
        for element in variant['elements']:
            start, end = element['from'], element['to']
            assert start[1] > end[1], 'Pinned chest geometry changed; review UV correction'
            width, height, depth = [abs(end[i] - start[i]) for i in range(3)]
            u, v, max_u, max_v = element['entityUVs']
            scale_u = (max_u - u) / (2 * (width + depth))
            scale_v = (max_v - v) / (depth + height)
            top = [u + depth * scale_u, v, u + (depth + width) * scale_u, v + depth * scale_v]
            bottom = [u + (depth + width) * scale_u, v, u + (depth + 2 * width) * scale_u, v + depth * scale_v]
            element['faces'] = {name: {} for name in ['north', 'south', 'east', 'west']}
            element['faces'].update(up={'uv': bottom}, down={'uv': top})
    file.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    import sys
    fix_chest_uvs(Path(sys.argv[1]))
