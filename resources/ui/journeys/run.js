// The run model (journeys-build.md, Contract 3): recording a journey run step by step and
// exporting it. All Sendproof's own: no Arazzo library models a run or writes JUnit. A browser-
// safe, maintained JUnit XML writer wasn't available either (junit-report-builder, MIT, imports
// node:fs and node:path at the top level and won't bundle for the browser), so toJUnit() is a
// small hand-written writer, matched against the JUnit XML schema most CI tools read.
import { bindStep, checkCriteria, stepOutputs } from './steps.js';
import { compareStep } from './compare.js';

const INTERNAL = Symbol('journeys-run-internal');
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(16).slice(2)}`);

/**
 * Starts a run of one Arazzo workflow (`journey`) against its expectations document. `store` is
 * the SQL system id expectations use for store-less changes (default "sqlite"); `clock` (default
 * the real clock) is the clock approved-difference expiry is read against.
 */
export function createRun({ journey, expectations, mode = 'preview', inputs = {}, persona, store = 'sqlite', clock = () => new Date() }) {
  const steps = (journey.steps ?? []).map(step => ({
    stepId: step.stepId, operationId: step.operationId, status: 'pending',
    httpStatus: null, durationMs: null, startMs: null,
    criteria: [], outputs: {}, findings: [], verdict: null, bound: null,
  }));
  return {
    runId: newId(), journeyId: journey.workflowId, name: journey.summary ?? journey.workflowId,
    mode, status: 'running', startedAt: clock().toISOString(), finishedAt: null, durationMs: null,
    persona, inputs, steps, approvedUsed: [], approvedUnused: [], approvedExpired: [],
    [INTERNAL]: { journey, expectations, store, clock, context: { inputs, steps: {} } },
  };
}

function computeApproved(run) {
  const { expectations, clock } = run[INTERNAL];
  const now = clock();
  const usedIds = new Set();
  for (const step of run.steps) for (const finding of step.findings) {
    if (finding.record) usedIds.add(finding.record);
    for (const field of finding.fields ?? []) if (field.record) usedIds.add(field.record);
  }
  const used = [], unused = [], expired = [];
  for (const record of (expectations.approvedDifferences ?? []).filter(r => r.journey === run.journeyId)) {
    if (record.expires && new Date(record.expires) < now) expired.push(record.id);
    else if (usedIds.has(record.id)) used.push(record.id);
    else unused.push(record.id);
  }
  run.approvedUsed = used; run.approvedUnused = unused; run.approvedExpired = expired;
}

function finalize(run, status) {
  const { clock } = run[INTERNAL];
  run.status = status;
  run.finishedAt = clock().toISOString();
  run.durationMs = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  computeApproved(run);
}

/**
 * Records one step's result: binds its outputs, checks its `successCriteria`, and compares its
 * captured `envelope.changes`/`envelope.effects` with its expectations. A step that is blocked,
 * is refused with an unexpected HTTP status, or fails its criteria stops the run (`status:
 * 'stopped'`, remaining pending steps marked 'skipped'); a write or effect mismatch alone does
 * not, per journeys.md ("write mismatches don't stop a run by default").
 */
export function recordStep(run, stepId, { response, envelope = {}, durationMs } = {}) {
  const internal = run[INTERNAL];
  const stepDef = internal.journey.steps?.find(step => step.stepId === stepId);
  const stepResult = run.steps.find(step => step.stepId === stepId);
  if (!stepDef || !stepResult) throw new RangeError(`Unknown step "${stepId}"`);

  const bound = bindStep(stepDef, internal.context).bound;
  const criteria = checkCriteria(stepDef.successCriteria, response);
  const outputs = stepOutputs(stepDef, response);
  internal.context.steps[stepId] = { outputs };

  const stepExpectations = internal.expectations.journeys?.[run.journeyId]?.steps?.[stepId] ?? {};
  const relevantApproved = (internal.expectations.approvedDifferences ?? [])
    .filter(record => record.journey === run.journeyId && record.step === stepId);
  const { verdict, findings } = compareStep({
    expected: stepExpectations, changes: envelope.changes ?? [], effects: envelope.effects ?? [], logs: envelope.logs ?? [],
    context: { ...internal.context, response, request: response?.request }, approved: relevantApproved,
    ignore: internal.expectations.ignore ?? [], unlisted: stepExpectations.unlisted ?? 'fail',
    store: internal.store, clock: internal.clock,
  });

  const blocked = Boolean(envelope.blocked);
  const criteriaPassed = criteria.every(criterion => criterion.passed);
  const httpStatus = response?.statusCode ?? null;
  const status = blocked ? 'blocked'
    : !criteriaPassed ? (httpStatus != null && httpStatus >= 400 ? 'refused' : 'failed')
    : verdict === 'failed' ? 'failed' : 'passed';
  Object.assign(stepResult, { httpStatus, durationMs: durationMs ?? null, criteria, outputs, findings, verdict, status, bound });

  const stops = blocked || !criteriaPassed;
  const stepIndex = run.steps.indexOf(stepResult);
  if (stops) {
    for (let i = stepIndex + 1; i < run.steps.length; i++) if (run.steps[i].status === 'pending') run.steps[i].status = 'skipped';
    finalize(run, 'stopped');
  } else if (stepIndex === run.steps.length - 1) {
    finalize(run, run.steps.every(step => step.status === 'passed') ? 'passed' : 'failed');
  } else {
    run.status = 'running';
  }
  return stepResult;
}

/** Marks a run that was never started (a Send-only journey in a Preview run of every journey)
 *  skipped: every step skipped, `status: 'skipped'`, and `skipReason` saying why. toJUnit()
 *  writes it as a testsuite whose cases are all skipped. */
export function skipRun(run, reason) {
  for (const step of run.steps) step.status = 'skipped';
  finalize(run, 'skipped');
  run.skipReason = reason;
  return run;
}

/** The run as plain JSON (its internal bookkeeping, kept under a Symbol key, is dropped). */
export function exportRun(run) {
  return JSON.parse(JSON.stringify(run));
}

const xmlEscape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

function findingText(finding) {
  const where = `${finding.store} ${finding.target}${finding.op ? ` (${finding.op})` : ''}`;
  if (finding.kind === 'missing') return `Missing: expected a write to ${where}, nothing matched.`;
  if (finding.kind === 'extra') return `Extra: an unlisted write to ${where} was made.`;
  const badFields = finding.fields.filter(field => field.state === 'differs')
    .map(field => `${field.name}: expected ${JSON.stringify(field.expected)}, got ${JSON.stringify(field.actual)}`);
  return `Differs: ${where} — ${badFields.join('; ')}`;
}

/** The run as JUnit XML: one `<testsuite>`, one `<testcase>` per step, failures listing the
 *  unmet criteria and findings as text. */
export function toJUnit(run) {
  const seconds = ms => ((ms ?? 0) / 1000).toFixed(3);
  const cases = run.steps.map(step => {
    const name = xmlEscape(step.stepId);
    const classname = xmlEscape(run.journeyId);
    const time = seconds(step.durationMs);
    if (step.status === 'skipped') return `<testcase name="${name}" classname="${classname}" time="${time}"><skipped/></testcase>`;
    const problems = [
      ...step.criteria.filter(criterion => !criterion.passed).map(criterion => `Criterion failed: ${criterion.condition} (actual: ${JSON.stringify(criterion.actual)})`),
      ...step.findings.filter(finding => finding.kind === 'differs' || finding.kind === 'missing' || finding.kind === 'extra').map(findingText),
      ...(step.status === 'blocked' ? ['Preview blocked by the write guard.'] : []),
      ...(step.status === 'refused' ? [`Unexpected response: ${step.httpStatus}`] : []),
    ];
    if (!problems.length) return `<testcase name="${name}" classname="${classname}" time="${time}"/>`;
    return `<testcase name="${name}" classname="${classname}" time="${time}"><failure message="${xmlEscape(problems[0])}">${xmlEscape(problems.join('\n'))}</failure></testcase>`;
  });
  const failures = run.steps.filter(step => step.status !== 'passed' && step.status !== 'skipped').length;
  const skipped = run.steps.filter(step => step.status === 'skipped').length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xmlEscape(run.name)}" tests="${run.steps.length}" failures="${failures}" skipped="${skipped}" time="${seconds(run.durationMs)}">\n${cases.join('\n')}\n</testsuite>\n`;
}
