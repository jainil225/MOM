// Minimal service worker so AiX Track installs as a mobile app (Add to Home Screen).
// Network only — MOCs and records are never cached on the device.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
