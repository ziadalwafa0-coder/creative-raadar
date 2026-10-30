import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scraper/fetch_amazon.py', import.meta.url));
let busy = false;
const waiting: Array<{ resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort: () => void }> = [];
let successfulRequests = 0;
let available: boolean | null = null;

export const scraplingEnabled = () => process.env.SCRAPLING_ENABLED === '1';
export const getScraplingStatus = () => ({ enabled: scraplingEnabled(), available, successfulRequests });

export function isScraplingAmazonUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['amazon.com', 'www.amazon.com'].includes(parsed.hostname)
      && !parsed.username && !parsed.password && (!parsed.port || parsed.port === '443');
  } catch { return false; }
}

function release(): void {
  const next = waiting.shift();
  if (!next) { busy = false; return; }
  next.signal?.removeEventListener('abort', next.onAbort);
  next.resolve();
}

async function acquire(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!busy) { busy = true; return; }
  if (waiting.length >= 32) throw new Error('Scrapling queue is full');
  await new Promise<void>((resolve, reject) => {
    const item = { resolve, reject, signal, onAbort: () => {
      const index = waiting.indexOf(item);
      if (index >= 0) waiting.splice(index, 1);
      reject(new Error('Scrapling request aborted'));
    } };
    waiting.push(item);
    signal?.addEventListener('abort', item.onAbort, { once: true });
  });
}

export function validateScraplingResponse(stdout: string): { status: number; html: string } {
  const value = JSON.parse(stdout);
  if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599
      || typeof value.html !== 'string' || !isScraplingAmazonUrl(value.url)) {
    throw new Error('Invalid Scrapling response');
  }
  return { status: value.status, html: value.html };
}

export async function fetchWithScrapling(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ status: number; html: string }> {
  if (!isScraplingAmazonUrl(url)) throw new Error('Invalid Scrapling destination');
  await acquire(options.signal);
  try {
    options.signal?.throwIfAborted();
    const timeoutMs = Math.min(20_000, Math.max(1000, options.timeoutMs || 8000));
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.env.SCRAPLING_PYTHON || 'python3', [script], {
        windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMs + 5000, signal: options.signal,
        // Do not give the scraper application access codes or provider keys.
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'LANG', 'LD_LIBRARY_PATH'].includes(key))),
      }, (error, output) => error ? reject(error) : resolve(output));
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify({ url, timeoutSeconds: timeoutMs / 1000 }));
    });
    const response = validateScraplingResponse(stdout);
    available = true;
    successfulRequests++;
    return response;
  } catch (error) {
    if (!options.signal?.aborted) available = false;
    throw error;
  } finally { release(); }
}
