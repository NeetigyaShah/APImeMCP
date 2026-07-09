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
