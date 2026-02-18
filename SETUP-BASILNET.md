# Shuttle Platform — Setup Guide for basilnet

Hey June — here's everything you need to get the Shuttle Platform running on basilnet. Follow these steps in order.

---

## Prerequisites

Make sure these are installed on basilnet:

- **Docker** + **Docker Compose** (v2)
- **Node.js** 20+
- **Git**
- **nginx** (runs via Docker, no system install needed)

Check with:
```bash
docker --version
docker compose version
node --version
git --version
```

---

## 1. Clone the repo

```bash
cd /opt
git clone https://github.com/LR-Paris/Launchpad.git shuttle-platform
cd shuttle-platform
```

---

## 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set a real session secret (must be 32+ characters):

```
SESSION_SECRET=<generate-something-long-here>
FRONTEND_URL=http://basilnet:3000
PORT=3001
NODE_ENV=production
```

To generate a good secret:
```bash
openssl rand -base64 48
```

---

## 3. Create the admin user

```bash
cd backend
npm install
npm run create-admin
```

It will prompt you for a username and password. Pick something strong — this is the only login for the whole platform. Password must be 8+ characters.

Then go back to root:
```bash
cd ..
```

---

## 4. Start everything

```bash
docker compose up -d
```

This launches three containers:
- **backend** on port `3001` — the API
- **frontend** on port `3000` — the admin dashboard
- **nginx-proxy** on port `80` — reverse proxy for shop subdomains

Check they're all running:
```bash
docker compose ps
```

---

## 5. Verify it works

Open in a browser:
```
http://basilnet:3000
```

Log in with the admin credentials you created in step 3. You should see an empty dashboard ready for shops.

Health check from CLI:
```bash
curl http://localhost:3001/api/health
```
Should return `{"status":"ok", ...}`

---

## 6. DNS / subdomain setup for shops

When you create a shop (e.g. slug `paris-store`), the platform generates an nginx config that routes `paris-store.basilnet` to that shop's container.

For this to work on your local network, you need DNS entries pointing `*.basilnet` to the server IP. Options:

**Option A — Local DNS (if you run Pi-hole, dnsmasq, etc.):**
```
address=/basilnet/<SERVER_IP>
```

**Option B — /etc/hosts on each machine that needs access:**
```
<SERVER_IP>  basilnet paris-store.basilnet another-shop.basilnet
```
(You'll need to add each new shop subdomain manually with this approach.)

**Option C — Use a real domain:**
Point a wildcard `*.yourdomain.com` A record to basilnet's IP, then update the nginx config generation in `backend/src/nginx.js` to use your domain instead of `.localhost`.

---

## 7. Creating your first shop

From the dashboard (`http://basilnet:3000`):

1. Click **"+ New Shop"**
2. Enter a name (e.g. "Paris Store")
3. Leave folder path empty to clone from the Shuttle template, OR provide a local path to existing shop files
4. Hit **Deploy Shop**

The platform will:
- Clone/copy the shop files into `shops/paris-store/`
- Write a `.env` and `docker-compose.yml` for it
- Spin up an nginx container on an auto-assigned port (starting at 8100)
- Generate a reverse proxy config so `paris-store.basilnet` routes to it
- Reload nginx

---

## 8. Managing shops

From the dashboard you can:
- **Start / Stop / Restart** any shop's container
- **View Orders** — reads from `shops/<slug>/orders/orders.csv`
- **Download CSV** — raw file download
- **Redeploy** — pulls latest from git (if cloned) and rebuilds
- **Delete** — stops container, removes nginx config, optionally deletes files

---

## 9. Where things live on disk

```
/opt/shuttle-platform/
├── backend/data/        # SQLite DBs (shops, sessions), users.json — DO NOT DELETE
├── shops/               # Each deployed shop gets a folder here
│   ├── paris-store/
│   ├── another-shop/
│   └── ...
├── nginx/conf.d/        # Auto-generated per-shop nginx configs
└── .env                 # Your secrets — never commit this
```

---

## 10. Troubleshooting

**Can't log in:**
- Check that you ran `create-admin` and the file `backend/data/users.json` exists
- Rate limit: 5 login attempts per 15 min. Wait or restart the backend container.

**Shop won't start:**
- Check Docker socket is mounted: `docker compose logs backend`
- Make sure the `shops/<slug>/docker-compose.yml` exists and has the right port

**Subdomain not routing:**
- Verify `nginx/conf.d/<slug>.conf` was generated
- Check nginx-proxy is running: `docker compose ps nginx-proxy`
- Reload manually if needed: `docker exec nginx-proxy nginx -s reload`
- Check your DNS/hosts config from step 6

**Rebuild everything from scratch:**
```bash
docker compose down
docker compose up -d --build
```

---

## 11. Backups

Back up these regularly:
```bash
# The important stuff
tar czf shuttle-backup-$(date +%Y%m%d).tar.gz \
  backend/data/ \
  shops/ \
  .env
```

---

That's it. Once it's running you manage everything from the web dashboard. Ping me if anything breaks.

— L
