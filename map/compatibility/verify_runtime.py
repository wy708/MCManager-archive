"""Check the reviewed artifact before pip and its installed native files afterwards."""
import argparse, hashlib, json
from pathlib import Path
from zipfile import ZipFile

parser=argparse.ArgumentParser()
parser.add_argument('--wheel',type=Path)
parser.add_argument('--installed',type=Path)
args=parser.parse_args()
manifest=json.loads(Path(__file__).with_name('verified-artifacts.json').read_text())
sha=lambda content: hashlib.sha256(content).hexdigest()
def require(condition,message):
    if not condition:
        raise ValueError(message)
if args.wheel:
    require(sha(args.wheel.read_bytes())==manifest['wheelSha256'], 'Unreviewed runtime wheel SHA256')
    with ZipFile(args.wheel) as archive:
        names=archive.namelist()
        for target,digest in manifest['files'].items():
            matches=[name for name in names if name==target or name.endswith('.data/data/'+target)]
            require(len(matches)==1, 'Missing or ambiguous wheel member: '+target)
            require(sha(archive.read(matches[0]))==digest, 'Native artifact mismatch: '+target)
        metadata=[name for name in names if name.endswith('.dist-info/METADATA')]
        require(len(metadata)==1,'Missing or ambiguous wheel metadata')
        require('\nVersion: '+manifest['wheelVersion']+'\n' in archive.read(metadata[0]).decode().replace('\r\n','\n'),'Wheel version mismatch')
if args.installed:
    for target,digest in manifest['files'].items():
        require(sha((args.installed/target).read_bytes())==digest, 'Installed artifact mismatch: '+target)
    installed=json.loads((args.installed/'manifest.json').read_text())
    require(installed['name']=='EndstoneRuntime' and installed['entry']=='endstone_runtime.dll','Installed runtime entry mismatch')
    require(installed['version']==manifest['modVersion'], 'Installed runtime profile mismatch')
require(args.wheel or args.installed, 'Provide --wheel and/or --installed')
print('Reviewed map runtime artifact checks passed.')
