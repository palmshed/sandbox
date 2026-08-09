/**
 * production/lib/harness.mjs
 *
 * Shared harness for Production Validation Suite scenarios.
 *
 * Each scenario receives a single `ctx` object. The ctx deliberately exposes
 * only the public SDK surface (through the injected Sandbox constructor) plus
 * assertion, timing-budget, and residue helpers. Scenarios never import the
 * workspace source directly; the runner resolves the installed
 * `@palmshed/sandbox` package, so the suite always exercises the artifact a
 * consumer would install.
 */
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import * as residue from './residue.mjs';

/** Resolve the installed @palmshed/sandbox package and report its version. */
export function resolveSandboxPackage() {
  const require = createRequire(import.meta.url);
  try {
    const entry = require.resolve('@palmshed/sandbox');
    const pkg = require('@palmshed/sandbox/package.json');
    return { entry, version: pkg.version, Sandbox: require('@palmshed/sandbox').Sandbox };
  } catch (err) {
    throw new Error(
      `@palmshed/sandbox is not installed in this checkout. Pack and install it first ` +
        `(see production/README.md): PACKFILE=\$(cd sdk/typescript && npm pack --silent | tail -n 1); ` +
        `npm install --no-save "./sdk/typescript/$PACKFILE". Underlying error: ${err.message}`
    );
  }
}

/** Make an assertion; on failure throw with a scenario-readable message. */
function makeAssert(ctx) {
  function assert(cond, message) {
    if (!cond) throw new Error(`assertion failed: ${message}`);
  }
  assert.equal = (actual, expected, message) => {
    if (actual !== expected) {
      throw new Error(
        `assertion failed: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  };
  assert.match = (value, regex, message) => {
    if (typeof value !== 'string' || !regex.test(value)) {
      throw new Error(`assertion failed: ${message}: ${JSON.stringify(value)} did not match ${regex}`);
    }
  };
  assert.ok = (cond, message) => {
    if (!cond) throw new Error(`assertion failed: ${message}`);
  };
  assert.notEqual = (actual, expected, message) => {
    if (actual === expected) {
      throw new Error(
        `assertion failed: ${message}: both were ${JSON.stringify(actual)}`
      );
    }
  };
  return assert;
}

/** Build a fresh scenario context bound to the resolved SDK. */
export function createContext({ Sandbox, log }) {
  const liveSandboxes = new Set();
  const steps = [];

  const ctx = {
    platform: process.platform,
    isWin: process.platform === 'win32',
    tmpdir: os.tmpdir(),
    log: (...args) => log(...args),

    assert: null, // assigned below

    /** Create a sandbox that the runner force-destroys if the scenario fails. */
    async sandbox(options) {
      const s = await Sandbox.create({ backend: 'native', ...options });
      liveSandboxes.add(s);
      return s;
    },

    /** Stop tracking a sandbox the scenario destroyed itself. */
    untrack(s) {
      liveSandboxes.delete(s);
    },

    /** Create a step (named, timed) for the scenario summary. */
    step(name) {
      const started = Date.now();
      const tracker = {
        name,
        ms: null,
        end() {
          this.ms = Date.now() - started;
          steps.push({ name, ms: this.ms });
        },
      };
      return tracker;
    },

    /** Best-effort destroy of everything this context still owns. */
    async cleanup() {
      let failures = 0;
      for (const s of liveSandboxes) {
        try {
          await s.destroy();
        } catch {
          failures += 1;
        }
      }
      liveSandboxes.clear();
      return failures;
    },

    // ── residue helpers ─────────────────────────────────────────────────

    scanResidue: residue.scanResidue,
    diffResidue: residue.diffResidue,
    formatResidue: residue.formatResidue,
    snapshotPgids: residue.snapshotRegistryPgids,
    liveProcesses: residue.liveProcesses,

    /** Assert no new residue appeared since a baseline snapshot. */
    assertNoResidue(before, label = 'scenario') {
      const after = residue.scanResidue();
      const leak = residue.diffResidue(before, after);
      if (residue.formatResidue(leak)) {
        throw new Error(`${label} left residue: ${residue.formatResidue(leak)}`);
      }
      return after;
    },

    /** Assert every recorded workload root is actually dead now. */
    assertPgidsDead(pgids, label = 'scenario') {
      const alive = residue.liveProcesses(pgids);
      if (alive.length > 0) {
        throw new Error(`${label} left live workload processes: ${alive.join(', ')}`);
      }
    },
  };

  ctx.assert = makeAssert(ctx);
  return { ctx, getSteps: () => steps };
}
