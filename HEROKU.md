# Heroku Deployment Configuration

## Prerequisites
- Heroku CLI installed
- Heroku account

## Deployment Steps

### 1. Create Heroku App
```bash
heroku create your-app-name
```

### 2. Set Environment Variables
```bash
heroku config:set NODE_ENV=production
heroku config:set TMDB_API_KEY=your_tmdb_api_key
```

### 3. Deploy
```bash
git push heroku main
```

### 4. Scale Dyno
```bash
heroku ps:scale web=1
```

## Environment Variables
- `NODE_ENV`: production
- `TMDB_API_KEY`: Your TMDB API key (optional)
- `PORT`: Automatically set by Heroku
- `USE_REDIS_CACHE`: Set to 'true' if using Redis addon
- `REDIS_URL`: Automatically set if using Heroku Redis addon

## Buildpacks
The app uses the default Node.js buildpack. No additional configuration needed.

## Procfile
A Procfile is included in the root directory:
```
web: node server.js
```
