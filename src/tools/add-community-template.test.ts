import { describe, expect, it, vi } from 'vitest';
import { addCommunityTemplateCore } from './add-community-template.js';

describe('addCommunityTemplateCore', () => {
  it('delegates a known domain to the injected registry client', async () => {
    const addFromRegistry = vi.fn().mockResolvedValue({ templateId: 'example-template', registered: true });
    await expect(addCommunityTemplateCore({ addFromRegistry }, { domain: 'example.com' })).resolves.toEqual({ templateId: 'example-template', registered: true });
    expect(addFromRegistry).toHaveBeenCalledWith('example.com');
  });

  it('returns the registry client failure unchanged', async () => {
    const addFromRegistry = vi.fn().mockResolvedValue({ templateId: '', registered: false, error: 'not found' });
    await expect(addCommunityTemplateCore({ addFromRegistry }, { domain: 'missing.example' })).resolves.toMatchObject({ registered: false, error: 'not found' });
  });
});
