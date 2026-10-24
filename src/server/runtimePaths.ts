import path from 'node:path';
import os from 'node:os';

// Cloud scratch space is temporary. It is never a substitute for durable storage.
export const DATA_DIR = path.resolve(process.env.CREATIVE_RADAAR_DATA_DIR ||
  (process.env.VERCEL ? path.join(os.tmpdir(), 'creative-radaar') : path.join(process.cwd(), '.data')));
