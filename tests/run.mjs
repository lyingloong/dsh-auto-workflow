/**
 * Run every test file in one process.
 *
 * Suites isolate themselves with temporary data directories and repositories,
 * so sharing a process is safe. The standard runner also works:
 * `node --test tests/run.mjs`.
 */

import './v3-core.test.mjs';
import './v3-executors.test.mjs';
import './host-contract.test.mjs';
import './pr-feedback.test.mjs';
import './v3-recovery.test.mjs';
import './v3-plugin.test.mjs';
import './v3-web-api.test.mjs';
import './v3-board.test.mjs';
import './development-example.test.mjs';
import './audit-core.test.mjs';
import './audit-integration.test.mjs';
import './audit-example.test.mjs';
