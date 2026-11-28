// The Story script: one entry per caption key, in the order the lab's talk track walks the page (docs/talk-track.md). Pure data, no DOM: the page wiring turns
// each entry into an engine step. The wording is in video/captions.md; test/story.test.js checks the two agree.
//
//   target   a CSS selector
//   trigger  'load' | 'run-done' (this lab's runs are scenario runs; a policy-change run is a run too)
//   prompt   { press }: the button Play for me clicks (the scenario the step narrates); the viewer picks the same one.
//   fixedSecs only where a later video's take.py passes secs=; Play for me holds every other bubble for its wording (shared hold.js).
//
// This lab has no Real mode: every step is Mock wording, every run simulated. The measured card is static content, not a run.

const SCEN = (id) => `[data-testid=scenario-${id}]`;
const RESULT = '[data-testid=flow-sim]';
const EVID = '[data-testid=evidence]';

export const STEPS = [
  { key: 'opening', type: 'slide', trigger: 'load' },

  // ---- Step 1: baseline
  { key: 'baseline_intro', type: 'bubble', trigger: 'load', target: SCEN('step-1-baseline'), prefer: 'below' },
  { key: 'baseline_run', type: 'bubble', trigger: 'run-done', target: RESULT, prefer: 'below', prompt: { press: SCEN('step-1-baseline') } },

  // ---- Step 2: add two Active policies
  { key: 'add_policies_intro', type: 'bubble', trigger: 'load', target: SCEN('step-2-add-policies'), prefer: 'below' },
  { key: 'add_policies_run', type: 'bubble', trigger: 'run-done', target: RESULT, prefer: 'below', prompt: { press: SCEN('step-2-add-policies') } },

  // ---- Step 3: same token, two tools (the measured shape)
  { key: 'same_token_intro', type: 'bubble', trigger: 'load', target: SCEN('step-3-same-token'), prefer: 'below' },
  { key: 'same_token_run', type: 'bubble', trigger: 'run-done', target: RESULT, prefer: 'below', prompt: { press: SCEN('step-3-same-token') } },

  // ---- Step 4: remove
  { key: 'remove_run', type: 'bubble', trigger: 'run-done', target: RESULT, prefer: 'below', prompt: { press: SCEN('step-4-remove') } },

  // ---- extras (all simulated, none measured)
  { key: 'act_text_run', type: 'bubble', trigger: 'run-done', target: RESULT, prefer: 'below', prompt: { press: SCEN('act-text') } },
  { key: 'no_token_run', type: 'bubble', trigger: 'run-done', target: RESULT, prefer: 'below', prompt: { press: SCEN('no-token') } },
  { key: 'candidate_run', type: 'bubble', trigger: 'run-done', target: RESULT, prefer: 'below', prompt: { press: SCEN('candidate') } },

  // ---- the measured card (static)
  { key: 'measured', type: 'bubble', trigger: 'load', target: `${EVID} h2`, prefer: 'right' },

  { key: 'closing', type: 'slide', trigger: 'load' },
];

// Bubbles only Story has (no video exists yet): none. Wording only a video would use: none.
export const STORY_ONLY = [];
export const VIDEO_ONLY = [];
export const EXTRA_SAMPLE_KEYS = [];

// What the parity test hands to captions.js parity(): the caption keys this script needs.
export function scriptKeys() {
  return {
    steps: STEPS.filter((s) => s.type === 'bubble').map((s) => s.key),
    slides: STEPS.filter((s) => s.type === 'slide').map((s) => s.key),
    sampleKeys: [...STEPS.map((s) => s.sampleKey).filter(Boolean), ...EXTRA_SAMPLE_KEYS],
  };
}
