# Launchpad Setup Guide for Basilnet

Hey June! This is the step-by-step guide to get Launchpad (clawdbot's shop management platform) up and running on basilnet. Follow it from top to bottom and you should be good.

---

## Prerequisites

Make sure basilnet has the following installed before starting:

- **Git** (to clone the repo)
- **Docker** and **Docker Compose** (to run everything)
- **Node.js 20+** (only needed if you want to run things outside Docker)

### Quick check

```bash
git --version
docker --version
docker compose version
```

If any of those fail, install them first:

```bash
# Docker (official convenience script)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in after this so the group takes effect

# Git (if missing)
sudo apt update && sudo apt install -y git
```

---

## Step 1 — Clone the repo

```bash
cd ~
git clone https://github.com/LR-Paris/Launchpad.git
cd Launchpad
```

---

## Step 2 — Create your environment file

Copy the example and fill in your own values:

```bash
cp .env.example .env
```

Now edit `.env`:

```bash
nano .env
```

Update it to look like this (change the values to your own):

```env
# Generate a random secret — must be at least 32 characters
# You can run this to make one:  openssl rand -hex 32
SESSION_SECRET=PUT_YOUR_RANDOM_SECRET_HERE

# Set this to basilnet's actual IP on the LAN
# Example: http://192.168.68.59:3000
FRONTEND_URL=http://<basilnet-ip>:3000

# Backend port (3001 is the default, fine to leave as-is)
PORT=3001

# Set to production for the real deal
NODE_ENV=production

# Leave false unless you set up HTTPS
COOKIE_SECURE=false
```

Save and close (`Ctrl+X`, then `Y`, then `Enter` in nano).

---

## Step 3 — Create required directories

These directories need to exist before Docker starts:

```bash
mkdir -p shops nginx/conf.d backend/data
```

---

## Step 4 — Build and start everything

```bash
docker compose up -d --build
```

This builds and starts two services:

| Service      | Port | What it does                  |
|--------------|------|-------------------------------|
| **backend**  | 3001 | API server (Express + SQLite) |
| **frontend** | 3000 | Web dashboard (React + Vite)  |

The nginx reverse proxy is optional — only needed if you're routing shop subdomains. To include it:

```bash
docker compose --profile proxy up -d --build
```

Wait for it to finish building. You can watch the logs with:

```bash
docker compose logs -f
```

(`Ctrl+C` to stop watching logs — the containers keep running.)

---

## Step 5 — Create your admin account

You need to exec into the backend container and run the admin setup script:

```bash
docker compose exec -it backend npm run create-admin
```

It will ask you for a **username** and **password** (password must be 8+ characters). Remember these — this is how you log in to the dashboard.

---

## Step 6 — Open the dashboard

From any machine on the same network, open a browser and go to:

```
http://<basilnet-ip>:3000
```

Replace `<basilnet-ip>` with basilnet's actual LAN IP address (e.g. `192.168.68.59`). Log in with the admin credentials you just created.

---

## Step 7 — Verify everything is working

Run a quick health check on the API:

```bash
curl http://localhost:3001/api/health
```

You should get a success response. If the frontend loads and you can log in, you're all set.

---

## Managing Launchpad

Here are the commands you'll need day to day:

```bash
# Start everything
docker compose up -d

# Stop everything
docker compose down

# Restart everything
docker compose restart

# View logs (all services)
docker compose logs -f

# View logs (just backend)
docker compose logs -f backend

# Rebuild after pulling updates
git pull
docker compose up -d --build
```

---

## Updating Launchpad

When there are new changes to pull:

```bash
cd ~/Launchpad
git pull origin main
docker compose up -d --build
```

Your data in `backend/data/`, `shops/`, and `nginx/conf.d/` persists across rebuilds since they're mounted as volumes.

---

## Ports Summary

Make sure these ports are available on basilnet and not blocked by a firewall:

| Port | Service            | Required? |
|------|--------------------|-----------|
| 3000 | Frontend dashboard | Yes       |
| 3001 | Backend API        | Yes       |
| 80   | Nginx proxy        | Only with `--profile proxy` |
| 443  | Nginx proxy HTTPS  | Only with `--profile proxy` |

If basilnet runs a firewall (ufw), open them:

```bash
sudo ufw allow 3000
sudo ufw allow 3001
```

---

## Troubleshooting

**"Permission denied" on Docker commands**
- Make sure your user is in the docker group: `sudo usermod -aG docker $USER`
- Log out and back in

**Backend can't manage containers**
- The Docker socket must be mounted. Check that `/var/run/docker.sock` exists on basilnet
- Verify with: `docker compose exec backend ls -la /var/run/docker.sock`

**Frontend won't load**
- Check it's running: `docker compose ps`
- Check logs: `docker compose logs frontend`

**Can't log in / session not sticking**
- Make sure `COOKIE_SECURE=false` in `.env` (unless you have HTTPS set up)
- Make sure `FRONTEND_URL` in `.env` matches the URL you're actually using in the browser

**Can't reach from other machines**
- Make sure you're using basilnet's LAN IP, not `localhost`
- Check firewall rules (see Ports Summary above)

**"An admin user already exists" when running create-admin**
- You already set up an admin. If you forgot the password, delete the users file and re-create:
  ```bash
  docker compose exec backend rm /app/data/users.json
  docker compose exec backend npm run create-admin
  ```

---

That's it! Once it's running, you can create and manage shops from the dashboard. Hit me up if anything goes sideways.
