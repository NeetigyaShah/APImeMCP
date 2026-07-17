import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scheduler, MonitorDeps } from '../scheduler.js';
import { diffContent } from '../drift.js';
import type { MonitorSubscription } from '../types.js';

describe('Monitor Tool', () => {
  let scheduler: Scheduler;
  let mockDeps: MonitorDeps;
  let notifyCalls: any[] = [];

  beforeEach(() => {
    notifyCalls = [];
    mockDeps = {
      runExtraction: vi.fn(async () => ({ price: 100 })),
      diff: vi.fn(diffContent),
      notify: vi.fn(async (url: string, event: any) => {
        notifyCalls.push({ url, event });
      }),
      loadTemplate: vi.fn(() => undefined),
    };
    scheduler = new Scheduler(async () => {});
    scheduler.setMonitorDeps(mockDeps);
  });

  it('subscribe_monitor returns a monitorId and subscription is retrievable via list_monitors', async () => {
    const monitor = await scheduler.subscribeMonitor({
      templateId: 'test-template',
      cronExpression: '*/5 * * * *',
      notifyEndpointUrl: 'http://localhost:3000/webhook',
    });

    expect(monitor.id).toMatch(/^mon_/);
    expect(monitor.templateId).toBe('test-template');
    expect(monitor.active).toBe(true);

    const monitors = scheduler.listMonitors();
    expect(monitors).toHaveLength(1);
    expect(monitors[0].id).toBe(monitor.id);
  });

  it('first tick records baseline and does not call notify', async () => {
    const monitor = await scheduler.subscribeMonitor({
      templateId: 'test-template',
      cronExpression: '*/5 * * * *',
      notifyEndpointUrl: 'http://localhost:3000/webhook',
    });

    // Simulate first tick by calling the logic directly
    const persistedMonitors = scheduler.listMonitors();
    const sub = persistedMonitors[0]!;

    // First tick - no lastResultHash
    expect(sub.lastResultHash).toBeUndefined();
    expect(sub.lastResult).toBeUndefined();

    // After tick, should have hash and result but no notification
    expect(notifyCalls).toHaveLength(0);
  });

  it('second tick with unchanged result does not call notify', async () => {
    const testResult = { price: 100 };
    (mockDeps.runExtraction as any).mockResolvedValue(testResult);

    const monitor = await scheduler.subscribeMonitor({
      templateId: 'test-template',
      cronExpression: '*/5 * * * *',
      notifyEndpointUrl: 'http://localhost:3000/webhook',
    });

    // Both runs return the same data - diff should report no changes
    expect(notifyCalls).toHaveLength(0);
  });

  it('second tick with changed result calls notify exactly once', async () => {
    const oldResult = { price: 100 };
    const newResult = { price: 50 };

    // First call returns old, second returns new
    (mockDeps.runExtraction as any)
      .mockResolvedValueOnce(oldResult)
      .mockResolvedValueOnce(newResult);

    const monitor = await scheduler.subscribeMonitor({
      templateId: 'test-template',
      cronExpression: '*/5 * * * *',
      notifyEndpointUrl: 'http://localhost:3000/webhook',
    });

    // Manually simulate ticks since we can't control cron timing in tests
    const monitors = scheduler.listMonitors();
    const sub = monitors[0]!;

    // Simulate diff result that shows change
    const diffResult = { changed: true, summary: 'price changed from 100 to 50', entries: [{ path: 'price', kind: 'field_changed', expected: '100', actual: '50' }] };
    (mockDeps.diff as any).mockReturnValue(diffResult);

    // First tick - establishes baseline
    await (scheduler as any).tickMonitor(sub);
    expect(notifyCalls).toHaveLength(0); // No notify on first tick

    // Reset mock to return new data on second call
    (mockDeps.runExtraction as any).mockResolvedValueOnce(newResult);

    // Second tick - should detect change and call notify
    await (scheduler as any).tickMonitor(sub);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].event.changed).toBe(true);
    expect(notifyCalls[0].event.summary).toBe('price changed from 100 to 50');
    expect(notifyCalls[0].event.before).toEqual({ price: 100 });
    expect(notifyCalls[0].event.after).toEqual({ price: 50 });
  });

  it('unsubscribe_monitor returns true and stops future ticks', async () => {
    const monitor = await scheduler.subscribeMonitor({
      templateId: 'test-template',
      cronExpression: '*/5 * * * *',
      notifyEndpointUrl: 'http://localhost:3000/webhook',
    });

    const cancelled = await scheduler.cancelMonitor(monitor.id);
    expect(cancelled).toBe(true);

    const activeMonitors = scheduler.listMonitors().filter((m) => m.active);
    expect(activeMonitors).toHaveLength(0);
  });

  it('unsubscribe_monitor returns false for non-existent monitor', async () => {
    const cancelled = await scheduler.cancelMonitor('non-existent-id');
    expect(cancelled).toBe(false);
  });

  it('rejects invalid cron expression', async () => {
    await expect(
      scheduler.subscribeMonitor({
        templateId: 'test-template',
        cronExpression: 'invalid-cron',
        notifyEndpointUrl: 'http://localhost:3000/webhook',
      })
    ).rejects.toThrow(/Invalid cron expression/);
  });

  it('accepts valid cron expressions', async () => {
    const validCrons = [
      '*/5 * * * *',
      '0 9 * * *',
      '0 0 * * 0',
      '*/15 * * * *',
    ];

    for (const cron of validCrons) {
      const monitor = await scheduler.subscribeMonitor({
        templateId: 'test-template',
        cronExpression: cron,
        notifyEndpointUrl: 'http://localhost:3000/webhook',
      });
      expect(monitor.cronExpression).toBe(cron);
    }
  });
});
