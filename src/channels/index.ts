// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with one default channel — `cli`, the always-on local-terminal
// channel. Other channel skills (/add-slack, /add-discord, /add-whatsapp,
// ...) copy their module from the `channels` branch and append a
// self-registration import below.

import './cli.js';
// Temporarily disabled during WhatsApp Cloud API migration testing — Baileys'
// stale session was blocking startup on a QR re-auth prompt, and channel
// adapters init sequentially so it was blocking whatsapp-cloud too. DB wiring
// and auth store are untouched; re-enable by uncommenting this import.
// import './whatsapp.js';
import './whatsapp-cloud.js';
