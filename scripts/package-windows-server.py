"""Package already verified official dependencies and the current native release.

Usage: python scripts/package-windows-server.py DOWNLOAD_DIRECTORY OUTPUT_DIRECTORY
No game installation is modified and no platform credentials are included.
"""
import pathlib,sys,json,hashlib,shutil

repo=pathlib.Path(__file__).resolve().parent.parent
downloads=pathlib.Path(sys.argv[1]).resolve()
out=pathlib.Path(sys.argv[2]).resolve()
if out.exists(): raise SystemExit('Output directory already exists; use a fresh release directory')
out.mkdir(parents=True)
def digest(file): return hashlib.sha256(file.read_bytes()).hexdigest()
def copy(src,relative):
    dst=out/relative;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
def write(relative,value):
    dst=out/relative;dst.parent.mkdir(parents=True,exist_ok=True)
    dst.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
identity=json.loads((repo/'collector/runtime-compat/identity.json').read_text())
assert digest(downloads/'preloader/bin/PreLoader.dll')==identity['preLoaderSHA256']
assert digest(downloads/'levilamina/LeviLamina/LeviLamina.dll')==identity['leviLaminaSHA256']
assert digest(downloads/'peeditor.zip')=='cfeba1e9c40fc65a1310853d5cd3d5431d7bc3855c68e23b3d9c7a26f1fe42c2'
assert digest(downloads/'bedrockdata.zip')=='f6708a6629e374fda58701c37f86012f55baae592efaaeab32fb590eeef592e6'
copy(downloads/'preloader/bin/PreLoader.dll','payload/PreLoader.dll')
copy(downloads/'bedrockdata/bedrock_runtime_data','payload/bedrock_runtime_data')
for name in ['LeviLamina.dll','manifest.json']:
    copy(downloads/'levilamina/LeviLamina'/name,'payload/plugins/LeviLamina/'+name)
copy(downloads/'crashlogger/CrashLogger.exe','payload/CrashLogger.exe')
copy(downloads/'crashlogger/CrashLogger.exe','payload/plugins/LeviLamina/CrashLogger.exe')
copy(downloads/'peeditor/PeEditor.exe','tools/PeEditor.exe')
for name in ['archive-runtime-compat.dll','manifest.json','identity.json','compat-symbols.tsv']:
    copy(repo/'collector/build/runtime-compat/AAA-archive-runtime-compat'/name,'payload/plugins/AAA-archive-runtime-compat/'+name)
assert digest(out/'payload/plugins/AAA-archive-runtime-compat/archive-runtime-compat.dll')==json.loads((repo/'collector/build/runtime-compat/build-evidence.json').read_text(encoding='utf-8-sig'))['dllSHA256']
for name in ['archive-collector.dll','manifest.json']:
    copy(repo/'collector/bin/1.26.61.1/archive-collector'/name,'payload/plugins/archive-collector/'+name)
write('payload/plugins/archive-collector/config/config.json',{'enabled':False,'serverId':'','token':'','endpoint':'https://mc.example.com/api/ingest/v1/batches','activityIdleSeconds':300})
write('payload/PreLoaderConfig.json',{'version':1,'colorLog':True,'logLevel':4,'logPath':'./logs/','modsPath':'./plugins/'})
copy(repo/'scripts/windows-package/LeviLamina.Config.json','payload/plugins/LeviLamina/config/Config.json')
for name in ['zh_CN.json','en_US.json']:
    if (downloads/name).exists(): copy(downloads/name,'payload/plugins/LeviLamina/lang/'+name)
for p in (repo/'backup/src').rglob('*'):
    if p.is_file(): copy(p,'host/src/'+p.relative_to(repo/'backup/src').as_posix())
copy(repo/'backup/package.json','host/package.json')
copy(repo/'backup/package-lock.json','host/package-lock.json')
shutil.copytree(repo/'backup/node_modules',out/'host/node_modules')
node=next((downloads/'node').glob('*/node.exe'))
copy(node,'runtime/node.exe');copy(node.parent/'LICENSE','licenses/Node.js-LICENSE.txt')
copy(repo/'scripts/windows-package/setup.mjs','setup.mjs')
copy(repo/'scripts/windows-package/diagnose.mjs','diagnose.mjs')
copy(repo/'scripts/windows-package/使用说明.txt','使用说明.txt')
for folder in ['levilamina','crashlogger']:
    for p in (downloads/folder).glob('COPYING*'):copy(p,'licenses/'+folder+'-'+p.name+'.txt')
for p in downloads.glob('*-LICENSE.txt'):copy(p,'licenses/'+p.name)
for p in downloads.glob('*-COPYING.txt'):copy(p,'licenses/'+p.name)
sources=json.loads((downloads/'sources.json').read_text())
sources.append(json.loads((downloads/'node-source.json').read_text()))
write('DEPENDENCIES.json',{'bds':'1.26.61.1','levilamina':'26.60.2','preloader':'1.16.8','compatibility':'0.2.0','collector':json.loads((repo/'collector/bin/1.26.61.1/archive-collector/manifest.json').read_text())['version'],'sources':sources,'notes':'Original upstream dependencies plus the explicitly marked MCManager compatibility adapter. No BDS files or game data are redistributed.'})
for name,command in [('01-install.cmd','install'),('02-configure.cmd','configure'),('04-local-console.cmd','local'),('05-verify-package.cmd','verify')]:
    (out/name).write_bytes(('@echo off\r\nchcp 65001 >nul\r\n"%~dp0runtime\\node.exe" "%~dp0setup.mjs" '+command+'\r\nset "result=%errorlevel%"\r\npause\r\nexit /b %result%\r\n').encode('ascii'))
(out/'03-start.cmd').write_bytes(b'@echo off\r\nchcp 65001 >nul\r\n"%~dp0runtime\\node.exe" "%~dp0setup.mjs" prestart\r\nif errorlevel 1 goto failed\r\n"%~dp0runtime\\node.exe" "%~dp0host\\src\\console-host.mjs" --config "%~dp0config\\host.json" --start\r\n:failed\r\npause\r\n')
(out/'07-diagnose.cmd').write_bytes(b'@echo off\r\nchcp 65001 >nul\r\n"%~dp0runtime\\node.exe" "%~dp0diagnose.mjs"\r\npause\r\n')
files={p.relative_to(out).as_posix():digest(p) for p in sorted(out.rglob('*')) if p.is_file()}
assert not any('craft-qa' in n or n.endswith('.pdb') or '/test/' in n for n in files)
write('SHA256.json',files)
print(json.dumps({'directory':str(out),'files':len(files),'bytes':sum(p.stat().st_size for p in out.rglob('*') if p.is_file())}))
