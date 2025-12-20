# Provider API Endpoints Documentation

This document describes the REST API endpoints for directly accessing streaming provider content.

## Overview

The Nuvio Streams addon now exposes individual provider endpoints that can be accessed directly via HTTP/HTTPS. These endpoints:

- ✅ Work in browsers (CORS enabled)
- ✅ Return JSON responses
- ✅ Only work if the provider is enabled in `.env`
- ✅ Can be integrated into any website or application
- ✅ Support both movies and TV shows

## Base URL

When running locally:
```
http://localhost:7777
```

For deployed instances, use your deployment URL (e.g., `https://yourdomain.com`)

## List All Providers

Get information about all available providers and their status.

### Endpoint
```
GET /api/providers
```

### Response
```json
{
  "success": true,
  "totalProviders": 10,
  "enabledCount": 2,
  "providers": {
    "moviesdrive": {
      "enabled": true,
      "name": "MoviesDrive",
      "endpoint": "/api/streams/moviesdrive/:tmdbId",
      "supports": ["movie", "tv"]
    },
    "4khdhub": {
      "enabled": false,
      "name": "4KHDHub",
      "endpoint": "/api/streams/4khdhub/:tmdbId",
      "supports": ["movie", "tv"]
    }
    // ... more providers
  },
  "enabledProviders": {
    // Only enabled providers
  }
}
```

## Get Streams from a Provider

Retrieve streaming links from a specific provider for a given TMDB ID.

### Endpoint Pattern
```
GET /api/streams/{provider}/{tmdbId}
```

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | Content type: `movie` or `tv` |
| `season` | integer | For TV | Season number (required for TV shows) |
| `episode` | integer | For TV | Episode number (required for TV shows) |

### Available Providers

| Provider ID | Name | Supports |
|------------|------|----------|
| `moviesdrive` | MoviesDrive | Movies, TV Shows |
| `4khdhub` | 4KHDHub | Movies, TV Shows |
| `uhdmovies` | UHDMovies | Movies, TV Shows |
| `moviesmod` | MoviesMod | Movies, TV Shows |
| `topmovies` | TopMovies | Movies only |
| `soapertv` | SoaperTV | Movies, TV Shows |
| `vidzee` | VidZee | Movies, TV Shows |
| `mp4hydra` | MP4Hydra | Movies, TV Shows |
| `vixsrc` | Vixsrc | Movies, TV Shows |
| `moviebox` | MovieBox | Movies, TV Shows |

### Examples

#### Movie Example
```bash
# Get streams for Fight Club (TMDB ID: 550)
curl "http://localhost:7777/api/streams/moviesdrive/550?type=movie"
```

#### TV Show Example
```bash
# Get streams for Game of Thrones S01E01 (TMDB ID: 1399)
curl "http://localhost:7777/api/streams/moviesdrive/1399?type=tv&season=1&episode=1"
```

### Success Response

```json
{
  "success": true,
  "provider": "MoviesDrive",
  "tmdbId": "550",
  "type": "movie",
  "season": null,
  "episode": null,
  "count": 5,
  "streams": [
    {
      "title": "Fight Club (1999)",
      "url": "https://example.com/stream.mp4",
      "quality": "1080p",
      "size": "2.5 GB",
      "provider": "MoviesDrive"
    }
    // ... more streams
  ]
}
```

### Error Responses

#### Provider Disabled (403)
```json
{
  "success": false,
  "error": "MoviesDrive provider is disabled",
  "message": "This provider is not enabled in the server configuration"
}
```

#### Invalid Parameters (400)
```json
{
  "success": false,
  "error": "Invalid or missing type parameter",
  "message": "type must be either 'movie' or 'tv'"
}
```

#### Server Error (500)
```json
{
  "success": false,
  "error": "Internal server error",
  "message": "Error description"
}
```

## Environment Configuration

To enable/disable providers, set these environment variables in your `.env` file:

```bash
# Provider Enablement (set to 'false' to disable, any other value or unset = enabled)
ENABLE_MOVIESDRIVE_PROVIDER=true
ENABLE_4KHDHUB_PROVIDER=false
ENABLE_UHDMOVIES_PROVIDER=true
ENABLE_MOVIESMOD_PROVIDER=true
ENABLE_TOPMOVIES_PROVIDER=true
ENABLE_SOAPERTV_PROVIDER=true
ENABLE_VIDZEE_PROVIDER=false
ENABLE_MP4HYDRA_PROVIDER=false
ENABLE_VIXSRC_PROVIDER=false
ENABLE_MOVIEBOX_PROVIDER=false
```

## Browser Integration Example

```html
<!DOCTYPE html>
<html>
<head>
    <title>Nuvio Streams API Example</title>
</head>
<body>
    <h1>Get Movie Streams</h1>
    <input type="text" id="tmdbId" placeholder="TMDB ID (e.g., 550)">
    <select id="provider">
        <option value="moviesdrive">MoviesDrive</option>
        <option value="4khdhub">4KHDHub</option>
        <option value="uhdmovies">UHDMovies</option>
    </select>
    <button onclick="getStreams()">Get Streams</button>
    <div id="results"></div>

    <script>
        async function getStreams() {
            const tmdbId = document.getElementById('tmdbId').value;
            const provider = document.getElementById('provider').value;
            
            const url = `http://localhost:7777/api/streams/${provider}/${tmdbId}?type=movie`;
            
            try {
                const response = await fetch(url);
                const data = await response.json();
                
                if (data.success) {
                    document.getElementById('results').innerHTML = 
                        `<h2>Found ${data.count} streams:</h2>
                        <pre>${JSON.stringify(data.streams, null, 2)}</pre>`;
                } else {
                    document.getElementById('results').innerHTML = 
                        `<p style="color: red;">Error: ${data.error}</p>`;
                }
            } catch (error) {
                document.getElementById('results').innerHTML = 
                    `<p style="color: red;">Network error: ${error.message}</p>`;
            }
        }
    </script>
</body>
</html>
```

## JavaScript/Node.js Integration Example

```javascript
const axios = require('axios');

async function getMovieStreams(provider, tmdbId) {
    try {
        const response = await axios.get(
            `http://localhost:7777/api/streams/${provider}/${tmdbId}`,
            { params: { type: 'movie' } }
        );
        
        if (response.data.success) {
            console.log(`Found ${response.data.count} streams:`);
            response.data.streams.forEach(stream => {
                console.log(`- ${stream.quality}: ${stream.url}`);
            });
        } else {
            console.error('Error:', response.data.error);
        }
    } catch (error) {
        console.error('Request failed:', error.message);
    }
}

// Usage
getMovieStreams('moviesdrive', '550'); // Fight Club
```

## Python Integration Example

```python
import requests

def get_movie_streams(provider, tmdb_id):
    url = f"http://localhost:7777/api/streams/{provider}/{tmdb_id}"
    params = {"type": "movie"}
    
    try:
        response = requests.get(url, params=params)
        data = response.json()
        
        if data.get('success'):
            print(f"Found {data['count']} streams:")
            for stream in data['streams']:
                print(f"- {stream['quality']}: {stream['url']}")
        else:
            print(f"Error: {data.get('error')}")
    except Exception as e:
        print(f"Request failed: {e}")

# Usage
get_movie_streams('moviesdrive', '550')  # Fight Club
```

## Rate Limiting

Currently, there are no rate limits on these endpoints. However, please be respectful and avoid making excessive requests to prevent overloading the server or the upstream providers.

## CORS Support

All API endpoints have CORS enabled, allowing them to be called from any domain in a browser context.

## Notes

- Provider availability depends on upstream services and may change without notice
- Stream URLs returned by providers may be temporary and expire after some time
- Some providers may require additional configuration in the `.env` file
- The quality and availability of streams depends on the provider's content library
- TMDB IDs can be found on [The Movie Database](https://www.themoviedb.org/)

## Support

For issues or questions, please open an issue on the [GitHub repository](https://github.com/RecklessEvadingDriver/NuvioStreamsAddon/issues).
