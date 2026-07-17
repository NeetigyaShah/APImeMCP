import { z } from 'zod';
import { SpanStatusCode } from '@opentelemetry/api';
import type { MeasureRecord } from './types.js';
import { onMeasure } from './metrics.js';

// Environment configuration schema using standard OpenTelemetry conventions
const OtelEnvSchema = z.object({
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('apimemcp'),
  OTEL_SDK_DISABLED: z.enum(['true', 'false']).default('false'),
});

export interface OtelAdapterStatus {
  enabled: boolean;
  exporter: 'otlp-http' | 'none';
  serviceName: string;
  recordsExported: number;
  lastExportAt?: number;
  lastError?: string;
}

let adapterStatus: OtelAdapterStatus = {
  enabled: false,
  exporter: 'none',
  serviceName: 'apimemcp',
  recordsExported: 0,
};

let unsubscribeListener: (() => void) | undefined;
let activeMeterProvider: { shutdown: () => Promise<void> } | undefined;
let activeTracerProvider: { shutdown: () => Promise<void> } | undefined;

// Lazy-load OTel SDK only when needed and enabled
async function initOtelSdk(endpoint: string, serviceName: string) {
  try {
    // Dynamically import OTel modules to avoid loading them if disabled
    const { MeterProvider, PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    const { BasicTracerProvider, BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    // ponytail: SDK initialization path; move if throughput requires non-blocking startup


    // The JS OTLP/HTTP exporters use `url` verbatim (no auto-appended signal path) once
    // it's set explicitly, unlike the OTEL_EXPORTER_OTLP_ENDPOINT env var's own default
    // behavior -- each signal needs its own /v1/<signal> suffix per the OTLP spec.
    const metricsEndpoint = `${endpoint.replace(/\/+$/, '')}/v1/metrics`;
    const tracesEndpoint = `${endpoint.replace(/\/+$/, '')}/v1/traces`;

    const meterProvider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: metricsEndpoint }),
        }),
      ],
    });

    const tracerProvider = new BasicTracerProvider();
    tracerProvider.addSpanProcessor(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: tracesEndpoint })
      )
    );

    // Both readers/processors default to long export intervals (60s metrics, 5s trace
    // batch) -- shutdownOtelAdapter() needs these references to force a final flush
    // instead of silently dropping whatever hasn't exported yet.
    activeMeterProvider = meterProvider;
    activeTracerProvider = tracerProvider;

    const meter = meterProvider.getMeter('apimemcp-metrics');
    const tracer = tracerProvider.getTracer('apimemcp-traces');

    const extractionCounter = meter.createCounter('apimemcp.extraction.count', {
      description: 'Total number of extractions executed',
    });

    const extractionDurationHistogram = meter.createHistogram('apimemcp.extraction.duration_ms', {
      description: 'Duration of extraction in milliseconds',
    });

    // Subscribe to measure records and export to OTel
    unsubscribeListener = onMeasure((record: MeasureRecord) => {
      try {
        // Export as counter and histogram metrics
        extractionCounter.add(1, {
          template_id: record.templateId,
          kind: record.kind,
          success: String(record.success),
        });

        extractionDurationHistogram.record(record.durationMs, {
          template_id: record.templateId,
          kind: record.kind,
          success: String(record.success),
        });

        // Export as a synthetic span
        const endTime = new Date(record.timestamp).getTime();
        const spanStartTime = endTime - record.durationMs;
        const spanEndTime = endTime;

        const span = tracer.startSpan(record.templateId, {
          startTime: spanStartTime,
        });

        if (!record.success && record.error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: record.error,
          });
        }

        span.end(spanEndTime);

        adapterStatus.recordsExported++;
        adapterStatus.lastExportAt = Date.now();
        adapterStatus.lastError = undefined;
      } catch (error) {
        adapterStatus.lastError = error instanceof Error ? error.message : String(error);
      }
    });

    return true;
  } catch (error) {
    adapterStatus.lastError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export function initOtelAdapter(env?: NodeJS.ProcessEnv): OtelAdapterStatus {
  const processEnv = env || process.env;

  let config;
  try {
    config = OtelEnvSchema.parse(processEnv);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    adapterStatus = {
      enabled: false,
      exporter: 'none',
      serviceName: 'apimemcp',
      recordsExported: 0,
      lastError: `Validation failed: ${errorMsg}`,
    };
    return adapterStatus;
  }

  // Check if OTel is explicitly disabled
  if (config.OTEL_SDK_DISABLED === 'true') {
    adapterStatus = {
      enabled: false,
      exporter: 'none',
      serviceName: config.OTEL_SERVICE_NAME,
      recordsExported: 0,
    };
    return adapterStatus;
  }

  // Check if endpoint is configured
  if (!config.OTEL_EXPORTER_OTLP_ENDPOINT) {
    adapterStatus = {
      enabled: false,
      exporter: 'none',
      serviceName: config.OTEL_SERVICE_NAME,
      recordsExported: 0,
    };
    return adapterStatus;
  }

  // Initialize the OTel SDK asynchronously
  initOtelSdk(config.OTEL_EXPORTER_OTLP_ENDPOINT, config.OTEL_SERVICE_NAME)
    .then((success) => {
      if (success) {
        adapterStatus = {
          enabled: true,
          exporter: 'otlp-http',
          serviceName: config.OTEL_SERVICE_NAME,
          recordsExported: 0,
        };
      } else {
        // initOtelSdk returned false but didn't set an error, check if lastError was already set
        if (!adapterStatus.lastError) {
          adapterStatus.lastError = 'SDK initialization returned false without error details';
        }
      }
    })
    .catch((error) => {
      adapterStatus.lastError = error instanceof Error ? error.message : String(error);
    });

  return adapterStatus;
}

export function getOtelStatus(): OtelAdapterStatus {
  return adapterStatus;
}

export async function shutdownOtelAdapter(): Promise<void> {
  if (unsubscribeListener) {
    unsubscribeListener();
    unsubscribeListener = undefined;
  }
  if (activeMeterProvider) {
    await activeMeterProvider.shutdown().catch(() => undefined);
    activeMeterProvider = undefined;
  }
  if (activeTracerProvider) {
    await activeTracerProvider.shutdown().catch(() => undefined);
    activeTracerProvider = undefined;
  }
  adapterStatus = {
    enabled: false,
    exporter: 'none',
    serviceName: 'apimemcp',
    recordsExported: 0,
  };
}
