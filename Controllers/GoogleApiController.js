const express = require('express');
const router = express.Router();

// [PLATFORM-PROXY] CHANGED FILE. StrAppers BE: GitHubService.GenerateNodeJSBackend, files["backend/Controllers/GoogleApiController.js"].
// Every Google call now goes through Infra/googleGateway.js instead of building Google URLs with raw keys here,
// so these health checks exercise the same path (proxy or direct) the student's agent code uses.
// Removed: getKey() / getMapsKey() and the hardcoded Google hosts. Replaced by isConfigured(service) and googleFetch(service, path).
const { googleFetch, isConfigured, isProxyMode } = require('../Infra/googleGateway');

// [PLATFORM-PROXY] CHANGED: /status reports which mode is active; in proxy mode the raw keys are intentionally absent.
router.get('/status', (req, res) => {
    const configured = isConfigured('gemini');
    const proxy = isProxyMode();
    res.json({
        configured,
        mapsConfigured: isConfigured('maps'),
        mode: proxy ? 'proxy' : 'direct',
        message: proxy
            ? 'Google APIs are reached through the Skill-in platform proxy (GOOGLE_PROXY_BASE_URL / GOOGLE_PROXY_TOKEN). Use googleFetch from Infra/googleGateway.js.'
            : configured ? 'Google API key is set. Gemini uses GOOGLE_API_KEY; Maps, Places, Directions, Geocoding, and Speech-to-Text use GOOGLE_MAPS_API_KEY.' : 'Google API key is not set. Add GOOGLE_API_KEY in Railway environment variables.'
    });
});

// [PLATFORM-PROXY] CHANGED: /health and /gemini share this; the request goes through googleFetch('gemini', ...).
async function checkGemini(req, res) {
    if (!isConfigured('gemini')) return res.json({ status: 'not_configured', message: 'GOOGLE_API_KEY is not set.', service: 'Gemini' });
    try {
        const r = await googleFetch('gemini', '/v1beta/models/gemini-2.5-flash:generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }] }) });
        const text = await r.text();
        if (!r.ok) return res.json({ status: 'error', message: text.length > 200 ? text.slice(0, 200) + '...' : text, service: 'Gemini' });
        const data = JSON.parse(text);
        let message = 'OK';
        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text)
            message = (data.candidates[0].content.parts[0].text || 'OK').trim();
        res.json({ status: 'ok', message, service: 'Gemini' });
    } catch (e) { res.json({ status: 'error', message: e.message, service: 'Gemini' }); }
}

router.get('/health', checkGemini);
router.get('/gemini', checkGemini);

// [PLATFORM-PROXY] CHANGED: googleFetch('maps', ...) instead of maps.googleapis.com with ?key=.
router.get('/geocoding', async (req, res) => {
    if (!isConfigured('maps')) return res.json({ status: 'not_configured', message: 'GOOGLE_MAPS_API_KEY is not set.', service: 'Geocoding' });
    try {
        const r = await googleFetch('maps', '/maps/api/geocode/json?address=Times+Square+New+York');
        const text = await r.text();
        if (!r.ok) return res.json({ status: 'error', message: text.length > 200 ? text.slice(0, 200) + '...' : text, service: 'Geocoding' });
        const data = JSON.parse(text);
        if (data.status === 'OK') return res.json({ status: 'ok', message: 'Geocoding API responded successfully.', service: 'Geocoding' });
        res.json({ status: 'error', message: data.status || '', service: 'Geocoding' });
    } catch (e) { res.json({ status: 'error', message: e.message, service: 'Geocoding' }); }
});

// [PLATFORM-PROXY] CHANGED: the Maps JavaScript API is loaded by the browser with a key in the script URL, so it cannot go
// through the proxy. In proxy mode there is no raw key, so this reports not_available. Direct mode is unchanged.
router.get('/maps', async (req, res) => {
    if (isProxyMode()) return res.json({ status: 'not_available', message: 'Maps JavaScript API is not provided in proxy mode (browser-loaded, needs a raw key).', service: 'Maps' });
    const key = (process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
    if (!key) return res.json({ status: 'not_configured', message: 'GOOGLE_MAPS_API_KEY is not set.', service: 'Maps' });
    try {
        const url = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key);
        const r = await fetch(url);
        const text = await r.text();
        if (!r.ok) return res.json({ status: 'error', message: text.length > 200 ? text.slice(0, 200) + '...' : text, service: 'Maps' });
        if (text.includes('ApiNotActivatedMapError')) return res.json({ status: 'error', message: 'Maps JavaScript API is not enabled for this key.', service: 'Maps' });
        if (text.includes('RefererNotAllowedMapError')) return res.json({ status: 'error', message: 'Referer not allowed for this key.', service: 'Maps' });
        if (text.includes('InvalidKeyMapError')) return res.json({ status: 'error', message: 'Invalid API key.', service: 'Maps' });
        res.json({ status: 'ok', message: 'Maps JavaScript API key valid.', service: 'Maps' });
    } catch (e) { res.json({ status: 'error', message: e.message, service: 'Maps' }); }
});

// [PLATFORM-PROXY] CHANGED: googleFetch('maps', ...) instead of maps.googleapis.com with ?key=.
router.get('/directions', async (req, res) => {
    if (!isConfigured('maps')) return res.json({ status: 'not_configured', message: 'GOOGLE_MAPS_API_KEY is not set.', service: 'Directions' });
    try {
        const origin = encodeURIComponent('Times Square, New York, NY');
        const dest = encodeURIComponent('Brooklyn Bridge, New York, NY');
        const r = await googleFetch('maps', `/maps/api/directions/json?origin=${origin}&destination=${dest}`);
        const text = await r.text();
        if (!r.ok) return res.json({ status: 'error', message: text.length > 200 ? text.slice(0, 200) + '...' : text, service: 'Directions' });
        const data = JSON.parse(text);
        if (data.status === 'OK') return res.json({ status: 'ok', message: 'Directions API responded successfully. Use it from the backend to return routes to the frontend.', service: 'Directions' });
        res.json({ status: 'error', message: data.status || '', service: 'Directions' });
    } catch (e) { res.json({ status: 'error', message: e.message, service: 'Directions' }); }
});

// [PLATFORM-PROXY] CHANGED: googleFetch('places', ...); the X-Goog-Api-Key header is now added by the gateway (direct mode only).
router.get('/places', async (req, res) => {
    if (!isConfigured('places')) return res.json({ status: 'not_configured', message: 'GOOGLE_MAPS_API_KEY is not set.', service: 'Places' });
    try {
        const r = await googleFetch('places', '/v1/places:searchText', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Goog-FieldMask': 'places.id' },
            body: JSON.stringify({ textQuery: 'coffee' })
        });
        const text = await r.text();
        if (r.ok) return res.json({ status: 'ok', message: 'Places API (New) responded successfully.', service: 'Places' });
        res.json({ status: 'error', message: text.length > 200 ? text.slice(0, 200) + '...' : text, service: 'Places' });
    } catch (e) { res.json({ status: 'error', message: e.message, service: 'Places' }); }
});

// [PLATFORM-PROXY] CHANGED: googleFetch('speech', ...) instead of speech.googleapis.com with ?key=.
router.get('/speech-to-text', async (req, res) => {
    if (!isConfigured('speech')) return res.json({ status: 'not_configured', message: 'GOOGLE_MAPS_API_KEY is not set.', service: 'SpeechToText' });
    try {
        const silence = Buffer.alloc(3200, 0);
        const base64Audio = silence.toString('base64');
        const r = await googleFetch('speech', '/v1/speech:recognize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' }, audio: { content: base64Audio } })
        });
        const text = await r.text();
        if (r.ok) return res.json({ status: 'ok', message: 'Speech-to-Text API accepted the request.', service: 'SpeechToText' });
        if (r.status === 400 && text.includes('No speech')) return res.json({ status: 'ok', message: 'Speech-to-Text API responded (no speech in test audio).', service: 'SpeechToText' });
        res.json({ status: 'error', message: text.length > 200 ? text.slice(0, 200) + '...' : text, service: 'SpeechToText' });
    } catch (e) { res.json({ status: 'error', message: e.message, service: 'SpeechToText' }); }
});

module.exports = router;
