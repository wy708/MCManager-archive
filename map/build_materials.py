"""Compile the pinned Mojang resource pack into top-view materials (no renamed guesses)."""
import argparse
import json
import re
from pathlib import Path
from PIL import Image

REVISION = '46ba6ea985fb5a92d79a9419198f10dda14c199d'  # Bedrock 1.26.50.4 resources, used by 1.26.51


def read(path):
    return json.loads(re.sub(r'(?m)^\s*//.*$', '', path.read_text(encoding='utf-8-sig')))


def build(source, destination):
    pack = source / 'resource_pack'
    definitions = read(pack / 'blocks.json')
    atlas = read(pack / 'textures/terrain_texture.json')['texture_data']
    metadata = read(source / 'metadata/vanilladata_modules/mojang-blocks.json')
    destination.mkdir(parents=True, exist_ok=True)
    textures = {}
    missing = []
    for key, entry in atlas.items():
        values = entry['textures']
        values = values if isinstance(values, list) else [values]
        images = []
        for value in values:
            value = value.get('path') if isinstance(value, dict) else value
            if not value:
                images.append(None)
                continue
            name = value.replace('/', '__') + '.png'
            target = destination / name
            if not target.exists():
                path = next((pack / (value + suffix) for suffix in ('.png', '.tga')
                             if (pack / (value + suffix)).is_file()), None)
                if path:
                    with Image.open(path) as image:
                        # Animated strips: first frame, as in the original static map.
                        image.convert('RGBA').crop((0, 0, image.width, image.width)).resize((16, 16), Image.Resampling.NEAREST).save(target)
                else:
                    missing.append(value)
            images.append(name if target.exists() else None)
        textures[key] = images
    catalog = {'revision': REVISION, 'definitions': definitions, 'textures': textures,
               'blocks': metadata['data_items'], 'properties': metadata['block_properties']}
    (destination / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'blocks': len(metadata['data_items']), 'atlasKeys': len(textures),
                      'missingSourceImages': sorted(set(missing))}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    build(args.source, args.destination)
