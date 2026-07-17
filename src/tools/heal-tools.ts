import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HealForensics, HealResult, HealStatus, HealTicket } from '../types.js';

const TemplateIdSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'templateId must be lowercase kebab-case');
const TicketIdSchema = z.string().regex(/^[a-zA-Z0-9._-]+$/, 'ticketId contains invalid characters');

export const RequestTemplateHealShape = {
  templateId: TemplateIdSchema,
};

export const SubmitTemplateHealShape = {
  templateId: TemplateIdSchema,
  ticketId: TicketIdSchema,
  newScript: z.string().min(1, 'newScript must not be empty').max(100_000, 'newScript exceeds the 100KB limit'),
  notes: z.string().optional(),
};

export interface HealToolsDeps {
  captureHealForensics: (templateId: string) => Promise<HealForensics>;
  writeHealTicket: (forensics: HealForensics) => Promise<HealTicket>;
  readHealTicket: (ticketId: string) => Promise<HealTicket>;
  verifyHealSubmission: (ticket: HealTicket, newScript: string) => Promise<HealResult>;
  openHealRegistryPr: (templateId: string, newScript: string, ticket: HealTicket, dryRunOutput: unknown) => Promise<{ prUrl: string; branch: string }>;
  updateHealTicketStatus: (ticketId: string, status: HealStatus) => Promise<HealTicket>;
  listPendingHeals: () => Promise<HealTicket[]>;
  log: (message: string) => void;
  logError: (message: string) => void;
}

function textResult(payload: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return textResult({ success: false, error: message }, true);
}

export function registerRequestTemplateHealTool(server: McpServer, deps: HealToolsDeps): void {
  server.tool('request_template_heal', RequestTemplateHealShape, async ({ templateId }) => {
    try {
      const forensics = await deps.captureHealForensics(templateId);
      const ticket = await deps.writeHealTicket(forensics);
      deps.log(`Created heal ticket "${ticket.id}" for template "${templateId}"`);
      return textResult({ ticketId: ticket.id, forensics });
    } catch (error) {
      deps.logError(`request_template_heal failed: ${error instanceof Error ? error.message : String(error)}`);
      return errorResult(error);
    }
  });
}

export function registerSubmitTemplateHealTool(server: McpServer, deps: HealToolsDeps): void {
  server.tool('submit_template_heal', SubmitTemplateHealShape, async ({ templateId, ticketId, newScript }) => {
    try {
      const ticket = await deps.readHealTicket(ticketId);
      if (ticket.templateId !== templateId) throw new Error(`Ticket "${ticketId}" belongs to "${ticket.templateId}", not "${templateId}"`);
      const verified = await deps.verifyHealSubmission(ticket, newScript);
      if (!verified.valid) return textResult(verified, true);
      const pr = await deps.openHealRegistryPr(templateId, newScript, ticket, verified.dryRunOutput);
      await deps.updateHealTicketStatus(ticketId, 'pr-opened');
      deps.log(`Opened heal PR for template "${templateId}" on branch "${pr.branch}"`);
      return textResult({ ...verified, ...pr });
    } catch (error) {
      deps.logError(`submit_template_heal failed: ${error instanceof Error ? error.message : String(error)}`);
      return errorResult(error);
    }
  });
}

export function registerListPendingHealsTool(server: McpServer, deps: HealToolsDeps): void {
  server.tool('list_pending_heals', {}, async () => {
    const tickets = await deps.listPendingHeals();
    return textResult(tickets.map(({ id, templateId, status, createdAt }) => ({ id, templateId, status, createdAt })));
  });
}
