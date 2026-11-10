"""Stage the Windows map add-on for packaging and isolated runtime verification.

Arguments: original Windows connection zip, new output directory.
Does not copy credentials or any game save.
"""
import hashlib,json,pathlib,shutil,subprocess,sys,zipfile

repo=pathlib.Path(__file__).resolve().parent.parent
out=pathlib.Path(sys.argv[2]).resolve()
if out.exists() and any(out.iterdir()): raise SystemExit('Use a fresh staging directory')
out.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(sys.argv[1]) as z:
    manifests=[n for n in z.namelist() if n.endswith('/SHA256.json') or n=='SHA256.json']
    assert len(manifests)==1
    prefix=manifests[0][:-len('SHA256.json')]
    hashes=json.loads(z.read(manifests[0]))
    for name,sha in hashes.items():
        assert not pathlib.PurePosixPath(name).is_absolute() and '..' not in pathlib.PurePosixPath(name).parts
        data=z.read(prefix+name);assert hashlib.sha256(data).hexdigest()==sha
        p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
pins=json.loads((repo/'map/compatibility/sources.json').read_text())
pybase=pathlib.Path(subprocess.check_output(['py','-3.12','-c','import sys;print(sys.base_prefix)'],text=True).strip())
python=out/'runtime/python';python.mkdir()
for name in ['python.exe','pythonw.exe','python3.dll','python312.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE.txt']:
    shutil.copy2(pybase/name,python/name)
for name in ['Lib','DLLs']:
    shutil.copytree(pybase/name,python/name,ignore=shutil.ignore_patterns('site-packages','__pycache__','test','tests','idlelib','tkinter','turtledemo'))
subprocess.run([str(python/'python.exe'),'-m','ensurepip','--default-pip'],check=True)
wheel=repo/'.tools/map-runtime-12661/LeviStone/dist'/f"levistone-{pins['wheelVersion']}-cp312-cp312-win_amd64.whl"
runtime=out/'payload/plugins/EndstoneRuntime'
subprocess.run([str(python/'python.exe'),'-m','pip','install','--target',str(runtime),'--no-deps','--no-compile','--disable-pip-version-check',str(wheel),*pins['runtimeDependencies']],check=True)
mapwheel=repo/'map/dist/endstone_mipmap-1.0.3+mcmanager.6-py2.py3-none-any.whl'
shutil.copy2(mapwheel,out/'payload/plugins'/mapwheel.name)
with zipfile.ZipFile(mapwheel) as z:
    config=out/'payload/plugins/mipmap/config.toml';config.parent.mkdir();config.write_bytes(z.read('endstone_mipmap/config.toml'))
shutil.copy2(repo/'scripts/windows-package/LeviLamina.Config.json',out/'payload/plugins/LeviLamina/config/Config.json')
for name in ['sources.json','verified-artifacts.json']:
    shutil.copy2(repo/'map/compatibility'/name,out/('map-'+name))
for name in ['LICENSE','COPYING']:
    for src in [repo/'.tools/map-runtime-12661/LeviStone'/name,repo/'.tools/map-runtime-12661/LeviStone/endstone'/name]:
        if src.exists():shutil.copy2(src,out/'licenses'/(src.parent.name+'-'+name+'.txt'))
print('STAGED '+str(out),flush=True)
