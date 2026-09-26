// Dinner Scout tools: what Gemini may call, and the code that runs each call through googleFetch.
// Every Google call goes through the platform proxy (Infra/googleGateway.js), which adds the run id.
// A session object remembers what Google returned in this request, so the final answer can only
// contain places, facts and travel times that were really looked up.

const { googleFetch } = require('../../Infra/googleGateway');
const { agentBreak } = require('./breaks'); // TESTING ONLY, see breaks.js

const MAX_DETAILS_CALLS = 5;     // Client: look into at most 5 restaurants per request
const MAX_DIRECTIONS_CALLS = 6;  // one per shortlisted place, plus one retry
// Searchable price levels. Google rejects PRICE_LEVEL_FREE as a search filter (HTTP 400), so it is not offered.
const PRICE_LEVELS = ['PRICE_LEVEL_INEXPENSIVE', 'PRICE_LEVEL_MODERATE', 'PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE'];

// Ratings are trusted only with enough reviews: a Bayesian average pulls small samples toward a prior.
const RATING_PRIOR = 4.0;
const RATING_PRIOR_WEIGHT = 100;
function trustedRating(rating, count) {
    if (typeof rating !== 'number') return null;
    const n = typeof count === 'number' ? count : 0;
    return Math.round(((n * rating + RATING_PRIOR_WEIGHT * RATING_PRIOR) / (n + RATING_PRIOR_WEIGHT)) * 100) / 100;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * 6371000 * Math.asin(Math.sqrt(a)));
}

const declarations = [
    {
        name: 'geocode_location',
        description: 'Turn a named place or address (e.g. "Times Square, New York") into coordinates. Do not call it when the guest position is already known.',
        parameters: {
            type: 'object',
            properties: { address: { type: 'string', description: 'The place or address as the guest said it, plus the city if known.' } },
            required: ['address']
        }
    },
    {
        name: 'search_restaurants',
        description: 'Search restaurants around a point. Returns up to 20 candidates with rating, trustedRating (rating adjusted for how many reviews it has), price level, open now, vegetarian flag and straight-line distance. Results can include places that do not match the query; check them.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What kind of food or place, e.g. "vegetarian restaurant". Keep it short.' },
                latitude: { type: 'number' },
                longitude: { type: 'number' },
                radiusMeters: { type: 'number', description: 'Search radius. Walking distance (15 min) is about 1000 m.' },
                openNow: { type: 'boolean', description: 'Only places open right now.' },
                priceLevels: { type: 'array', items: { type: 'string', enum: PRICE_LEVELS }, description: 'Allowed price levels. Omit for any price.' },
                minRating: { type: 'number', description: 'Minimum rating 1 to 5. Omit for any rating.' }
            },
            required: ['query', 'latitude', 'longitude', 'radiusMeters']
        }
    },
    {
        name: 'get_place_details',
        description: `Reviews and details of one restaurant, to judge soft preferences (quiet, romantic, kids, business) from what diners say. At most ${MAX_DETAILS_CALLS} per request, so use it only on the most promising candidates.`,
        parameters: {
            type: 'object',
            properties: { placeId: { type: 'string' } },
            required: ['placeId']
        }
    },
    {
        name: 'get_travel_time',
        description: 'Real travel time from the guest origin to one restaurant. Needed for every place you recommend.',
        parameters: {
            type: 'object',
            properties: {
                placeId: { type: 'string' },
                originLatitude: { type: 'number' },
                originLongitude: { type: 'number' },
                mode: { type: 'string', enum: ['walking', 'driving'] }
            },
            required: ['placeId', 'originLatitude', 'originLongitude', 'mode']
        }
    },
    {
        name: 'submit_answer',
        description: 'Finish. Call exactly once, with the final shortlist best first, or with a clarifying question.',
        parameters: {
            type: 'object',
            properties: {
                status: { type: 'string', enum: ['ok', 'needs_clarification', 'no_results'] },
                message: { type: 'string', description: 'One or two short sentences to the guest. Must mention anything that was relaxed and any contradiction in the request.' },
                question: { type: 'string', description: 'Only for needs_clarification: one short question.' },
                travelMode: { type: 'string', enum: ['walking', 'driving'] },
                openNowRequired: { type: 'boolean', description: 'True when the guest asked for somewhere open now.' },
                dietary: { type: 'array', items: { type: 'string' }, description: 'Dietary needs from the request, e.g. ["vegetarian"]. Empty when none.' },
                relaxed: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            constraint: { type: 'string', enum: ['distance', 'price', 'rating'] },
                            from: { type: 'string' },
                            to: { type: 'string' }
                        },
                        required: ['constraint', 'from', 'to']
                    }
                },
                results: {
                    type: 'array',
                    description: '3 to 5 places, best first.',
                    items: {
                        type: 'object',
                        properties: {
                            placeId: { type: 'string' },
                            why: { type: 'string', description: 'One sentence, specific to this request, under 200 characters.' }
                        },
                        required: ['placeId', 'why']
                    }
                }
            },
            required: ['status', 'message']
        }
    }
];

function createSession() {
    return {
        origin: null,        // {lat, lng}: the guest position, else the last geocoded place
        places: new Map(),   // placeId -> facts from Places (search and details), exactly as Google returned them
        travel: new Map(),   // `${placeId}|${mode}` -> minutes from Directions
        searchRadii: [],     // radius of every successful search, to know whether distance was ever relaxed
        nudges: new Set(),   // submit_answer corrections already sent (each at most once)
        detailsCalls: 0,
        directionsCalls: 0,
        trace: []
    };
}

function rememberPlace(session, p) {
    const prev = session.places.get(p.id) || {};
    session.places.set(p.id, {
        ...prev,
        placeId: p.id,
        name: p.displayName?.text ?? prev.name ?? null,
        address: p.formattedAddress ?? prev.address ?? null,
        location: p.location ?? prev.location ?? null,
        rating: p.rating ?? prev.rating ?? null,
        userRatingCount: p.userRatingCount ?? prev.userRatingCount ?? null,
        priceLevel: p.priceLevel ?? prev.priceLevel ?? null,
        openNow: p.currentOpeningHours?.openNow ?? prev.openNow ?? null,
        servesVegetarianFood: p.servesVegetarianFood ?? prev.servesVegetarianFood ?? null
    });
    return session.places.get(p.id);
}

async function readJson(res, what) {
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) return { error: `${what} failed (HTTP ${res.status})`, detail: body?.error?.message ?? text.slice(0, 200) };
    // The legacy Maps web services answer HTTP 200 with a status field; only OK and ZERO_RESULTS are real answers.
    if (typeof body?.status === 'string' && !['OK', 'ZERO_RESULTS'].includes(body.status))
        return { error: `${what} failed (${body.status})`, detail: body.error_message ?? '' };
    return body;
}

const executors = {
    async geocode_location(session, { address }) {
        const res = await googleFetch('maps', '/maps/api/geocode/json?address=' + encodeURIComponent(address));
        const body = await readJson(res, 'Geocoding');
        if (body?.error) { session.trace.push(`Geocoding "${address}" failed: ${body.error}`); return body; }
        const hit = body?.results?.[0];
        session.trace.push(`Geocoded "${address}": ${hit ? hit.formatted_address : 'no match'}`);
        if (!hit) return { found: false, status: body?.status };
        session.origin = { lat: hit.geometry.location.lat, lng: hit.geometry.location.lng };
        return { found: true, formattedAddress: hit.formatted_address, latitude: hit.geometry.location.lat, longitude: hit.geometry.location.lng };
    },

    async search_restaurants(session, args) {
        const request = {
            textQuery: args.query,
            pageSize: 20,
            locationBias: { circle: { center: { latitude: args.latitude, longitude: args.longitude }, radius: Math.min(Math.max(args.radiusMeters || 1000, 100), 50000) } }
        };
        if (args.openNow && agentBreak() !== 'no_hard_rules') request.openNow = true;
        if (Array.isArray(args.priceLevels) && args.priceLevels.length) request.priceLevels = args.priceLevels.filter((l) => PRICE_LEVELS.includes(l));
        if (typeof args.minRating === 'number') request.minRating = args.minRating;

        const res = await googleFetch('places', '/v1/places:searchText', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-FieldMask': agentBreak() === 'no_hard_rules'
                    ? 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel'
                    : 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.servesVegetarianFood'
            },
            body: JSON.stringify(request)
        });
        const body = await readJson(res, 'Places search');
        if (body?.error) return body;
        session.searchRadii.push(request.locationBias.circle.radius);
        const candidates = (body?.places || []).map((p) => {
            const place = rememberPlace(session, p);
            const meters = place.location ? distanceMeters(args.latitude, args.longitude, place.location.latitude, place.location.longitude) : null;
            return {
                placeId: place.placeId, name: place.name, rating: place.rating, userRatingCount: place.userRatingCount,
                trustedRating: trustedRating(place.rating, place.userRatingCount), priceLevel: place.priceLevel,
                openNow: place.openNow, servesVegetarianFood: place.servesVegetarianFood, straightLineMeters: meters
            };
        });
        session.trace.push(`Searched "${args.query}" within ${request.locationBias.circle.radius} m${request.openNow ? ', open now' : ''}${request.priceLevels ? ', ' + request.priceLevels.join('/') : ''}: ${candidates.length} candidates`);
        return { count: candidates.length, candidates };
    },

    async get_place_details(session, { placeId }) {
        if (session.detailsCalls >= MAX_DETAILS_CALLS)
            return { error: `Detail limit reached (${MAX_DETAILS_CALLS} per request). Decide with what you have.` };
        session.detailsCalls++;
        const res = await googleFetch('places', '/v1/places/' + encodeURIComponent(placeId), {
            headers: {
                'X-Goog-FieldMask': agentBreak() === 'no_hard_rules'
                    ? 'id,displayName,formattedAddress,location,rating,userRatingCount,priceLevel,reviews'
                    : 'id,displayName,formattedAddress,location,rating,userRatingCount,priceLevel,currentOpeningHours,servesVegetarianFood,reviews'
            }
        });
        const body = await readJson(res, 'Place details');
        if (body?.error) return body;
        const place = rememberPlace(session, body);
        session.trace.push(`Read reviews of ${place.name}`);
        return {
            placeId: place.placeId, name: place.name, openNow: place.openNow, servesVegetarianFood: place.servesVegetarianFood,
            reviews: (body.reviews || []).map((r) => ({ rating: r.rating, text: r.text?.text ?? r.originalText?.text ?? '' }))
        };
    },

    async get_travel_time(session, { placeId, originLatitude, originLongitude, mode }) {
        if (agentBreak() === 'skip_directions') {
            // TESTING ONLY: a guess from straight-line distance instead of a Directions call.
            const place = session.places.get(placeId);
            const travelMode = mode === 'driving' ? 'driving' : 'walking';
            if (!place?.location) return { found: false };
            const meters = distanceMeters(originLatitude, originLongitude, place.location.latitude, place.location.longitude);
            const minutes = Math.max(1, Math.round(meters / (travelMode === 'walking' ? 80 : 400)));
            session.travel.set(`${placeId}|${travelMode}`, minutes);
            return { placeId, mode: travelMode, minutes, meters };
        }
        if (session.directionsCalls >= MAX_DIRECTIONS_CALLS)
            return { error: 'Travel time limit reached for this request.' };
        session.directionsCalls++;
        if (!session.origin) session.origin = { lat: originLatitude, lng: originLongitude };
        const travelMode = mode === 'driving' ? 'driving' : 'walking';
        const path = `/maps/api/directions/json?origin=${originLatitude},${originLongitude}&destination=place_id:${encodeURIComponent(placeId)}&mode=${travelMode}`;
        const res = await googleFetch('maps', path);
        const body = await readJson(res, 'Directions');
        if (body?.error) return body;
        const leg = body?.routes?.[0]?.legs?.[0];
        if (!leg) return { found: false, status: body?.status };
        const minutes = Math.max(1, Math.round(leg.duration.value / 60));
        session.travel.set(`${placeId}|${travelMode}`, minutes);
        const name = session.places.get(placeId)?.name ?? placeId;
        session.trace.push(`${travelMode === 'walking' ? 'Walk' : 'Drive'} to ${name}: ${minutes} min`);
        return { placeId, mode: travelMode, minutes, meters: leg.distance.value };
    }
};

/** The tools offered to Gemini (TESTING ONLY: ignore_reviews hides the review lookup). */
function toolDeclarations() {
    return agentBreak() === 'ignore_reviews' ? declarations.filter((d) => d.name !== 'get_place_details') : declarations;
}

module.exports = { declarations, toolDeclarations, executors, createSession, trustedRating, distanceMeters, MAX_DETAILS_CALLS };
