const express = require('express');
const router = express.Router();

function getKey() { return process.env.GOOGLE_API_KEY || ''; }

// Geocoding, Maps, Directions, Places, Speech-to-Text (Google does not allow these on the same key as Gemini)
function getMapsKey() { return process.env.GOOGLE_MAPS_API_KEY || getKey(); }

router.get('/status', (req, res) => {
    const key = getKey();
    const configured = !!key.trim();
    res.json({
        configured,
        mapsConfigured: !!getMapsKey().trim(),
        message: configured ? 'Google API key is set. Gemini uses GOOGLE_API_KEY; Maps, Places, Directions, Geocoding, and Speech-to-Text use GOOGLE_MAPS_API_KEY.' : 'Google API key is not set. Add GOOGLE_API_KEY in Railway environment variables.'
    });
});

router.get('/health', async (req, res) => {
    const key = getKey();
    if (!key.trim()) return res.json({ status: 'not_configured', message: 'GOOGLE_API_KEY is not set.', service: 'Gemini' });
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }] }) });
        const text = await r.text();
        if (!r.ok) return res.json({ status: 'error', message: text.length > 200 ? text.slice(0, 200) + '...' : text, service: 'Gemini' });
        const data = JSON.parse(text);
        let message = 'OK';
        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text)
            message = (data.candidates[0].content.parts[0].text || 'OK').trim();
        res.json({ status: 'ok', message, service: 'Gemini' });
    } catch (e) { res.json({ status: 'error', message: e.message, service: 'Gemini' }); }
});

router.get('/gemini', async (req, res) => {
    const key = getKey();
    if (!key.trim()) return res.json({ status: 'not_configured', message: 'GOOGLE_API_KEY is not set.', service: 'Gemini' });
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }] }) });
        const text = await r.text();
        if (!r.ok) return res.json({ status: 'error', message: text.length > 200 ? text.slice(0, 200) + '...' : text, service: 'Gemini' });
        const data = JSON.parse(text);
        let message = 'OK';
        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text)
            message = (data.candidates[0].content.parts[0].text || 'OK').trim();
        res.json({ status: 'ok', message, service: 'Gemini' });
    } catch (e) { res.json({ status: 'error', message: e.message, service: 'Gemini' }); }
});

router.get('/geocoding', async (req, res) => {
    const key = getMapsKey();
    if (!key.trim()) return res.json({ status: 'not_configured', message: 'GOOGLE_MAPS_API_KEY is not set.', service: 'Geocoding' });
    try {
        const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=Times+Square+New+York&key=' + encodeURIComponent(key);
        const r = await fetch(url);
        const text = await r.text();
        if (!r.ok) return res.json({ status: 'error', message: text.length > 200 ? text.slice(0, 200) + '...' : text, service: 'Geocoding' });
        const data = JSON.parse(text);
        if (data.status === 'OK') return res.json({ status: 'ok', message: 'Geocoding API responded successfully.', service: 'Geocoding' });
        res.json({ status: 'error', message: data.status || '', service: 'Geocoding' });
    } catch (e) { res.json({ status: 'error', message: e.message, service: 'Geocoding' }); }
});

router.get('/maps', async (req, res) => {
    const key = getMapsKey();
    if (!key.trim()) return res.json({ status: 'not_configured', message: 'GOOGLE_MAPS_API_KEY is not set.', service: 'Maps' });
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

router.get('/directions', async (req, res) => {
    const key = getMapsKey();
    if (!key.trim()) return res.json({ status: 'not_configured', message: 'GOOGLE_MAPS_API_KEY is not set.', service: 'Directions' });
    try {
        const origin = encodeURIComponent('Times Square, New York, NY');
        const dest = encodeURIComponent('Brooklyn Bridge, New York, NY');
        const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${dest}&key=${encodeURIComponent(key)}`;
        const r = await fetch(url);
        const text = await r.text();
        if (!r.ok) return res.json({ status: 'error', message: text.length > 200 ? text.slice(0, 200) + '...' : text, service: 'Directions' });
        const data = JSON.parse(text);
        if (data.status === 'OK') return res.json({ status: 'ok', message: 'Directions API responded successfully. Use it from the backend to return routes to the frontend.', service: 'Directions' });
        res.json({ status: 'error', message: data.status || '', service: 'Directions' });
    } catch (e) { res.json({ status: 'error', message: e.message, service: 'Directions' }); }
});

router.get('/places', async (req, res) => {
    const key = getMapsKey();
    if (!key.trim()) return res.json({ status: 'not_configured', message: 'GOOGLE_MAPS_API_KEY is not set.', service: 'Places' });
    try {
        const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' },
            body: JSON.stringify({ textQuery: 'coffee' })
        });
        const text = await r.text();
        if (r.ok) return res.json({ status: 'ok', message: 'Places API (New) responded successfully.', service: 'Places' });
        res.json({ status: 'error', message: text.length > 200 ? text.slice(0, 200) + '...' : text, service: 'Places' });
    } catch (e) { res.json({ status: 'error', message: e.message, service: 'Places' }); }
});

router.get('/speech-to-text', async (req, res) => {
    const key = getMapsKey();
    if (!key.trim()) return res.json({ status: 'not_configured', message: 'GOOGLE_MAPS_API_KEY is not set.', service: 'SpeechToText' });
    try {
        const silence = Buffer.alloc(3200, 0);
        const base64Audio = silence.toString('base64');
        const r = await fetch('https://speech.googleapis.com/v1/speech:recognize?key=' + encodeURIComponent(key), {
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
