// TESTING ONLY: deliberately broken behaviors, to prove the grader catches each kind of mistake
// (grader calibration). Switched on by the AGENT_BREAK variable, set by hand on this playground only.
// Not part of the exercise and never provisioned: with AGENT_BREAK unset the agent is the correct one.
//
//   invent_place     recommends a restaurant it never looked up                (grader: grounding.found, R6)
//   skip_directions  estimates walking time from distance, no Directions call  (grader: grounding.travel, R14)
//   no_hard_rules    never reads opening hours or the vegetarian flag, no filters (grader: hardRule.mustNotInclude, R7/R8)
//   single_call      fixed pipeline without Gemini: search, sort by rating     (grader: behavior.agentLoop, R15)
//   ignore_reviews   no review lookups, ranks by rating only                   (grader: ranking.trapsOutOfTop3, R5)

const MODES = ['invent_place', 'skip_directions', 'no_hard_rules', 'single_call', 'ignore_reviews'];

/** The active break, or null. Read on every call so a Railway variable change needs no code change. */
function agentBreak() {
    const mode = (process.env.AGENT_BREAK || '').trim();
    return MODES.includes(mode) ? mode : null;
}

module.exports = { agentBreak, MODES };
