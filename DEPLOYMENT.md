# Deployment Guide

This guide covers deploying Nuvio Streams to various cloud platforms.

## Table of Contents
- [Vercel](#vercel)
- [Netlify](#netlify)
- [Railway](#railway)
- [Render](#render)
- [Heroku](#heroku)
- [Docker](#docker)

---

## Vercel

### Quick Deploy
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/RecklessEvadingDriver/NuvioStreamsAddon)

### Manual Deployment

1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Deploy:
```bash
vercel
```

3. Set environment variables in Vercel dashboard:
   - `TMDB_API_KEY` (optional)
   - `USE_REDIS_CACHE` (optional)
   - `REDIS_URL` (if using Redis)

### Configuration
The `vercel.json` file is already configured. It:
- Builds the Node.js application
- Routes all requests to `server.js`
- Includes necessary files (providers, views)

---

## Netlify

### Quick Deploy
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/RecklessEvadingDriver/NuvioStreamsAddon)

### Manual Deployment

1. Install Netlify CLI:
```bash
npm install -g netlify-cli
```

2. Install serverless dependencies:
```bash
npm install serverless-http
```

3. Deploy:
```bash
netlify deploy --prod
```

4. Set environment variables in Netlify dashboard:
   - `TMDB_API_KEY` (optional)
   - `NODE_VERSION=20`

### Configuration
The `netlify.toml` file configures:
- Build command and Node version
- Serverless function routing
- CORS headers

---

## Railway

### Quick Deploy
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/RecklessEvadingDriver/NuvioStreamsAddon)

### Manual Deployment

1. Install Railway CLI:
```bash
npm install -g @railway/cli
```

2. Login and initialize:
```bash
railway login
railway init
```

3. Deploy:
```bash
railway up
```

4. Set environment variables:
```bash
railway variables set TMDB_API_KEY=your_key
```

### Configuration
The `railway.json` file is configured automatically.

---

## Render

### Quick Deploy
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### Manual Deployment

1. Create a new Web Service on [Render Dashboard](https://dashboard.render.com/)

2. Connect your GitHub repository

3. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment**: Node

4. Add environment variables:
   - `TMDB_API_KEY` (optional)

### Configuration
The `render.yaml` file provides automatic configuration.

---

## Heroku

### Quick Deploy
[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy)

### Manual Deployment

1. Install Heroku CLI:
```bash
npm install -g heroku
```

2. Login and create app:
```bash
heroku login
heroku create your-app-name
```

3. Deploy:
```bash
git push heroku main
```

4. Set environment variables:
```bash
heroku config:set TMDB_API_KEY=your_key
heroku config:set NODE_ENV=production
```

5. Scale dyno:
```bash
heroku ps:scale web=1
```

See [HEROKU.md](./HEROKU.md) for detailed instructions.

---

## Docker

### Using Docker Compose

1. Build and run:
```bash
docker-compose up -d
```

2. Stop:
```bash
docker-compose down
```

### Using Dockerfile

1. Build image:
```bash
docker build -t nuvio-streams .
```

2. Run container:
```bash
docker run -p 7777:7777 -d nuvio-streams
```

3. With environment variables:
```bash
docker run -p 7777:7777 \
  -e TMDB_API_KEY=your_key \
  -e USE_REDIS_CACHE=true \
  -d nuvio-streams
```

---

## Environment Variables

### Required
None - the app works with defaults

### Optional
- `TMDB_API_KEY` - TMDB API key for fetching content metadata
- `PORT` - Server port (default: 7777)
- `NODE_ENV` - Environment (production/development)
- `USE_REDIS_CACHE` - Enable Redis caching (true/false)
- `REDIS_URL` - Redis connection URL
- `ENABLE_MOVIESDRIVE_PROVIDER` - Enable MoviesDrive (default: true)
- `ENABLE_4KHDHUB_PROVIDER` - Enable 4KHDHub (default: true)

---

## Post-Deployment

After deploying, your app will be available at:
- **Home**: `https://your-domain.com/`
- **Browse**: `https://your-domain.com/browse.html`
- **Configure**: `https://your-domain.com/configure`
- **API**: `https://your-domain.com/api/providers`

---

## Troubleshooting

### Build Fails
- Ensure Node version >= 14.0.0
- Check `package.json` dependencies
- Set `PUPPETEER_SKIP_DOWNLOAD=true` if Puppeteer install fails

### App Crashes
- Check logs: Platform-specific commands
  - Vercel: `vercel logs`
  - Netlify: Check Functions logs in dashboard
  - Railway: `railway logs`
  - Render: Check logs in dashboard
  - Heroku: `heroku logs --tail`

### Provider Issues
- Ensure environment variables are set correctly
- Check if providers are enabled in `.env`

---

## Need Help?

- Open an issue: [GitHub Issues](https://github.com/RecklessEvadingDriver/NuvioStreamsAddon/issues)
- Documentation: [README.md](./README.md)
