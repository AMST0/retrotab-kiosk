/**
 * Installs a silent Windows Startup launcher (VBScript) for RetroTab Companion Agent.
 * Uses process.execPath so it works reliably even when PATH is minimal at logon.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const agentScript = path.resolve(__dirname, 'laptop-agent.mjs');
const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const vbsPath = path.join(startupDir, 'RetroTabCompanionAgent.vbs');

if (process.platform !== 'win32') {
    console.error('[RetroTab] This startup helper targets Windows. On Linux/macOS use systemd or launchd.');
    process.exit(1);
}

if (!fs.existsSync(startupDir)) {
    console.error('[RetroTab] Startup directory not found:', startupDir);
    process.exit(1);
}

const nodeExe = process.execPath.replace(/"/g, '""');
const escapedAgent = agentScript.replace(/"/g, '""');
const vbs = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run """${nodeExe}"" ""${escapedAgent}""", 0, False`,
    ''
].join('\r\n');

fs.writeFileSync(vbsPath, vbs, 'utf8');
console.log('[RetroTab] Installed Windows Startup launcher:', vbsPath);
console.log('[RetroTab] Agent script:', agentScript);
