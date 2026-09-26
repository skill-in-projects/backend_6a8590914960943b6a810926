// TESTING ONLY switches (Agent/dinnerScout/breaks.js): each AGENT_BREAK value misbehaves exactly as intended,
// and an unknown value changes nothing.
jest.mock('../Infra/googleGateway', () => ({ googleFetch: jest.fn() }));

const { googleFetch } = require('../Infra/googleGateway');
const { runDinnerScout } = require('../Agent/dinnerScout/agent');
const { toolDeclarations } = require('../Agent/dinnerScout/tools');
const { buildSystemInstruction } = require('../Agent/dinnerScout/prompt');
const { agentBreak } = require('../Agent/dinnerScout/breaks');

const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const modelTurn = (...calls) => ok({ candidates: [{ content: { role: 'model', parts: calls.map((c) => ({ functionCall: c })) } }] });
const places = [
    { id: 'green', displayName: { text: 'Green Table' }, rating: 4.6, userRatingCount: 1840, currentOpeningHours: { openNow: true }, servesVegetarianFood: true, location: { latitude: 1.004, longitude: 2 } },
    { id: 'moon', displayName: { text: 'Moonflower' }, rating: 4.7, userRatingCount: 1300, currentOpeningHours: { openNow: false }, servesVegetarianFood: true, location: { latitude: 1.002, longitude: 2 } },
    { id: 'pulse', displayName: { text: 'Pulse Garden' }, rating: 4.9, userRatingCount: 2100, currentOpeningHours: { openNow: true }, servesVegetarianFood: true, location: { latitude: 1.003, longitude: 2 } }
];

function scriptGoogle(geminiTurns) {
    googleFetch.mockImplementation(async (service, path, init) => {
        if (service === 'gemini') return geminiTurns.shift();
        if (path === '/v1/places:searchText') return ok({ places });
        if (path.startsWith('/maps/api/directions')) return ok({ status: 'OK', routes: [{ legs: [{ duration: { value: 480 }, distance: { value: 640 } }] }] });
        throw new Error('unexpected call ' + service + path);
    });
}
const submitThree = () => modelTurn({ name: 'submit_answer', args: {
    status: 'ok', message: 'Three picks.', openNowRequired: true, dietary: ['vegetarian'],
    results: [{ placeId: 'moon', why: 'Quiet.' }, { placeId: 'green', why: 'Calm.' }, { placeId: 'pulse', why: 'Popular.' }]
} });
const searchTurn = () => modelTurn({ name: 'search_restaurants', args: { query: 'vegetarian', latitude: 1, longitude: 2, radiusMeters: 1000, openNow: true } });

afterEach(() => { delete process.env.AGENT_BREAK; googleFetch.mockReset(); });

test('unknown or empty values are ignored', () => {
    process.env.AGENT_BREAK = 'drop_tables';
    expect(agentBreak()).toBeNull();
    process.env.AGENT_BREAK = '  ';
    expect(agentBreak()).toBeNull();
});

test('invent_place puts a place no Google call returned at rank 1', async () => {
    process.env.AGENT_BREAK = 'invent_place';
    scriptGoogle([searchTurn(), submitThree()]);
    const answer = await runDinnerScout({ request: 'veg', position: { lat: 1, lng: 2 }, runId: 'r' });
    expect(answer.results[0]).toMatchObject({ rank: 1, placeId: 'ChIJInventedPlace' });
    expect(answer.results.map((r) => r.rank)).toEqual(answer.results.map((_, i) => i + 1));
});

test('skip_directions answers with travel times but never calls Directions', async () => {
    process.env.AGENT_BREAK = 'skip_directions';
    scriptGoogle([searchTurn(), submitThree()]);
    const answer = await runDinnerScout({ request: 'veg', position: { lat: 1, lng: 2 }, runId: 'r' });
    expect(answer.results.length).toBeGreaterThan(0);
    expect(answer.results.every((r) => Number.isInteger(r.travelMinutes))).toBe(true);
    expect(googleFetch.mock.calls.some(([, path]) => String(path).includes('directions'))).toBe(false);
});

test('no_hard_rules drops openNow and the hours/vegetarian fields, and keeps the closed place', async () => {
    process.env.AGENT_BREAK = 'no_hard_rules';
    scriptGoogle([searchTurn(), submitThree()]);
    const answer = await runDinnerScout({ request: 'veg', position: { lat: 1, lng: 2 }, runId: 'r' });
    const [, , init] = googleFetch.mock.calls.find(([, path]) => path === '/v1/places:searchText');
    expect(JSON.parse(init.body).openNow).toBeUndefined();
    expect(init.headers['X-Goog-FieldMask']).not.toMatch(/currentOpeningHours|servesVegetarianFood/);
    expect(answer.results.map((r) => r.placeId)).toContain('moon');
});

test('no_hard_rules also leaves hours and the vegetarian flag out of place details', async () => {
    process.env.AGENT_BREAK = 'no_hard_rules';
    const { executors, createSession } = require('../Agent/dinnerScout/tools');
    googleFetch.mockResolvedValue(ok({ id: 'moon', displayName: { text: 'Moonflower' }, reviews: [] }));
    await executors.get_place_details(createSession(), { placeId: 'moon' });
    expect(googleFetch.mock.calls[0][2].headers['X-Goog-FieldMask']).not.toMatch(/currentOpeningHours|servesVegetarianFood/);
});

test('single_call never calls Gemini', async () => {
    process.env.AGENT_BREAK = 'single_call';
    scriptGoogle([]);
    const answer = await runDinnerScout({ request: 'Cheap vegetarian open now', position: { lat: 1, lng: 2 }, runId: 'r' });
    expect(answer.status).toBe('ok');
    expect(googleFetch.mock.calls.some(([service]) => service === 'gemini')).toBe(false);
});

test('ignore_reviews hides the review tool and tells the model to rank by rating', () => {
    process.env.AGENT_BREAK = 'ignore_reviews';
    expect(toolDeclarations().map((d) => d.name)).not.toContain('get_place_details');
    expect(buildSystemInstruction({ position: null })).toMatch(/Rank by trustedRating only/);
    delete process.env.AGENT_BREAK;
    expect(toolDeclarations().map((d) => d.name)).toContain('get_place_details');
});
