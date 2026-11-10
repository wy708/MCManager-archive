"""Build the pinned scene baker; only the output directory may be published.

Requires Git and JDK 21. Downloads upstream assets at build time, not per viewer.
Usage: python scene/build.py --output .tools/scene-runtime
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile
from fix_chest_uvs import fix_chest_uvs

ROOT = Path(__file__).resolve().parent
SOURCES = json.loads((ROOT / 'sources.json').read_text())


def run(*args, cwd=None):
    subprocess.run([str(a) for a in args], cwd=cwd, check=True)


def checkout(target, spec):
    if not target.exists():
        run('git', 'init', target)
        run('git', 'remote', 'add', 'origin', spec['repository'], cwd=target)
    actual_remote = subprocess.check_output(['git', 'remote', 'get-url', 'origin'], cwd=target, text=True).strip()
    if actual_remote != spec['repository']:
        raise RuntimeError('Unexpected source repository: ' + str(target))
    try:
        run('git', 'cat-file', '-e', spec['revision'] + '^{commit}', cwd=target)
    except subprocess.CalledProcessError:
        run('git', 'fetch', '--depth', '1', 'origin', spec['revision'], cwd=target)
    run('git', 'checkout', '--detach', spec['revision'], cwd=target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--sources', default=str(ROOT.parent / '.tools' / 'scene-build-sources'))
    args = parser.parse_args()
    output, cache = Path(args.output).resolve(), Path(args.sources).resolve()
    # Never delete a caller supplied path. Fresh output avoids stale resource mixing.
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise RuntimeError('Output must be empty: ' + str(output))
    cache.mkdir(parents=True, exist_ok=True)
    patch = ROOT / 'patches' / 'miex-bedrock-compat.patch'
    miex, bedrock = cache / ('miex-' + hashlib.sha256(patch.read_bytes()).hexdigest()[:12]), cache / 'bedrock'
    checkout(miex, SOURCES['miex'])
    reverse = subprocess.run(['git', 'apply', '--reverse', '--check', str(patch)], cwd=miex, capture_output=True)
    if reverse.returncode:
        run('git', 'apply', '--check', patch, cwd=miex)
        run('git', 'apply', patch, cwd=miex)
    checkout(bedrock, SOURCES['bedrock'])
    download = SOURCES['javaGeometry']['download']
    archive = cache / (download['sha1'] + '.jar')
    if not archive.is_file() or hashlib.sha1(archive.read_bytes()).hexdigest() != download['sha1']:
        temporary = archive.with_suffix('.download')
        urllib.request.urlretrieve(download['url'], temporary)
        if temporary.stat().st_size != download['size'] or hashlib.sha1(temporary.read_bytes()).hexdigest() != download['sha1']:
            raise RuntimeError('Official resource download checksum mismatch')
        temporary.replace(archive)
    base = output / 'packs' / 'base_resource_pack'
    base.mkdir(parents=True)
    with zipfile.ZipFile(archive) as source:
        for info in source.infolist():
            if not info.filename.startswith('assets/') or info.is_dir():
                continue
            destination = (base / info.filename).resolve()
            if not destination.is_relative_to(base):
                raise RuntimeError('Invalid resource archive path')
            destination.parent.mkdir(parents=True, exist_ok=True)
            with source.open(info) as incoming, destination.open('wb') as outgoing:
                shutil.copyfileobj(incoming, outgoing)
    shutil.copytree(miex / 'builtin_files' / 'base_resource_pack', base, dirs_exist_ok=True)
    fix_chest_uvs(base)
    for name, asset in SOURCES['javaGeometry'].get('fontAssets', {}).items():
        cached = cache / asset['hash']
        if not cached.is_file() or hashlib.sha1(cached.read_bytes()).hexdigest() != asset['hash']:
            content = urllib.request.urlopen('https://resources.download.minecraft.net/' + asset['hash'][:2] + '/' + asset['hash']).read()
            if len(content) != asset['size'] or hashlib.sha1(content).hexdigest() != asset['hash']:
                raise RuntimeError('Official font checksum mismatch')
            cached.write_bytes(content)
        destination = (base / 'assets' / name).resolve()
        if not destination.is_relative_to(base / 'assets'):
            raise RuntimeError('Invalid font resource path')
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(cached, destination)
    shutil.copytree(bedrock / 'resource_pack', output / 'packs' / 'bedrock')
    # Client biomes only contain water/atmosphere appearance. Plant colormaps need
    # the official behavior-pack climate; merge water too so filesystem order is immaterial.
    biome_dir = output / 'packs' / 'bedrock' / 'biomes'
    for file in (bedrock / 'behavior_pack' / 'biomes').glob('*.json'):
        data = json.loads(file.read_text(encoding='utf-8-sig'))
        biome = data.get('minecraft:biome')
        if not biome:
            continue
        client = biome_dir / file.name.replace('.biome.json', '.client_biome.json')
        if client.is_file():
            appearance = json.loads(client.read_text(encoding='utf-8-sig')).get('minecraft:client_biome', {}).get('components', {})
            water = appearance.get('minecraft:water_appearance', {}).get('surface_color')
            if water is not None:
                biome.setdefault('components', {}).setdefault('minecraft:map_tints', {})['water'] = water
        (biome_dir / file.name).write_text(json.dumps(data), encoding='utf-8')
    classes = output / 'classes'
    classes.mkdir()
    libs = output / 'libs'
    libs.mkdir()
    for lib in (miex / 'libs').glob('*.jar'):
        if not lib.name.endswith(('-sources.jar', '-javadoc.jar')):
            shutil.copy2(lib, libs)
    for resource in (miex / 'src').iterdir():
        if resource.is_file() and resource.suffix != '.java':
            shutil.copy2(resource, classes)
    java_home = os.environ.get('JAVA_HOME')
    javac = str(Path(java_home) / 'bin' / 'javac') if java_home else 'javac'
    files = list((miex / 'src').rglob('*.java')) + list((ROOT / 'src').rglob('*.java'))
    argfile = output / 'compile.args'
    # Java argfiles require slash paths and quoted whitespace, independent of shell.
    argfile.write_text('\n'.join('"' + p.as_posix() + '"' for p in files), encoding='utf-8')
    run(javac, '-J-Duser.language=en', '--release', '21', '-encoding', 'UTF-8', '-cp', str(libs / '*'), '-d', classes, '@' + str(argfile))
    argfile.unlink()
    licenses = output / 'licenses'
    licenses.mkdir()
    for prefix, source in [('MiEx', miex), ('Mojang-bedrock-samples', bedrock)]:
        for file in source.glob('*'):
            if file.is_file() and file.name.lower().startswith(('license', 'notice')):
                shutil.copy2(file, licenses / (prefix + '-' + file.name))
    shutil.copy2(ROOT / 'run.mjs', output)
    shutil.copy2(ROOT / 'glb.mjs', output)
    shutil.copy2(ROOT / 'export-range.mjs', output)
    shutil.copy2(ROOT / 'sources.json', output)
    (output / 'build.json').write_text(json.dumps({'sources': SOURCES, 'adapterSha256': hashlib.sha256((ROOT / 'src/org/mcmanager/scene/SceneBaker.java').read_bytes()).hexdigest(), 'patchSha256': hashlib.sha256(patch.read_bytes()).hexdigest(), 'chestUvFixSha256': hashlib.sha256((ROOT / 'fix_chest_uvs.py').read_bytes()).hexdigest()}, indent=2))
    print('Scene runtime built:', output)


if __name__ == '__main__':
    main()
