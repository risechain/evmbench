import { API_BASE } from "@/lib/api"

export async function fetchModels(
  openaiKey?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const headers: Record<string, string> = {}
  if (openaiKey) {
    headers["X-OpenAI-Key"] = openaiKey
  }

  const response = await fetch(`${API_BASE}/v1/models`, {
    signal,
    cache: "no-store",
    headers,
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch models (${response.status})`)
  }

  return response.json()
}
