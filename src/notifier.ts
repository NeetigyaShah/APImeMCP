import type { MonitorEvent } from './types.js';
import { isHttpUrl } from './types.js';

export async function sendNotification(endpointUrl: string, message: string): Promise<void> {
  if (!isHttpUrl(endpointUrl)) {
    throw new Error('endpointUrl must be an absolute http:// or https:// URL');
  }
  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, timestamp: new Date().toISOString() }),
  });
  if (!response.ok) {
    throw new Error(`Notification endpoint responded with HTTP ${response.status}`);
  }
}

export async function notifyChange(endpointUrl: string, event: MonitorEvent): Promise<void> {
  const message = `Monitor ${event.monitorId} (${event.templateId}): ${event.summary}`;
  // Call through the same endpoint-push channel as send_notification
  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, message, timestamp: event.at }),
  });
  if (!response.ok) {
    throw new Error(`Notification endpoint responded with HTTP ${response.status}`);
  }
}
