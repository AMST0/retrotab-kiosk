/**
 * RetroTab Kiosk — Serverless Backend API (Vercel / Node 18+)
 * 100% environment-driven, zero personal data or hardcoded secrets.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';

// ─── Runtime Configuration (All via Environment Variables) ───
function getConfig() {
    return {
        jwtSecret: String(process.env.JWT_SECRET || '').trim(),
        userName: String(process.env.KIOSK_USER_NAME || 'User').trim(),
        cityName: String(process.env.KIOSK_CITY_NAME || 'San Francisco').trim(),
        timeZone: String(process.env.KIOSK_TIMEZONE || 'UTC').trim(),
        originName: String(process.env.COMMUTE_ORIGIN_NAME || 'Home Stop').trim(),
        originLat: Number(process.env.COMMUTE_ORIGIN_LAT || 37.7749),
        originLon: Number(process.env.COMMUTE_ORIGIN_LON || -122.4194),
        destName: String(process.env.COMMUTE_DEST_NAME || 'Downtown Office').trim(),
        destLat: Number(process.env.COMMUTE_DEST_LAT || 37.7897),
        destLon: Number(process.env.COMMUTE_DEST_LON || -122.4014),
        preferredLine: String(process.env.COMMUTE_PREFERRED_LINE || 'Bus 38R').trim(),
        googleMapsKey: String(process.env.GOOGLE_MAPS_API_KEY || '').trim(),
        geminiKey: String(process.env.GEMINI_API_KEY || '').trim(),
        geminiTextModel: String(process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash').trim(),
        geminiTtsModel: String(process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts').trim(),
        geminiTtsVoice: String(process.env.GEMINI_TTS_VOICE || 'Charon').trim(),
        spotifyClientId: String(process.env.SPOTIFY_CLIENT_ID || '').trim(),
        spotifyClientSecret: String(process.env.SPOTIFY_CLIENT_SECRET || '').trim(),
        spotifyRefreshToken: String(process.env.SPOTIFY_REFRESH_TOKEN || '').trim(),
        googleClientId: String(process.env.GOOGLE_CLIENT_ID || '').trim(),
        googleClientSecret: String(process.env.GOOGLE_CLIENT_SECRET || '').trim(),
        googleRefreshToken: String(process.env.GOOGLE_REFRESH_TOKEN || '').trim(),
        haUrl: String(process.env.HA_URL || '').replace(/\/+$/, ''),
        haToken: String(process.env.HA_TOKEN || '').trim(),
        haRoomLight: String(process.env.HA_ROOM_LIGHT_ENTITY || 'light.room_light').trim(),
        supabaseUrl: String(process.env.SUPABASE_URL || '').trim(),
        supabaseKey: String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
    };
}

let cachedSupabase = null;
function getSupabase(cfg) {
    if (!cfg.supabaseUrl || !cfg.supabaseKey) return null;
    if (!cachedSupabase) {
        cachedSupabase = createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: false } });
    }
    return cachedSupabase;
}

// ─── Ephemeral Fallback Stores (when Supabase is not configured) ───
const memState = {
    agentToken: '',
    agentDevice: '',
    agentLastSeen: 0,
    agentVolume: 50,
    pendingPairCode: '',
    pendingPairExpires: 0,
    pcQueue: [],
    roomLightOn: false,
    tasks: [
        { id: 'demo-1', title: 'Review morning calendar & commute ETA', status: 'todo', priority: 'high' },
        { id: 'demo-2', title: 'Pair local Windows S0 companion agent', status: 'todo', priority: 'medium' },
        { id: 'demo-3', title: 'Mount legacy iPad 2 on desk or wall stand', status: 'completed', priority: 'low' }
    ]
};

function verifyJwt(req, cfg) {
    if (cfg.jwtSecret.length < 16) return null;
    const authHeader = String(req.headers.authorization || '');
    const queryTok = req.query && req.query.token ? String(req.query.token) : '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : queryTok.trim();
    if (!token) return null;
    try {
        return jwt.verify(token, cfg.jwtSecret);
    } catch {
        return null;
    }
}

function timingSafeEqualStr(a, b) {
    const ba = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    if (ba.length !== bb.length || ba.length === 0) return false;
    return crypto.timingSafeEqual(ba, bb);
}

// ─── Weather (Open-Meteo — Free, No API Key Required) ───
const WMO_LABELS = {
    0: ['Clear Sky', 'clear'],
    1: ['Mostly Clear', 'clear'],
    2: ['Partly Cloudy', 'cloudy'],
    3: ['Overcast', 'cloudy'],
    45: ['Foggy', 'fog'],
    48: ['Rime Fog', 'fog'],
    51: ['Light Drizzle', 'rain'],
    53: ['Drizzle', 'rain'],
    61: ['Light Rain', 'rain'],
    63: ['Moderate Rain', 'rain'],
    65: ['Heavy Rain', 'rain'],
    71: ['Light Snow', 'snow'],
    73: ['Snow', 'snow'],
    80: ['Rain Showers', 'rain'],
    95: ['Thunderstorm', 'storm']
};

async function fetchWeather(cfg) {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${cfg.originLat}&longitude=${cfg.originLon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day&timezone=auto`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const cur = data.current || {};
        const code = Number(cur.weather_code ?? 0);
        const [label, kind] = WMO_LABELS[code] || ['Mild', 'cloudy'];
        return {
            city: cfg.cityName,
            tempC: Math.round(Number(cur.temperature_2m ?? 18)),
            feelsLikeC: Math.round(Number(cur.apparent_temperature ?? 18)),
            windKmh: Math.round(Number(cur.wind_speed_10m ?? 10)),
            code,
            label,
            kind,
            isDay: cur.is_day !== 0,
            isRainy: kind === 'rain' || kind === 'storm' || kind === 'snow'
        };
    } catch {
        return {
            city: cfg.cityName,
            tempC: 18,
            feelsLikeC: 18,
            windKmh: 8,
            code: 2,
            label: 'Partly Cloudy',
            kind: 'cloudy',
            isDay: true,
            isRainy: false
        };
    }
}

// ─── Transit Arrivals (Google Maps Directions API or Clean Fallback) ───
async function fetchTransit(cfg) {
    if (cfg.googleMapsKey) {
        try {
            const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${cfg.originLat},${cfg.originLon}&destination=${cfg.destLat},${cfg.destLon}&mode=transit&departure_time=now&alternatives=true&key=${encodeURIComponent(cfg.googleMapsKey)}`;
            const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
            if (resp.ok) {
                const json = await resp.json();
                const routes = Array.isArray(json.routes) ? json.routes : [];
                const arrivals = [];
                for (const route of routes.slice(0, 3)) {
                    const leg = route.legs && route.legs[0];
                    if (!leg) continue;
                    const transitStep = (leg.steps || []).find((s) => s.travel_mode === 'TRANSIT' && s.transit_details);
                    const line = transitStep?.transit_details?.line?.short_name || transitStep?.transit_details?.line?.name || cfg.preferredLine;
                    const depVal = transitStep?.transit_details?.departure_time?.value;
                    const etaMin = depVal ? Math.max(1, Math.round((depVal * 1000 - Date.now()) / 60000)) : Math.max(2, Math.round((leg.duration?.value || 900) / 60));
                    const stopsAway = Math.max(1, Math.min(12, Math.round(etaMin / 1.8)));
                    arrivals.push({
                        line,
                        etaMin,
                        stopsAway,
                        tripMin: Math.round((leg.duration?.value || 1320) / 60),
                        headsign: transitStep?.transit_details?.headsign || cfg.destName
                    });
                }
                if (arrivals.length > 0) {
                    arrivals.sort((a, b) => a.etaMin - b.etaMin);
                    return {
                        stopName: cfg.originName,
                        destination: cfg.destName,
                        preferredLine: cfg.preferredLine,
                        source: 'google_maps',
                        arrivals
                    };
                }
            }
        } catch { /* fallback below */ }
    }

    // Deterministic schedule simulation when no Maps API key is configured
    const minute = new Date().getMinutes();
    const next1 = Math.max(1, 7 - (minute % 7));
    const next2 = next1 + 8;
    return {
        stopName: cfg.originName,
        destination: cfg.destName,
        preferredLine: cfg.preferredLine,
        source: 'simulated',
        arrivals: [
            { line: cfg.preferredLine, etaMin: next1, stopsAway: Math.max(1, Math.ceil(next1 / 2)), tripMin: 22, headsign: cfg.destName },
            { line: 'Express 14X', etaMin: next2, stopsAway: Math.max(2, Math.ceil(next2 / 2)), tripMin: 19, headsign: cfg.destName }
        ]
    };
}

// ─── Spotify Web API Helper ───
let spotifyTokenCache = { accessToken: '', expiresAt: 0 };

async function getSpotifyAccessToken(cfg) {
    if (!cfg.spotifyClientId || !cfg.spotifyClientSecret || !cfg.spotifyRefreshToken) return '';
    if (spotifyTokenCache.accessToken && Date.now() < spotifyTokenCache.expiresAt - 60000) {
        return spotifyTokenCache.accessToken;
    }
    const basic = Buffer.from(`${cfg.spotifyClientId}:${cfg.spotifyClientSecret}`).toString('base64');
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cfg.spotifyRefreshToken
    });
    const resp = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    if (!resp.ok) return '';
    const data = await resp.json();
    spotifyTokenCache = {
        accessToken: data.access_token || '',
        expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
    };
    return spotifyTokenCache.accessToken;
}

async function handleSpotify(body, cfg) {
    const token = await getSpotifyAccessToken(cfg);
    if (!token) {
        return {
            connected: false,
            isPlaying: false,
            track: 'Spotify Not Configured',
            artist: 'Set SPOTIFY_* env vars in .env.local',
            albumArt: '',
            progressMs: 0,
            durationMs: 0,
            volume: 50,
            devices: [],
            playlists: []
        };
    }

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const op = String(body.op || 'status');

    if (op === 'play') {
        const playBody = body.contextUri ? JSON.stringify({ context_uri: body.contextUri }) : undefined;
        await fetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT', headers, body: playBody });
    } else if (op === 'pause') {
        await fetch('https://api.spotify.com/v1/me/player/pause', { method: 'PUT', headers });
    } else if (op === 'next') {
        await fetch('https://api.spotify.com/v1/me/player/next', { method: 'POST', headers });
    } else if (op === 'prev') {
        await fetch('https://api.spotify.com/v1/me/player/previous', { method: 'POST', headers });
    } else if (op === 'seek') {
        const pos = Math.max(0, Math.round(Number(body.positionMs) || 0));
        await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${pos}`, { method: 'PUT', headers });
    } else if (op === 'volume') {
        const vol = Math.max(0, Math.min(100, Math.round(Number(body.volume) || 50)));
        await fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${vol}`, { method: 'PUT', headers });
    } else if (op === 'transfer' && body.deviceId) {
        await fetch('https://api.spotify.com/v1/me/player', {
            method: 'PUT',
            headers,
            body: JSON.stringify({ device_ids: [String(body.deviceId)], play: true })
        });
    } else if (op === 'playlists') {
        const plResp = await fetch('https://api.spotify.com/v1/me/playlists?limit=20', { headers });
        const plJson = plResp.ok ? await plResp.json() : { items: [] };
        return {
            connected: true,
            playlists: (plJson.items || []).map((p) => ({
                id: p.id,
                name: p.name,
                uri: p.uri,
                tracks: p.tracks?.total || 0
            }))
        };
    }

    const [playerResp, devResp] = await Promise.all([
        fetch('https://api.spotify.com/v1/me/player', { headers }),
        fetch('https://api.spotify.com/v1/me/player/devices', { headers })
    ]);
    const player = playerResp.status === 200 ? await playerResp.json() : null;
    const devs = devResp.ok ? await devResp.json() : { devices: [] };
    const item = player?.item;

    return {
        connected: true,
        isPlaying: Boolean(player?.is_playing),
        track: item?.name || 'Nothing Playing',
        artist: (item?.artists || []).map((a) => a.name).join(', ') || 'Select a playlist or device',
        albumArt: item?.album?.images?.[0]?.url || '',
        previewUrl: item?.preview_url || '',
        progressMs: Number(player?.progress_ms || 0),
        durationMs: Number(item?.duration_ms || 0),
        volume: Number(player?.device?.volume_percent ?? 50),
        activeDevice: player?.device?.name || '',
        devices: (devs.devices || []).map((d) => ({ id: d.id, name: d.name, active: Boolean(d.is_active) }))
    };
}

// ─── Google Gmail + Calendar Helper ───
async function getGoogleAccessToken(cfg) {
    if (!cfg.googleClientId || !cfg.googleClientSecret || !cfg.googleRefreshToken) return '';
    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: cfg.googleClientId,
            client_secret: cfg.googleClientSecret,
            refresh_token: cfg.googleRefreshToken,
            grant_type: 'refresh_token'
        })
    });
    if (!resp.ok) return '';
    const data = await resp.json();
    return data.access_token || '';
}

async function fetchCommsFeed(cfg) {
    const mails = [];
    const events = [];
    const googleToken = await getGoogleAccessToken(cfg);
    let googleConnected = false;

    if (googleToken) {
        googleConnected = true;
        const headers = { Authorization: `Bearer ${googleToken}` };
        try {
            const listResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=in:inbox', { headers });
            if (listResp.ok) {
                const listJson = await listResp.json();
                const ids = (listJson.messages || []).slice(0, 5).map((m) => m.id);
                const details = await Promise.all(ids.map(async (id) => {
                    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, { headers });
                    return r.ok ? r.json() : null;
                }));
                for (const msg of details) {
                    if (!msg) continue;
                    const hdrs = msg.payload?.headers || [];
                    const subject = hdrs.find((h) => h.name === 'Subject')?.value || '(No Subject)';
                    const from = hdrs.find((h) => h.name === 'From')?.value || '';
                    mails.push({ id: msg.id, subject, from: from.replace(/<.*>/, '').trim(), snippet: msg.snippet || '' });
                }
            }
        } catch { /* ignore mail errors */ }

        try {
            const nowIso = new Date().toISOString();
            const calResp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=5&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(nowIso)}`, { headers });
            if (calResp.ok) {
                const calJson = await calResp.json();
                for (const ev of (calJson.items || []).slice(0, 5)) {
                    events.push({
                        id: ev.id,
                        title: ev.summary || 'Untitled Event',
                        start: ev.start?.dateTime || ev.start?.date || ''
                    });
                }
            }
        } catch { /* ignore calendar errors */ }
    }

    let tasks = memState.tasks;
    const sb = getSupabase(cfg);
    if (sb) {
        try {
            const { data } = await sb.from('personal_tasks').select('id, title, status, priority').order('created_at', { ascending: false }).limit(12);
            if (Array.isArray(data)) tasks = data;
        } catch { /* fallback to memState */ }
    }

    const sortedTasks = [...tasks].sort((a, b) => (a.status === 'completed' ? 1 : 0) - (b.status === 'completed' ? 1 : 0));
    return { googleConnected, mails, events, tasks: sortedTasks };
}

// ─── Home Assistant Helper ───
async function setRoomLight(cfg, turnOn) {
    memState.roomLightOn = Boolean(turnOn);
    if (!cfg.haUrl || !cfg.haToken) return { ok: true, simulated: true, on: memState.roomLightOn };
    try {
        const service = turnOn ? 'turn_on' : 'turn_off';
        const resp = await fetch(`${cfg.haUrl}/api/services/light/${service}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.haToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: cfg.haRoomLight })
        });
        return { ok: resp.ok, on: memState.roomLightOn };
    } catch {
        return { ok: false, on: memState.roomLightOn };
    }
}

// ─── Gemini Conversational AI + Charon WAV TTS ───
function pcm16ToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmBuffer.length, 40);
    return Buffer.concat([header, pcmBuffer]);
}

async function synthesizeCharonWav(text, cfg) {
    if (!cfg.geminiKey) return null;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiTtsModel)}:generateContent?key=${encodeURIComponent(cfg.geminiKey)}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: String(text || '').slice(0, 420) }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.geminiTtsVoice } }
                }
            }
        }),
        signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const inline = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inline?.data) return null;
    const raw = Buffer.from(inline.data, 'base64');
    if (String(inline.mimeType || '').includes('L16') || String(inline.mimeType || '').includes('pcm')) {
        return { buf: pcm16ToWav(raw), mimeType: 'audio/wav' };
    }
    return { buf: raw, mimeType: inline.mimeType || 'audio/wav' };
}

async function askGemini(prompt, cfg, contextSummary) {
    if (!cfg.geminiKey) {
        return `Hello ${cfg.userName}. Gemini API key is not configured yet, but your live kiosk telemetry says: ${contextSummary}`;
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiTextModel)}:generateContent?key=${encodeURIComponent(cfg.geminiKey)}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            systemInstruction: {
                parts: [{ text: `You are RetroTab AI, a concise, helpful smart wall hub assistant for ${cfg.userName}. Answer in 1-2 short natural sentences suitable for voice playback. Context: ${contextSummary}` }]
            },
            contents: [{ role: 'user', parts: [{ text: String(prompt || '').slice(0, 600) }] }]
        }),
        signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return `Unable to reach Gemini right now (${contextSummary}).`;
    const json = await resp.json();
    return json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Ready.';
}

function makeCloudCameraPlaceholder(camKey) {
    const title = camKey === 'door' ? 'DOOR INTERCOM' : 'ROOM CAMERA';
    return [
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">',
        '<rect width="640" height="360" fill="#070d18"/>',
        '<rect x="16" y="16" width="608" height="328" rx="14" fill="none" stroke="#1e293b" stroke-width="2"/>',
        `<text x="320" y="166" text-anchor="middle" fill="#e2e8f0" font-family="Arial,sans-serif" font-size="18" font-weight="bold">${title}</text>`,
        '<text x="320" y="198" text-anchor="middle" fill="#64748b" font-family="Arial,sans-serif" font-size="13">Tap LAN Bridge to stream directly from your local Windows companion agent</text>',
        '</svg>'
    ].join('');
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const cfg = getConfig();

    // ─── GET Camera Frame Placeholder ───
    if (req.method === 'GET' && req.query?.action === 'camera_frame') {
        const claims = verifyJwt(req, cfg);
        if (!claims) return res.status(401).json({ error: 'Unauthorized' });
        const cam = req.query.cam === 'door' ? 'door' : 'main';
        res.setHeader('Content-Type', 'image/svg+xml');
        return res.status(200).send(makeCloudCameraPlaceholder(cam));
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const actionType = String(body.actionType || 'status');

    // ─── Unauthenticated-by-JWT Companion Agent Pairing & Heartbeat ───
    if (actionType === 'pc_pair_claim') {
        const code = String(body.code || '').trim();
        if (!memState.pendingPairCode || Date.now() > memState.pendingPairExpires || !timingSafeEqualStr(code, memState.pendingPairCode)) {
            return res.status(401).json({ error: 'Invalid or expired 6-digit pairing code' });
        }
        memState.pendingPairCode = '';
        memState.agentToken = crypto.randomBytes(32).toString('hex');
        memState.agentDevice = String(body.deviceName || 'Windows PC').slice(0, 64);
        memState.agentLastSeen = Date.now();
        return res.status(200).json({ ok: true, agentToken: memState.agentToken });
    }

    if (actionType === 'agent_heartbeat') {
        const hdrTok = String(req.headers['x-agent-token'] || '');
        if (!memState.agentToken || !timingSafeEqualStr(hdrTok, memState.agentToken)) {
            return res.status(401).json({ error: 'Invalid agent token' });
        }
        memState.agentLastSeen = Date.now();
        memState.agentDevice = String(body.deviceName || memState.agentDevice || 'Windows PC').slice(0, 64);
        if (Number.isFinite(Number(body.volume))) {
            memState.agentVolume = Math.max(0, Math.min(100, Math.round(Number(body.volume))));
        }
        const commands = memState.pcQueue.splice(0, 10);
        return res.status(200).json({ ok: true, commands });
    }

    // ─── All User Kiosk Endpoints Require Valid JWT ───
    const claims = verifyJwt(req, cfg);
    if (!claims) return res.status(401).json({ error: 'Unauthorized' });

    if (actionType === 'status') {
        const [weather, transit] = await Promise.all([fetchWeather(cfg), fetchTransit(cfg)]);
        const pcOnline = memState.agentLastSeen > 0 && (Date.now() - memState.agentLastSeen) < 25000;
        return res.status(200).json({
            ok: true,
            config: {
                userName: cfg.userName,
                cityName: cfg.cityName,
                originName: cfg.originName,
                destName: cfg.destName,
                preferredLine: cfg.preferredLine
            },
            weather,
            transit,
            roomLightOn: memState.roomLightOn,
            pc: {
                online: pcOnline,
                deviceName: memState.agentDevice || 'Windows Companion',
                volume: memState.agentVolume
            }
        });
    }

    if (actionType === 'spotify') {
        const result = await handleSpotify(body, cfg);
        return res.status(200).json(result);
    }

    if (actionType === 'comms_feed') {
        const feed = await fetchCommsFeed(cfg);
        return res.status(200).json({ ok: true, ...feed });
    }

    if (actionType === 'task_toggle') {
        const taskId = String(body.taskId || '');
        const nextStatus = body.completed ? 'completed' : 'todo';
        const sb = getSupabase(cfg);
        if (sb && !taskId.startsWith('demo-')) {
            await sb.from('personal_tasks').update({ status: nextStatus }).eq('id', taskId);
        } else {
            const found = memState.tasks.find((t) => t.id === taskId);
            if (found) found.status = nextStatus;
        }
        return res.status(200).json({ ok: true, taskId, status: nextStatus });
    }

    if (actionType === 'ha_toggle') {
        const target = typeof body.on === 'boolean' ? body.on : !memState.roomLightOn;
        const result = await setRoomLight(cfg, target);
        return res.status(200).json({ ok: true, ...result });
    }

    if (actionType === 'pc_pair_create') {
        const code = String(crypto.randomInt(100000, 999999));
        memState.pendingPairCode = code;
        memState.pendingPairExpires = Date.now() + 5 * 60 * 1000;
        return res.status(200).json({ ok: true, code, expiresInSec: 300 });
    }

    if (actionType === 'pc_command') {
        const cmd = String(body.command || '');
        const allowed = ['sleep', 'wake', 'volume_set', 'volume_delta', 'volume_mute', 'spotify_open'];
        if (!allowed.includes(cmd)) {
            return res.status(400).json({ error: 'Unsupported or unsafe PC command' });
        }
        memState.pcQueue.push({ id: crypto.randomUUID(), action: cmd, payload: body.payload || {} });
        if (cmd === 'volume_set' && Number.isFinite(Number(body.payload?.level))) {
            memState.agentVolume = Math.max(0, Math.min(100, Math.round(Number(body.payload.level))));
        }
        return res.status(200).json({ ok: true, queued: cmd, volume: memState.agentVolume });
    }

    if (actionType === 'scene') {
        const scene = String(body.scene || '').toLowerCase();
        if (scene === 'focus') {
            await setRoomLight(cfg, true);
            memState.pcQueue.push({ id: crypto.randomUUID(), action: 'volume_set', payload: { level: 35 } });
            memState.agentVolume = 35;
            return res.status(200).json({
                ok: true,
                scene: 'focus',
                roomLightOn: true,
                pcVolume: 35,
                spotifyAction: 'play',
                reply: 'Focus mode enabled. Room light is on, PC volume set to 35 percent, and music started.'
            });
        }
        if (scene === 'sleep') {
            await setRoomLight(cfg, false);
            memState.pcQueue.push({ id: crypto.randomUUID(), action: 'sleep', payload: {} });
            return res.status(200).json({
                ok: true,
                scene: 'sleep',
                roomLightOn: false,
                spotifyAction: 'pause',
                reply: 'Good night. Music paused, lights off, and PC entering safe S0 standby.'
            });
        }
        if (scene === 'leave') {
            await setRoomLight(cfg, false);
            memState.pcQueue.push({ id: crypto.randomUUID(), action: 'sleep', payload: {} });
            const [weather, transit] = await Promise.all([fetchWeather(cfg), fetchTransit(cfg)]);
            const nextBus = transit.arrivals && transit.arrivals[0];
            const busMsg = nextBus ? `${nextBus.line} arrives in ${nextBus.etaMin} minutes (${nextBus.stopsAway} stops away).` : 'Transit schedule is ready.';
            const rainMsg = weather.isRainy ? ' Rain expected, take an umbrella.' : '';
            return res.status(200).json({
                ok: true,
                scene: 'leave',
                roomLightOn: false,
                spotifyAction: 'pause',
                reply: `Heading out. Lights off, PC sleeping. ${busMsg}${rainMsg}`
            });
        }
        return res.status(400).json({ error: 'Unknown scene' });
    }

    if (actionType === 'chat') {
        const [weather, transit] = await Promise.all([fetchWeather(cfg), fetchTransit(cfg)]);
        const nextBus = transit.arrivals && transit.arrivals[0];
        const summary = `Weather in ${weather.city}: ${weather.tempC}C ${weather.label}. Next bus: ${nextBus ? `${nextBus.line} in ${nextBus.etaMin} min` : 'N/A'}. Room light: ${memState.roomLightOn ? 'ON' : 'OFF'}.`;
        const reply = await askGemini(body.message || 'Give me a brief morning update.', cfg, summary);
        return res.status(200).json({ ok: true, reply });
    }

    if (actionType === 'tts') {
        const audio = await synthesizeCharonWav(body.text || '', cfg);
        if (!audio) return res.status(503).json({ error: 'TTS not configured or unavailable' });
        res.setHeader('Content-Type', audio.mimeType);
        return res.status(200).send(audio.buf);
    }

    return res.status(400).json({ error: `Unknown actionType: ${actionType}` });
}
