const express = require('express');
const router = express.Router();
const { getRunId } = require('../Infra/runContext');
const { runDinnerScout } = require('../Agent/dinnerScout/agent');

/**
 * @swagger
 * /api/agent/dinner:
 *   post:
 *     summary: Dinner Scout - restaurant recommendations for a hotel guest
 *     description: Send X-Run-Id to follow the Google calls of this request in GET /api/debug/runs/{runId}.
 *     tags: [Agent]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [request]
 *             properties:
 *               request:
 *                 type: string
 *                 example: Cheap vegetarian place near Times Square, open now, quiet enough for a date
 *               position:
 *                 type: object
 *                 properties:
 *                   lat: { type: number }
 *                   lng: { type: number }
 *     responses:
 *       200:
 *         description: status ok, needs_clarification or no_results, with the ranked results and the trace
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Unexpected failure
 */
router.post('/dinner', async (req, res) => {
    const request = req.body?.request;
    if (typeof request !== 'string' || request.trim().length === 0 || request.length > 500)
        return res.status(400).json({ error: 'request is required and must be 1 to 500 characters.' });

    const position = req.body?.position;
    if (position !== undefined && position !== null) {
        const valid = typeof position === 'object'
            && Number.isFinite(position.lat) && Math.abs(position.lat) <= 90
            && Number.isFinite(position.lng) && Math.abs(position.lng) <= 180;
        if (!valid) return res.status(400).json({ error: 'position must be { lat, lng } with valid coordinates.' });
    }

    try {
        const answer = await runDinnerScout({ request: request.trim(), position: position || null, runId: getRunId() });
        res.json(answer);
    } catch (err) {
        console.error('[DinnerScout] failed:', err);
        res.status(500).json({ error: 'The assistant could not complete this request.', detail: err.message });
    }
});

module.exports = router;
