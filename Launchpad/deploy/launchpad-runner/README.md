# launchpad-runner

The Launchpad backend faces the internet, so it has no Docker socket. Docker
actions go to this host service instead, over the unix socket
`/srv/launchpad-runner/runner.sock` (mounted into the backend at
`/run/launchpad-runner`). The backend calls it through `bin/launchpad-runner.js`.

- `runner.py` checks every request. For `up`, it parses the shop's compose file,
  refuses anything Launchpad does not generate (privileged, extra mounts, host
  networking, other images), and runs a rewritten copy with log rotation,
  `no-new-privileges` and dropped capabilities.
- `nginx-promote.py` checks the nginx includes the backend generates, copies
  clean ones to `/etc/nginx/launchpad/`, and reloads nginx. nginx never reads
  the backend's own copy.

Install on the host:

    install -m 0755 runner.py /usr/local/lib/launchpad-runner/runner.py
    install -m 0755 nginx-promote.py /usr/local/sbin/launchpad-nginx-promote
    cp launchpad-runner.service nginx-reload.path nginx-reload.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now launchpad-runner nginx-reload.path
    # nginx: include /etc/nginx/launchpad/shops-locations.inc and mcp-locations.inc

Logs: `journalctl -u launchpad-runner` and `journalctl -u nginx-reload`.
