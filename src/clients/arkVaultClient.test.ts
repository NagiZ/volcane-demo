import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCreateCredentialBody,
  buildCreateVaultBody,
  createCredential,
  createVault,
  createVaultWithLeyoCredential,
  deleteVault,
  updateCredential,
  VAULT_CREDENTIAL_DISPLAY_NAME,
  VAULT_SECRET_NAME,
} from './arkVaultClient.js';

vi.mock('axios');

describe('buildCreateVaultBody', () => {
  it('only sends display_name (no auth)', () => {
    const body = buildCreateVaultBody('abc123');
    expect(body).toEqual({ display_name: 'debug-leyo-vault-abc123' });
    expect(body).not.toHaveProperty('auth');
    expect(body).not.toHaveProperty('config');
    expect(body).not.toHaveProperty('type');
  });
});

describe('buildCreateCredentialBody', () => {
  it('uses environment_variable auth and LEYO_AGENT_KEY', () => {
    const body = buildCreateCredentialBody('plain-token');
    expect(body.display_name).toBe(VAULT_CREDENTIAL_DISPLAY_NAME);
    const auth = body.auth as {
      type: string;
      secret_name: string;
      secret_value: string;
      networking: { type: string };
    };
    expect(auth.type).toBe('environment_variable');
    expect(auth.secret_name).toBe(VAULT_SECRET_NAME);
    expect(auth.secret_value).toBe('plain-token');
    expect(auth.networking).toEqual({ type: 'unrestricted' });
  });
});

describe('createVault', () => {
  afterEach(() => vi.mocked(axios.post).mockReset());

  it('POSTs /vaults with display_name only', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { id: 'vault-9' } });
    const result = await createVault({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      nameSuffix: 'x1',
    });
    expect(result).toEqual({ vaultId: 'vault-9' });
    expect(axios.post).toHaveBeenCalledWith(
      'https://example.com/api/v3/vaults',
      { display_name: 'debug-leyo-vault-x1' },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer k' }),
      }),
    );
  });
});

describe('createCredential', () => {
  afterEach(() => vi.mocked(axios.post).mockReset());

  it('POSTs /vaults/{id}/credentials', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { id: 'cred-1' } });
    const result = await createCredential({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      vaultId: 'vault-9',
      secretValue: 'tok',
    });
    expect(result).toEqual({ credentialId: 'cred-1' });
    expect(axios.post).toHaveBeenCalledWith(
      'https://example.com/api/v3/vaults/vault-9/credentials',
      expect.objectContaining({
        display_name: VAULT_CREDENTIAL_DISPLAY_NAME,
        auth: expect.objectContaining({
          secret_name: 'LEYO_AGENT_KEY',
          secret_value: 'tok',
        }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer k' }),
      }),
    );
  });
});

describe('createVaultWithLeyoCredential', () => {
  afterEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.delete).mockReset();
  });

  it('creates vault then credential', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { id: 'vault-9' } })
      .mockResolvedValueOnce({ data: { id: 'cred-1' } });
    const result = await createVaultWithLeyoCredential({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      secretValue: 'tok',
      nameSuffix: 'x1',
    });
    expect(result).toEqual({ vaultId: 'vault-9', credentialId: 'cred-1' });
    expect(axios.post).toHaveBeenNthCalledWith(
      1,
      'https://example.com/api/v3/vaults',
      { display_name: 'debug-leyo-vault-x1' },
      expect.anything(),
    );
    expect(axios.post).toHaveBeenNthCalledWith(
      2,
      'https://example.com/api/v3/vaults/vault-9/credentials',
      expect.objectContaining({
        auth: expect.objectContaining({ secret_value: 'tok' }),
      }),
      expect.anything(),
    );
  });

  it('deletes vault when credential create fails', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { id: 'vault-9' } })
      .mockRejectedValueOnce(new Error('cred failed'));
    vi.mocked(axios.delete).mockResolvedValue({ data: {} });
    await expect(
      createVaultWithLeyoCredential({
        arkApiKey: 'k',
        arkBaseUrl: 'https://example.com/api/v3',
        secretValue: 'tok',
      }),
    ).rejects.toThrow();
    expect(axios.delete).toHaveBeenCalledWith(
      'https://example.com/api/v3/vaults/vault-9',
      expect.anything(),
    );
  });
});

describe('updateCredential', () => {
  afterEach(() => vi.mocked(axios.put).mockReset());

  it('PUTs credential secret_value', async () => {
    vi.mocked(axios.put).mockResolvedValue({ data: {} });
    await updateCredential({
      arkApiKey: 'k',
      arkBaseUrl: 'https://example.com/api/v3',
      vaultId: 'vault-9',
      credentialId: 'cred-1',
      secretValue: 'new-tok',
    });
    expect(axios.put).toHaveBeenCalledWith(
      'https://example.com/api/v3/vaults/vault-9/credentials/cred-1',
      expect.objectContaining({
        auth: expect.objectContaining({ secret_value: 'new-tok' }),
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
