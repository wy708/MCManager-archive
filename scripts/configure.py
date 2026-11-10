"""Create fresh deployment credentials without overwriting existing configuration."""
import argparse
import ipaddress
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlsplit

def configure():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-url', required=True)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8088)
    parser.add_argument('--username', default='admin')
    args = parser.parse_args()
    url = urlsplit(args.public_url)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        parser.error('--public-url must be an HTTP(S) origin without credentials or a path')
    try:
        port = url.port
    except ValueError:
        parser.error('Invalid public URL port')
    if re.search(r'[\s\x00-\x1f"\'\\$#]', args.public_url):
        parser.error('Unsupported characters in public URL')
    if url.scheme == 'http' and url.hostname not in ('localhost', '127.0.0.1', '::1'):
        parser.error('Use HTTPS for non-loopback public access')
    try:
        bind = ipaddress.ip_address(args.bind)
    except ValueError:
        parser.error('--bind must be an IP address')
    if bind.version != 4:
        parser.error('This Compose binding helper requires IPv4')
    if not 1 <= args.port <= 65535 or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', args.username):
        parser.error('Invalid port or administrator name')
    values = {
        'MCM_ADMIN_USERNAME': args.username,
        'MCM_ADMIN_PASSWORD': secrets.token_hex(24),
        'MCM_DB_PASSWORD': secrets.token_hex(24),
        'MCM_PUBLIC_BASE_URL': args.public_url.rstrip('/'),
        'MCM_COOKIE_SECURE': str(url.scheme == 'https').lower(),
        'MCM_WEB_BIND': args.bind,
        'MCM_WEB_PORT': str(args.port),
        'MCM_STATISTICS_ZONE': 'Asia/Shanghai',
        'MCM_BACKUP_POLICY_WORKER_ENABLED': 'true',
    }
    destination = Path.cwd() / '.env'
    try:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        parser.error('.env already exists; no files changed')
    with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
        stream.write('# Private deployment configuration. Do not commit or share.\n')
        stream.writelines(f'{key}={value}\n' for key, value in values.items())
    print('Created .env. Read MCM_ADMIN_USERNAME and MCM_ADMIN_PASSWORD privately to sign in.')
    print('Run: docker compose up -d --build')

if __name__ == '__main__':
    configure()
