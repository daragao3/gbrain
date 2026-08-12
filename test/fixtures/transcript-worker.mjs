import { writeFileSync } from 'node:fs';

const [mode, value = '', marker = ''] = process.argv.slice(2);
if (mode === 'stdout') {
  process.stdout.write(value);
  process.exit(0);
} else if (mode === 'stderr') {
  process.stderr.write(value);
  process.exit(0);
} else if (mode === 'exit') {
  process.exit(Number(value));
} else if (mode === 'wait') {
  if (marker) writeFileSync(marker, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  throw new Error(`unknown transcript worker mode: ${mode}`);
}
