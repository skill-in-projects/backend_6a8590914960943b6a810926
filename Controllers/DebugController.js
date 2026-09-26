// [PLATFORM-PROXY] NEW FILE.
// StrAppers BE: emit from GitHubService.GenerateNodeJSBackend as files["backend/Controllers/DebugController.js"]
// and register it in the app.js template (see the [PLATFORM-PROXY] lines in app.js).
// (The template body is a C# verbatim string, where a double quote must be written twice. This file uses single quotes only.)
//
// Lets the student see every Google call made while serving one request (one run id).
// Proxy mode: forwards to the platform proxy's run log, which is the same data the grader uses.
// Direct mode: returns the in-memory log kept by Infra/googleGateway.js.

const express = require('express');
const router = express.Router();
const { RUN_ID_PATTERN } = require('../Infra/runContext');
const { isProxyMode, proxyBaseUrl, proxyToken, getLocalRun } = require('../Infra/googleGateway');

/**
 * @swagger
 * /api/debug/runs/{runId}:
 *   get:
 *     summary: Every Google API call made while serving one request
 *     description: Send X-Run-Id on your request (or read it from the X-Run-Id response header), then open its trace here.
 *     tags: [Debug]
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The ordered list of calls for this run
 *       404:
 *         description: No calls recorded for this run id
 */
router.get('/runs/:runId', async (req, res) => {
    const runId = req.params.runId;
    if (!RUN_ID_PATTERN.test(runId)) return res.status(400).json({ error: 'Invalid run id.' });

    if (isProxyMode()) {
        try {
            const r = await fetch(proxyBaseUrl() + '/runs/' + encodeURIComponent(runId), { headers: { 'X-Proxy-Token': proxyToken() } });
            const text = await r.text();
            return res.status(r.status).type('application/json').send(text);
        } catch (e) {
            return res.status(502).json({ error: 'Could not reach the platform proxy.', message: e.message });
        }
    }

    const calls = getLocalRun(runId);
    if (!calls) return res.status(404).json({ runId, source: 'local', error: 'No calls recorded for this run id.' });
    res.json({ runId, source: 'local', calls });
});

module.exports = router;
