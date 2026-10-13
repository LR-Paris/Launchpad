#!/usr/bin/env python3
"""launchpad-nginx-promote: check Launchpad's generated nginx includes, then
copy them where nginx reads them and reload.

The backend writes shops-locations.inc into a folder it can modify. nginx must
never include that file directly, because nginx reads its config as root and an
injected directive (an access_log path, an alias, a second server block) would
run with that power. So every line has to match a shape Launchpad generates.
A clean file goes to /etc/nginx/launchpad/. A file with anything else is
refused, the last good copy stays live, and the refusal is logged.

Runs from nginx-reload.service, which a systemd path unit starts whenever the
backend rewrites an include or touches .nginx-reload-trigger.
"""
import os
import re
import shutil
import subprocess
import sys
import time

SOURCES = {
    'shops-locations.inc': '/root/Launchpad/backend/nginx/conf.d/shops-locations.inc',
    'mcp-locations.inc': '/root/Launchpad/backend/nginx/conf.d/mcp-locations.inc',
}
DEST_DIR = '/etc/nginx/launchpad'

SLUG = r'[a-z0-9][a-z0-9-]{0,62}'
OPENERS = [
    re.compile(rf'^location /{SLUG}/ \{{$'),
    re.compile(r'^location = /mcp \{$'),
    re.compile(r'^location /mcp/ \{$'),
    re.compile(r'^location /\.well-known/oauth-(authorization-server|protected-resource) \{$'),
]
DIRECTIVES = [
    re.compile(r'^proxy_pass http://127\.0\.0\.1:(?P<port>\d{4,5});$'),
    re.compile(r'^proxy_http_version 1\.1;$'),
    re.compile(r'^proxy_set_header (Upgrade \$http_upgrade|Connection \'upgrade\'|Connection "upgrade"'
               r'|Host \$host|X-Real-IP \$remote_addr|X-Forwarded-For \$proxy_add_x_forwarded_for'
               r'|X-Forwarded-Proto \$scheme);$'),
    re.compile(r'^proxy_cache_bypass \$http_upgrade;$'),
    re.compile(r'^proxy_(read|send|connect)_timeout \d{1,4}s;$'),
    re.compile(r'^proxy_buffering off;$'),
    re.compile(r'^auth_basic "[A-Za-z0-9 .,\'!-]{1,80}";$'),
    re.compile(rf'^auth_basic_user_file /etc/nginx/\.htpasswd-{SLUG};$'),
]


def log(msg):
    print(f'{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())} {msg}', flush=True)


def check(text):
    depth = 0
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if depth == 0:
            if any(p.match(line) for p in OPENERS):
                depth = 1
                continue
            return f'line {n}: only location blocks are allowed here: {line[:80]!r}'
        if line == '}':
            depth = 0
            continue
        for p in DIRECTIVES:
            m = p.match(line)
            if m:
                port = m.groupdict().get('port')
                if port and not 1024 < int(port) < 65536:
                    return f'line {n}: port {port} out of range'
                break
        else:
            return f'line {n}: directive not allowed: {line[:80]!r}'
    if depth != 0:
        return 'unclosed location block'
    return None


def nginx_ok():
    p = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
    return p.returncode == 0, (p.stderr or p.stdout)[-600:]


def main():
    os.makedirs(DEST_DIR, mode=0o755, exist_ok=True)
    changed, previous = [], {}
    for name, src in SOURCES.items():
        dest = os.path.join(DEST_DIR, name)
        try:
            text = open(src).read()
        except FileNotFoundError:
            log(f'{name}: source missing, keeping the current copy')
            continue
        problem = check(text)
        if problem:
            log(f'REFUSED {name}: {problem}. The last good copy stays live.')
            continue
        old = open(dest).read() if os.path.exists(dest) else None
        if old == text:
            continue
        previous[name] = old
        with open(dest + '.tmp', 'w') as f:
            f.write(text)
        os.replace(dest + '.tmp', dest)
        changed.append(name)

    if not changed and '--force-reload' not in sys.argv:
        log('nothing changed')
        return 0

    ok, out = nginx_ok()
    if not ok:
        for name, old in previous.items():
            dest = os.path.join(DEST_DIR, name)
            if old is None:
                os.unlink(dest)
            else:
                with open(dest, 'w') as f:
                    f.write(old)
        log(f'nginx -t failed with the new includes, restored the previous ones: {out!r}')
        return 1
    subprocess.run(['systemctl', 'reload', 'nginx'], check=False)
    log(f'promoted {", ".join(changed) or "(forced)"} and reloaded nginx')
    return 0


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--check':
        problem = check(open(sys.argv[2]).read())
        print(problem or 'OK')
        sys.exit(1 if problem else 0)
    sys.exit(main())
