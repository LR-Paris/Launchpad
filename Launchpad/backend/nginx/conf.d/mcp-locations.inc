# LR Paris Shuttle MCP server.
#
# Include this from the lrparisstore.com server block, next to the existing
# `include .../shops-locations.inc;` line:
#
#     include /root/Launchpad/backend/nginx/conf.d/mcp-locations.inc;
#
# Do NOT paste it into shops-locations.inc. That file is rewritten by backend/src/nginx.js
# every time a shop is created or deleted, and anything hand-added to it is lost.
#
# proxy_pass has NO trailing slash and NO path, on purpose. With a trailing slash nginx
# strips the matched prefix, the app would see /authorize instead of /mcp/authorize, and
# every discovery URL it publishes would point somewhere that 404s. This has bitten the
# shop locations before. Leave it as it is.

# The MCP endpoint itself is https://lrparisstore.com/mcp, with no trailing slash, so the
# exact-match location is required: `location /mcp/` alone would not match it.
location = /mcp {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Tool calls wait on Launchpad, which waits on docker compose. Two minutes is enough
    # for a restart to report back and short enough that a hung call does not sit forever.
    proxy_read_timeout 120s;
    # Streamable HTTP may answer as an event stream. Buffering would hold it back.
    proxy_buffering off;
}

# Everything else under the prefix: /mcp/authorize, /mcp/token, /mcp/register, /mcp/revoke,
# /mcp/login, /mcp/healthz.
location /mcp/ {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    proxy_buffering off;
}

# OAuth discovery has to live at the root of the domain: a client looking for the
# authorization server for https://lrparisstore.com/mcp asks the host, not the path.
location /.well-known/oauth-authorization-server {
    proxy_pass http://127.0.0.1:3002;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /.well-known/oauth-protected-resource {
    proxy_pass http://127.0.0.1:3002;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
