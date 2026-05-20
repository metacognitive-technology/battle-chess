# Battle Chess — Hostinger VPS Deployment Guide

## Requirements

- Node.js 20+
- npm 9+
- PM2 (process manager)

```bash
npm install -g pm2
```

---

## First-Time Setup

### 1. Upload the project

Copy the project to your VPS (e.g. `/var/www/battle-chess`):

```bash
scp -r . user@your-vps-ip:/var/www/battle-chess
```

Or clone from your repository:

```bash
git clone <your-repo-url> /var/www/battle-chess
cd /var/www/battle-chess
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env if you need a different port
```

### 4. Build the app

```bash
npm run build
```

This produces:
- `dist/index.cjs` — compiled server
- `dist/public/` — compiled frontend assets

### 5. Start with PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

The app will be available at `http://your-vps-ip:3003`.

---

## Nginx Reverse Proxy (recommended)

To serve on port 80/443, add an Nginx site config:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
```

> The `Upgrade` and `Connection` headers are required for WebSocket support.

Enable it and reload Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/battle-chess /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## Updating the App

```bash
# Pull latest code
git pull

# Rebuild
npm install
npm run build

# Restart
pm2 restart battle-chess
```

---

## Data Storage

Game data is stored as JSON files under `server/data/`:

| Path | Contents |
|---|---|
| `server/data/games/` | Individual game state files |
| `server/data/layouts.json` | Saved wall layouts |
| `server/data/attack_stats.json` | Aggregate attack statistics |

Back these up regularly. No external database is required.

---

## PM2 Useful Commands

```bash
pm2 status                # show running apps
pm2 logs battle-chess     # tail logs
pm2 restart battle-chess  # restart app
pm2 stop battle-chess     # stop app
pm2 delete battle-chess   # remove from PM2
```
