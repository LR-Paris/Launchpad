#!/usr/bin/env python3
"""launchpad-runner: the only process on this host that runs docker for Launchpad.

The Launchpad backend faces the internet, so it does not get the Docker socket.
Instead it sends this service one JSON line over a unix socket, and this
service runs a fixed set of actions after checking them:

    {"action": "compose", "slug": "<shop>", "verb": "up"}
    {"action": "compose", "slug": "<shop>", "verb": "down|restart|stop|start"}
    {"action": "compose", "slug": "<shop>", "verb": "ps"}
    {"action": "compose", "slug": "<shop>", "verb": "logs", "tail": 200, "timestamps": false}
    {"action": "self-rebuild"}
    {"action": "ping"}

Shop compose files sit in folders the backend and the shop itself can write, so
they are never handed to docker as-is. For "up", the file is parsed, checked
against the shape Launchpad generates, and re-emitted with only the allowed
keys plus forced hardening. Anything unexpected is refused, and the refusal is
logged. The other verbs act on the compose project by name and read no file.

Reply: one JSON line, {"code": <exit code>, "output": "<text>"}.
"""
import json
import os
import re
import socket
import socketserver
import subprocess
import sys
import threading
import time

import yaml

SOCK_DIR = '/srv/launchpad-runner'
SOCK = os.path.join(SOCK_DIR, 'runner.sock')
SHOPS = '/root/Launchpad/shops'
LAUNCHPAD_DIR = '/root/Launchpad'
LAUNCHPAD_COMPOSE = os.path.join(LAUNCHPAD_DIR, 'docker-compose.yml')
OUT_DIR = '/var/lib/launchpad-runner/compose'

SLUG_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,62}$')
IMAGE_RE = re.compile(r'^node:2[0-9]-alpine$')
ENV_KEY_RE = re.compile(r'^[A-Z][A-Z0-9_]{0,63}$')
PORT_RE = re.compile(r'^127\.0\.0\.1:(\d{4,5}):3000$')
RESERVED_PORTS = {3000, 3001, 3002}
SERVICE_KEYS = {'image', 'working_dir', 'volumes', 'ports', 'environment', 'command', 'restart', 'logging'}
RESTART_VALUES = {'no', 'always', 'unless-stopped', 'on-failure'}
PROJECT_VERBS = {'down', 'restart', 'stop', 'start'}

# Applied to every shop container started through the runner.
FORCED = {
    'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}},
    'security_opt': ['no-new-privileges:true'],
    'cap_drop': ['NET_RAW', 'MKNOD', 'SYS_CHROOT', 'SETFCAP', 'AUDIT_WRITE'],
}

MAX_OUTPUT = 2_000_000
mutate_lock = threading.Lock()


class Refused(Exception):
    pass


def log(msg):
    print(f'{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())} {msg}', flush=True)


def check_slug(slug):
    if not isinstance(slug, str) or not SLUG_RE.match(slug):
        raise Refused('bad shop name')
    if not os.path.isdir(os.path.join(SHOPS, slug)):
        raise Refused(f'no shop folder for {slug}')


def sanitize(slug):
    """Return the path of a checked, rewritten compose file for this shop."""
    path = os.path.join(SHOPS, slug, 'docker-compose.yml')
    if not os.path.isfile(path):
        raise Refused(f'no docker-compose.yml for {slug}')
    with open(path) as f:
        doc = yaml.safe_load(f)
    if not isinstance(doc, dict):
        raise Refused('compose file is not a mapping')
    extra = set(doc) - {'version', 'services'}
    if extra:
        raise Refused(f'unexpected top-level keys {sorted(extra)}')
    services = doc.get('services')
    if not isinstance(services, dict) or set(services) != {'web'}:
        raise Refused('expected exactly one service, named web')
    web = services['web']
    if not isinstance(web, dict):
        raise Refused('service web is not a mapping')
    extra = set(web) - SERVICE_KEYS
    if extra:
        raise Refused(f'service web has keys Launchpad does not generate: {sorted(extra)}')

    image = str(web.get('image', ''))
    if not IMAGE_RE.match(image):
        raise Refused(f'image {image!r} is not node:2N-alpine')
    if web.get('working_dir', '/app') != '/app':
        raise Refused('working_dir must be /app')
    volume = f'{SHOPS}/{slug}:/app'
    if web.get('volumes') != [volume]:
        raise Refused(f'volumes must be exactly [{volume}]')

    ports = web.get('ports')
    if not (isinstance(ports, list) and len(ports) == 1):
        raise Refused('expected exactly one port mapping')
    m = PORT_RE.match(str(ports[0]))
    if not m or not 1024 < int(m.group(1)) < 65536 or int(m.group(1)) in RESERVED_PORTS:
        raise Refused(f'port mapping {ports[0]!r} is not allowed')

    env = web.get('environment') or []
    if isinstance(env, dict):
        env = [f'{k}={"" if v is None else v}' for k, v in env.items()]
    if not isinstance(env, list):
        raise Refused('environment must be a list')
    clean_env = []
    for entry in env:
        if not isinstance(entry, str) or '=' not in entry:
            raise Refused(f'bad environment entry {entry!r}')
        key, value = entry.split('=', 1)
        if not ENV_KEY_RE.match(key) or '\n' in value or len(value) > 4096:
            raise Refused(f'bad environment entry for {key!r}')
        clean_env.append(f'{key}={value}')

    command = web.get('command')
    if command is not None and not isinstance(command, str):
        raise Refused('command must be a string')
    restart = web.get('restart', 'unless-stopped')
    if restart is False:
        restart = 'no'
    if restart not in RESTART_VALUES:
        raise Refused(f'restart {restart!r} is not allowed')

    service = {
        'image': image,
        'working_dir': '/app',
        'volumes': [volume],
        'ports': [str(ports[0])],
        'environment': clean_env,
        'restart': restart,
    }
    if command is not None:
        service['command'] = command
    service.update(FORCED)

    os.makedirs(OUT_DIR, mode=0o700, exist_ok=True)
    dest = os.path.join(OUT_DIR, f'{slug}.yml')
    with open(dest + '.tmp', 'w') as f:
        yaml.safe_dump({'services': {'web': service}}, f, sort_keys=False, default_flow_style=False)
    os.replace(dest + '.tmp', dest)
    return dest


def run(cmd, timeout, cwd=None):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    out = (p.stdout or '') + (p.stderr or '')
    return p.returncode, out[-MAX_OUTPUT:]


def compose(req):
    slug, verb = req.get('slug'), req.get('verb')
    check_slug(slug)
    if verb == 'up':
        f = sanitize(slug)
        with mutate_lock:
            return run(['docker', 'compose', '-p', slug, '-f', f, 'up', '-d'], 600)
    if verb in PROJECT_VERBS:
        with mutate_lock:
            return run(['docker', 'compose', '-p', slug, verb], 300)
    if verb == 'ps':
        return run(['docker', 'compose', '-p', slug, 'ps', '--format', 'json'], 60)
    if verb == 'logs':
        tail = req.get('tail', 200)
        if not isinstance(tail, int) or not 1 <= tail <= 10000:
            raise Refused('tail must be 1-10000')
        cmd = ['docker', 'compose', '-p', slug, 'logs', f'--tail={tail}']
        if req.get('timestamps') is True:
            cmd.append('--timestamps')
        return run(cmd, 60)
    raise Refused(f'verb {verb!r} is not allowed')


def self_rebuild():
    """Rebuild Launchpad itself from its own compose file, which the backend
    container cannot write (the project is mounted read-only there)."""
    def later():
        time.sleep(5)
        with mutate_lock:
            code, out = run(['docker', 'compose', '-f', LAUNCHPAD_COMPOSE, 'up', '-d', '--build'],
                            1800, cwd=LAUNCHPAD_DIR)
        log(f'self-rebuild finished code={code} {out[-500:]!r}')
    threading.Thread(target=later, daemon=True).start()
    return 0, 'Rebuild scheduled. Launchpad restarts in about 30 seconds.'


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        started = time.time()
        req = {}
        try:
            line = self.rfile.readline(65536)
            req = json.loads(line or b'{}')
            if not isinstance(req, dict):
                raise Refused('request must be a JSON object')
            action = req.get('action')
            if action == 'compose':
                code, out = compose(req)
            elif action == 'self-rebuild':
                code, out = self_rebuild()
            elif action == 'ping':
                code, out = 0, 'pong'
            else:
                raise Refused(f'unknown action {action!r}')
        except Refused as e:
            code, out = 2, f'launchpad-runner refused: {e}'
        except subprocess.TimeoutExpired:
            code, out = 124, 'launchpad-runner: docker timed out'
        except Exception as e:  # noqa: BLE001 - report, never crash the server
            code, out = 1, f'launchpad-runner error: {type(e).__name__}: {e}'
        if req.get('verb') not in ('ps', 'logs') or code != 0:
            log(f'action={req.get("action")} slug={req.get("slug")} verb={req.get("verb")} '
                f'code={code} {time.time() - started:.1f}s' + (f' :: {out[:300]!r}' if code else ''))
        try:
            self.wfile.write((json.dumps({'code': code, 'output': out}) + '\n').encode())
        except BrokenPipeError:
            pass


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    os.makedirs(SOCK_DIR, mode=0o700, exist_ok=True)
    if os.path.exists(SOCK):
        os.unlink(SOCK)
    srv = Server(SOCK, Handler)
    os.chmod(SOCK, 0o600)
    log(f'listening on {SOCK}')
    srv.serve_forever()


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--check':
        # Dry run: validate one shop's compose file and print the rewritten one.
        try:
            dest = sanitize(sys.argv[2])
            print(open(dest).read())
        except Refused as e:
            print(f'REFUSED: {e}')
            sys.exit(2)
        sys.exit(0)
    main()
