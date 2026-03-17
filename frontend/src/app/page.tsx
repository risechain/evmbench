"use client"

import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { startDeviceAuth, pollDeviceAuth, readAuthJsonFile } from "@/lib/device-auth"
import { AppFooter } from "@/components/app-footer"
import { AppHeader } from "@/components/app-header"
import { FileUploader } from "@/components/file-uploader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAuth } from "@/hooks/use-auth"
import { useLocalStorage } from "@/hooks/use-local-storage"
import { useSessionStorage } from "@/hooks/use-session-storage"
import { API_BASE } from "@/lib/api"
import { startJob } from "@/lib/jobs"
import type { AuthTokens } from "@/lib/device-auth"
import { fetchModels } from "@/lib/models"
import { addRecentJob, type RecentJob } from "@/lib/recent-jobs"
import { inferPackageName } from "@/lib/upload-utils"
import { createZipFromFiles } from "@/lib/zip"
import { useUploadStore } from "@/store/upload-store"
import openaiSmall from "../../public/openai-small.svg"
import paradigmSmall from "../../public/paradigm-small.svg"

export default function Page() {
  const router = useRouter()
  const { files, packageName, setUpload, clearUpload } = useUploadStore()
  const [openaiKey, setOpenaiKey] = useSessionStorage("evmbench.openaiKey", "")
  const [authTokens, setAuthTokens] = useState<Record<string, unknown> | null>(
    null,
  )
  const authFileRef = useRef<HTMLInputElement>(null)
  const [deviceAuthLoading, setDeviceAuthLoading] = useState(false)
  const [deviceCode, setDeviceCode] = useState<{
    session_id: string
    verification_url: string
    user_code: string
  } | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [recentJobs, setRecentJobs] = useLocalStorage<RecentJob[]>(
    "evmbench.recentJobs.v1",
    [],
  )
  const {
    isAuthorized,
    isLoading: isAuthLoading,
    isConfigLoading,
    keyPredefined,
  } = useAuth()

  // Fetch models on mount (fallback list) and re-fetch when the user enters a key
  useEffect(() => {
    const controller = new AbortController()
    const trimmed = openaiKey.trim()

    // Debounce key input so we don't hit OpenAI on every keystroke
    const delay = trimmed ? 500 : 0
    const timer = setTimeout(() => {
      // If using device auth, fetch without a key (use fallback list)
      const keyForFetch = authTokens ? undefined : trimmed || undefined
      fetchModels(keyForFetch, controller.signal)
        .then((list) => {
          setModels(list)
          setModel((prev) => (list.includes(prev) ? prev : list[0] ?? ""))
        })
        .catch(() => {})
    }, delay)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [openaiKey, authTokens])

  const handleAuthFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return
      setSubmitError(null)
      try {
        const tokens = await readAuthJsonFile(file)
        setAuthTokens(tokens)
      } catch (error) {
        setSubmitError(
          error instanceof Error ? error.message : "Invalid auth.json",
        )
      }
      event.target.value = ""
    },
    [],
  )

  const handleDeviceAuth = useCallback(async () => {
    setDeviceAuthLoading(true)
    setSubmitError(null)
    try {
      const session = await startDeviceAuth()
      setDeviceCode(session)

      // Poll for completion
      const poll = async () => {
        for (let i = 0; i < 180; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          try {
            const result = await pollDeviceAuth(session.session_id)
            if (result.status === "complete" && result.auth_tokens) {
              setAuthTokens(result.auth_tokens)
              setDeviceCode(null)
              setDeviceAuthLoading(false)
              return
            }
            if (result.status === "error") {
              setSubmitError(result.error ?? "Device auth failed")
              setDeviceCode(null)
              setDeviceAuthLoading(false)
              return
            }
          } catch {
            // Network error, keep polling
          }
        }
        setSubmitError("Device auth timed out")
        setDeviceCode(null)
        setDeviceAuthLoading(false)
      }
      poll()
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Failed to start device auth",
      )
      setDeviceAuthLoading(false)
    }
  }, [])

  const fileCount = files?.length ?? 0
  const selectedLabel = useMemo(() => {
    if (packageName) return packageName
    if (files) return inferPackageName(files)
    return null
  }, [files, packageName])

  const hasCredentials = !!openaiKey.trim() || !!authTokens || keyPredefined
  const canSubmit =
    !!files &&
    fileCount > 0 &&
    !!model &&
    hasCredentials &&
    !isSubmitting &&
    !isAuthLoading &&
    isAuthorized

  const handleFilesSelected = useCallback(
    (selected: File[]) => {
      setUpload(selected, inferPackageName(selected))
    },
    [setUpload],
  )

  const handleKeyChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setOpenaiKey(event.target.value)
    },
    [setOpenaiKey],
  )

  const handleSubmit = async () => {
    if (!files || fileCount === 0) return
    if (!isAuthorized) {
      setSubmitError("Authorize with GitHub to start analysis.")
      return
    }
    const trimmedKey = openaiKey.trim()

    setIsSubmitting(true)
    setSubmitError(null)

    try {
      const name = selectedLabel ?? "files"
      const zipFile = await createZipFromFiles(files, name)
      const response = await startJob(
        zipFile,
        model,
        trimmedKey,
        authTokens ?? undefined,
      )
      // Persist locally so users can navigate back without server-side auth/history.
      const next = addRecentJob({
        job_id: response.job_id,
        label: name,
        created_at_ms: Date.now(),
      })
      setRecentJobs(next)
      router.push(`/results?job_id=${response.job_id}`)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Upload failed")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen w-screen flex-col">
      <AppHeader showLogo={false} showBorder={false} />
      <section className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-4xl">
          <div className="mx-auto grid max-w-sm gap-10 lg:max-w-none lg:grid-cols-5">
            <div className="space-y-6 lg:col-span-3">
              <div>
                <div className="-ms-2 mb-3 flex items-center gap-2">
                  <a
                    href="https://openai.com"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Image
                      src={openaiSmall}
                      alt="OpenAI"
                      className="size-12 dark:invert"
                    />
                  </a>
                  <div className="h-9 w-px bg-border" />
                  <a
                    href="https://paradigm.xyz"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Image
                      src={paradigmSmall}
                      alt="Paradigm"
                      className="size-12 dark:invert"
                    />
                  </a>
                </div>
                <h1 className="text-5xl leading-[1.1] font-serif text-foreground mb-1.5">
                  evmbench
                </h1>
                <h2 className="text-2xl leading-[1.1] font-serif text-foreground mb-3">
                  Evaluating AI performance on high-severity contract findings
                </h2>
                <div className="space-y-2 text-base text-foreground/80">
                  <p className="leading-tight">
                    evmbench is an open benchmark from OpenAI and Paradigm that
                    evaluates whether AI agents can detect, patch, and exploit
                    high-severity vulnerabilities.
                  </p>
                  <p className="leading-tight">
                    This interface focuses on detection and only reports
                    high-severity findings. Upload a contract folder, provide an
                    API key, and start a run.
                  </p>
                  <div className="flex flex-col items-start gap-0.5">
                    <a
                      href="https://www.paradigm.xyz/2026/02/evmbench"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 font-serif leading-tight underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Read the blog post
                      <HugeiconsIcon
                        icon={ArrowUpRight01Icon}
                        strokeWidth={2}
                        className="size-3.5"
                      />
                    </a>
                    <a
                      href="https://github.com/paradigmxyz/evmbench"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 font-serif leading-tight underline-offset-4 hover:text-foreground hover:underline"
                    >
                      View the repo
                      <HugeiconsIcon
                        icon={ArrowUpRight01Icon}
                        strokeWidth={2}
                        className="size-3.5"
                      />
                    </a>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-6 lg:col-span-2">
              <FileUploader
                onFilesSelected={handleFilesSelected}
                files={files}
                selectedLabel={selectedLabel}
                fileCount={fileCount}
                disabled={isSubmitting}
                onClear={clearUpload}
              />

              <div className="grid gap-3 text-xs text-muted-foreground">
                {!isConfigLoading && !keyPredefined && (
                  <div className="grid gap-1">
                    {authTokens ? (
                      <div className="flex items-center justify-between rounded-md border px-3 py-2">
                        <span className="text-xs text-foreground">
                          Logged in with ChatGPT
                        </span>
                        <button
                          type="button"
                          onClick={() => setAuthTokens(null)}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          Disconnect
                        </button>
                      </div>
                    ) : deviceCode ? (
                      <div className="grid gap-2 rounded-md border p-3">
                        <span className="text-xs text-foreground font-medium">
                          Login with ChatGPT
                        </span>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Open the link below and enter the code:
                        </p>
                        <div className="flex items-center justify-center rounded bg-muted px-3 py-2">
                          <code className="text-lg font-mono font-bold tracking-widest text-foreground">
                            {deviceCode.user_code}
                          </code>
                        </div>
                        <a
                          href={deviceCode.verification_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-foreground underline underline-offset-2 hover:text-primary truncate"
                        >
                          {deviceCode.verification_url}
                        </a>
                        <span className="text-xs text-muted-foreground animate-pulse">
                          Waiting for login...
                        </span>
                      </div>
                    ) : (
                      <>
                        <Label
                          htmlFor="openai-key"
                          className="text-xs text-foreground"
                        >
                          OpenAI API Key
                        </Label>
                        <Input
                          id="openai-key"
                          type="password"
                          placeholder="sk-&hellip;"
                          value={openaiKey}
                          onChange={handleKeyChange}
                        />
                        <div className="flex items-center gap-2">
                          <div className="h-px flex-1 bg-border" />
                          <span className="text-xs text-muted-foreground">
                            or
                          </span>
                          <div className="h-px flex-1 bg-border" />
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleDeviceAuth}
                          disabled={deviceAuthLoading}
                          className="w-full"
                        >
                          {deviceAuthLoading
                            ? "Starting login..."
                            : "Login with ChatGPT"}
                        </Button>
                        <input
                          ref={authFileRef}
                          type="file"
                          accept=".json"
                          onChange={handleAuthFileChange}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => authFileRef.current?.click()}
                          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                        >
                          or upload auth.json
                        </button>
                      </>
                    )}
                  </div>
                )}
                <div className="grid gap-1">
                  <Label
                    htmlFor="model-select"
                    className="text-xs text-foreground"
                  >
                    Model
                  </Label>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger id="model-select" className="w-full">
                      <SelectValue placeholder="Select model" />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {!isAuthLoading && !isAuthorized && (
                  <span className="text-base font-serif text-muted-foreground">
                    <a
                      href={`${API_BASE}/v1/auth/`}
                      className="text-foreground underline underline-offset-2 hover:text-primary"
                    >
                      Authorize
                    </a>{" "}
                    to start analysis.
                  </span>
                )}
                <Button
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className="w-full uppercase"
                >
                  {isSubmitting ? "Uploading…" : "Start analysis"}
                </Button>
                {submitError && (
                  <div className="text-xs text-destructive">{submitError}</div>
                )}

                {recentJobs.length > 0 && (
                  <div className="pt-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-xs text-muted-foreground">
                        Recent runs
                      </span>
                      <button
                        type="button"
                        onClick={() => setRecentJobs([])}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        Clear
                      </button>
                    </div>
                    <div className="mt-2 space-y-1">
                      {recentJobs.slice(0, 6).map((job) => (
                        <button
                          key={job.job_id}
                          type="button"
                          onClick={() =>
                            router.push(`/results?job_id=${job.job_id}`)
                          }
                          className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/40"
                          title={job.job_id}
                        >
                          <span className="min-w-0 flex-1 truncate text-foreground">
                            {job.label}
                          </span>
                          <span className="shrink-0 font-mono text-muted-foreground">
                            {job.job_id.slice(0, 8)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
      <AppFooter showBorder={false} />
    </main>
  )
}
