import { promises as fs } from 'node:fs';
import path from 'node:path';

const CONCURRENCY_LIMIT = 5;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
};

export interface DownloadResult {
  url: string;
  success: boolean;
  path?: string;
  error?: string;
}

function sanitizeBaseName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'file';
}

function uniqueFileName(url: string, contentType: string | null, usedNames: Set<string>): string {
  let baseName = 'file';
  let extension = '';
  try {
    const { pathname } = new URL(url);
    const segment = decodeURIComponent(pathname.split('/').pop() || '');
    extension = path.extname(segment);
    baseName = sanitizeBaseName(extension ? segment.slice(0, -extension.length) : segment);
  } catch {
    // fall through with defaults below
  }

  if (!extension) {
    const type = contentType ? contentType.split(';')[0].trim().toLowerCase() : '';
    extension = EXTENSION_BY_CONTENT_TYPE[type] ?? '';
  }

  let candidate = `${baseName}${extension}`;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}-${suffix}${extension}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

async function downloadOne(url: string, outputDir: string, usedNames: Set<string>): Promise<DownloadResult> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const fileName = uniqueFileName(url, response.headers.get('content-type'), usedNames);
    const filePath = path.join(outputDir, fileName);
    await fs.writeFile(filePath, buffer);
    return { url, success: true, path: filePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { url, success: false, error: message };
  }
}

export async function batchDownload(
  urls: string[],
  outputDir: string,
  onProgress?: (current: number, total: number) => void
): Promise<DownloadResult[]> {
  await fs.mkdir(outputDir, { recursive: true });

  const results: DownloadResult[] = new Array(urls.length);
  const usedNames = new Set<string>();
  let nextIndex = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= urls.length) return;
      results[index] = await downloadOne(urls[index], outputDir, usedNames);
      completed++;
      onProgress?.(completed, urls.length);
    }
  }

  const workerCount = Math.min(CONCURRENCY_LIMIT, urls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
