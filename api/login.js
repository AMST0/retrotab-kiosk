import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const loginAttempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
    const now = Date.now();
    const rec = loginAttempts.get(ip);
    if (!rec || now > rec.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
        return true;
    }
    if (rec.count >= MAX_ATTEMPTS) return false;
    rec.count += 1;
    return true;
}

function timingSafeTextEqual(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const jwtSecret = String(process.env.JWT_SECRET || '').trim();
    const expectedUser = String(process.env.ADMIN_USERNAME || 'admin').trim();
    const expectedPass = String(process.env.ADMIN_PASSWORD || '').trim();

    if (jwtSecret.length < 16 || !expectedPass) {
        return res.status(503).json({
            error: 'Server authentication is not configured. Set JWT_SECRET (>=16 chars) and ADMIN_PASSWORD in environment variables.'
        });
    }

    const ip = getClientIp(req);
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    const userOk = timingSafeTextEqual(username, expectedUser);
    let passOk = false;
    if (expectedPass.startsWith('$2a$') || expectedPass.startsWith('$2b$') || expectedPass.startsWith('$2y$')) {
        passOk = await bcrypt.compare(password, expectedPass);
    } else {
        passOk = timingSafeTextEqual(password, expectedPass);
    }

    if (!userOk || !passOk) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    loginAttempts.delete(ip);
    const token = jwt.sign(
        { sub: expectedUser, role: 'kiosk_admin' },
        jwtSecret,
        { expiresIn: '30d' }
    );

    return res.status(200).json({
        success: true,
        token,
        user: expectedUser,
        expiresIn: '30d'
    });
}
