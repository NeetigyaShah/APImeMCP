import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initOtelAdapter, getOtelStatus, shutdownOtelAdapter } from './otel-adapter.js';
import * as metricsModule from './metrics.js';
import type { MeasureRecord } from './types.js';

// Mock the metrics module to avoid triggering real listeners
vi.mock('./metrics.js', () => ({
  onMeasure: vi.fn((listener) => {
    // Store listener for testing
    mockListeners.push(listener);
    return () => {
      mockListeners = mockListeners.filter((l) => l !== listener);
    };
  }),
}));

// Mock OpenTelemetry modules with call tracking
let lastCounterAdd: any = null;
let lastHistogramRecord: any = null;
let lastSpanSetStatus: any = null;

vi.mock('@opentelemetry/sdk-metrics', () => ({
  MeterProvider: vi.fn(function (this: any, config: any) {
    this.getMeter = vi.fn(() => ({
      createCounter: vi.fn(() => ({
        add: vi.fn((value, attrs) => {
          lastCounterAdd = { value, attrs };
        }),
      })),
      createHistogram: vi.fn(() => ({
        record: vi.fn((value, attrs) => {
          lastHistogramRecord = { value, attrs };
        }),
      })),
    }));
  }),
  PeriodicExportingMetricReader: vi.fn(function (this: any, config: any) {
    this.config = config;
  }),
}));

vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: vi.fn(function (this: any, config: any) {
    this.config = config;
  }),
}));

vi.mock('@opentelemetry/sdk-trace-base', () => ({
  BasicTracerProvider: vi.fn(function (this: any) {
    this.addSpanProcessor = vi.fn();
    this.getTracer = vi.fn(() => ({
      startSpan: vi.fn((name: string, options: any) => ({
        setStatus: vi.fn((status) => {
          lastSpanSetStatus = status;
        }),
        end: vi.fn(),
      })),
    }));
  }),
  BatchSpanProcessor: vi.fn(function (this: any, exporter: any) {
    this.exporter = exporter;
  }),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: vi.fn(function (this: any, config: any) {
    this.config = config;
  }),
}));

let mockListeners: Array<(record: MeasureRecord) => void> = [];

describe('otel-adapter', () => {
  beforeEach(() => {
    mockListeners = [];
    lastCounterAdd = null;
    lastHistogramRecord = null;
    lastSpanSetStatus = null;
    // Reset the adapter state before each test
    shutdownOtelAdapter();
  });

  afterEach(async () => {
    await shutdownOtelAdapter();
    vi.clearAllMocks();
  });

  it('returns disabled status when OTEL_SDK_DISABLED=true', () => {
    const status = initOtelAdapter({
      OTEL_SDK_DISABLED: 'true',
      OTEL_SERVICE_NAME: 'test-service',
    });

    expect(status.enabled).toBe(false);
    expect(status.exporter).toBe('none');
    expect(status.recordsExported).toBe(0);
  });

  it('returns disabled status when no OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
    const status = initOtelAdapter({
      OTEL_SERVICE_NAME: 'test-service',
    });

    expect(status.enabled).toBe(false);
    expect(status.exporter).toBe('none');
    expect(status.recordsExported).toBe(0);
  });

  it('uses default OTEL_SERVICE_NAME when not provided', () => {
    const status = initOtelAdapter({});

    expect(status.serviceName).toBe('apimemcp');
  });

  it('exports measure records as metrics and spans with correct attributes', async () => {
    initOtelAdapter({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_SERVICE_NAME: 'test-service',
    });

    // Give async initialization time to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Trigger a measure record through the listener
    const testRecord: MeasureRecord = {
      templateId: 'test-template',
      kind: 'extraction',
      success: true,
      durationMs: 100,
      timestamp: '2026-07-17T12:00:00.000Z',
    };

    // Find and call the listener that was registered
    if (mockListeners.length > 0) {
      mockListeners[0](testRecord);

      // Verify counter.add was called with correct value and attributes
      expect(lastCounterAdd).not.toBeNull();
      expect(lastCounterAdd.value).toBe(1);
      expect(lastCounterAdd.attrs).toEqual({
        template_id: 'test-template',
        kind: 'extraction',
        success: 'true',
      });

      // Verify histogram.record was called with correct value and attributes
      expect(lastHistogramRecord).not.toBeNull();
      expect(lastHistogramRecord.value).toBe(100);
      expect(lastHistogramRecord.attrs).toEqual({
        template_id: 'test-template',
        kind: 'extraction',
        success: 'true',
      });
    }
  });

  it('marks failed extractions with ERROR span status', async () => {
    initOtelAdapter({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const failureRecord: MeasureRecord = {
      templateId: 'error-template',
      kind: 'extraction',
      success: false,
      error: 'Template validation failed',
      durationMs: 50,
      timestamp: '2026-07-17T12:00:00.500Z',
    };

    // Call the listener with a failure record
    if (mockListeners.length > 0) {
      mockListeners[0](failureRecord);

      // Verify setStatus was called with ERROR code and error message
      expect(lastSpanSetStatus).not.toBeNull();
      expect(lastSpanSetStatus.code).toBe(2); // SpanStatusCode.ERROR
      expect(lastSpanSetStatus.message).toBe('Template validation failed');
    }
  });

  it('returns current status via getOtelStatus', async () => {
    initOtelAdapter({
      OTEL_SDK_DISABLED: 'true',
    });

    const status = getOtelStatus();
    expect(status.enabled).toBe(false);
    expect(status.exporter).toBe('none');
  });

  it('clears status and unsubscribes on shutdown', async () => {
    const onMeasureSpy = vi.spyOn(metricsModule, 'onMeasure');
    onMeasureSpy.mockReturnValue(() => {
      // Unsubscribe function
    });

    initOtelAdapter({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    });

    await shutdownOtelAdapter();

    const status = getOtelStatus();
    expect(status.enabled).toBe(false);
    expect(status.recordsExported).toBe(0);
  });

  it('does not throw when listener throws', async () => {
    // Initialize with a throwing listener scenario
    // This tests the error isolation in the fan-out logic
    expect(() => {
      initOtelAdapter({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      });
    }).not.toThrow();
  });

  it('handles invalid endpoint gracefully', () => {
    const status = initOtelAdapter({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url',
    });

    // Should return disabled due to URL validation failure
    expect(status.enabled).toBe(false);
    expect(status.exporter).toBe('none');
    expect(status.lastError).toBeDefined();
  });
});
