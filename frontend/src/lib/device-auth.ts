/**
 * ChatGPT auth via codex CLI device-code flow.
 *
 * The backend runs `codex login --device-auth` and returns a verification URL
 * and user code.  The frontend polls until the user completes login in their
 * browser, then receives the auth tokens.
 */

import { API_BASE } from "@/lib/api"

export interface AuthTokens {
  auth_mode: "chatgpt"
  tokens: {
    access_token: string
    refresh_token: string
    id_token: string
    account_id?: string
  }
  [key: string]: unknown
}

export interface DeviceStartResponse {
  session_id: string
  verification_url: string
  user_code: string
}

export interface DevicePollResponse {
  status: "pending" | "complete" | "error"
  auth_tokens: Record<string, unknown> | null
  error: string | null
}

export async function startDeviceAuth(): Promise<DeviceStartResponse> {
  const response = await fetch(`${API_BASE}/v1/auth/device/start`, {
    method: "POST",
    credentials: "include",
  })

  if (!response.ok) {
    const data = await response.json().catch(() => null)
    const detail = data?.detail ?? `Failed to start device auth (${response.status})`
    throw new Error(detail)
  }

  return response.json()
}

export async function pollDeviceAuth(
  sessionId: string,
  signal?: AbortSignal,
): Promise<DevicePollResponse> {
  const response = await fetch(`${API_BASE}/v1/auth/device/${sessionId}`, {
    signal,
    cache: "no-store",
    credentials: "include",
  })

  if (!response.ok) {
    const data = await response.json().catch(() => null)
    const detail = data?.detail ?? `Failed to poll device auth (${response.status})`
    throw new Error(detail)
  }

  return response.json()
}

/** For backward compat — parse an uploaded auth.json file */
export function parseAuthJson(text: string): AuthTokens {
  const data = JSON.parse(text)

  if (data.auth_mode !== "chatgpt") {
    throw new Error("Invalid auth.json: expected auth_mode 'chatgpt'")
  }

  const tokens = data.tokens
  if (!tokens?.access_token) {
    throw new Error("Invalid auth.json: missing tokens.access_token")
  }

  return data as AuthTokens
}

export async function readAuthJsonFile(file: File): Promise<AuthTokens> {
  const text = await file.text()
  return parseAuthJson(text)
}
