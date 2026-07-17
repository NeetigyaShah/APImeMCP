import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppConnectionIdShape, ConnectAppShape } from '../types.js';
import type { AppConnection, ConnectAppInput } from '../types.js';

export interface AppConnectionsToolDeps {
  appConnections: {
    upsert: (input: ConnectAppInput) => Promise<AppConnection>;
    list: () => Promise<AppConnection[]>;
  };
  engine: {
    open: (connectionId: string) => Promise<AppConnection>;
    confirm: (connectionId: string) => Promise<AppConnection>;
  };
  log: (message: string) => void;
  logError: (message: string) => void;
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    result: { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true },
  };
}

export function registerConnectAppTool(server: McpServer, deps: AppConnectionsToolDeps): void {
  server.tool('connect_app', ConnectAppShape, async (input) => {
    try {
      const configured = await deps.appConnections.upsert(input);
      const opened = await deps.engine.open(configured.connectionId);
      deps.log(`Opened login profile for app connection "${opened.connectionId}"`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { success: true, connection: opened, nextStep: 'Log in in the visible browser window, then call confirm_app_connection.' },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const { message, result } = errorResult(error);
      deps.logError(`connect_app failed: ${message}`);
      return result;
    }
  });
}

export function registerConfirmAppConnectionTool(server: McpServer, deps: AppConnectionsToolDeps): void {
  server.tool('confirm_app_connection', AppConnectionIdShape, async (input) => {
    try {
      const connection = await deps.engine.confirm(input.connectionId);
      deps.log(`Confirmed app connection "${connection.connectionId}"`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, connection }, null, 2) }] };
    } catch (error) {
      const { message, result } = errorResult(error);
      deps.logError(`confirm_app_connection failed: ${message}`);
      return result;
    }
  });
}

export function registerListAppConnectionsTool(server: McpServer, deps: AppConnectionsToolDeps): void {
  server.tool('list_app_connections', {}, async () => {
    const connections = await deps.appConnections.list();
    return { content: [{ type: 'text' as const, text: JSON.stringify(connections, null, 2) }] };
  });
}
