// Journey runs kept in this browser, like Try it's history (journeys.md, "The model": a run lives
// in browser storage, or a file from the CLI). Each journey keeps its last 20 runs per API
// document, newest first. A stored run is the engine's exported run model (ui/journeys/run.js,
// the same JSON as the CLI's --out and MCP's get_run) plus what the summary shows about it: who
// ran it, what each store did with its writes, and the operation each step called. Runs never
// hold cookies, Authorization headers or request bodies: only statuses, outputs and findings.

/** How many runs each journey keeps. */
export const RUNS_KEPT = 20;

export const runsStorageKey = documentUrl => `sendproof-journey-runs:${documentUrl || ''}`;

/** Every stored run for one API document: `{ [journeyId]: run[] }`, newest first. Unreadable storage means none. */
export function loadRuns(storage, documentUrl) {
  try {
    const value = JSON.parse(storage?.getItem(runsStorageKey(documentUrl)) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, runs]) => Array.isArray(runs)).map(([id, runs]) => [id, runs.filter(run => run && typeof run === 'object' && run.runId)]));
  } catch { return {}; }
}

/** Adds or replaces a run (by runId) at the front of its journey's list, keeping RUNS_KEPT. Returns the new map. */
export function saveRun(storage, documentUrl, run) {
  const all = loadRuns(storage, documentUrl);
  const list = (all[run.journeyId] ?? []).filter(item => item.runId !== run.runId);
  all[run.journeyId] = [run, ...list].slice(0, RUNS_KEPT);
  try { storage?.setItem(runsStorageKey(documentUrl), JSON.stringify(all)); } catch { /* Full or blocked storage only forgets runs. */ }
  return all;
}

/**
 * Tallies a step's findings: matched, approved (whole findings or fields covered by a record),
 * problems and not checked. A problem is what the step's detail lists: each differing field, each
 * missing or extra write and each unmet success criterion, so the rail, the chips, the verdict and
 * the tab's flag all say the same number.
 */
export function findingCounts(step) {
  const counts = { match: 0, approved: 0, problems: 0, unchecked: 0 };
  for (const finding of step?.findings ?? []) {
    if (finding.kind === 'match') counts.match++;
    else if (finding.kind === 'approved') counts.approved++;
    else if (finding.kind === 'unchecked') counts.unchecked++;
    if (finding.kind === 'differs') counts.approved += (finding.fields ?? []).filter(field => field.state === 'approved').length;
  }
  counts.problems = stepProblems(step).filter(item => item.kind !== 'approved').length + (step?.criteria ?? []).filter(criterion => !criterion.passed).length;
  return counts;
}

/**
 * The problems a step's findings hold, one per differing field or missing/extra write:
 * `{ kind, finding, field? }`. Approved fields are listed separately with `kind: 'approved'`.
 */
export function stepProblems(step) {
  const out = [];
  for (const finding of step?.findings ?? []) {
    if (finding.kind === 'missing' || finding.kind === 'extra') out.push({ kind: finding.kind, finding });
    for (const field of finding.fields ?? []) {
      if (field.state === 'differs') out.push({ kind: 'differs', finding, field });
    }
  }
  for (const finding of step?.findings ?? []) {
    for (const field of finding.fields ?? []) if (field.state === 'approved') out.push({ kind: 'approved', finding, field });
    if (finding.kind === 'approved' && !(finding.fields ?? []).length) out.push({ kind: 'approved', finding });
  }
  return out;
}

/** The step a run stopped or first failed at (its index), or -1 when every step passed. */
export function failedStepIndex(run) {
  return (run?.steps ?? []).findIndex(step => ['failed', 'refused', 'blocked'].includes(step.status));
}

/**
 * Adds a store tally to a run's bookkeeping from one step's envelope: changes per store system
 * (SQL changes carry no `store`, so they count under `sql`) and effects held or sent.
 */
export function tallyEnvelope(tally, envelope, sqlStore = 'sql') {
  const next = { stores: { ...(tally?.stores ?? {}) }, effects: tally?.effects ?? 0 };
  for (const change of envelope?.changes ?? []) {
    const system = change.store || sqlStore;
    next.stores[system] = (next.stores[system] ?? 0) + 1;
  }
  next.effects += (envelope?.effects ?? []).length;
  return next;
}

/**
 * A run the person ended (End run, a persona switch, Stop run) or that expired: stopped, not failed.
 * It is saved with `cancelled: true`; a run that also has a failing step is still a failure.
 */
export const runEnded = run => run?.cancelled === true && !(run.steps ?? []).some(step => ['failed', 'refused', 'blocked'].includes(step.status));

/** The index of the last step a run ran (not pending, not skipped), or -1. */
export const lastRanStep = run => (run?.steps ?? []).findLastIndex(step => !['pending', 'skipped'].includes(step.status));

/**
 * What the sidebar shows for a journey: the status of its latest run that finished by itself (passed,
 * failed, refused), else 'ended' when every run was ended early (a quiet mark, never red), else null.
 * `list` is the journey's runs, newest first.
 */
export function lastStatusOf(list) {
  const finished = list.find(run => !runEnded(run));
  return finished?.status ?? (list.length ? 'ended' : null);
}

/** Runs of every journey, newest first, for "Earlier runs". */
export function recentRuns(all, journeyId) {
  return (all?.[journeyId] ?? []).slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}
