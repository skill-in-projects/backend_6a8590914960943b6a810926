// Dinner Scout agent loop: Gemini decides which lookups to make (function calling), this code runs them
// through the platform proxy and feeds the results back, until Gemini calls submit_answer.

const { googleFetch } = require('../../Infra/googleGateway');
const { declarations, executors, createSession } = require('./tools');
const { buildSystemInstruction } = require('./prompt');
const { assembleAnswer, placesMissingTravel, reviewSubmit } = require('./answer');

const MODEL_PATH = '/v1beta/models/gemini-2.5-flash:generateContent';
const MAX_TURNS = 8;
// The Integration Sheet allows 20 s. After this, the model may only call submit_answer.
const WRAP_UP_AFTER_MS = 13000;
const THINKING_BUDGET = Number.parseInt(process.env.AGENT_THINKING_BUDGET ?? '0', 10);

async function callGemini(systemInstruction, contents, forceSubmit) {
    const body = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        tools: [{ functionDeclarations: declarations }],
        // ANY: every turn is a tool call, so the loop always ends through submit_answer.
        toolConfig: { functionCallingConfig: forceSubmit ? { mode: 'ANY', allowedFunctionNames: ['submit_answer'] } : { mode: 'ANY' } },
        generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: THINKING_BUDGET } }
    };
    const res = await googleFetch('gemini', MODEL_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    const content = data.candidates?.[0]?.content;
    if (!content?.parts?.length) throw new Error(`Gemini returned no content (finishReason ${data.candidates?.[0]?.finishReason ?? 'unknown'})`);
    return content;
}

async function runTool(session, call) {
    const exec = executors[call.name];
    try {
        return exec ? await exec(session, call.args || {}) : { error: `Unknown tool ${call.name}` };
    } catch (err) {
        return { error: err.message };
    }
}

async function finish(session, submit, runId, position) {
    // Every recommended place needs a real travel time; look up any the model skipped.
    const origin = position || session.origin;
    if (submit.status === 'ok' && origin) {
        const mode = submit.travelMode === 'driving' ? 'driving' : 'walking';
        await Promise.all(placesMissingTravel(session, submit).map((placeId) =>
            runTool(session, { name: 'get_travel_time', args: { placeId, originLatitude: origin.lat, originLongitude: origin.lng, mode } })));
    }
    return assembleAnswer(session, submit, runId);
}

async function runDinnerScout({ request, position, runId }) {
    const started = Date.now();
    const session = createSession();
    const systemInstruction = buildSystemInstruction({ position });
    const contents = [{ role: 'user', parts: [{ text: `Guest request: ${request}` }] }];
    if (position) session.origin = { lat: position.lat, lng: position.lng };

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const forceSubmit = turn === MAX_TURNS || Date.now() - started > WRAP_UP_AFTER_MS;
        const content = await callGemini(systemInstruction, contents, forceSubmit);
        contents.push(content); // unchanged, so any thought signatures go back to the model as required

        const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
        const submit = calls.find((c) => c.name === 'submit_answer');
        let correction = null;
        if (submit) {
            correction = forceSubmit ? null : reviewSubmit(session, submit.args || {});
            if (!correction) return finish(session, submit.args || {}, runId, position);
            session.trace.push(`Asked the model to revise its answer: ${correction.split('.')[0]}`);
        }
        if (calls.length === 0) {
            contents.push({ role: 'user', parts: [{ text: 'Use the tools, and finish with submit_answer.' }] });
            continue;
        }

        const responses = await Promise.all(calls.map(async (call) => ({
            functionResponse: {
                name: call.name,
                response: call.name === 'submit_answer' ? { error: correction } : await runTool(session, call)
            }
        })));
        contents.push({ role: 'user', parts: responses });
    }
    throw new Error('The agent did not finish.'); // unreachable: the last turn may only submit
}

module.exports = { runDinnerScout };
