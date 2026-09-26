// Dinner Scout: the hard-rule guardrails, the trusted rating, and the agent loop against a scripted Gemini.
jest.mock('../Infra/googleGateway', () => ({ googleFetch: jest.fn() }));

const { googleFetch } = require('../Infra/googleGateway');
const { assembleAnswer, placesMissingTravel } = require('../Agent/dinnerScout/answer');
const { createSession, trustedRating } = require('../Agent/dinnerScout/tools');
const { runDinnerScout } = require('../Agent/dinnerScout/agent');

function sessionWith(places, travel = {}) {
    const session = createSession();
    for (const p of places) session.places.set(p.placeId, { rating: 4.5, userRatingCount: 500, priceLevel: 'PRICE_LEVEL_INEXPENSIVE', address: 'addr', ...p });
    for (const [key, minutes] of Object.entries(travel)) session.travel.set(key, minutes);
    return session;
}

describe('assembleAnswer guardrails', () => {
    const places = [
        { placeId: 'green', name: 'Green Table', openNow: true, servesVegetarianFood: true },
        { placeId: 'steak', name: 'Prime Cut', openNow: true, servesVegetarianFood: false },
        { placeId: 'closed', name: 'Moonflower', openNow: false, servesVegetarianFood: true },
        { placeId: 'leaf', name: 'Leaf & Lantern', openNow: true, servesVegetarianFood: true }
    ];
    const travel = { 'green|walking': 8, 'steak|walking': 3, 'closed|walking': 4, 'leaf|walking': 12 };
    const submit = {
        status: 'ok', message: 'Here you go.', travelMode: 'walking', openNowRequired: true, dietary: ['vegetarian'],
        results: [
            { placeId: 'invented', why: 'Made up.' },
            { placeId: 'steak', why: 'Romantic.' },
            { placeId: 'green', why: 'Calm and vegetarian.' },
            { placeId: 'closed', why: 'Quiet.' },
            { placeId: 'leaf', why: 'Cozy.' }
        ]
    };

    test('keeps only real, open, diet-safe places, with facts from Google and ranks from 1', () => {
        const answer = assembleAnswer(sessionWith(places, travel), submit, 'run-1');

        expect(answer.runId).toBe('run-1');
        expect(answer.status).toBe('ok');
        expect(answer.results.map((r) => r.placeId)).toEqual(['green', 'leaf']);
        expect(answer.results[0]).toMatchObject({ rank: 1, name: 'Green Table', rating: 4.5, travelMinutes: 8, travelMode: 'walking' });
        expect(answer.results[1].rank).toBe(2);
        expect(answer.trace.join('\n')).toMatch(/invented: not returned by Google/);
        expect(answer.trace.join('\n')).toMatch(/Prime Cut: does not fit the dietary need/);
        expect(answer.trace.join('\n')).toMatch(/Moonflower: closed now/);
    });

    test('drops a place without a looked-up travel time, and turns an empty shortlist into no_results', () => {
        const session = sessionWith([places[0]]);
        const answer = assembleAnswer(session, { status: 'ok', message: 'Great news!', results: [{ placeId: 'green', why: 'x' }] }, 'r');

        expect(answer.status).toBe('no_results');
        expect(answer.results).toEqual([]);
        expect(answer.message).toMatch(/could not find/);
    });

    test('lists places still missing a travel time for the chosen mode', () => {
        const session = sessionWith(places, { 'green|walking': 8 });
        expect(placesMissingTravel(session, submit)).toEqual(['leaf']);
    });

    test('needs_clarification carries the question and no results', () => {
        const answer = assembleAnswer(createSession(), { status: 'needs_clarification', message: 'Where?', question: 'Which address is your office?' }, 'r');
        expect(answer).toMatchObject({ status: 'needs_clarification', question: 'Which address is your office?', results: [], relaxed: [] });
    });

    test('keeps only relaxable constraints and caps why at 200 characters', () => {
        const session = sessionWith([places[0]], travel);
        const answer = assembleAnswer(session, {
            status: 'ok', message: 'm',
            relaxed: [{ constraint: 'distance', from: '15 min', to: '25 min' }, { constraint: 'dietary', from: 'a', to: 'b' }],
            results: [{ placeId: 'green', why: 'x'.repeat(300) }]
        }, 'r');
        expect(answer.relaxed).toEqual([{ constraint: 'distance', from: '15 min', to: '25 min' }]);
        expect(answer.results[0].why.length).toBeLessThanOrEqual(200);
    });
});

describe('trustedRating', () => {
    test('trusts many reviews over a perfect score from a few', () => {
        expect(trustedRating(4.6, 2000)).toBeGreaterThan(trustedRating(5.0, 4));
    });
    test('is null without a rating', () => {
        expect(trustedRating(null, 10)).toBeNull();
    });
});

describe('agent loop', () => {
    const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const modelTurn = (...calls) => ok({ candidates: [{ content: { role: 'model', parts: calls.map((c) => ({ functionCall: c })) } }] });

    beforeEach(() => googleFetch.mockReset());

    test('runs the tools Gemini asks for, then answers from what Google returned', async () => {
        const gemini = [
            modelTurn({ name: 'geocode_location', args: { address: 'Times Square' } }),
            modelTurn({ name: 'search_restaurants', args: { query: 'vegetarian', latitude: 40.758, longitude: -73.9855, radiusMeters: 1000, openNow: true } }),
            modelTurn(
                { name: 'get_travel_time', args: { placeId: 'green', originLatitude: 40.758, originLongitude: -73.9855, mode: 'walking' } },
                { name: 'get_travel_time', args: { placeId: 'leaf', originLatitude: 40.758, originLongitude: -73.9855, mode: 'walking' } }),
            modelTurn({
                name: 'submit_answer',
                args: { status: 'ok', message: 'Two quiet picks.', travelMode: 'walking', openNowRequired: true, dietary: ['vegetarian'],
                    results: [{ placeId: 'green', why: 'Calm.' }, { placeId: 'leaf', why: 'Cozy.' }, { placeId: 'ghost', why: 'Invented.' }] }
            })
        ];
        googleFetch.mockImplementation(async (service, path) => {
            if (service === 'gemini') return gemini.shift();
            if (path.startsWith('/maps/api/geocode')) return ok({ status: 'OK', results: [{ formatted_address: 'Times Square', geometry: { location: { lat: 40.758, lng: -73.9855 } } }] });
            if (path === '/v1/places:searchText') return ok({ places: [
                { id: 'green', displayName: { text: 'Green Table' }, rating: 4.6, userRatingCount: 1840, priceLevel: 'PRICE_LEVEL_INEXPENSIVE', currentOpeningHours: { openNow: true }, servesVegetarianFood: true, location: { latitude: 40.7625, longitude: -73.9855 } },
                { id: 'leaf', displayName: { text: 'Leaf & Lantern' }, rating: 4.5, userRatingCount: 920, currentOpeningHours: { openNow: true }, servesVegetarianFood: true, location: { latitude: 40.758, longitude: -73.994 } }
            ] });
            if (path.startsWith('/maps/api/directions')) {
                const minutes = path.includes('place_id:green') ? 8 : 12;
                return ok({ status: 'OK', routes: [{ legs: [{ duration: { value: minutes * 60 }, distance: { value: minutes * 80 } }] }] });
            }
            throw new Error('unexpected call ' + service + path);
        });

        const answer = await runDinnerScout({ request: 'Cheap vegetarian near Times Square, open now, quiet', position: null, runId: 'run-x' });

        expect(answer.status).toBe('ok');
        expect(answer.results.map((r) => [r.placeId, r.travelMinutes])).toEqual([['green', 8], ['leaf', 12]]);
        expect(googleFetch.mock.calls.filter(([s]) => s === 'gemini')).toHaveLength(4);
        expect(answer.trace.join('\n')).toMatch(/ghost: not returned by Google/);
    });

    test('with a known position it never geocodes, and looks up travel times the model skipped', async () => {
        const gemini = [
            modelTurn({ name: 'search_restaurants', args: { query: 'vegetarian', latitude: 1, longitude: 2, radiusMeters: 1000 } }),
            modelTurn({ name: 'submit_answer', args: { status: 'ok', message: 'One pick.', results: [{ placeId: 'green', why: 'Calm.' }] } })
        ];
        googleFetch.mockImplementation(async (service, path) => {
            if (service === 'gemini') return gemini.shift();
            if (path === '/v1/places:searchText') return ok({ places: [{ id: 'green', displayName: { text: 'Green Table' }, rating: 4.6, userRatingCount: 1840 }] });
            if (path.startsWith('/maps/api/directions')) return ok({ status: 'OK', routes: [{ legs: [{ duration: { value: 420 }, distance: { value: 560 } }] }] });
            throw new Error('unexpected call ' + service + path);
        });

        const answer = await runDinnerScout({ request: 'vegetarian near me', position: { lat: 1, lng: 2 }, runId: 'r' });

        expect(answer.results).toEqual([expect.objectContaining({ placeId: 'green', travelMinutes: 7 })]);
        expect(googleFetch.mock.calls.some(([, path]) => String(path).includes('geocode'))).toBe(false);
        expect(googleFetch.mock.calls.find(([, path]) => String(path).includes('directions'))[1]).toContain('origin=1,2');
    });

    test('the system instruction forbids geocoding when the position is known', async () => {
        googleFetch.mockImplementation(async () => modelTurn({ name: 'submit_answer', args: { status: 'needs_clarification', message: 'Where?', question: 'Where are you?' } }));
        await runDinnerScout({ request: 'dinner', position: { lat: 1, lng: 2 }, runId: 'r' });
        const sent = JSON.parse(googleFetch.mock.calls[0][2].body);
        expect(sent.systemInstruction.parts[0].text).toMatch(/Do NOT call geocode_location/);
        expect(sent.toolConfig.functionCallingConfig.mode).toBe('ANY');
    });
});
