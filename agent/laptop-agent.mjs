/**
 * RetroTab Kiosk — Local Windows Companion Agent (Safe S0 Standby + CoreAudio + LAN Camera Bridge)
 *
 * Security boundaries:
 *   - NEVER invokes shutdown, poweroff, reboot, or BIOS modifications.
 *   - Only supports safe S0 Modern Standby (monitor/display sleep), CoreAudio volume,
 *     Spotify desktop launcher, and RFC1918 local-network camera snapshots.
 *   - Pairing uses an interactive 6-digit single-use pairing code or loopback handshake.
 *   - All pairing credentials are stored locally in ~/.retrotab-agent.json with 0600 permissions.
 */

import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';

const HOST = process.env.RETROTAB_AGENT_HOST || '127.0.0.1';
const PORT = Number(process.env.RETROTAB_AGENT_PORT || 8091);
const CONFIG_PATH = path.join(os.homedir(), '.retrotab-agent.json');
const CLOUD_ORIGIN = (process.env.RETROTAB_CLOUD_ORIGIN || 'https://your-retrotab-kiosk.vercel.app').replace(/\/+$/, '');
const POLL_MS = 4000;

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch { /* ignore malformed local file */ }
    return {
        cloudOrigin: CLOUD_ORIGIN,
        agentToken: '',
        deviceName: os.hostname(),
        cameras: {
            main: process.env.RETROTAB_CAM_MAIN_URL || '',
            door: process.env.RETROTAB_CAM_DOOR_URL || ''
        }
    };
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
}

let config = loadConfig();
let lastSyncAt = 0;
let lastSyncError = '';

// ─── RFC1918 Private-Network Guard for Local LAN Camera Bridge ───
function isPrivateLanHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
    return false;
}

const camFrameCache = {
    main: { ts: 0, buf: null, contentType: 'image/jpeg' },
    door: { ts: 0, buf: null, contentType: 'image/jpeg' }
};

function makeCameraPlaceholderSvg(camKey, statusText) {
    const label = camKey === 'door' ? 'DOOR INTERCOM (LAN)' : 'ROOM CAMERA (LAN)';
    const safeStatus = String(statusText || 'Ready for LAN IP/RTSP URL').replace(/[<>&"]/g, '');
    return [
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">',
        '<rect width="640" height="360" fill="#070d18"/>',
        '<rect x="18" y="18" width="604" height="324" rx="14" fill="none" stroke="#1e293b" stroke-width="2"/>',
        '<circle cx="44" cy="44" r="6" fill="#38bdf8"/>',
        `<text x="60" y="49" fill="#e2e8f0" font-family="Arial,sans-serif" font-size="14" font-weight="bold">${label}</text>`,
        `<text x="320" y="182" text-anchor="middle" fill="#94a3b8" font-family="Arial,sans-serif" font-size="16">${safeStatus}</text>`,
        `<text x="320" y="212" text-anchor="middle" fill="#475569" font-family="Arial,sans-serif" font-size="12">RFC1918 Local Bridge • Zero Cloud Bandwidth</text>`,
        '</svg>'
    ].join('');
}

async function captureLanCameraFrame(camKey) {
    const key = camKey === 'door' ? 'door' : 'main';
    const now = Date.now();
    if (camFrameCache[key].buf && (now - camFrameCache[key].ts) < 1500) {
        return camFrameCache[key];
    }

    const rawUrl = String((config.cameras && config.cameras[key]) || '').trim();
    if (!rawUrl) {
        return {
            buf: Buffer.from(makeCameraPlaceholderSvg(key, 'Set RETROTAB_CAM_MAIN_URL / DOOR_URL to enable live feed')),
            contentType: 'image/svg+xml'
        };
    }

    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return {
            buf: Buffer.from(makeCameraPlaceholderSvg(key, 'Invalid camera URL')),
            contentType: 'image/svg+xml'
        };
    }

    if (!isPrivateLanHost(parsed.hostname)) {
        return {
            buf: Buffer.from(makeCameraPlaceholderSvg(key, 'Blocked: Only private RFC1918 LAN cameras allowed')),
            contentType: 'image/svg+xml'
        };
    }

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        try {
            const resp = await fetch(parsed.toString(), { signal: AbortSignal.timeout(4000) });
            if (resp.ok) {
                const ct = resp.headers.get('content-type') || 'image/jpeg';
                const buf = Buffer.from(await resp.arrayBuffer());
                camFrameCache[key] = { ts: now, buf, contentType: ct };
                return camFrameCache[key];
            }
        } catch { /* fall through to placeholder */ }
    }

    if (parsed.protocol === 'rtsp:') {
        const tmpJpg = path.join(os.tmpdir(), `retrotab-cam-${key}.jpg`);
        try {
            await new Promise((resolve, reject) => {
                execFile('ffmpeg', [
                    '-y', '-rtsp_transport', 'tcp',
                    '-i', parsed.toString(),
                    '-frames:v', '1',
                    '-vf', 'scale=640:-1',
                    '-q:v', '7',
                    tmpJpg
                ], { timeout: 6000 }, (err) => (err ? reject(err) : resolve()));
            });
            if (fs.existsSync(tmpJpg)) {
                const buf = fs.readFileSync(tmpJpg);
                camFrameCache[key] = { ts: now, buf, contentType: 'image/jpeg' };
                return camFrameCache[key];
            }
        } catch { /* ffmpeg optional */ }
    }

    return {
        buf: Buffer.from(makeCameraPlaceholderSvg(key, 'Camera unreachable on LAN')),
        contentType: 'image/svg+xml'
    };
}

// ─── Windows CoreAudio Volume & Safe S0 Display Standby Helpers ───
function runPowerShell(psScript) {
    return new Promise((resolve, reject) => {
        if (process.platform !== 'win32') {
            return resolve('non-windows-noop');
        }
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 8000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve(String(stdout || '').trim());
        });
    });
}

const AUDIO_CSHARP = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int f();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
public class RetroAudio {
    static IAudioEndpointVolume Vol() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice dev; enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        var iid = typeof(IAudioEndpointVolume).GUID;
        object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
        return (IAudioEndpointVolume)o;
    }
    public static int GetVol() { float v; Vol().GetMasterVolumeLevelScalar(out v); return (int)Math.Round(v * 100); }
    public static void SetVol(int pct) {
        float f = Math.Max(0f, Math.Min(1f, pct / 100f));
        Vol().SetMasterVolumeLevelScalar(f, Guid.Empty);
    }
    public static void ToggleMute() { bool m; var v = Vol(); v.GetMute(out m); v.SetMute(!m, Guid.Empty); }
}
"@ -ErrorAction SilentlyContinue
`;

async function getSystemVolume() {
    if (process.platform !== 'win32') return 50;
    try {
        const out = await runPowerShell(`${AUDIO_CSHARP}\n[RetroAudio]::GetVol()`);
        const n = parseInt(out, 10);
        return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50;
    } catch {
        return 50;
    }
}

async function setSystemVolume(pct) {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    if (process.platform !== 'win32') return clamped;
    await runPowerShell(`${AUDIO_CSHARP}\n[RetroAudio]::SetVol(${clamped})`);
    return clamped;
}

async function triggerSafeS0Sleep() {
    // Safe S0 Display Standby ONLY — NEVER calls shutdown / poweroff / hibernate.
    if (process.platform !== 'win32') return 'noop';
    await runPowerShell(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SafeSleep {
    [DllImport("user32.dll")] public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);
}
"@ -ErrorAction SilentlyContinue
[SafeSleep]::SendMessage(-1, 0x0112, 0xF170, 2)
`);
    return 'display_s0_standby';
}

async function triggerWakeDisplay() {
    if (process.platform !== 'win32') return 'noop';
    await runPowerShell(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SafeWake {
    [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
}
"@ -ErrorAction SilentlyContinue
[SafeWake]::SetThreadExecutionState(0x00000003)
`);
    return 'display_awake';
}

async function executeAgentAction(action, payload) {
    if (action === 'sleep') return await triggerSafeS0Sleep();
    if (action === 'wake') return await triggerWakeDisplay();
    if (action === 'volume_set') return await setSystemVolume(payload?.level ?? 50);
    if (action === 'volume_delta') {
        const cur = await getSystemVolume();
        return await setSystemVolume(cur + Number(payload?.delta || 0));
    }
    if (action === 'volume_mute') {
        if (process.platform === 'win32') {
            await runPowerShell(`${AUDIO_CSHARP}\n[RetroAudio]::ToggleMute()`);
        }
        return 'mute_toggled';
    }
    if (action === 'spotify_open') {
        if (process.platform === 'win32') {
            execFile('cmd.exe', ['/c', 'start', '', 'spotify:'], { windowsHide: true });
        }
        return 'spotify_launched';
    }
    return 'ignored';
}

async function pollCloudQueue() {
    if (!config.agentToken || !config.cloudOrigin) return;
    try {
        const vol = await getSystemVolume();
        const resp = await fetch(`${config.cloudOrigin}/api/kiosk`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Agent-Token': config.agentToken
            },
            body: JSON.stringify({
                actionType: 'agent_heartbeat',
                deviceName: config.deviceName || os.hostname(),
                volume: vol,
                platform: process.platform
            }),
            signal: AbortSignal.timeout(8000)
        });
        if (!resp.ok) {
            lastSyncError = `HTTP ${resp.status}`;
            return;
        }
        const data = await resp.json();
        lastSyncAt = Date.now();
        lastSyncError = '';
        if (Array.isArray(data.commands)) {
            for (const cmd of data.commands) {
                try {
                    await executeAgentAction(cmd.action, cmd.payload || {});
                } catch (e) {
                    console.error('[RetroTab Agent] Command failed:', cmd.action, e.message);
                }
            }
        }
    } catch (err) {
        lastSyncError = err.message;
    }
}

async function pairWithSixDigitCode(code, originOverride) {
    const targetOrigin = (originOverride || config.cloudOrigin || CLOUD_ORIGIN).replace(/\/+$/, '');
    const resp = await fetch(`${targetOrigin}/api/kiosk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            actionType: 'pc_pair_claim',
            code: String(code || '').trim(),
            deviceName: os.hostname()
        })
    });
    const data = await resp.json();
    if (!resp.ok || !data.agentToken) {
        throw new Error(data.error || 'Pairing failed');
    }
    config.cloudOrigin = targetOrigin;
    config.agentToken = data.agentToken;
    saveConfig(config);
    console.log('[RetroTab Agent] Paired cleanly with', targetOrigin);
}

// ─── CLI `--pair <6-digit-code> [origin]` shortcut ───
const pairIdx = process.argv.indexOf('--pair');
if (pairIdx !== -1) {
    const code = process.argv[pairIdx + 1];
    const originArg = process.argv[pairIdx + 2];
    if (!code) {
        console.error('Usage: node agent/laptop-agent.mjs --pair <6-digit-code> [https://your-kiosk.vercel.app]');
        process.exit(1);
    }
    pairWithSixDigitCode(code, originArg)
        .then(() => process.exit(0))
        .catch((err) => { console.error('[RetroTab Agent]', err.message); process.exit(1); });
} else {
    // ─── Local HTTP Server (Loopback + LAN Camera Bridge) ───
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        const parsedUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
        const remoteAddr = req.socket?.remoteAddress || '';
        const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';

        if (req.method === 'GET' && parsedUrl.pathname === '/api/agent/health') {
            const volume = await getSystemVolume();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                ok: true,
                paired: Boolean(config.agentToken),
                deviceName: config.deviceName,
                volume,
                lastSyncAt,
                lastSyncError,
                camerasConfigured: {
                    main: Boolean(config.cameras?.main),
                    door: Boolean(config.cameras?.door)
                }
            }));
        }

        if (req.method === 'GET' && parsedUrl.pathname === '/api/agent/camera') {
            const cam = parsedUrl.searchParams.get('cam') || 'main';
            const frame = await captureLanCameraFrame(cam);
            res.writeHead(200, {
                'Content-Type': frame.contentType,
                'Cache-Control': 'no-store'
            });
            return res.end(frame.buf);
        }

        if (req.method === 'POST' && parsedUrl.pathname === '/api/agent/camera-config') {
            if (!isLoopback) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Loopback only' }));
            }
            let raw = '';
            for await (const chunk of req) raw += chunk;
            try {
                const body = JSON.parse(raw || '{}');
                config.cameras = config.cameras || {};
                for (const key of ['main', 'door']) {
                    if (typeof body[key] === 'string') {
                        const val = body[key].trim();
                        if (val) {
                            const u = new URL(val);
                            if (!isPrivateLanHost(u.hostname)) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                return res.end(JSON.stringify({ error: 'Only RFC1918 private LAN URLs are permitted' }));
                            }
                        }
                        config.cameras[key] = val;
                    }
                }
                saveConfig(config);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, cameras: { main: Boolean(config.cameras.main), door: Boolean(config.cameras.door) } }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e.message }));
            }
        }

        if (req.method === 'POST' && parsedUrl.pathname === '/api/agent/pair') {
            if (!isLoopback) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Loopback only' }));
            }
            let raw = '';
            for await (const chunk of req) raw += chunk;
            try {
                const body = JSON.parse(raw || '{}');
                if (body.code) {
                    await pairWithSixDigitCode(body.code, body.cloudOrigin);
                } else if (body.agentToken && body.cloudOrigin) {
                    config.agentToken = String(body.agentToken);
                    config.cloudOrigin = String(body.cloudOrigin).replace(/\/+$/, '');
                    saveConfig(config);
                } else {
                    throw new Error('Provide { code } or { agentToken, cloudOrigin }');
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, paired: true }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e.message }));
            }
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    });

    server.listen(PORT, HOST, () => {
        console.log(`[RetroTab Agent] Listening on http://${HOST}:${PORT} (paired=${Boolean(config.agentToken)})`);
        setInterval(pollCloudQueue, POLL_MS);
        pollCloudQueue();
    });
}
