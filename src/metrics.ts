import { promises as fs } from 'node:fs';
import path from 'node:path';

const CSV_HEADER = 'timestamp,templateId,url,imageCount\n';

function getMetricsPath(): string {
  return path.join(path.resolve(process.cwd(), 'templates'), 'extraction_metrics.csv');
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export async function logExtractionMetric(templateId: string, url: string, imageCount: number): Promise<void> {
  const filePath = getMetricsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const row = `${new Date().toISOString()},${csvEscape(templateId)},${csvEscape(url)},${imageCount}\n`;

  const exists = await fs.access(filePath).then(
    () => true,
    () => false
  );
  if (!exists) {
    await fs.writeFile(filePath, CSV_HEADER + row, 'utf8');
  } else {
    await fs.appendFile(filePath, row, 'utf8');
  }
}

export interface ExtractionStats {
  totalImages: number;
  recentDomains: string[];
  lastSuccessfulRun: string | null;
}

export async function getExtractionStats(): Promise<ExtractionStats> {
  let raw: string;
  try {
    raw = await fs.readFile(getMetricsPath(), 'utf8');
  } catch {
    return { totalImages: 0, recentDomains: [], lastSuccessfulRun: null };
  }

  const lines = raw.trim().split('\n').slice(1).filter(Boolean);
  let totalImages = 0;
  const domains: string[] = [];
  let lastSuccessfulRun: string | null = null;

  for (const line of lines) {
    const [timestamp, , url, imageCountRaw] = parseCsvLine(line);
    totalImages += Number(imageCountRaw) || 0;
    try {
      domains.push(new URL(url).hostname);
    } catch {
      // skip malformed url
    }
    lastSuccessfulRun = timestamp;
  }

  const recentDomains = Array.from(new Set(domains.slice(-10).reverse()));
  return { totalImages, recentDomains, lastSuccessfulRun };
}
