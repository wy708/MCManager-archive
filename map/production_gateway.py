"""Add public isolated map views and secret upload routes to the existing web port.

Arguments: server UUID, upload-key file, output nginx file, public HTTP(S) origin.
The key file contains only a random 64-character hexadecimal secret.
"""
import pathlib,sys,re,os
from uuid import UUID

server=str(UUID(sys.argv[1]))
key=pathlib.Path(sys.argv[2]).read_text().strip()
if not re.fullmatch('[a-fA-F0-9]{64}',key): raise ValueError('Expected a private upload key')
prefix=f'/maps/{server}/'
origin=(sys.argv[4] if len(sys.argv)>4 else os.environ.get('MCM_PUBLIC_BASE_URL','')).rstrip('/')
if not re.fullmatch(r'https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?',origin):
    raise ValueError('Supply a public HTTP(S) origin without credentials or a path')
root=pathlib.Path(__file__).resolve().parent.parent
base=(root/'frontend/nginx.conf').read_text(encoding='utf-8')
locations=f'''
    set $original_map http://mipmap:8000;
    location ^~ {prefix} {{
        if ($request_method !~ ^(GET|HEAD)$) {{ return 405; }}
        rewrite ^{prefix}(.*)$ /$1 break;
        proxy_set_header Cookie "";
        proxy_set_header Authorization "";
        proxy_set_header Accept-Encoding "";
        proxy_pass $original_map;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
        add_header Access-Control-Allow-Origin "*" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy no-referrer always;
        add_header Content-Security-Policy "sandbox allow-scripts allow-downloads; default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: blob:; font-src 'self'; connect-src {origin}{prefix}; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'none'" always;
        sub_filter_once off;
        sub_filter_types text/css application/javascript text/javascript;
        sub_filter '"/api/' '"{prefix}api/';
        sub_filter '`/api/' '`{prefix}api/';
        sub_filter '"/static/' '"{prefix}static/';
    }}
    location = /upload/{key}/chunks {{
        access_log off;
        client_max_body_size 2m;
        if ($request_method != POST) {{ return 405; }}
        proxy_set_header Cookie "";
        proxy_set_header Authorization "";
        proxy_pass $original_map/api/chunks-data;
    }}
    location = /upload/{key}/players {{
        access_log off;
        client_max_body_size 2m;
        if ($request_method != POST) {{ return 405; }}
        proxy_set_header Cookie "";
        proxy_set_header Authorization "";
        proxy_pass $original_map/api/players-data;
    }}
    location /upload/ {{ access_log off; return 404; }}
    location /maps/ {{ return 404; }}
'''
needle='    location / { try_files $uri $uri/ /index.html; }'
assert needle in base
out=pathlib.Path(sys.argv[3]);out.write_text(base.replace(needle,locations+'\n'+needle),encoding='utf-8')
print(f'Configured public map {prefix} on the existing web port')
