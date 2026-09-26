// [PLATFORM-PROXY] NEW FILE.
// StrAppers BE: emit from GitHubService.GenerateNodeJSBackend as files["backend/Infra/googleGateway.js"].
// (The template body is a C# verbatim string, where a double quote must be written twice. This file uses single quotes only.)
//
// The single door for every outbound Google call (Gemini, Geocoding, Directions, Places, Speech-to-Text).
// Student code calls googleFetch(service, pathAndQuery, init) and never touches keys or hosts.
//
// Two modes, decided from env vars on every call:
//   proxy mode  - GOOGLE_PROXY_BASE_URL and GOOGLE_PROXY_TOKEN are both set. Calls go to the Skill-in platform proxy,
//                 which holds the real Google keys, logs every call per run id, and in grading serves fixture data.
//                 StrAppers BE (BoardsController, where GOOGLE_API_KEY / GOOGLE_MAPS_API_KEY are upserted to Railway:
//                 board creation, the late fallback, and the Quest environment) must set these two vars INSTEAD of
//                 the raw keys for proxy-enabled projects. If the raw keys are also set, students can bypass the proxy.
//   direct mode - proxy vars not set. Calls go straight to Google with GOOGLE_API_KEY / GOOGLE_MAPS_API_KEY.
//                 This is the behavior every provisioned repo has today, so existing projects keep working.
//
// Proxy URL contract (the proxy service in StrAppers BE must implement exactly this):
//   ANY {GOOGLE_PROXY_BASE_URL}/{service}{upstreamPathAndQuery}
//       service is a key of UPSTREAM below; the proxy forwards to that host with the same path, query, method and body.
//       Request headers added here: X-Proxy-Token (auth; identifies the board), X-Run-Id (correlation, may be absent).
//       The proxy must strip both, add the real Google key, and return Google's status and body unchanged.
//   GET {GOOGLE_PROXY_BASE_URL}/runs/{runId}   (header X-Proxy-Token)
//       Returns the call log for that run, limited to the token's own board. Used by Controllers/DebugController.js.

const { getRunId } = require('./runContext');

const UPSTREAM = {
    gemini: 'https://generativelanguage.googleapis.com',
    maps: 'https://maps.googleapis.com',       // Geocoding, Directions (legacy web services)
    places: 'https://places.googleapis.com',   // Places API (New)
    speech: 'https://speech.googleapis.com'
};

function proxyBaseUrl() { return (process.env.GOOGLE_PROXY_BASE_URL || '').trim().replace(/\/+$/, ''); }
function proxyToken() { return (process.env.GOOGLE_PROXY_TOKEN || '').trim(); }
function isProxyMode() { return !!proxyBaseUrl() && !!proxyToken(); }

// Direct mode only. Google does not allow Maps-family APIs on the same key as Gemini.
function directKey(service) {
    const geminiKey = (process.env.GOOGLE_API_KEY || '').trim();
    if (service === 'gemini') return geminiKey;
    return (process.env.GOOGLE_MAPS_API_KEY || '').trim() || geminiKey;
}

function isConfigured(service) { return isProxyMode() || !!directKey(service); }

async function googleFetch(service, pathAndQuery, init = {}) {
    if (!UPSTREAM[service]) throw new Error('Unknown Google service: ' + service);
    const headers = { ...(init.headers || {}) };
    const runId = getRunId();
    let url;
    if (isProxyMode()) {
        url = proxyBaseUrl() + '/' + service + pathAndQuery;
        headers['X-Proxy-Token'] = proxyToken();
        if (runId) headers['X-Run-Id'] = runId;
    } else {
        const key = directKey(service);
        url = UPSTREAM[service] + pathAndQuery;
        // Gemini and Places (New) take the key as a header; the legacy Maps web services and Speech take it as a query param.
        if (service === 'gemini' || service === 'places') headers['X-Goog-Api-Key'] = key;
        else url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
    }

    const startedAt = Date.now();
    const res = await fetch(url, { ...init, headers });
    // In proxy mode the proxy records the call; locally we only record in direct mode so debugging works before the proxy exists.
    if (!isProxyMode() && runId) await recordLocalCall(runId, service, pathAndQuery, init, res, Date.now() - startedAt);
    return res;
}

// ---- Local call log (direct mode only) ----
// A stand-in for the proxy's run log with the same shape, kept in memory for the last MAX_LOCAL_RUNS runs.
// It is for the student's own debugging; grading never trusts it, only the proxy's log.
const MAX_LOCAL_RUNS = 50;
const MAX_BODY_CHARS = 4000;
const localRuns = new Map();

function truncate(text) {
    if (typeof text !== 'string') return text;
    return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + '...[truncated]' : text;
}

async function recordLocalCall(runId, service, pathAndQuery, init, res, durationMs) {
    let responseBody = '';
    try { responseBody = await res.clone().text(); } catch (e) { responseBody = '[unreadable: ' + e.message + ']'; }
    if (!localRuns.has(runId)) {
        localRuns.set(runId, []);
        if (localRuns.size > MAX_LOCAL_RUNS) localRuns.delete(localRuns.keys().next().value);
    }
    localRuns.get(runId).push({
        at: new Date().toISOString(),
        service,
        method: (init.method || 'GET').toUpperCase(),
        path: pathAndQuery,
        status: res.status,
        durationMs,
        requestBody: truncate(typeof init.body === 'string' ? init.body : ''),
        responseBody: truncate(responseBody)
    });
}

function getLocalRun(runId) { return localRuns.get(runId) || null; }

module.exports = { googleFetch, isProxyMode, isConfigured, proxyBaseUrl, proxyToken, getLocalRun };
