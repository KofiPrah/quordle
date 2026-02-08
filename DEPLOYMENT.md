# Deployment Guide

Deploy your Quordle game with a split architecture:
- **Client** → Vercel (static hosting, free)
- **Server** → Railway/Render/Fly.io (WebSocket + API)

---

## Dual Deployment: Vercel (Client) + Railway (Server)

This is the recommended setup for production.

### Step 1: Deploy Server to Railway

1. **Create account** at [railway.app](https://railway.app)

2. **Deploy from GitHub**:
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your `quordle` repository

3. **Configure**:
   - Set **Root Directory**: `server`
   - Add environment variables:
     ```
     VITE_DISCORD_CLIENT_ID=your_client_id
     DISCORD_CLIENT_SECRET=your_secret
     ALLOWED_ORIGINS=https://your-app.vercel.app
     ```

4. **Get your server URL**: e.g., `https://quordle-server.up.railway.app`

### Step 2: Deploy Client to Vercel

1. **Create account** at [vercel.com](https://vercel.com)

2. **Import Project**:
   - Click "Add New" → "Project"
   - Import your `quordle` repository

3. **Configure**:
   - Set **Root Directory**: `client`
   - **Framework Preset**: Vite
   - Add environment variables:
     ```
     VITE_DISCORD_CLIENT_ID=your_client_id
     VITE_API_URL=https://quordle-server.up.railway.app
     ```

4. **Deploy**: Click Deploy

5. **Get your client URL**: e.g., `https://quordle.vercel.app`

### Step 3: Update Railway CORS

Go back to Railway and update `ALLOWED_ORIGINS` with your actual Vercel URL:
```
ALLOWED_ORIGINS=https://quordle.vercel.app
```

### Step 4: Update Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your app → **Activities**
3. Update **URL Mappings** to point to your Vercel client URL

---

## Server-Only Deployment Options

If you prefer to host everything on one platform (server-side rendering or monorepo):

### Railway

1. **Create account** at [railway.app](https://railway.app)

2. **Deploy from GitHub**:
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your `quordle` repository

3. **Configure**:
   - Set **Root Directory**: `server`
   - Add environment variables:
     ```
     VITE_DISCORD_CLIENT_ID=your_client_id
     DISCORD_CLIENT_SECRET=your_secret
     ALLOWED_ORIGINS=*
     ```

4. **Get your URL**: `https://your-app.up.railway.app`

**WebSocket URL**: `wss://your-app.up.railway.app/ws`

---

### Render

1. **Create account** at [render.com](https://render.com)

2. **New Web Service**:
   - Connect your GitHub repo
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

3. **Environment Variables**:
   ```
   VITE_DISCORD_CLIENT_ID=your_client_id
   DISCORD_CLIENT_SECRET=your_secret
   ```

4. **Get your URL**: `https://your-app.onrender.com`

**Note**: Free tier spins down after 15 min inactivity. First request takes ~30s.

---

### Fly.io

1. **Install Fly CLI**:
   ```powershell
   powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
   ```

2. **Login and launch**:
   ```bash
   cd server
   fly auth login
   fly launch
   ```

3. **Create `fly.toml`** in `/server`:
   ```toml
   app = "quordle-server"
   primary_region = "iad"

   [build]

   [http_service]
     internal_port = 3001
     force_https = true
     auto_stop_machines = true
     auto_start_machines = true

   [env]
     PORT = "3001"
   ```

4. **Set secrets**:
   ```bash
   fly secrets set VITE_DISCORD_CLIENT_ID=your_client_id
   fly secrets set DISCORD_CLIENT_SECRET=your_secret
   ```

5. **Deploy**:
   ```bash
   fly deploy
   ```

**URL**: `https://quordle-server.fly.dev`

---

### VPS (DigitalOcean, Linode, etc.)

#### Setup

```bash
# SSH into your VPS
ssh root@your-server-ip

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone your repo
git clone https://github.com/KofiPrah/quordle.git
cd quordle/server

# Install dependencies
npm install

# Create .env file
cat > .env << EOF
VITE_DISCORD_CLIENT_ID=your_client_id
DISCORD_CLIENT_SECRET=your_secret
PORT=3001
EOF
```

#### Run with PM2 (process manager)

```bash
npm install -g pm2
pm2 start server.js --name quordle
pm2 save
pm2 startup
```

#### Setup HTTPS with Nginx + Let's Encrypt

```bash
# Install Nginx and Certbot
sudo apt install nginx certbot python3-certbot-nginx

# Configure Nginx
sudo nano /etc/nginx/sites-available/quordle
```

Add this configuration:

```nginx
server {
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
# Enable site and get SSL
sudo ln -s /etc/nginx/sites-available/quordle /etc/nginx/sites-enabled/
sudo certbot --nginx -d your-domain.com
sudo systemctl restart nginx
```

---

## Adding Redis for Persistence

The current server uses in-memory storage (data lost on restart). To add Redis:

1. **Install Redis dependency**:
   ```bash
   npm install redis
   ```

2. **Update `server.js`** - replace the `gameStateStore` object:
   ```javascript
   import { createClient } from 'redis';

   const redis = createClient({ url: process.env.REDIS_URL });
   await redis.connect();

   const gameStateStore = {
     _makeKey(roomId, dateKey, userId) {
       return `game:${roomId}:${dateKey}:${userId}`;
     },

     async get(roomId, dateKey, userId) {
       const data = await redis.get(this._makeKey(roomId, dateKey, userId));
       return data ? JSON.parse(data) : null;
     },

     async set(roomId, dateKey, userId, state) {
       await redis.set(
         this._makeKey(roomId, dateKey, userId),
         JSON.stringify(state),
         { EX: 86400 } // Expire after 24 hours
       );
     },

     async delete(roomId, dateKey, userId) {
       await redis.del(this._makeKey(roomId, dateKey, userId));
     },
   };
   ```

3. **Add Redis to your platform**:
   - **Railway**: Add Redis from the dashboard
   - **Render**: Create a Redis instance, link it
   - **Fly.io**: `fly redis create`

---

## Discord Activity Configuration

After deploying, update your Discord Application:

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your app → **Activities**
3. Update **URL Mappings**:
   - `/api` → `https://your-deployed-url.com/api`
   - `/ws` → `wss://your-deployed-url.com/ws`

---

## Client Configuration

Update your client to connect to the deployed server:

```javascript
// In your client code
const WS_URL = import.meta.env.PROD 
  ? 'wss://your-deployed-url.com/ws'
  : 'ws://localhost:3001/ws';

const socket = new WebSocket(WS_URL);
```

---

## Troubleshooting

### WebSocket not connecting
- Ensure your platform supports WebSocket (all listed platforms do)
- Check that `/ws` path is not being stripped by a proxy

### 502 Bad Gateway
- Server crashed - check logs: `fly logs`, `railway logs`, or PM2: `pm2 logs`

### Data not persisting
- You're using in-memory storage - add Redis (see above)
