// ================================================================================
// Nuvio Streams Addon for Stremio
// ================================================================================
// 
// GOOGLE ANALYTICS SETUP:
// 1. Go to https://analytics.google.com/ and create a new GA4 property
// 2. Get your Measurement ID (format: G-XXXXXXXXXX)
// 3. Replace 'G-XXXXXXXXXX' in views/index.html with your actual Measurement ID
// 4. The addon will automatically track:
//    - Addon installations (install_addon_clicked)
//    - Manifest copies (copy_manifest_clicked)
//    - Provider configurations (apply_providers_clicked)
//    - Cookie configurations (set_cookie_clicked)
//    - Tutorial access (cookie_tutorial_opened)
//    - Stream requests (will be added to server-side logging)
//
// ================================================================================

const { addonBuilder } = require('stremio-addon-sdk');
require('dotenv').config(); // Ensure environment variables are loaded
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto'); // For hashing cookies
const Redis = require('ioredis');

// Add Redis client if enabled
const USE_REDIS_CACHE = process.env.USE_REDIS_CACHE === 'true';
let redis = null;
let redisKeepAliveInterval = null; // Variable to manage the keep-alive interval

if (USE_REDIS_CACHE) {
    try {
        console.log(`[Redis Cache] Initializing Redis in addon.js. REDIS_URL from env: ${process.env.REDIS_URL ? 'exists and has value' : 'MISSING or empty'}`);
        if (!process.env.REDIS_URL) {
            throw new Error("REDIS_URL environment variable is not set or is empty.");
        }
        
        // Check if this is a local Redis instance or remote
        const isLocal = process.env.REDIS_URL.includes('localhost') || process.env.REDIS_URL.includes('127.0.0.1');
        
        redis = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 5,
            retryStrategy(times) {
                const delay = Math.min(times * 500, 5000);
                // Added verbose logging for each retry attempt
                console.warn(`[Redis Cache] Retry strategy activated. Attempt #${times}, will retry in ${delay}ms`);
                return delay;
            },
            reconnectOnError: function(err) {
                const targetError = 'READONLY';
                const shouldReconnect = err.message.includes(targetError);
                // Added detailed logging for reconnectOnError decisions
                console.warn(`[Redis Cache] reconnectOnError invoked due to error: "${err.message}". Decided to reconnect: ${shouldReconnect}`);
                return shouldReconnect;
            },
            // TLS is optional - only use if explicitly specified with rediss:// protocol
            tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
            enableOfflineQueue: true,
            enableReadyCheck: true,
            autoResubscribe: true,
            autoResendUnfulfilledCommands: true,
            lazyConnect: false
        });
        
        redis.on('error', (err) => {
            console.error(`[Redis Cache] Connection error: ${err.message}`);
            // --- BEGIN: Clear Keep-Alive on Error ---
            if (redisKeepAliveInterval) {
                clearInterval(redisKeepAliveInterval);
                redisKeepAliveInterval = null;
            }
            // --- END: Clear Keep-Alive on Error ---
        });
        
        redis.on('connect', () => {
            console.log('[Redis Cache] Successfully connected to Upstash Redis');

            // --- BEGIN: Redis Keep-Alive ---
            if (redisKeepAliveInterval) {
                clearInterval(redisKeepAliveInterval);
            }

            redisKeepAliveInterval = setInterval(() => {
                if (redis && redis.status === 'ready') {
                    redis.ping((err) => {
                        if (err) {
                            console.error('[Redis Cache Keep-Alive] Ping failed:', err.message);
                        }
                    });
                }
            }, 4 * 60 * 1000); // 4 minutes
            // --- END: Redis Keep-Alive ---
        });
        
        // --- BEGIN: Additional Redis connection lifecycle logging ---
        redis.on('reconnecting', (delay) => {
            console.warn(`[Redis Cache] Reconnecting... next attempt in ${delay}ms (current status: ${redis.status})`);
        });
        redis.on('close', () => {
            console.warn('[Redis Cache] Connection closed.');
        });
        redis.on('end', () => {
            console.error('[Redis Cache] Connection ended. No further reconnection attempts will be made.');
        });
        redis.on('ready', () => {
            console.log('[Redis Cache] Connection is ready and commands can now be processed.');
        });
        // --- END: Additional Redis connection lifecycle logging ---
        
        console.log('[Redis Cache] Upstash Redis client initialized');
    } catch (err) {
        console.error(`[Redis Cache] Failed to initialize Redis: ${err.message}`);
        console.log('[Redis Cache] Will use file-based cache as fallback');
    }
}

// Provider configuration - Only MoviesDrive and 4KHDHub

// NEW: Read environment variable for MoviesDrive
const ENABLE_MOVIESDRIVE_PROVIDER = process.env.ENABLE_MOVIESDRIVE_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] MoviesDrive provider fetching enabled: ${ENABLE_MOVIESDRIVE_PROVIDER}`);

// NEW: Read environment variable for 4KHDHub
const ENABLE_4KHDHUB_PROVIDER = process.env.ENABLE_4KHDHUB_PROVIDER !== 'false'; // Defaults to true if not set or not 'false'
console.log(`[addon.js] 4KHDHub provider fetching enabled: ${ENABLE_4KHDHUB_PROVIDER}`)

// NEW: Stream caching config
const STREAM_CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.streams_cache') : path.join(__dirname, '.streams_cache');
const STREAM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const ENABLE_STREAM_CACHE = process.env.DISABLE_STREAM_CACHE !== 'true'; // Enabled by default
console.log(`[addon.js] Stream links caching ${ENABLE_STREAM_CACHE ? 'enabled' : 'disabled'}`);
console.log(`[addon.js] Redis caching ${redis ? 'available' : 'not available'}`);

// Only import the two providers we need
const { getMoviesDriveStreams } = require('./providers/moviesdrive.js'); // Import from moviesdrive.js
const { get4KHDHubStreams } = require('./providers/4khdhub.js'); // Import from 4khdhub.js
const axios = require('axios'); // For external provider requests

// Helper function for fetching with a timeout
function fetchWithTimeout(promise, timeoutMs, providerName) {
  return new Promise((resolve) => { // Always resolve to prevent Promise.all from rejecting
    let timer = null;

    const timeoutPromise = new Promise(r => {
      timer = setTimeout(() => {
        console.log(`[${providerName}] Request timed out after ${timeoutMs}ms. Returning empty array.`);
        r({ streams: [], provider: providerName, error: new Error('Timeout') }); // Resolve with an object indicating timeout
      }, timeoutMs);
    });

    Promise.race([promise, timeoutPromise])
      .then((result) => {
        clearTimeout(timer);
        // Ensure the result is an object with a streams array, even if the original promise resolved with just an array
        if (Array.isArray(result)) {
          resolve({ streams: result, provider: providerName });
        } else if (result && typeof result.streams !== 'undefined') {
          resolve(result); // Already in the expected format (e.g. from timeoutPromise)
        } else {
          // This case might happen if the promise resolves with something unexpected
          console.warn(`[${providerName}] Resolved with unexpected format. Returning empty array. Result:`, result);
          resolve({ streams: [], provider: providerName });
        }
      })
      .catch(error => {
        clearTimeout(timer);
        console.error(`[${providerName}] Error fetching streams: ${error.message}. Returning empty array.`);
        resolve({ streams: [], provider: providerName, error }); // Resolve with an object indicating error
      });
  });
}

// --- Stream Caching Functions ---
// Ensure stream cache directory exists
const ensureStreamCacheDir = async () => {
    if (!ENABLE_STREAM_CACHE) return;
    
    try {
        await fs.mkdir(STREAM_CACHE_DIR, { recursive: true });
        console.log(`[Stream Cache] Cache directory ensured at ${STREAM_CACHE_DIR}`);
    } catch (error) {
        if (error.code !== 'EEXIST') {
            console.warn(`[Stream Cache] Warning: Could not create cache directory ${STREAM_CACHE_DIR}: ${error.message}`);
        }
    }
};

// Initialize stream cache directory on startup
ensureStreamCacheDir().catch(err => console.error(`[Stream Cache] Error creating cache directory: ${err.message}`));

// Generate cache key for a provider's streams
const getStreamCacheKey = (provider, type, id, seasonNum = null, episodeNum = null, region = null, cookie = null) => {
    // Basic key parts
    let key = `streams_${provider}_${type}_${id}`;
    
    // Add season/episode for TV series
    if (seasonNum !== null && episodeNum !== null) {
        key += `_s${seasonNum}e${episodeNum}`;
    }
    
    // For ShowBox with custom cookie/region, add those to the cache key
    if (provider.toLowerCase() === 'showbox' && (region || cookie)) {
        key += '_custom';
        if (region) key += `_${region}`;
        if (cookie) {
            // Hash the cookie to avoid storing sensitive info in filenames
            const cookieHash = crypto.createHash('md5').update(cookie).digest('hex').substring(0, 10);
            key += `_${cookieHash}`;
        }
    }
    
    return key;
};

// Get cached streams for a provider - Hybrid approach (Redis first, then file)
const getStreamFromCache = async (provider, type, id, seasonNum = null, episodeNum = null, region = null, cookie = null) => {
    if (!ENABLE_STREAM_CACHE) return null;
    // Exclude ShowBox and PStream from cache entirely
    try {
        if (provider && ['showbox', 'pstream'].includes(String(provider).toLowerCase())) {
            return null;
        }
    } catch (_) {}
    
    const cacheKey = getStreamCacheKey(provider, type, id, seasonNum, episodeNum, region, cookie);
    
    // Try Redis first if available
    if (redis) {
        try {
            const data = await redis.get(cacheKey);
            if (data) {
                const cached = JSON.parse(data);
                
                // Check if cache is expired (redundant with Redis TTL, but for safety)
                if (cached.expiry && Date.now() > cached.expiry) {
                    console.log(`[Redis Cache] EXPIRED for ${provider}: ${cacheKey}`);
                    await redis.del(cacheKey);
                    return null;
                }
                
                // Check for failed status - retry on next request
                if (cached.status === 'failed') {
                    console.log(`[Redis Cache] RETRY for previously failed ${provider}: ${cacheKey}`);
                    return null;
                }
                
                console.log(`[Redis Cache] HIT for ${provider}: ${cacheKey}`);
                return cached.streams;
            }
        } catch (error) {
            console.warn(`[Redis Cache] READ ERROR for ${provider}: ${cacheKey}: ${error.message}`);
            console.log('[Redis Cache] Falling back to file cache');
            // Fall back to file cache on Redis error
        }
    }
    
    // File cache fallback
    const fileCacheKey = cacheKey + '.json';
    const cachePath = path.join(STREAM_CACHE_DIR, fileCacheKey);
    
    try {
        const data = await fs.readFile(cachePath, 'utf-8');
        const cached = JSON.parse(data);
        
        // Check if cache is expired
        if (cached.expiry && Date.now() > cached.expiry) {
            console.log(`[File Cache] EXPIRED for ${provider}: ${fileCacheKey}`);
            await fs.unlink(cachePath).catch(() => {}); // Delete expired cache
            return null;
        }
        
        // Check for failed status - retry on next request
        if (cached.status === 'failed') {
            console.log(`[File Cache] RETRY for previously failed ${provider}: ${fileCacheKey}`);
            return null;
        }
        
        console.log(`[File Cache] HIT for ${provider}: ${fileCacheKey}`);
        return cached.streams;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`[File Cache] READ ERROR for ${provider}: ${fileCacheKey}: ${error.message}`);
        }
        return null;
    }
};

// Save streams to cache - Hybrid approach (Redis + file)
const saveStreamToCache = async (provider, type, id, streams, status = 'ok', seasonNum = null, episodeNum = null, region = null, cookie = null, ttlMs = null) => {
    if (!ENABLE_STREAM_CACHE) return;
    // Exclude ShowBox and PStream from cache entirely
    try {
        if (provider && ['showbox', 'pstream'].includes(String(provider).toLowerCase())) {
            return;
        }
    } catch (_) {}
    
    const cacheKey = getStreamCacheKey(provider, type, id, seasonNum, episodeNum, region, cookie);
    const effectiveTtlMs = ttlMs !== null ? ttlMs : STREAM_CACHE_TTL_MS; // Use provided TTL or default

    const cacheData = {
        streams: streams,
        status: status,
        expiry: Date.now() + effectiveTtlMs, // Use effective TTL
        timestamp: Date.now()
    };
    
    let redisSuccess = false;
    
    // Try Redis first if available
    if (redis) {
        try {
            // PX sets expiry in milliseconds
            await redis.set(cacheKey, JSON.stringify(cacheData), 'PX', effectiveTtlMs); // Use effective TTL
            console.log(`[Redis Cache] SAVED for ${provider}: ${cacheKey} (${streams.length} streams, status: ${status}, TTL: ${effectiveTtlMs / 1000}s)`);
            redisSuccess = true;
        } catch (error) {
            console.warn(`[Redis Cache] WRITE ERROR for ${provider}: ${cacheKey}: ${error.message}`);
            console.log('[Redis Cache] Falling back to file cache');
        }
    }
    
    // Also save to file cache as backup, or if Redis failed
    try {
        const fileCacheKey = cacheKey + '.json';
        const cachePath = path.join(STREAM_CACHE_DIR, fileCacheKey);
        await fs.writeFile(cachePath, JSON.stringify(cacheData), 'utf-8');
        
        // Only log if Redis didn't succeed to avoid redundant logging
        if (!redisSuccess) {
            console.log(`[File Cache] SAVED for ${provider}: ${fileCacheKey} (${streams.length} streams, status: ${status}, TTL: ${effectiveTtlMs / 1000}s)`);
        }
    } catch (error) {
        console.warn(`[File Cache] WRITE ERROR for ${provider}: ${cacheKey}.json: ${error.message}`);
    }
};

// Define stream handler for movies
builder.defineStreamHandler(async (args) => {
    const requestStartTime = Date.now(); // Start total request timer
    const providerTimings = {}; // Object to store timings

    const formatDuration = (ms) => {
        if (ms < 1000) {
            return `${ms}ms`;
        }
        const totalSeconds = ms / 1000;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        
        let str = "";
        if (minutes > 0) {
            str += `${minutes}m `;
        }
        
        if (seconds > 0 || minutes === 0) {
            let secStr = seconds.toFixed(2);
            if (secStr.endsWith('.00')) {
                secStr = secStr.substring(0, secStr.length - 3);
            }
            str += `${secStr}s`;
        }
        
        return str.trim();
    };

    const { type, id, config: sdkConfig } = args;

    // Read config from global set by server.js middleware
    const requestSpecificConfig = global.currentRequestConfig || {};
    // Mask sensitive fields for logs
    const maskedForLog = (() => {
        try {
            const clone = JSON.parse(JSON.stringify(requestSpecificConfig));
            if (clone.cookie) clone.cookie = '[PRESENT: ****]';
            if (clone.cookies && Array.isArray(clone.cookies)) clone.cookies = `[${clone.cookies.length} cookies]`;
            if (clone.scraper_api_key) clone.scraper_api_key = '[PRESENT: ****]';
            if (clone.chosenFebboxBaseCookieForRequest) clone.chosenFebboxBaseCookieForRequest = '[PRESENT: ****]';
            return clone;
        } catch (_) {
            return { masked: true };
        }
    })();
    console.log(`[addon.js] Read from global.currentRequestConfig: ${JSON.stringify(maskedForLog)}`);

    // NEW: Get minimum quality preferences
    const minQualitiesPreferences = requestSpecificConfig.minQualities || {};
    if (Object.keys(minQualitiesPreferences).length > 0) {
        console.log(`[addon.js] Minimum quality preferences: ${JSON.stringify(minQualitiesPreferences)}`);
    } else {
        console.log(`[addon.js] No minimum quality preferences set by user.`);
    }

    // NEW: Get codec exclude preferences
    const excludeCodecsPreferences = requestSpecificConfig.excludeCodecs || {};
    if (Object.keys(excludeCodecsPreferences).length > 0) {
        console.log(`[addon.js] Codec exclude preferences: ${JSON.stringify(excludeCodecsPreferences)}`);
    } else {
        console.log(`[addon.js] No codec exclude preferences set by user.`);
    }

    console.log("--- FULL ARGS OBJECT (from SDK) ---");
    console.log(JSON.stringify(args, null, 2));
    console.log("--- SDK ARGS.CONFIG (still logging for comparison) ---");
    console.log(JSON.stringify(sdkConfig, null, 2)); // Log the original sdkConfig
    console.log("---------------------------------");

    // Helper to get flag emoji from URL hostname
    const getFlagEmojiForUrl = (url) => {
        try {
            const hostname = new URL(url).hostname;
            // Match common patterns like xx, xxN, xxNN at the start of a part of the hostname
            const match = hostname.match(/^([a-zA-Z]{2,3})[0-9]{0,2}(?:[.-]|$)/i);
            if (match && match[1]) {
                const countryCode = match[1].toLowerCase();
                const flagMap = {
                    'us': '🇺🇸', 'usa': '🇺🇸',
                    'gb': '🇬🇧', 'uk': '🇬🇧',
                    'ca': '🇨🇦',
                    'de': '🇩🇪',
                    'fr': '🇫🇷',
                    'nl': '🇳🇱',
                    'hk': '🇭🇰',
                    'sg': '🇸🇬',
                    'jp': '🇯🇵',
                    'au': '🇦🇺',
                    'in': '🇮🇳',
                    // Add more as needed
                };
                return flagMap[countryCode] || ''; // Return empty string if no match
            }
        } catch (e) {
            // Invalid URL or other error
        }
        return ''; // Default to empty string
    };

    // Use values from requestSpecificConfig (derived from global)
    let userRegionPreference = requestSpecificConfig.region || null;
    let userCookie = requestSpecificConfig.cookie || null; // Already decoded by server.js
    let userScraperApiKey = requestSpecificConfig.scraper_api_key || null; // NEW: Get ScraperAPI Key
    
    // Combine single cookie + cookies array into unified list for ShowBox
    // This ensures both single cookie and multi-cookie setups work
    const cookiesFromArray = Array.isArray(requestSpecificConfig.cookies) ? requestSpecificConfig.cookies : [];
    const allCookies = [];
    
    // Add single cookie first (priority)
    if (userCookie && userCookie.trim()) {
        allCookies.push(userCookie.trim());
    }
    
    // Add cookies from array (deduplicate)
    for (const c of cookiesFromArray) {
        if (c && c.trim() && !allCookies.includes(c.trim())) {
            allCookies.push(c.trim());
        }
    }
    
    if (allCookies.length > 0) {
        console.log(`[addon.js] Combined ${allCookies.length} unique cookie(s) for ShowBox`);
    }
    
    // Log the request information in a more detailed way
    console.log(`Stream request for Stremio type: '${type}', id: '${id}'`);
    
    let selectedProvidersArray = null;
    if (requestSpecificConfig.providers) {
        selectedProvidersArray = requestSpecificConfig.providers.split(',').map(p => p.trim().toLowerCase());
    }
    
    // Detect presence of cookies (single or array)
    const hasCookiesArray = cookiesFromArray.length > 0;
    const hasAnyCookies = allCookies.length > 0;
    console.log(`Effective request details: ${JSON.stringify({
        regionPreference: userRegionPreference || 'none',
        hasCookie: hasAnyCookies,
        cookieCount: allCookies.length,
        selectedProviders: selectedProvidersArray ? selectedProvidersArray.join(', ') : 'all'
    })}`);
    
    if (userRegionPreference) {
        console.log(`[addon.js] Using region from global config: ${userRegionPreference}`);
    } else {
        console.log(`[addon.js] No region preference found in global config.`);
    }
    
    if (hasAnyCookies) {
        const cookieSource = userCookie ? 'single' : 'array';
        console.log(`[addon.js] Using personal cookie(s): ${allCookies.length} cookie(s) available (source: ${cookieSource})`);
    } else {
        console.log(`[addon.js] No cookie found in global config.`);
    }

    if (selectedProvidersArray) {
        console.log(`[addon.js] Using providers from global config: ${selectedProvidersArray.join(', ')}`);
    } else {
        console.log('[addon.js] No specific providers selected by user in global config, will attempt all.');
    }

    if (type !== 'movie' && type !== 'series' && type !== 'tv') {
        return { streams: [] };
    }
    
    let tmdbId;
    let tmdbTypeFromId;
    let seasonNum = null;
    let episodeNum = null;
    let initialTitleFromConversion = null;
    let isAnimation = false; // <--- New flag to track if content is animation
    
    const idParts = id.split(':');
    
    if (idParts[0] === 'tmdb') {
        tmdbId = idParts[1];
        tmdbTypeFromId = type === 'movie' ? 'movie' : 'tv';
        console.log(`  Received TMDB ID directly: ${tmdbId} for type ${tmdbTypeFromId}`);
        
        // Check for season and episode
        if (idParts.length >= 4 && (type === 'series' || type === 'tv')) {
            seasonNum = parseInt(idParts[2], 10);
            episodeNum = parseInt(idParts[3], 10);
            console.log(`  Parsed season ${seasonNum}, episode ${episodeNum} from Stremio ID`);
        }
    } else if (id.startsWith('tt')) {
        console.log(`  Received IMDb ID: ${id}. Attempting to convert to TMDB ID.`);
        
        const imdbParts = id.split(':');
        let baseImdbId = id; // Default to full ID for movies

        if (imdbParts.length >= 3 && (type === 'series' || type === 'tv')) {
            seasonNum = parseInt(imdbParts[1], 10);
            episodeNum = parseInt(imdbParts[2], 10);
            baseImdbId = imdbParts[0]; // Use only the IMDb ID part for conversion
            console.log(`  Parsed season ${seasonNum}, episode ${episodeNum} from IMDb ID parts`);
        }
        
        // Pass userRegionPreference and expected type to convertImdbToTmdb
        const conversionResult = await convertImdbToTmdb(baseImdbId, userRegionPreference, type);
        if (conversionResult && conversionResult.tmdbId && conversionResult.tmdbType) {
            tmdbId = conversionResult.tmdbId;
            tmdbTypeFromId = conversionResult.tmdbType;
            initialTitleFromConversion = conversionResult.title; // Capture title from conversion
            console.log(`  Successfully converted IMDb ID ${baseImdbId} to TMDB ${tmdbTypeFromId} ID ${tmdbId} (${initialTitleFromConversion || 'No title returned'})`);
        } else {
            console.log(`  Failed to convert IMDb ID ${baseImdbId} to TMDB ID.`);
            return { streams: [] };
        }
    } else {
        console.log(`  Unrecognized ID format: ${id}`);
        return { streams: [] };
    }
    
    if (!tmdbId || !tmdbTypeFromId) {
        console.log('  Could not determine TMDB ID or type after processing Stremio ID.');
        return { streams: [] };
    }

    let movieOrSeriesTitle = initialTitleFromConversion;
    let movieOrSeriesYear = null;
    let seasonTitle = null;

    if (tmdbId && TMDB_API_KEY) {
        try {
            let detailsUrl;
            if (tmdbTypeFromId === 'movie') {
                detailsUrl = `${TMDB_API_URL}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
            } else { // 'tv'
                detailsUrl = `${TMDB_API_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
            }
            
            console.log(`Fetching details from TMDB: ${detailsUrl}`);
            const tmdbDetailsResponse = await fetchWithRetry(detailsUrl, {});
            if (!tmdbDetailsResponse.ok) throw new Error(`TMDB API error: ${tmdbDetailsResponse.status}`);
            const tmdbDetails = await tmdbDetailsResponse.json();

            if (tmdbTypeFromId === 'movie') {
                if (!movieOrSeriesTitle) movieOrSeriesTitle = tmdbDetails.title;
                movieOrSeriesYear = tmdbDetails.release_date ? tmdbDetails.release_date.substring(0, 4) : null;
            } else { // 'tv'
                if (!movieOrSeriesTitle) movieOrSeriesTitle = tmdbDetails.name;
                movieOrSeriesYear = tmdbDetails.first_air_date ? tmdbDetails.first_air_date.substring(0, 4) : null;
            }
            console.log(`  Fetched/Confirmed TMDB details: Title='${movieOrSeriesTitle}', Year='${movieOrSeriesYear}'`);

            // NEW: Fetch season-specific title for TV shows
            if (tmdbTypeFromId === 'tv' && seasonNum) {
                const seasonDetailsUrl = `${TMDB_API_URL}/tv/${tmdbId}/season/${seasonNum}?api_key=${TMDB_API_KEY}&language=en-US`;
                console.log(`Fetching season details from TMDB: ${seasonDetailsUrl}`);
                try {
                    const seasonDetailsResponse = await fetchWithRetry(seasonDetailsUrl, {});
                    if (seasonDetailsResponse.ok) {
                        const seasonDetails = await seasonDetailsResponse.json();
                        seasonTitle = seasonDetails.name;
                        console.log(`  Fetched season title: "${seasonTitle}"`);
                    }
                } catch (e) {
                    console.warn(`Could not fetch season-specific title: ${e.message}`);
                }
            }

            // Check for Animation genre
            if (tmdbDetails.genres && Array.isArray(tmdbDetails.genres)) {
                if (tmdbDetails.genres.some(genre => genre.name.toLowerCase() === 'animation')) {
                    isAnimation = true;
                    console.log('  Content identified as Animation based on TMDB genres.');
                }
            }

        } catch (e) {
            console.error(`  Error fetching details from TMDB: ${e.message}`);
        }
    } else if (tmdbId && !TMDB_API_KEY) {
        console.warn("TMDB_API_KEY is not configured. Cannot fetch full title/year/genres.");
    }
    
    // --- Send Analytics Event ---
    if (movieOrSeriesTitle) {
        sendAnalyticsEvent('stream_request', {
            content_type: tmdbTypeFromId,
            content_id: tmdbId,
            content_title: movieOrSeriesTitle,
            content_year: movieOrSeriesYear || 'N/A',
            selected_providers: selectedProvidersArray ? selectedProvidersArray.join(',') : 'all',
            // Custom dimension for tracking if it's an animation
            is_animation: isAnimation ? 'true' : 'false', 
        });
    }

    let combinedRawStreams = [];

    // --- Provider Selection Logic ---
    const shouldFetch = (providerId) => {
        if (!selectedProvidersArray) return true; // If no selection, fetch all
        return selectedProvidersArray.includes(providerId.toLowerCase());
    };

    // Helper for timing provider fetches
    const timeProvider = async (providerName, fetchPromise) => {
        const startTime = Date.now();
        const result = await fetchPromise;
        const endTime = Date.now();
        providerTimings[providerName] = formatDuration(endTime - startTime);
        return result;
    };

    // --- NEW: Asynchronous provider fetching with caching ---
    console.log('[Stream Cache] Checking cache for enabled providers (MoviesDrive and 4KHDHub only)...');
    
    const providerFetchFunctions = {
        // MoviesDrive provider with cache integration
        moviesdrive: async () => {
            if (!ENABLE_MOVIESDRIVE_PROVIDER) {
                console.log('[MoviesDrive] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('moviesdrive')) {
                console.log('[MoviesDrive] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('moviesdrive', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[MoviesDrive] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: 'MoviesDrive' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[MoviesDrive] Fetching new streams...`);
                const streams = await getMoviesDriveStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                
                if (streams && streams.length > 0) {
                    console.log(`[MoviesDrive] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('moviesdrive', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: 'MoviesDrive' }));
                } else {
                    console.log(`[MoviesDrive] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('moviesdrive', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[MoviesDrive] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('moviesdrive', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        },

        // 4KHDHub provider with cache integration
        '4khdhub': async () => {
            if (!ENABLE_4KHDHUB_PROVIDER) {
                console.log('[4KHDHub] Skipping fetch: Disabled by environment variable.');
                return [];
            }
            if (!shouldFetch('4khdhub')) {
                console.log('[4KHDHub] Skipping fetch: Not selected by user.');
                return [];
            }
            
            // Try to get cached streams first
            const cachedStreams = await getStreamFromCache('4khdhub', tmdbTypeFromId, tmdbId, seasonNum, episodeNum);
            if (cachedStreams) {
                console.log(`[4KHDHub] Using ${cachedStreams.length} streams from cache.`);
                return cachedStreams.map(stream => ({ ...stream, provider: '4KHDHub' }));
            }
            
            // No cache or expired, fetch fresh
            try {
                console.log(`[4KHDHub] Fetching new streams...`);
                const streams = await get4KHDHubStreams(tmdbId, tmdbTypeFromId, seasonNum, episodeNum);
                
                if (streams && streams.length > 0) {
                    console.log(`[4KHDHub] Successfully fetched ${streams.length} streams.`);
                    // Save to cache
                    await saveStreamToCache('4khdhub', tmdbTypeFromId, tmdbId, streams, 'ok', seasonNum, episodeNum);
                    return streams.map(stream => ({ ...stream, provider: '4KHDHub' }));
                } else {
                    console.log(`[4KHDHub] No streams returned.`);
                    // Save empty result
                    await saveStreamToCache('4khdhub', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                    return [];
                }
            } catch (err) {
                console.error(`[4KHDHub] Error fetching streams:`, err.message);
                // Save error status to cache
                await saveStreamToCache('4khdhub', tmdbTypeFromId, tmdbId, [], 'failed', seasonNum, episodeNum);
                return [];
            }
        }
    };

    // Execute all provider fetches in parallel
    console.log('Running parallel provider fetches with caching (MoviesDrive and 4KHDHub only)...');
    
    try {
        // Execute provider functions in parallel with timeout
        const PROVIDER_TIMEOUT_MS = 45000; // 45 seconds
        const providerPromises = [
            timeProvider('MoviesDrive', providerFetchFunctions.moviesdrive()),
            timeProvider('4KHDHub', providerFetchFunctions['4khdhub']())
        ];
        
        // Implement proper timeout that returns results immediately after timeout
        let providerResults;
        let timeoutOccurred = false;
        
        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => {
                timeoutOccurred = true;
                console.log(`[Timeout] ${PROVIDER_TIMEOUT_MS/1000}-second timeout reached. Returning fetched links so far.`);
                resolve('timeout');
            }, PROVIDER_TIMEOUT_MS);
        });
        
        // Start all providers and race against timeout
        const settledPromise = Promise.allSettled(providerPromises);
        const raceResult = await Promise.race([settledPromise, timeoutPromise]);
        
        if (raceResult === 'timeout') {
            // Timeout occurred, collect results from completed providers only
            console.log(`[Timeout] Collecting results from completed providers...`);
            
            // Give a brief moment for any providers that might be just finishing
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Get current state of all promises
            const currentResults = await Promise.allSettled(providerPromises.map(p => 
                Promise.race([p, Promise.resolve([])])
            ));
            
            providerResults = currentResults.map((result, index) => {
                const providerNames = ['MoviesDrive', '4KHDHub'];
                if (result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0) {
                    console.log(`[Timeout] Provider ${providerNames[index]} completed with ${result.value.length} streams.`);
                    return result.value;
                } else {
                    console.log(`[Timeout] Provider ${providerNames[index]} did not complete in time or returned no streams.`);
                    return []; // Return empty array for incomplete/failed providers
                }
            });
        } else {
            // All providers completed within timeout
            providerResults = raceResult.map(result => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    return [];
                }
            });
        }
        
        // Process results into streamsByProvider object
        const streamsByProvider = {
            'MoviesDrive': ENABLE_MOVIESDRIVE_PROVIDER && shouldFetch('moviesdrive') ? applyAllStreamFilters(providerResults[0], 'MoviesDrive', minQualitiesPreferences.moviesdrive, excludeCodecsPreferences.moviesdrive) : [],
            '4KHDHub': ENABLE_4KHDHUB_PROVIDER && shouldFetch('4khdhub') ? applyAllStreamFilters(providerResults[1], '4KHDHub', minQualitiesPreferences['4khdhub'], excludeCodecsPreferences['4khdhub']) : []
        };

        // Sort streams for each provider by quality, then size
        console.log('Sorting streams for each provider by quality, then size...');
        for (const provider in streamsByProvider) {
            streamsByProvider[provider].sort((a, b) => {
                const qualityA = parseQuality(a.quality);
                const qualityB = parseQuality(b.quality);
                if (qualityB !== qualityA) {
                    return qualityB - qualityA; // Higher quality first
                }
                const sizeA = parseSize(a.size);
                const sizeB = parseSize(b.size);
                return sizeB - sizeA; // Larger file first if same quality
            });
        }

        // Combine streams in the preferred provider order
        combinedRawStreams = [];
		const providerOrder = ['MoviesDrive', '4KHDHub'];
        providerOrder.forEach(providerKey => {
            if (streamsByProvider[providerKey] && streamsByProvider[providerKey].length > 0) {
                combinedRawStreams.push(...streamsByProvider[providerKey]);
            }
        });
        
        console.log(`Total raw streams after provider-ordered fetch: ${combinedRawStreams.length}`);

    } catch (error) {
        console.error('Error during provider fetching:', error);
        // Continue with any streams we were able to fetch
    }
    
    if (combinedRawStreams.length === 0) {
        console.log(`  No streams found from any provider for TMDB ${tmdbTypeFromId}/${tmdbId}`);
        return { streams: [] };
    }
    
    console.log(`Total streams after provider-level sorting: ${combinedRawStreams.length}`);

    // Format and send the response
    const stremioStreamObjects = combinedRawStreams.map((stream) => {
        // --- Special handling for MoviesDrive to use its pre-formatted titles ---
        if (stream.provider === 'MoviesDrive') {
            return {
                name: stream.name,    // Use the name from the provider, e.g., "MoviesDrive (Pixeldrain) - 2160p"
                title: stream.title,  // Use the title from the provider, e.g., "Title\nSize\nFilename"
                url: stream.url,
                type: 'url',
                availability: 2,
                behaviorHints: {
                    notWebReady: true
                }
            };
        }

        const qualityLabel = stream.quality || 'UNK'; // UNK for unknown
        
        let displayTitle;
        
        if (stream.provider === '4KHDHub' && stream.title) {
            displayTitle = stream.title; // Use the enhanced title that includes filename and size
        } else if (tmdbTypeFromId === 'tv' && seasonNum !== null && episodeNum !== null && movieOrSeriesTitle) {
            displayTitle = `${movieOrSeriesTitle} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
        } else if (movieOrSeriesTitle) {
            if (tmdbTypeFromId === 'movie' && movieOrSeriesYear) {
                displayTitle = `${movieOrSeriesTitle} (${movieOrSeriesYear})`;
            } else {
                displayTitle = movieOrSeriesTitle;
            }
        } else {
            displayTitle = stream.title || "Unknown Title"; // Fallback to the title from the raw stream data
        }

        const flagEmoji = getFlagEmojiForUrl(stream.url);

        let providerDisplayName = stream.provider; // Default to the existing provider name
        if (stream.provider === 'MoviesDrive') {
            providerDisplayName = 'MoviesDrive';
        } else if (stream.provider === '4KHDHub') {
            providerDisplayName = '4KHDHub';
        }

        let nameDisplay;
        if (stream.provider === 'MoviesDrive') {
            // For MoviesDrive, use the enhanced stream title that comes from the provider
            // which includes detailed quality, source, and size information
            nameDisplay = stream.name || `${providerDisplayName} - ${stream.quality || 'UNK'}`;
        } else if (stream.provider === '4KHDHub') {
            // For 4KHDHub, extract metadata from stream title and enhance the name
            const extractMetadata = (title) => {
                if (!title) return { nameMetadata: [], audioMetadata: [] };
                const nameMetadata = [];
                const audioMetadata = [];
                
                // Check for HDR formats
                if (/HDR10/i.test(title)) nameMetadata.push('HDR10');
                if (/\bDV\b|Dolby.?Vision/i.test(title)) nameMetadata.push('DV');
                if (/HDR/i.test(title) && !nameMetadata.includes('HDR10')) nameMetadata.push('HDR');
                
                // Check for source formats
                if (/BluRay|Blu-ray|BDRip|BRRip/i.test(title)) nameMetadata.push('BluRay');
                if (/WEB-?DL|WEBRip/i.test(title)) nameMetadata.push('WEB');
                if (/REMUX/i.test(title)) nameMetadata.push('REMUX');
                if (/DVD/i.test(title)) nameMetadata.push('DVD');
                
                // Check for special formats
                if (/IMAX/i.test(title)) nameMetadata.push('IMAX');
                
                // Check for audio formats (for title field)
                if (/ATMOS/i.test(title)) audioMetadata.push('ATMOS');
                if (/DTS/i.test(title)) audioMetadata.push('DTS');
                
                return { nameMetadata, audioMetadata };
            };
            
            // Create abbreviated server name mapping for 4KHDHub
            const getAbbreviatedServerName = (streamName) => {
                if (!streamName) return `${providerDisplayName} - ${stream.quality || 'UNK'}`;
                
                const serverMappings = {
                    'HubCloud': '[HC]',
                    'Pixeldrain': '[PD]',
                    'FSL Server': '[FSL]',
                    'BuzzServer': '[BS]',
                    'S3 Server': '[S3]',
                    '10Gbps Server': '[10G]',
                    'HubDrive': '[HD]',
                    'Direct Link': '[DL]'
                };
                
                // Extract server name from stream.name (format: "4KHDHub - ServerName - Quality")
                 const match = streamName.match(/4KHDHub - ([^-]+)/);
                 if (match) {
                     const serverName = match[1].trim();
                     const abbreviation = serverMappings[serverName] || `[${serverName.substring(0, 3).toUpperCase()}]`;
                     
                     // Format quality display
                     const quality = stream.quality || 'UNK';
                     let qualityDisplay;
                     if (quality === '2160' || quality === 2160 || quality === '2160p') {
                         qualityDisplay = '4K';
                     } else if (typeof quality === 'string' && quality.endsWith('p')) {
                         qualityDisplay = quality; // Already has 'p' suffix
                     } else {
                         qualityDisplay = `${quality}p`;
                     }
                     
                     return `4KHDHub ${abbreviation} - ${qualityDisplay}`;
                 }
                
                return streamName;
            };
            
            const baseName = getAbbreviatedServerName(stream.name);
            const { nameMetadata, audioMetadata } = extractMetadata(stream.title);
            
            // Store audio metadata for later use in title field
            stream.audioMetadata = audioMetadata;
            
            if (nameMetadata.length > 0) {
                nameDisplay = `${baseName} | ${nameMetadata.join(' | ')}`;
            } else {
                nameDisplay = baseName;
            }
        } else if (stream.provider === 'Vixsrc') {
            // For Vixsrc, show quality prominently
            const qualityLabel = stream.quality || 'UNK';
            nameDisplay = `${providerDisplayName} - ${qualityLabel}`;
        } else if (stream.provider === 'MovieBox') {
            // For MovieBox, use the name field from the provider (includes language if detected)
            nameDisplay = stream.name || `${providerDisplayName} - ${stream.quality || 'UNK'}`;
        } else { // For other providers
            const qualityLabel = stream.quality || 'UNK';
            // Skip flag emoji for PStream streams
            if (stream.provider === 'PStream') {
                nameDisplay = `${providerDisplayName} - ${qualityLabel}`;
            } else if (flagEmoji) {
                nameDisplay = `${flagEmoji} ${providerDisplayName} - ${qualityLabel}`;
            } else {
                nameDisplay = `${providerDisplayName} - ${qualityLabel}`;
            }
        }
        
        const nameVideoTechTags = [];
        if (stream.codecs && Array.isArray(stream.codecs)) {
            // Only keep HDR codecs if present
            if (stream.codecs.includes('DV')) {
                nameVideoTechTags.push('DV');
            } else if (stream.codecs.includes('HDR10+')) {
                nameVideoTechTags.push('HDR10+');
            } else if (stream.codecs.includes('HDR')) {
                nameVideoTechTags.push('HDR');
            }
        }
        if (nameVideoTechTags.length > 0) {
            nameDisplay += ` | ${nameVideoTechTags.join(' | ')}`;
        }

        let titleParts = [];

        if (stream.codecs && Array.isArray(stream.codecs) && stream.codecs.length > 0) {
            // A more specific order for codecs
            const codecOrder = ['DV', 'HDR', 'Atmos', 'DTS-HD', 'DTS', 'EAC3', 'AC3', 'H.265', 'H.264', '10-bit'];
            const sortedCodecs = stream.codecs.slice().sort((a, b) => {
                const indexA = codecOrder.indexOf(a);
                const indexB = codecOrder.indexOf(b);
                if (indexA === -1 && indexB === -1) return 0;
                if (indexA === -1) return 1;
                if (indexB === -1) return -1;
                return indexA - indexB;
            });
            titleParts.push(...sortedCodecs);
        }

        if (stream.size && stream.size !== 'Unknown size' && !stream.size.toLowerCase().includes('n/a')) {
            let sizeWithAudio = stream.size;
            
            // Add audio metadata for 4KHDHub after size with dot separation
            if (stream.provider === '4KHDHub' && stream.audioMetadata && stream.audioMetadata.length > 0) {
                sizeWithAudio += ' • ' + stream.audioMetadata.join(' • ');
            }

            titleParts.push(sizeWithAudio);
        }
            
        const titleSecondLine = titleParts.join(" • ");
        let finalTitle = titleSecondLine ? `${displayTitle}
${titleSecondLine}` : displayTitle;

        return {
            name: nameDisplay, 
            title: finalTitle, 
            url: stream.url,
            type: 'url', // CRITICAL: This is the type of the stream itself, not the content
            availability: 2, 
            behaviorHints: {
                notWebReady: true // As per the working example, indicates Stremio might need to handle it carefully or use external player
            }
        };
    });

    console.log("--- BEGIN Stremio Stream Objects to be sent ---");
    // Log first 3 streams to keep logs shorter
    const streamSample = stremioStreamObjects.slice(0, 3);
    console.log(JSON.stringify(streamSample, null, 2));
    if (stremioStreamObjects.length > 3) {
        console.log(`... and ${stremioStreamObjects.length - 3} more streams`);
    }
    console.log("--- END Stremio Stream Objects to be sent ---");

    // No need to clean up global variables since we're not using them anymore
    const requestEndTime = Date.now();
    const totalRequestTime = requestEndTime - requestStartTime;
    console.log(`Request for ${id} completed successfully`);

    // --- Timings Summary ---
    console.log("--- Request Timings Summary ---");
    console.log(JSON.stringify(providerTimings, null, 2));
    console.log(`Total Request Time: ${formatDuration(totalRequestTime)}`);
    console.log("-------------------------------");

    return {
        streams: stremioStreamObjects
    };
});

// Build and export the addon
module.exports = builder.getInterface();