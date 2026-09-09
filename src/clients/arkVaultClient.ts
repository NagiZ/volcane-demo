import { randomBytes } from 'node:crypto';
import axios, { AxiosError } from 'axios';
import { ArkApiError } from './arkClient.js';

const NO_TIMEOUT = 0;

export const VAULT_SECRET_NAME = 'LEYO_AGENT_KEY';
export const VAULT_CREDENTIAL_DISPLAY_NAME = 'leyo-agent-key-cred';

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function readArkErrorPayload(data: unknown): { message: string; code?: string } {
  if (!data || typeof data !== 'object') return { message: 'Unknown ark error' };
  const obj = data as Record<string, unknown>;
  const nested = obj.error;
  if (nested && typeof nested === 'object') {
    const err = nested as Record<string, unknown>;
    return {
      message: typeof err.message === 'string' ? err.message : 'Ark API error',
      code: typeof err.code === 'string' ? err.code : undefined,
    };
  }
  return {
    message:
      (typeof obj.message === 'string' && obj.message) ||
      (typeof obj.error === 'string' && obj.error) ||
      'Ark API error',
    code: typeof obj.code === 'string' ? obj.code : undefined,
  };
}

function toArkError(err: unknown): ArkApiError {
  if (err instanceof ArkApiError) return err;
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const { message, code } = readArkErrorPayload(err.response?.data);
    return new ArkApiError(message, { status, code });
  }
  return new ArkApiError(err instanceof Error ? err.message : 'Unknown ark error');
}

/** 空 Vault 容器：仅 display_name，禁止携带 auth。 */
export function buildCreateVaultBody(
  nameSuffix: string = randomBytes(4).toString('hex'),
): Record<string, unknown> {
  return {
    display_name: `debug-leyo-vault-${nameSuffix}`,
  };
}

/** Vault 下的 environment_variable 凭据。 */
export function buildCreateCredentialBody(secretValue: string): Record<string, unknown> {
  return {
    display_name: VAULT_CREDENTIAL_DISPLAY_NAME,
    auth: {
      type: 'environment_variable',
      secret_name: VAULT_SECRET_NAME,
      secret_value: secretValue,
      networking: { type: 'unrestricted' },
    },
  };
}

export function buildUpdateCredentialBody(secretValue: string): Record<string, unknown> {
  return {
    auth: {
      type: 'environment_variable',
      secret_name: VAULT_SECRET_NAME,
      secret_value: secretValue,
      networking: { type: 'unrestricted' },
    },
  };
}

export async function createVault(params: {
  arkApiKey: string;
  arkBaseUrl: string;
  nameSuffix?: string;
}): Promise<{ vaultId: string }> {
  try {
    const res = await axios.post<{ id?: string }>(
      `${params.arkBaseUrl}/vaults`,
      buildCreateVaultBody(params.nameSuffix),
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT },
    );
    if (!res.data?.id) throw new ArkApiError('Create vault response missing id');
    return { vaultId: res.data.id };
  } catch (err) {
    throw toArkError(err);
  }
}

export async function createCredential(params: {
  arkApiKey: string;
  arkBaseUrl: string;
  vaultId: string;
  secretValue: string;
}): Promise<{ credentialId: string }> {
  try {
    const res = await axios.post<{ id?: string }>(
      `${params.arkBaseUrl}/vaults/${encodeURIComponent(params.vaultId)}/credentials`,
      buildCreateCredentialBody(params.secretValue),
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT },
    );
    if (!res.data?.id) throw new ArkApiError('Create credential response missing id');
    return { credentialId: res.data.id };
  } catch (err) {
    throw toArkError(err);
  }
}

/** 先建空 Vault，再写入唯一 LEYO_AGENT_KEY 凭据；凭据失败则删 Vault。 */
export async function createVaultWithLeyoCredential(params: {
  arkApiKey: string;
  arkBaseUrl: string;
  secretValue: string;
  nameSuffix?: string;
}): Promise<{ vaultId: string; credentialId: string }> {
  const { vaultId } = await createVault({
    arkApiKey: params.arkApiKey,
    arkBaseUrl: params.arkBaseUrl,
    nameSuffix: params.nameSuffix,
  });
  try {
    const { credentialId } = await createCredential({
      arkApiKey: params.arkApiKey,
      arkBaseUrl: params.arkBaseUrl,
      vaultId,
      secretValue: params.secretValue,
    });
    return { vaultId, credentialId };
  } catch (err) {
    try {
      await deleteVault({
        arkApiKey: params.arkApiKey,
        arkBaseUrl: params.arkBaseUrl,
        vaultId,
      });
    } catch {
      // 尽力回滚空 Vault
    }
    throw err;
  }
}

export async function updateCredential(params: {
  arkApiKey: string;
  arkBaseUrl: string;
  vaultId: string;
  credentialId: string;
  secretValue: string;
}): Promise<void> {
  try {
    await axios.put(
      `${params.arkBaseUrl}/vaults/${encodeURIComponent(params.vaultId)}/credentials/${encodeURIComponent(params.credentialId)}`,
      buildUpdateCredentialBody(params.secretValue),
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT },
    );
  } catch (err) {
    throw toArkError(err);
  }
}

export async function deleteVault(params: {
  arkApiKey: string;
  arkBaseUrl: string;
  vaultId: string;
}): Promise<void> {
  try {
    await axios.delete(
      `${params.arkBaseUrl}/vaults/${encodeURIComponent(params.vaultId)}`,
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT },
    );
  } catch (err) {
    throw toArkError(err);
  }
}
