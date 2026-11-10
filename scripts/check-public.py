"""Check public source paths, accidental secrets and relative documentation links."""
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote

root=Path(__file__).resolve().parent.parent
try:
    names=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
except subprocess.CalledProcessError:
    names=[]
if not any(names):
    names=[p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() and not set(p.relative_to(root).parts)&{'.git','.tools','node_modules','target','dist','test-results','__pycache__'}]
errors=[]
secret=re.compile(r'mcm(?:agent|collector|host)\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}')
personal=re.compile(r'[A-Za-z]:[\\/]+Users[\\/]+(?!Public[\\/]|Example[\\/])[^\s"\']+',re.I)
for name in filter(None,names):
    path=root/name
    if path.is_symlink(): errors.append(name+': symlink');continue
    if path.name=='.env' or path.name.endswith(('.private.json','.private','.log','.pdb')) or 'worlds' in path.parts:
        errors.append(name+': private/runtime path')
    try: text=path.read_text(encoding='utf-8')
    except UnicodeDecodeError: continue
    if personal.search(text):errors.append(name+': personal home path')
    if secret.search(text) and '/test/' not in name and '/tests/' not in name and '/e2e/' not in name:
        errors.append(name+': possible live credential')
    if path.suffix=='.md':
        for raw in re.findall(r'\]\(([^)]+)\)|(?:src|href)="([^"]+)"',text):
            target=next(x for x in raw if x).split(' "')[0]
            if re.match(r'^[a-z]+:',target) or target.startswith(('#','//')):continue
            target=unquote(target.split('#')[0])
            if target and not (path.parent/target).exists():errors.append(name+': broken link '+target)
if errors:
    print('\n'.join(errors));sys.exit(1)
print(f'Public source checks passed: {len(list(filter(None,names)))} files')
