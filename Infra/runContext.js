// [PLATFORM-PROXY] NEW FILE.
// StrAppers BE: emit from GitHubService.GenerateNodeJSBackend as files["backend/Infra/runContext.js"].
// (The template body is a C# verbatim string, where a double quote must be written twice. This file uses single quotes only.)
//
// Gives every incoming request a run id and keeps it available to all code that runs for that request,
// including code after awaits. googleGateway.js reads it and sends it to the platform proxy as X-Run-Id,
// so the proxy can group every Gemini / Maps call made while serving one request.
// The grader sends its own X-Run-Id; when a caller sends none, one is generated.
// The id is echoed back in the X-Run-Id response header so the caller can open the debug trace.

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const storage = new AsyncLocalStorage();

// Accept only simple ids so a caller cannot inject anything into proxy headers or URLs.
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

function runContextMiddleware(req, res, next) {
    const incoming = (req.get('X-Run-Id') || '').trim();
    const runId = RUN_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
    res.set('X-Run-Id', runId);
    storage.run({ runId }, () => next());
}

function getRunId() {
    const store = storage.getStore();
    return store ? store.runId : null;
}

module.exports = { runContextMiddleware, getRunId, RUN_ID_PATTERN };
