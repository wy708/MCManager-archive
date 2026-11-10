"""Build the credential-free 0.7.0 host update against the deployed 0.6.0 baseline."""
from pathlib import Path
import hashlib, json, shutil, subprocess, sys, zipfile

repo = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1]).resolve()
if out.exists():
    raise SystemExit('Use a new output directory')
out.mkdir(parents=True)
sha = lambda data: hashlib.sha256(data).hexdigest()
files = {}
for name in ['src/archive.mjs', 'src/cli.mjs', 'src/host-config.mjs', 'src/host-runner.mjs',
             'src/live-files.mjs', 'src/verify-upload.mjs', 'package.json', 'package-lock.json']:
    before = subprocess.check_output(['git', 'show', '3ac08be:backup/' + name], cwd=repo)
    normalized = before.replace(b'\r\n', b'\n')
    after = (repo / 'backup' / name).read_bytes()
    target = out / 'world-backup-update/host' / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(after)
    files['host/' + name] = {'before': sorted({sha(before), sha(normalized), sha(normalized.replace(b'\n', b'\r\n'))}), 'after': sha(after)}
(out / 'world-backup-update/patch.json').write_text(json.dumps({'version': '0.7.0', 'baseline': '3ac08be', 'files': files}, indent=2), encoding='utf-8')
shutil.copy2(repo / 'scripts/windows-package/update-world-backup.mjs', out / 'update-world-backup.mjs')
shutil.copy2(repo / 'docs/世界存档备份.md', out / '使用说明.md')
(out / '更新世界备份.cmd').write_bytes(b'@echo off\r\nchcp 65001 >nul\r\n"%~dp0runtime\\node.exe" "%~dp0update-world-backup.mjs"\r\nset "result=%errorlevel%"\r\npause\r\nexit /b %result%\r\n')
archive = Path(str(out) + '.zip')
with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as z:
    for file in sorted(out.rglob('*')):
        if file.is_file(): z.write(file, file.relative_to(out).as_posix())
print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'sha256': sha(archive.read_bytes())}))
