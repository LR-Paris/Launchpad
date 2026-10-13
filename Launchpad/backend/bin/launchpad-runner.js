#!/usr/bin/env node
// launchpad-runner client. The backend has no Docker access of its own. Every
// docker action goes to the host's launchpad-runner service over a unix socket,
// and the host checks it first (deploy/launchpad-runner/runner.py).
//
// The arguments mirror the docker compose calls the backend used to make, so
// call sites only swap `docker compose` for `launchpad-runner compose`:
//
//   launchpad-runner compose -f <...>/shops/<slug>/docker-compose.yml up -d [--build]
//   launchpad-runner compose -f <...>/shops/<slug>/docker-compose.yml down|restart|stop|start
//   launchpad-runner compose -f <...>/shops/<slug>/docker-compose.yml ps --format json
//   launchpad-runner compose -f <...>/shops/<slug>/docker-compose.yml logs --tail=200 [--timestamps]
//   launchpad-runner self-rebuild
//   launchpad-runner ping
const net = require('net');

const SOCK = process.env.LAUNCHPAD_RUNNER_SOCK || '/run/launchpad-runner/runner.sock';
const args = process.argv.slice(2);

function fail(msg, code = 2) {
  process.stderr.write(`launchpad-runner: ${msg}\n`);
  process.exit(code);
}

function parse() {
  if (args[0] === 'self-rebuild') return { action: 'self-rebuild' };
  if (args[0] === 'ping') return { action: 'ping' };
  if (args[0] !== 'compose') fail('unknown command');

  const rest = args.slice(1);
  const fi = rest.indexOf('-f');
  if (fi < 0 || !rest[fi + 1]) fail('compose needs -f <shops/<slug>/docker-compose.yml>');
  const m = /\/shops\/([a-z0-9][a-z0-9-]{0,62})\/docker-compose\.yml$/.exec(rest[fi + 1]);
  if (!m) fail(`not a shop compose file: ${rest[fi + 1]}`);
  const words = rest.filter((a, i) => i !== fi && i !== fi + 1);
  const verb = words.find((w) => !w.startsWith('-'));
  if (!verb) fail('compose needs a verb');

  const req = { action: 'compose', slug: m[1], verb };
  if (verb === 'logs') {
    const t = words.find((w) => w.startsWith('--tail='));
    req.tail = t ? parseInt(t.slice(7), 10) : 200;
    req.timestamps = words.includes('--timestamps');
  }
  return req;
}

const req = parse();
const conn = net.createConnection(SOCK);
let buf = '';
conn.setTimeout(30 * 60 * 1000, () => fail('timed out waiting for the runner', 1));
conn.on('connect', () => conn.write(JSON.stringify(req) + '\n'));
conn.on('data', (d) => { buf += d; });
conn.on('end', () => {
  let reply;
  try { reply = JSON.parse(buf); } catch { fail('bad reply from the runner', 1); }
  const out = reply.output || '';
  const text = out.endsWith('\n') || !out ? out : `${out}\n`;
  if (reply.code === 0) process.stdout.write(text);
  else process.stderr.write(text);
  process.exit(Number.isInteger(reply.code) ? reply.code : 1);
});
conn.on('error', (e) => fail(`cannot reach the runner at ${SOCK}: ${e.message}`, 1));
