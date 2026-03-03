# Launchpad

**Shop management and deployment platform for Shuttle.**

Launchpad is a centralized dashboard for creating, managing, and orchestrating multiple [Shuttle](https://github.com/LR-Paris/Shuttle) shop instances. It handles shop lifecycle management, inventory tracking, order processing, file management, and automated Docker-based deployments — all from a single web interface.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Deployment](#deployment)
  - [Local / LAN](#local--lan)
  - [Production (DigitalOcean)](#production-digitalocean)
- [Usage Guide](#usage-guide)
  - [Dashboard](#dashboard)
  - [Creating a Shop](#creating-a-shop)
  - [Shop Management](#shop-management)
  - [Orders](#orders)
  - [Inventory](#inventory)
  - [Catalog & File Management](#catalog--file-management)
  - [Global Settings & Updates](#global-settings--updates)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Managing Launchpad](#managing-launchpad)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Shop Lifecycle Management** — Create, start, stop, restart, deploy, and delete shops from the dashboard. Each shop runs in its own isolated Docker container.
- **Real-Time Monitoring** — View live container logs and shop status (running/stopped) with auto-refresh.
- **Order Processing** — Parse and display orders from CSV files, download order exports, view attached PO files, and see product photos inline on order cards.
- **Inventory Tracking** — Manage stock levels per product with CSV-backed inventory. Seed inventory from the shop catalog, bulk update stock, and monitor fuel status (nominal / low / depleted).
- **File Manager** — Browse, read, edit, upload, replace, and delete files within any shop's directory. Supports ZIP uploads for bulk database imports.
- **Path-Based Shop Routing** — Shops are served at `yourdomain.com/shopname` via dynamically generated Nginx location blocks. No DNS wildcard required.
- **Shop Template Updates** — Check for and install Shuttle template updates on individual shops.
- **Platform Self-Update** — Check for new Launchpad versions on GitHub, switch branches, and pull updates directly from the dashboard.
- **Authentication** — Session-based login with bcrypt password hashing, rate-limited login attempts, and 24-hour session expiration.
- **Dark/Light Theme** — Toggle between dark and light mode from the header.

---

## Architecture

```
                    ┌───────────────────────────────────────────┐
                    │              Host / Server                 │
   Internet ───────▶│                                           │
                    │  ┌───────────────────────────────────┐    │
        :80/:443   │  │          nginx-proxy                │    │
       ────────────┼─▶│                                     │    │
                    │  │  yourdomain.com      → frontend    │    │
                    │  │  yourdomain.com/api  → backend     │    │
                    │  │  yourdomain.com/shop → shop:PORT   │    │
                    │  └───────┬──────────────┬─────────────┘    │
                    │          │              │                   │
                    │  ┌───────▼──────┐ ┌─────▼───────────┐      │
                    │  │   backend    │ │ shop containers  │      │
                    │  │   :3001      │ │ :8100, :8101 ... │      │
                    │  │   Express    │ │ (Shuttle/Next.js)│      │
                    │  │   SQLite     │ │                  │      │
                    │  └──────────────┘ └─────────────────┘      │
                    │                                            │
                    │  ┌──────────────┐                          │
                    │  │   frontend   │  (React + Vite)          │
                    │  │   :3000      │  Dev mode only;           │
                    │  │              │  prod is static via nginx │
                    │  └──────────────┘                          │
                    └───────────────────────────────────────────┘
```

**Key concepts:**

- **Backend** — Express.js API server managing shop metadata (SQLite), Docker containers, file I/O, and CSV-based order/inventory data.
- **Frontend** — React SPA served by Vite in development or as static files through Nginx in production.
- **Nginx Proxy** — Reverse proxy that routes the dashboard, API, and individual shop paths to their respective containers.
- **Shop Containers** — Each Shuttle shop runs in its own Docker container with an assigned port starting at 8100.

---

## Tech Stack

### Backend
| Package | Purpose |
|---------|---------|
| Express.js | Web framework |
| better-sqlite3 | Embedded database (shops, sessions) |
| bcrypt | Password hashing (12 rounds) |
| express-session | Session management (24h expiry) |
| express-rate-limit | Login rate limiting |
| multer | File upload handling |
| csv-parse | CSV parsing for orders/inventory |
| adm-zip | ZIP file extraction |
| slugify | URL-friendly slug generation |

### Frontend
| Package | Purpose |
|---------|---------|
| React 18 | UI framework |
| React Router 6 | Client-side routing |
| TanStack React Query | Server state & data fetching |
| Axios | HTTP client |
| Vite 6 | Build tool & dev server |
| Tailwind CSS | Utility-first styling |
| Radix UI | Accessible component primitives |
| Lucide React | Icon library |

### Infrastructure
| Tool | Purpose |
|------|---------|
| Docker & Docker Compose | Containerization & orchestration |
| Nginx (Alpine) | Reverse proxy & static file serving |
| Certbot | Let's Encrypt SSL certificates |

---

## Prerequisites

- **Git**
- **Docker** and **Docker Compose**
- **Node.js 20+** (only if running outside Docker)

Verify your setup:

```bash
git --version
docker --version
docker compose version
```

If Docker is not installed:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect
```

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/LR-Paris/Launchpad.git
cd Launchpad

# 2. Create your environment file
cp .env.example .env
# Edit .env with your values (see Configuration section below)

# 3. Create required directories
mkdir -p shops nginx/conf.d backend/data

# 4. Build and start
docker compose up -d --build

# 5. Create an admin account
docker compose exec -it backend npm run create-admin

# 6. Open the dashboard
# http://localhost:3000
```

---

## Configuration

Create a `.env` file from the provided template:

```bash
cp .env.example .env
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SESSION_SECRET` | Yes | — | Random string, must be at least 32 characters. Generate with `openssl rand -hex 32` |
| `FRONTEND_URL` | Yes | `http://localhost:3000` | Full URL where the dashboard is accessible |
| `PORT` | No | `3001` | Backend API port |
| `NODE_ENV` | No | `development` | Set to `production` for production deployments |
| `COOKIE_SECURE` | No | `false` | Set to `true` when serving over HTTPS |
| `BASE_DOMAIN` | Yes (prod) | — | Your domain (e.g. `yourdomain.com`). Used for CORS and shop routing |
| `HOST_PROJECT_DIR` | Auto | `$PWD` | Absolute path to the project on the host. Set automatically by Docker Compose |

### Example `.env` for local development

```env
SESSION_SECRET=change-me-to-a-random-string-at-least-32-chars
FRONTEND_URL=http://localhost:3000
PORT=3001
NODE_ENV=development
COOKIE_SECURE=false
```

### Example `.env` for production

```env
SESSION_SECRET=<output of openssl rand -hex 32>
FRONTEND_URL=https://yourdomain.com
PORT=3001
NODE_ENV=production
COOKIE_SECURE=true
BASE_DOMAIN=yourdomain.com
HOST_PROJECT_DIR=/opt/launchpad
```

---

## Deployment

### Local / LAN

For running on a local network (e.g. a home server):

```bash
docker compose up -d --build
```

This starts three services:

| Service | Port | Description |
|---------|------|-------------|
| backend | 3001 | Express API server |
| frontend | 3000 | React dev server |
| nginx-proxy | 80/443 | Reverse proxy (optional, use `--profile proxy`) |

To include the Nginx reverse proxy:

```bash
docker compose --profile proxy up -d --build
```

Set `FRONTEND_URL` in `.env` to your machine's LAN IP (e.g. `http://192.168.1.50:3000`).

See [BASILNET-SETUP.md](BASILNET-SETUP.md) for a detailed local network walkthrough.

### Production (DigitalOcean)

For cloud deployments with SSL:

```bash
# Automated setup
bash scripts/setup-digitalocean.sh \
  --domain yourdomain.com \
  --email you@example.com

# Or without SSL
bash scripts/setup-digitalocean.sh \
  --domain yourdomain.com \
  --skip-ssl
```

Production uses `docker-compose.prod.yml`, which:
- Builds the frontend as static files (multi-stage Dockerfile)
- Serves them through Nginx instead of the Vite dev server
- Includes Certbot for automatic SSL certificate renewal

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

See [DIGITALOCEAN-SETUP.md](DIGITALOCEAN-SETUP.md) for the full production guide including DNS setup, SSL configuration, and scaling recommendations.

---

## Usage Guide

### Dashboard

The dashboard (`/`) is the main landing page after login. It displays all shops as cards with:

- **Status indicator** — Green for running, gray for stopped
- **Running count** — Shows how many shops are currently active (e.g. "3 / 5 running")
- **Auto-refresh** — Shop statuses refresh every 10 seconds
- **Launch Shop** button — Navigate to the shop creation page

### Creating a Shop

Navigate to `/shops/new` or click **Launch Shop** from the dashboard.

1. **Name your shop** — Enter a display name. A URL-friendly slug is generated automatically, or you can customize it.
2. **Choose a preset** — Select from shop type presets that configure checkout field requirements:
   - **Basic Free Shop** — Free checkout with address, details, and notes fields
   - **PO Required Shop** — Requires a purchase order for checkout
   - **Hotel Event Shop** — Includes hotel list selection
   - **Minimal Free Shop** — Stripped-down free checkout
3. **Upload a DATABASE zip** (optional) — Upload a ZIP file containing your shop's database folder (collections, design assets, etc.) during creation.
4. **Deploy** — The backend clones the Shuttle template, writes the shop's Docker Compose file, builds the container, and starts it. Live logs stream to the terminal during deployment.

### Shop Management

From the dashboard, click on any shop card to access its management pages:

- **Start / Stop / Restart** — Control the shop's Docker container
- **Deploy** — Rebuild and restart the container
- **Logs** — View real-time container logs
- **Version** — Check the current Shuttle template version
- **Upgrade** — Pull the latest Shuttle template and rebuild
- **Settings** — Configure shop-specific options, change lifecycle status, or delete the shop
- **Lifecycle Status** — Track shops through stages: `none` → `active` → other states. Active shops are protected from destructive actions like order wiping.

### Orders

Navigate to `/shops/:slug/orders` to view and manage orders for a shop.

- **Order list** — Parsed from the shop's `DATABASE/Orders/orders.csv` file. Each order card shows customer info, items, and status.
- **Product photos** — Order cards display product thumbnails pulled from the shop's catalog (`DATABASE/ShopCollections/`).
- **PO files** — If an order has an attached purchase order, click to view or download it (PDF, Excel, images, etc.).
- **Download CSV** — Export the full orders file.
- **Wipe orders** — Clear all orders (preserves CSV headers). Blocked on shops with `active` lifecycle status.

### Inventory

Navigate to `/shops/:slug/catalog` to manage inventory.

- **Inventory table** — Displays all products with SKU, name, collection, stock level, and last updated timestamp.
- **Fuel status** — Color-coded stock indicators:
  - **Nominal** — Stock > 5
  - **Low Fuel** — Stock 1-5
  - **Depleted** — Stock 0
- **Seed from catalog** — Automatically populate the inventory CSV from the shop's `ShopCollections` folder. New products are added without overwriting existing stock levels.
- **Bulk update** — Edit stock and notes for multiple items at once.
- **Single item update** — Adjust stock or add notes for individual products.
- **Summary endpoint** — Dashboard-level fuel status overview without loading full inventory data.

Inventory data is stored in `DATABASE/Inventory/inventory.csv` with the format:

```
SKU,Product ID,Product Name,Collection,Stock,Last Updated,Notes
```

### Catalog & File Management

The file manager (accessible from shop settings) lets you browse and manage any shop's directory:

- **Browse** — Navigate the directory tree. Skips `.git`, `node_modules`, and `.next` folders.
- **Read/Edit** — Open and edit text files (`.js`, `.jsx`, `.json`, `.md`, `.txt`, `.css`, `.html`, `.yml`, `.csv`, `.env`, and more). Files up to 500KB.
- **Images** — Preview image files directly in the browser (`.jpg`, `.png`, `.gif`, `.webp`, `.avif`, etc.).
- **Upload** — Upload up to 20 files at once to any directory.
- **Replace** — Replace a single file (useful for swapping out images or assets).
- **Upload ZIP** — Upload a ZIP file to replace an entire directory (e.g. uploading a new `DATABASE` folder). OS artifacts like `__MACOSX` are automatically stripped.
- **Delete** — Remove files or entire directories.
- **Security** — All file operations are sandboxed to the shop's directory with path traversal prevention.

### Global Settings & Updates

Navigate to `/settings` for platform-wide configuration:

- **Change Password** — Update your admin password (minimum 8 characters).
- **Theme Toggle** — Switch between dark and light mode.
- **Platform Version** — View the current Launchpad version and git info (branch, commit hash).
- **Check for Updates** — Compare your local version against the latest release on GitHub.
- **Install Updates** — Pull the latest code from GitHub and trigger a container rebuild. Supports switching branches.
- **Branch Selection** — View all available remote branches and switch between them.

---

## API Reference

All endpoints (except health and login) require authentication via session cookie.

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/login` | Login with username/password (rate-limited: 5 attempts per 15 min) |
| `POST` | `/api/auth/logout` | End session |
| `POST` | `/api/auth/change-password` | Update password (requires `oldPassword` and `newPassword`) |
| `GET` | `/api/auth/me` | Get current authenticated user |

### Shops

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/shops` | List all shops |
| `GET` | `/api/shops/:slug` | Get shop details |
| `POST` | `/api/shops` | Create a new shop |
| `PATCH` | `/api/shops/:slug` | Update shop metadata |
| `DELETE` | `/api/shops/:slug` | Delete a shop (query: `deleteFiles=true` to remove files) |
| `POST` | `/api/shops/:slug/start` | Start shop container |
| `POST` | `/api/shops/:slug/stop` | Stop shop container |
| `POST` | `/api/shops/:slug/restart` | Restart shop container |
| `POST` | `/api/shops/:slug/deploy` | Build and deploy shop |
| `GET` | `/api/shops/:slug/logs` | Get container logs (query: `lines=100`) |
| `GET` | `/api/shops/:slug/version` | Get Shuttle template version |
| `POST` | `/api/shops/:slug/upgrade` | Upgrade Shuttle template |
| `GET` | `/api/shops/:slug/check-update` | Check for template updates |
| `POST` | `/api/shops/:slug/update-template` | Install template update |

### Orders

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/shops/:slug/orders` | List orders (parsed from CSV) |
| `GET` | `/api/shops/:slug/orders/download` | Download orders CSV file |
| `POST` | `/api/shops/:slug/orders/wipe` | Clear all orders (header preserved) |
| `GET` | `/api/shops/:slug/orders/po/:filename` | Download/view a PO file |
| `GET` | `/api/shops/:slug/orders/catalog-photos` | Get product name to photo mappings |
| `GET` | `/api/shops/:slug/orders/product-image/:productId` | Serve product thumbnail |

### Files

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/shops/:slug/files?path=` | List directory contents |
| `GET` | `/api/shops/:slug/files/read?path=` | Read a text file |
| `GET` | `/api/shops/:slug/files/image?path=` | Serve an image file |
| `PUT` | `/api/shops/:slug/files/write?path=` | Write/update a text file |
| `DELETE` | `/api/shops/:slug/files?path=` | Delete a file or directory |
| `POST` | `/api/shops/:slug/files/upload?path=` | Upload files (up to 20, max 1GB each) |
| `POST` | `/api/shops/:slug/files/replace?path=` | Replace a single file |
| `POST` | `/api/shops/:slug/files/upload-zip?path=` | Upload and extract a ZIP file |

### Inventory

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/shops/:slug/inventory` | Get full inventory list |
| `GET` | `/api/shops/:slug/inventory/summary` | Get inventory fuel status summary |
| `POST` | `/api/shops/:slug/inventory/seed` | Seed inventory from shop catalog |
| `PATCH` | `/api/shops/:slug/inventory/bulk` | Bulk update stock (body: `{ updates: [...] }`) |
| `PATCH` | `/api/shops/:slug/inventory/:productId` | Update single item (body: `{ stock, notes }`) |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check (unauthenticated) |
| `GET` | `/api/system/version` | Current version and git info |
| `GET` | `/api/system/check-update` | Compare local vs remote version |
| `POST` | `/api/system/update` | Pull latest code and rebuild (body: `{ branch }`) |
| `GET` | `/api/system/branches` | List available git branches |

---

## Project Structure

```
Launchpad/
├── backend/
│   ├── src/
│   │   ├── index.js          # Express app, middleware, session store
│   │   ├── auth.js           # Authentication & user management
│   │   ├── shops.js          # Shop CRUD, Docker lifecycle, deployment
│   │   ├── orders.js         # Order CSV parsing, PO files, product images
│   │   ├── inventory.js      # Inventory CSV management, seeding, bulk updates
│   │   ├── files.js          # File browser, upload/download, ZIP extraction
│   │   ├── nginx.js          # Nginx config generation for shop routing
│   │   └── update.js         # Version checking & platform updates
│   ├── scripts/
│   │   └── create-admin.js   # Admin user creation utility
│   ├── data/                  # Runtime data (SQLite DBs, users.json)
│   ├── Dockerfile
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Login.jsx          # Authentication page
│   │   │   ├── Dashboard.jsx      # Shop overview with status cards
│   │   │   ├── NewShop.jsx        # Shop creation wizard with presets
│   │   │   ├── Orders.jsx         # Order viewer with product photos
│   │   │   ├── Catalog.jsx        # Inventory editor with fuel status
│   │   │   ├── Settings.jsx       # Per-shop settings
│   │   │   └── GlobalSettings.jsx # Platform settings, updates, password
│   │   ├── components/            # Reusable UI components
│   │   ├── lib/
│   │   │   ├── api.js             # Axios client & API functions
│   │   │   └── utils.js           # Utility helpers
│   │   ├── App.jsx                # Router & auth wrapper
│   │   └── main.jsx               # React entry point
│   ├── Dockerfile                  # Development
│   ├── Dockerfile.prod             # Production (multi-stage build)
│   ├── vite.config.js
│   ├── tailwind.config.js
│   └── package.json
│
├── nginx/
│   └── conf.d/                # Generated Nginx configs (shop locations)
│
├── shops/                     # Shop data directories (one per shop)
│
├── templates/                 # Shop Docker Compose templates
│   └── shop-docker-compose.yml
│
├── scripts/
│   └── setup-digitalocean.sh  # Automated cloud deployment script
│
├── docker-compose.yml         # Development orchestration
├── docker-compose.prod.yml    # Production orchestration (Nginx + SSL)
├── .env.example               # Environment variable template
├── BASILNET-SETUP.md          # Local network setup guide
└── DIGITALOCEAN-SETUP.md      # Production deployment guide
```

### Data Storage

| Data | Storage | Location |
|------|---------|----------|
| Shop metadata | SQLite | `backend/data/shops.db` |
| Sessions | SQLite (WAL mode) | `backend/data/sessions.db` |
| User credentials | JSON (bcrypt hashed) | `backend/data/users.json` |
| Orders | CSV per shop | `shops/:slug/DATABASE/Orders/orders.csv` |
| Inventory | CSV per shop | `shops/:slug/DATABASE/Inventory/inventory.csv` |
| Product catalog | Directory structure | `shops/:slug/DATABASE/ShopCollections/` |

---

## Managing Launchpad

### Common Docker Commands

```bash
# Start all services
docker compose up -d

# Stop all services
docker compose down

# Restart all services
docker compose restart

# View logs (all services)
docker compose logs -f

# View logs (backend only)
docker compose logs -f backend

# Rebuild after changes
docker compose up -d --build

# Create admin user
docker compose exec -it backend npm run create-admin
```

### Production Commands

```bash
cd /opt/launchpad

# Start production stack
docker compose -f docker-compose.prod.yml up -d --build

# Include Nginx proxy
docker compose -f docker-compose.prod.yml --profile proxy up -d --build

# Enable SSL auto-renewal
docker compose -f docker-compose.prod.yml --profile ssl up -d

# View status
docker compose -f docker-compose.prod.yml ps
```

### Backend Scripts

```bash
npm start              # Run production server
npm run dev            # Run with file watching (auto-restart on changes)
npm run create-admin   # Interactive admin account creation
```

### Frontend Scripts

```bash
npm run dev            # Start Vite dev server (port 3000)
npm run build          # Production build to /dist
npm run preview        # Preview production build locally
npm run version:patch  # Bump patch version (x.x.X)
npm run version:minor  # Bump minor version (x.X.0)
npm run version:major  # Bump major version (X.0.0)
```

---

## Updating

### From the Dashboard

1. Go to **Settings** (`/settings`)
2. Click **Check for Updates**
3. If an update is available, click **Install Update**
4. Launchpad pulls the latest code and triggers a container rebuild

### From the Command Line

```bash
cd ~/Launchpad  # or /opt/launchpad for production
git pull origin main
docker compose up -d --build
```

Data in `backend/data/`, `shops/`, and `nginx/conf.d/` persists across rebuilds since they are mounted as Docker volumes.

---

## Troubleshooting

### Cannot log in / session not sticking

- Ensure `COOKIE_SECURE=false` in `.env` unless you have HTTPS configured.
- Ensure `FRONTEND_URL` matches the exact URL in your browser (including port).

### Backend cannot manage shop containers

- The Docker socket must be mounted. Verify: `docker compose exec backend ls -la /var/run/docker.sock`
- Ensure the Docker socket exists on the host: `ls -la /var/run/docker.sock`

### Frontend won't load

- Check the container is running: `docker compose ps`
- Check logs: `docker compose logs frontend`

### "Permission denied" on Docker commands

- Add your user to the docker group: `sudo usermod -aG docker $USER`
- Log out and back in for the change to take effect.

### Cannot reach from other machines on the network

- Use the host machine's LAN IP, not `localhost`.
- Check firewall rules: `sudo ufw allow 3000 && sudo ufw allow 3001`

### "An admin user already exists"

If you forgot your password, remove the users file and re-create:

```bash
docker compose exec backend rm /app/data/users.json
docker compose exec -it backend npm run create-admin
```

### 502 Bad Gateway on /api

- Verify the backend is running: `docker compose ps backend`
- Check backend logs: `docker compose logs backend`

### Shop subdomains not resolving (production)

- Verify wildcard DNS: `dig +short anyname.yourdomain.com`
- Ensure `BASE_DOMAIN` is set in `.env`
- Restart the backend to regenerate shop configs.

### Running out of disk space

```bash
docker system prune -a    # Remove unused images/containers
df -h                      # Check disk usage
```

---

## Ports

| Port | Service | Required |
|------|---------|----------|
| 3000 | Frontend (dev mode) | Development only |
| 3001 | Backend API | Yes (internal in production) |
| 80 | Nginx HTTP | Production (with `--profile proxy`) |
| 443 | Nginx HTTPS | Production (with SSL) |
| 8100+ | Shop containers | Internal only (proxied through Nginx) |

In production, only ports 80 and 443 need to be exposed. All other ports are proxied internally through Nginx.

---

## Additional Guides

- **[BASILNET-SETUP.md](BASILNET-SETUP.md)** — Step-by-step guide for local network deployment
- **[DIGITALOCEAN-SETUP.md](DIGITALOCEAN-SETUP.md)** — Production deployment on DigitalOcean with SSL, DNS, and scaling recommendations
