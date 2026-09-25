/**
 * Fixture for test/stdout-write.test.ts. Reproduces the CLI's stdout shape --
 * an 'error' listener on process.stdout, exactly as process-cleanup.ts
 * installs -- then emits HARNESS_BYTES of JSON through writeStdout and exits
 * through the real flushThenExit, like `gbrain <cmd> --json` does.
 */
import { writeStdout } from '../../src/core/stdout-write.ts';
import { flushThenExit } from '../../src/core/cli-force-exit.ts';

process.stdout.on('error', () => {});

const size = Number(process.env.HARNESS_BYTES ?? '1000000');
const payload = JSON.stringify({ blob: 'x'.repeat(size) }) + '\n';

await writeStdout(payload);
flushThenExit(0);
