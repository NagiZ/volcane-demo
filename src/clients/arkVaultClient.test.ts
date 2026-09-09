import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCreateEnvVaultBody,
  createEnvVault,
  deleteVault,
  VAULT_SECRET_NAME,
} from './arkVaultClient.js';

vi.mock('axios');

describe('buildCreateEnvVaultBody', () => {
  it('uses environment_variable shape and LEYO_AGENT_KEY', () => {
    const body = buildCreateEnvVaultBody('plain-token', 'abc123');
    expect(body.name).toBe('debug-token-abc123');
    expect(body.type).toBe('environment_variable');
    const config = body.config as {
      auth: {
        type: string;
        secret_name: string;
        secret_value: string;
        networking: { type: string };
      };
    };
    expect(config.auth.type).toBe('environment_variable');
    expect(config.auth.secret_name).toBe(VAULT_SECRET_NAME);
    expect(config.auth.secret_name).toBe('LEYO_AGENT_KEY');
    expect(config.auth.secret_value).toBe('plain-token');
    expect(config.auth.networking).toEqual({ type: 'unrestricted' });
  });
});

describe('createEnvVault', () => {
  afterEach(() => vi.mocked(axios.post).mockReset());

  it('POSTs /vaults and returns id', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { id: 'vault-9' } });
    const result = await createEnvVault({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      secretValue: 'tok',
      nameSuffix: 'x1',
    });
    expect(result).toEqual({ vaultId: 'vault-9' });
    expect(axios.post).toHaveBeenCalledWith(
      'https://example.com/api/v3/vaults',
      expect.objectContaining({
        name: 'debug-token-x1',
        type: 'environment_variable',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer k' }),
      }),
    );
  });
});

describe('deleteVault', () => {
  afterEach(() => vi.mocked(axios.delete).mockReset());

  it('DELETEs /vaults/{id}', async () => {
    vi.mocked(axios.delete).mockResolvedValue({ data: {} });
    await deleteVault({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      vaultId: 'vault-9',
    });
    expect(axios.delete).toHaveBeenCalledWith(
      'https://example.com/api/v3/vaults/vault-9',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer k' }),
      }),
    );
  });
});
