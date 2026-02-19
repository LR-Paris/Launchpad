# Launchpad + Shuttle — Digital Ocean Setup Guide

Deploy Launchpad (the shop management dashboard) and Shuttle (shop instances) on a Digital Ocean Droplet with Nginx reverse proxy and optional SSL.

---

## What you'll end up with

- **Launchpad dashboard** at `https://yourdomain.com`
- **Shuttle shops** at `https://shopname.yourdomain.com`
- Nginx reverse proxy handling routing + SSL
- Auto-renewing Let's Encrypt certificates
- Everything running in Docker

---

## Prerequisites

- A **Digital Ocean account**
- A **domain name** pointed at Digital Ocean's nameservers (or an A record pointing to your droplet)
- An **SSH key** added to your DO account

---

## Step 1 — Create a Droplet

From the Digital Ocean dashboard, create a new droplet:

| Setting        | Recommended value                         |
|----------------|-------------------------------------------|
| **Image**      | Ubuntu 24.04 LTS                          |
| **Plan**       | Basic — $12/mo (2 GB RAM / 1 vCPU) minimum. Use $24/mo (4 GB) if running many shops. |
| **Region**     | Closest to your users                     |
| **Auth**       | SSH key (recommended)                     |
| **Hostname**   | `launchpad` (or whatever you prefer)      |

Wait for the droplet to boot, then note its **IP address**.

---

## Step 2 — Point your domain

Add DNS records pointing to your droplet's IP. You need both the root domain and a wildcard for shop subdomains.

| Type | Name | Value            |
|------|------|------------------|
| A    | @    | `<droplet-ip>`   |
| A    | *    | `<droplet-ip>`   |

If you're using Digital Ocean's DNS (Networking → Domains), add both records there. If using an external registrar, add them at your registrar's DNS settings.

**Wait for DNS to propagate** before proceeding. You can verify with:

```bash
dig +short yourdomain.com
dig +short test.yourdomain.com
```

Both should return your droplet's IP.

---

## Step 3 — SSH into the droplet

```bash
ssh root@<droplet-ip>
```

---

## Step 4 — Run the setup script (automated)

The quickest path. This installs Docker, clones the repo, generates configs, builds everything, and sets up SSL.

```bash
# Install git if needed
apt update && apt install -y git

# Clone and run
git clone https://github.com/LR-Paris/Launchpad.git /opt/launchpad
cd /opt/launchpad

# With SSL (recommended)
bash scripts/setup-digitalocean.sh \
  --domain yourdomain.com \
  --email you@example.com

# Without SSL (HTTP only)
bash scripts/setup-digitalocean.sh \
  --domain yourdomain.com \
  --skip-ssl
```

Skip to **Step 9** if using the automated script.

---

## Step 5 — Manual setup: Install Docker

If you prefer to set things up manually instead of using the script:

```bash
curl -fsSL https://get.docker.com | sh
```

Verify:

```bash
docker --version
docker compose version
```

---

## Step 6 — Manual setup: Clone and configure

```bash
git clone https://github.com/LR-Paris/Launchpad.git /opt/launchpad
cd /opt/launchpad
```

Create required directories:

```bash
mkdir -p shops nginx/conf.d backend/data certbot/conf certbot/www
```

Generate your `.env`:

```bash
cat > .env <<EOF
SESSION_SECRET=$(openssl rand -hex 32)
FRONTEND_URL=https://yourdomain.com
PORT=3001
NODE_ENV=production
COOKIE_SECURE=true
BASE_DOMAIN=yourdomain.com
EOF
```

Replace `yourdomain.com` with your actual domain. If not using SSL, change `FRONTEND_URL` to `http://...` and set `COOKIE_SECURE=false`.

---

## Step 7 — Manual setup: Configure Nginx

Create the Launchpad nginx config that serves the frontend and proxies the API:

```bash
cat > nginx/conf.d/launchpad.conf <<'NGINX'
server {
    listen 80;
    server_name yourdomain.com;

    # Let's Encrypt challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location /api/ {
        proxy_pass http://backend:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
NGINX
```

Replace `yourdomain.com` with your domain.

---

## Step 8 — Manual setup: Build and start

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

This starts three services:

| Service         | Purpose                                    |
|-----------------|--------------------------------------------|
| **backend**     | Express API (port 3001, internal)          |
| **frontend**    | Builds React app, copies to shared volume  |
| **nginx-proxy** | Serves frontend + proxies API + shop routes |

Check that everything is running:

```bash
docker compose -f docker-compose.prod.yml ps
```

---

## Step 9 — Create your admin account

```bash
cd /opt/launchpad
docker compose -f docker-compose.prod.yml exec -it backend npm run create-admin
```

Enter a username and password (8+ characters). This is how you log in to the dashboard.

---

## Step 10 — Set up SSL (if not using the script)

Get your initial certificate:

```bash
docker run --rm \
  -v /opt/launchpad/certbot/conf:/etc/letsencrypt \
  -v /opt/launchpad/certbot/www:/var/www/certbot \
  certbot/certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email you@example.com \
  --agree-tos \
  --no-eff-email \
  -d yourdomain.com
```

Add the SSL server block:

```bash
cat > nginx/conf.d/launchpad-ssl.conf <<'NGINX'
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location /api/ {
        proxy_pass http://backend:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
NGINX
```

Update the HTTP block to redirect to HTTPS:

```bash
cat > nginx/conf.d/launchpad.conf <<'NGINX'
server {
    listen 80;
    server_name yourdomain.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
NGINX
```

Reload nginx and start auto-renewal:

```bash
docker exec nginx-proxy nginx -s reload
docker compose -f docker-compose.prod.yml --profile ssl up -d certbot
```

---

## Shop subdomain SSL

For shop subdomains (`shopname.yourdomain.com`) to work over HTTPS, you need a wildcard certificate. This requires DNS validation instead of HTTP:

```bash
docker run -it --rm \
  -v /opt/launchpad/certbot/conf:/etc/letsencrypt \
  certbot/certbot certonly \
  --manual \
  --preferred-challenges dns \
  --email you@example.com \
  --agree-tos \
  -d "*.yourdomain.com"
```

Certbot will ask you to create a TXT record. Add it in your DNS settings, wait for propagation, then confirm. After that, add a wildcard SSL block:

```bash
cat > nginx/conf.d/shops-ssl.conf <<'NGINX'
server {
    listen 443 ssl;
    server_name *.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        # Individual shop configs handle routing via server_name
        return 404;
    }
}
NGINX
```

Then reload: `docker exec nginx-proxy nginx -s reload`

---

## Managing Launchpad

All commands should be run from `/opt/launchpad`:

```bash
cd /opt/launchpad

# View status
docker compose -f docker-compose.prod.yml ps

# View logs
docker compose -f docker-compose.prod.yml logs -f
docker compose -f docker-compose.prod.yml logs -f backend

# Restart
docker compose -f docker-compose.prod.yml restart

# Stop
docker compose -f docker-compose.prod.yml down

# Rebuild after updates
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

---

## Updating

```bash
cd /opt/launchpad
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

Data in `backend/data/`, `shops/`, and `nginx/conf.d/` persists across rebuilds.

---

## Architecture overview

```
                    ┌─────────────────────────────────────────┐
                    │            Digital Ocean Droplet         │
Internet ──────────▶│                                         │
                    │  ┌──────────────────────────────────┐   │
        :80/:443    │  │         nginx-proxy               │   │
       ─────────────┼─▶│                                   │   │
                    │  │  yourdomain.com → frontend files  │   │
                    │  │  yourdomain.com/api → backend     │   │
                    │  │  shop.yourdomain.com → shop:PORT  │   │
                    │  └──────┬──────────────┬─────────────┘   │
                    │         │              │                  │
                    │  ┌──────▼──────┐ ┌─────▼──────────┐      │
                    │  │  backend    │ │  shop containers│      │
                    │  │  :3001      │ │  :8100, :8101.. │      │
                    │  │  Express    │ │  (Shuttle)      │      │
                    │  │  SQLite     │ │                 │      │
                    │  └─────────────┘ └────────────────┘      │
                    └─────────────────────────────────────────┘
```

---

## Ports

Only ports 80 and 443 need to be open to the internet. The backend (3001) and shop ports (8100+) are proxied through nginx and should not be directly exposed.

| Port | Exposed? | Purpose                  |
|------|----------|--------------------------|
| 80   | Yes      | HTTP (+ Let's Encrypt)   |
| 443  | Yes      | HTTPS                    |
| 3001 | No       | Backend API (internal)   |
| 8100+| No       | Shop containers (internal)|

---

## Troubleshooting

**Frontend shows blank page**
- Check that the frontend build completed: `docker compose -f docker-compose.prod.yml logs frontend`
- Rebuild: `docker compose -f docker-compose.prod.yml up -d --build frontend`

**"502 Bad Gateway" on /api**
- Backend might not be running: `docker compose -f docker-compose.prod.yml ps backend`
- Check backend logs: `docker compose -f docker-compose.prod.yml logs backend`

**Shop subdomains not resolving**
- Verify the wildcard DNS record: `dig +short anyname.yourdomain.com`
- Check that `BASE_DOMAIN` is set in `.env`
- Regenerate shop configs by restarting backend

**SSL certificate issues**
- Verify DNS is pointing to the droplet: `dig +short yourdomain.com`
- Check certbot logs: `docker compose -f docker-compose.prod.yml logs certbot`
- Manual renewal: `docker run --rm -v /opt/launchpad/certbot/conf:/etc/letsencrypt -v /opt/launchpad/certbot/www:/var/www/certbot certbot/certbot renew`

**Docker socket permission denied**
- Ensure the socket exists: `ls -la /var/run/docker.sock`
- The backend container needs access — this is handled by the volume mount

**Running out of disk space**
- Clean up unused Docker images: `docker system prune -a`
- Check disk: `df -h`

---

## Recommended Droplet sizing

| Shops | Droplet Plan               | RAM  | vCPUs |
|-------|----------------------------|------|-------|
| 1–5   | Basic $12/mo               | 2 GB | 1     |
| 5–15  | Basic $24/mo               | 4 GB | 2     |
| 15–30 | Basic $48/mo               | 8 GB | 4     |
| 30+   | Consider multiple droplets | —    | —     |

Each Shuttle shop runs its own Node.js container, so RAM is the main constraint.
