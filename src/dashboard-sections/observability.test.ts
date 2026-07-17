import { describe, it, expect } from 'vitest';
import { renderObservabilityPanel } from './observability.js';

describe('renderObservabilityPanel', () => {
  it('shows disabled state clearly', () => {
    const html = renderObservabilityPanel({ enabled: false, exporter: 'none', serviceName: 'apimemcp', recordsExported: 0 });
    expect(html).toContain('disabled');
  });
  it('shows export count and last export time when enabled', () => {
    const html = renderObservabilityPanel({
      enabled: true, exporter: 'otlp-http', serviceName: 'apimemcp',
      recordsExported: 42, lastExportAt: 1700000000000,
    });
    expect(html).toContain('42');
    expect(html).toContain('otlp-http');
  });
});
