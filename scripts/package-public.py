"""Create source/MCP/host release archives from committed public sources only."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',required=True)
args=parser.parse_args()
out=Path(args.output).resolve()
if out.exists():parser.error('Use a fresh output directory')
subprocess.run(['python' if __import__('os').name=='nt' else 'python3',str(root/'scripts/check-public.py')],cwd=root,check=True)
if subprocess.check_output(['git','status','--porcelain','--untracked-files=normal'],cwd=root).strip():
    parser.error('Commit the public tree before packaging')
version=(root/'VERSION').read_text().strip()
files=list(filter(None,subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')))
out.mkdir(parents=True)
def archive(name,selected):
    path=out/(name+'.zip')
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for rel in sorted(selected):
            source=root/rel
            if source.is_symlink():raise ValueError('Symlink in source')
            info=zipfile.ZipInfo(name+'/'+rel,date_time=(2026,1,1,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=(0o100755 if rel.endswith('/mvnw') else 0o100644)<<16
            z.writestr(info,source.read_bytes())
    return path
bundles=[archive('MCManager-Archive-'+version+'-source',files)]
common=[p for p in files if p in ['LICENSE','THIRD_PARTY_NOTICES.md','release.json','VERSION'] or p.startswith(('licenses/','docs/'))]
for component,label in [('mcp','MCP'),('backup','Host')]:
    v=json.loads((root/component/'package.json').read_text())['version']
    selected=[p for p in files if p.startswith(component+'/') and '/test/' not in p]
    bundles.append(archive('MCManager-'+label+'-'+v+'-source',selected+common))
(out/'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in bundles),encoding='utf-8')
print(json.dumps([{'file':p.name,'bytes':p.stat().st_size} for p in bundles],indent=2))
