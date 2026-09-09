import { randomBytes } from 'node:crypto';
import axios, { AxiosError } from 'axios';
import { ArkApiError } from './arkClient.js';

const NO_TIMEOUT = 0;

export const VAULT_SECRET_NAME = 'LEYO_AGENT_KEY';

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

export function buildCreateEnvVaultBody(
  secretValue: string,
  nameSuffix: string = randomBytes(4).toString('hex'),
): Record<string, unknown> {
  return {
    display_name: `debug-token-${nameSuffix}`,
    type: 'environment_variable',
    config: {
      auth: {
        type: 'environment_variable',
        secret_name: VAULT_SECRET_NAME,
        secret_value: secretValue,
        networking: { type: 'unrestricted' },
      },
    },
  };
}

export async function createEnvVault(params: {
  arkApiKey: string;
  arkBaseUrl: string;
  secretValue: string;
  nameSuffix?: string;
}): Promise<{ vaultId: string }> {
  try {
    const res = await axios.post<{ id?: string }>(
      `${params.arkBaseUrl}/vaults`,
      buildCreateEnvVaultBody(params.secretValue, params.nameSuffix),
      { headers: authHeaders(params.arkApiKey), timeout: NO_TIMEOUT },
    );
    if (!res.data?.id) throw new ArkApiError('Create vault response missing id');
    return { vaultId: res.data.id };
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
