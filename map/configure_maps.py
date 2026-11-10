"""Generate isolated original-MipMap services behind one public map port."""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

ROOT = Path(__file__).resolve().parent.parent


def configuration(args):
    env = {}
    if (ROOT / '.env').exists():
        for line in (ROOT / '.env').read_text(encoding='utf-8-sig').splitlines():
            if line.startswith('MCM_') and '=' in line:
                name, value = line.split('=', 1)
                env[name] = value
    env.update(os.environ)
    entries = json.loads(args.config.read_text()) if args.config else [{'serverId': args.server_id, 'keyEnv': 'MCM_MAP_INGEST_KEY'}]
    if not entries:
        raise ValueError('At least one server is required')
    base = args.public_origin.rstrip('/')
    uri = urlsplit(base)
    if uri.scheme not in ('http', 'https') or not uri.netloc or uri.path or uri.query or uri.fragment or uri.username:
        raise ValueError('Public origin must not contain paths or credentials')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    services, volumes, locations, addresses = {}, {}, [], []
    seen_ids, seen_keys = set(), set()
    for index, entry in enumerate(entries):
        server = str(UUID(entry['serverId']))
        secret = env.get(entry['keyEnv'], '')
        if len(secret) != 64 or any(c not in '0123456789abcdefABCDEF' for c in secret):
            raise ValueError('Missing 64-character upload key in ' + entry['keyEnv'])
        if server in seen_ids or secret.lower() in seen_keys:
            raise ValueError('Each map requires a distinct archive identity and upload key')
        seen_ids.add(server)
        seen_keys.add(secret.lower())
        service = 'mipmap' if index == 0 else 'mipmap-' + server.replace('-', '')
        volume = 'map-tiles' if index == 0 else 'map-tiles-' + server.replace('-', '')
        services[service] = {'build': {'context': str(ROOT / 'map')}, 'image': 'mcmanager-mipmap-original:local',
                             'volumes': [volume + ':/app/data'], 'restart': 'unless-stopped', 'cpus': 1.0, 'mem_limit': '768m'}
        volumes[volume] = None
        prefix = '/maps/' + server + '/'
        addresses.append(server + '=' + base + prefix)
        locations.append(f'''    set $map{index} http://{service}:8000;
    location ^~ {prefix} {{
        if ($request_method !~ ^(GET|HEAD)$) {{ return 405; }}
        rewrite ^{prefix}(.*)$ /$1 break;
        proxy_set_header Accept-Encoding "";
        proxy_pass $map{index};
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy no-referrer always;
        sub_filter_once off;
        sub_filter_types text/css application/javascript text/javascript;
        sub_filter '"/api/' '"{prefix}api/';
        sub_filter '`/api/' '`{prefix}api/';
        sub_filter '"/static/' '"{prefix}static/';
    }}
    location = /upload/{secret}/chunks {{
        access_log off;
        if ($request_method != POST) {{ return 405; }}
        proxy_pass $map{index}/api/chunks-data;
    }}
    location = /upload/{secret}/players {{
        access_log off;
        if ($request_method != POST) {{ return 405; }}
        proxy_pass $map{index}/api/players-data;
    }}''')
    first = str(UUID(entries[0]['serverId']))
    nginx = '''server {
    listen 80;
    server_tokens off;
    client_max_body_size 2m;
    resolver 127.0.0.11 valid=10s ipv6=off;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
''' + '\n'.join(locations) + f'''
    location = / {{ return 302 /maps/{first}/; }}
    location /upload/ {{ access_log off; return 404; }}
    location / {{ return 404; }}
}}
'''
    conf = output / 'nginx.conf'
    conf.write_text(nginx)
    try:
        conf.chmod(0o600)
    except OSError:
        pass
    services['backend'] = {'environment': {'MCM_MAP_PUBLIC_URLS': ','.join(addresses)}}
    services['map-web'] = {'image': 'nginx:stable-alpine', 'volumes': [str(conf) + ':/etc/nginx/conf.d/default.conf:ro'],
                           'ports': [f'{args.bind}:{args.port}:80'], 'restart': 'unless-stopped',
                           'depends_on': [key for key in services if key.startswith('mipmap')]}
    compose = output / 'compose.json'
    compose.write_text(json.dumps({'services': services, 'volumes': volumes}, indent=2))
    print(compose)
    print(f'{len(entries)} isolated maps configured on one map port')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--config', type=Path)
    mode.add_argument('--server-id')
    parser.add_argument('--public-origin', default='http://127.0.0.1:18091')
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=18091)
    parser.add_argument('--output', type=Path, default=ROOT / '.tools/map-generated')
    configuration(parser.parse_args())
