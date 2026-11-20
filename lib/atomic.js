// Saving a file all at once: write a temporary file next to it, then rename it over the old one. A rename is atomic,
// so a crash or power cut mid-save leaves either the old file or the new one, never half of one.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const tempName = (file) => `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

export function writeFileAtomicSync(file, data, { mode = 0o600 } = {}) {
  const tmp = tempName(file);
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export async function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const tmp = tempName(file);
  try {
    await fs.promises.writeFile(tmp, data, { mode });
    await fs.promises.rename(tmp, file);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
}
