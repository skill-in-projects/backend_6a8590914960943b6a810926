// Builds the final Dinner Scout response from Gemini's submit_answer and what Google really returned
// in this request (the session). The model chooses and orders; the code enforces the hard rules:
//   - only places Google returned in this request (never an invented or remembered place)
//   - facts (name, rating, price, address) copied from Google, never from the model
//   - no closed place when the guest asked for open now, and dietary needs are never relaxed
//   - travel minutes only from a Directions call in this request
// Pure: no I/O, so it is unit-tested directly.

const STATUSES = ['ok', 'needs_clarification', 'no_results'];
const RELAXABLE = ['distance', 'price', 'rating'];
const MAX_RESULTS = 5;
const MAX_WHY = 200;

const travelMode = (submit) => (submit?.travelMode === 'driving' ? 'driving' : 'walking');

function needsVegetarian(submit) {
    return (submit?.dietary || []).some((d) => /vegetarian|vegan/i.test(String(d)));
}

/**
 * Places from submit_answer that pass the hard rules, in the model's order, before the travel-time check.
 * Returns the reasons for anything dropped instead of tracing them, since it runs more than once per request.
 */
function eligiblePlaces(session, submit) {
    const seen = new Set();
    const eligible = [];
    const dropped = [];
    for (const item of submit?.results || []) {
        const id = item?.placeId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const place = session.places.get(id);
        if (!place) { dropped.push(`Dropped ${id}: not returned by Google in this request`); continue; }
        if (submit.openNowRequired && place.openNow === false) { dropped.push(`Dropped ${place.name}: closed now`); continue; }
        if (needsVegetarian(submit) && place.servesVegetarianFood === false) { dropped.push(`Dropped ${place.name}: does not fit the dietary need`); continue; }
        eligible.push({ place, why: String(item.why || '').trim() });
    }
    return { eligible, dropped };
}

/** Eligible places that still have no travel time for the chosen mode (the agent fetches these before assembling). */
function placesMissingTravel(session, submit) {
    const mode = travelMode(submit);
    return eligiblePlaces(session, submit).eligible
        .slice(0, MAX_RESULTS)
        .filter(({ place }) => !session.travel.has(`${place.placeId}|${mode}`))
        .map(({ place }) => place.placeId);
}

function shortWhy(why, place) {
    const text = why || `Matches your request: ${place.name}.`;
    return text.length > MAX_WHY ? text.slice(0, MAX_WHY - 3).trimEnd() + '...' : text;
}

function assembleAnswer(session, submit, runId) {
    let status = STATUSES.includes(submit?.status) ? submit.status : 'ok';
    let message = String(submit?.message || '').trim();
    const base = { runId, status, message, question: null, relaxed: [], results: [], trace: session.trace };

    if (status === 'needs_clarification') {
        const question = String(submit?.question || message || 'Where should I search?').trim();
        return { ...base, message: message || question, question };
    }

    const relaxed = (submit?.relaxed || [])
        .filter((r) => RELAXABLE.includes(r?.constraint))
        .map((r) => ({ constraint: r.constraint, from: String(r.from ?? ''), to: String(r.to ?? '') }));

    const mode = travelMode(submit);
    const results = [];
    if (status === 'ok') {
        const { eligible, dropped } = eligiblePlaces(session, submit);
        session.trace.push(...dropped);
        for (const { place, why } of eligible) {
            if (results.length >= MAX_RESULTS) break;
            const minutes = session.travel.get(`${place.placeId}|${mode}`);
            if (minutes === undefined) { session.trace.push(`Dropped ${place.name}: no ${mode} time was looked up`); continue; }
            results.push({
                rank: results.length + 1,
                placeId: place.placeId,
                name: place.name,
                address: place.address,
                rating: place.rating,
                userRatingCount: place.userRatingCount,
                priceLevel: place.priceLevel,
                travelMinutes: minutes,
                travelMode: mode,
                why: shortWhy(why, place)
            });
        }
        if (results.length === 0) {
            status = 'no_results';
            message = 'Sorry, I could not find a place that fits everything you asked for.';
        }
    }
    if (!message) message = status === 'ok' ? `Here are ${results.length} places for you.` : 'Sorry, I could not find a place that fits.';

    return { ...base, status, message, relaxed, results };
}

/**
 * A one-time correction for a submit_answer that breaks the client's rules in a way the model can still fix,
 * or null to accept it. Each correction is sent at most once, so the loop always ends.
 *   relax: no_results without ever widening the search (the client: relax distance first).
 *   fill:  fewer than 3 places, while more may meet the hard constraints (the contract asks for 3 to 5).
 *          Not sent when the answer already reports a relaxation: then scarcity is evident and a short list is right.
 */
function reviewSubmit(session, submit) {
    // Gave up right after the fill bounce: accept, and the agent keeps the answer from before the bounce.
    if (session.beforeFill && submit?.status !== 'ok') return null;
    const radii = session.searchRadii;
    if (submit?.status === 'no_results' && !session.nudges.has('relax') && radii.length > 0 && Math.max(...radii) < radii[0] * 2) {
        session.nudges.add('relax');
        return 'Not yet: relax distance before giving up. Search again with at least double the radius (then price, then rating), report the relaxation in "relaxed" and "message", and submit again.';
    }
    const count = (submit?.results || []).length;
    const relaxed = (submit?.relaxed || []).length > 0;
    if (submit?.status === 'ok' && count > 0 && count < 3 && !relaxed && !session.nudges.has('fill')) {
        session.nudges.add('fill');
        session.beforeFill = submit;
        return `You listed ${count} place(s). The contract asks for 3 to 5 whenever that many meet the hard constraints (open now, dietary, cuisine). Mood only ranks places, it never excludes them. Add the next best places that meet the hard constraints, with their travel times. If no other place meets them, call submit_answer again with exactly the same answer (status ok, same places).`;
    }
    return null;
}

module.exports = { assembleAnswer, placesMissingTravel, eligiblePlaces, reviewSubmit, MAX_RESULTS };
