import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { STT_MODELS_DIR, TMP_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { JinnConfig } from "../shared/types.js";

const execFileAsync = promisify(execFile);

const WHISPER_CLI = "whisper-cli";
const FFMPEG = "ffmpeg";

/** Valid Whisper language codes (ISO 639-1). */
export const WHISPER_LANGUAGES: Record<string, string> = {
  en: "English", bg: "Bulgarian", de: "German", fr: "French", es: "Spanish",
  it: "Italian", pt: "Portuguese", ru: "Russian", zh: "Chinese", ja: "Japanese",
  ko: "Korean", ar: "Arabic", hi: "Hindi", tr: "Turkish", pl: "Polish",
  nl: "Dutch", sv: "Swedish", cs: "Czech", el: "Greek", ro: "Romanian",
  uk: "Ukrainian", he: "Hebrew", da: "Danish", fi: "Finnish", hu: "Hungarian",
  no: "Norwegian", sk: "Slovak", hr: "Croatian", ca: "Catalan", th: "Thai",
  vi: "Vietnamese", id: "Indonesian", ms: "Malay", tl: "Filipino", sr: "Serbian",
  lt: "Lithuanian", lv: "Latvian", sl: "Slovenian", et: "Estonian",
};

const MODEL_URLS: Record<string, string> = {
  tiny: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  "tiny.en": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
  base: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  "base.en": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  small: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  "small.en": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
  medium: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
  "medium.en": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin",
  "large-v3-turbo": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
};

const MODEL_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(MODEL_URLS).map(([k, url]) => [k, path.basename(url)]),
);

const EXPECTED_SIZES: Record<string, number> = {
  tiny: 75_000_000,
  "tiny.en": 75_000_000,
  base: 142_000_000,
  "base.en": 142_000_000,
  small: 466_000_000,
  "small.en": 466_000_000,
  medium: 1_500_000_000,
  "medium.en": 1_500_000_000,
  "large-v3-turbo": 1_500_000_000,
};

let downloading = false;
let downloadProgress = 0;

// Cached result of the last HTTP health check.
let httpSttAvailable = false;

/** Ensure models directory exists. */
export function initStt(): void {
  fs.mkdirSync(STT_MODELS_DIR, { recursive: true });
  logger.info(`STT initialized, models dir: ${STT_MODELS_DIR}`);
}

export function getModelPath(model: string): string | null {
  const filename = MODEL_FILES[model];
  if (!filename) return null;
  const filePath = path.join(STT_MODELS_DIR, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

export interface SttStatus {
  available: boolean;
  model: string | null;
  downloading: boolean;
  progress: number;
  languages: string[];
  backend: "local" | "http";
}

/**
 * Resolve the languages list from config, with backwards compat for the
 * old `language: "en"` string format.
 */
export function resolveLanguages(sttConfig?: { language?: string; languages?: string[] }): string[] {
  if (sttConfig?.languages && sttConfig.languages.length > 0) return sttConfig.languages;
  if (sttConfig?.language) return [sttConfig.language];
  return ["en"];
}

/**
 * Probe the HTTP STT server's health endpoint and cache the result.
 * Called at gateway startup and on config reload.
 */
export async function checkHttpSttHealth(url: string): Promise<void> {
  // Health endpoint is at the server root, not the versioned API path.
  // Use URL.origin so "http://host:9001/v1" probes "http://host:9001/health".
  const origin = new URL(url).origin;
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) });
    httpSttAvailable = res.ok;
    logger.info(`STT HTTP health check ${res.ok ? "OK" : "FAILED"} (${origin}/health → ${res.status})`);
  } catch (err) {
    httpSttAvailable = false;
    logger.warn(`STT HTTP health check failed (${origin}/health): ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Return true when STT is usable for the given config — accounts for both
 * backends so connector availability gates don't use the wrong check.
 */
export function isSttAvailable(sttConfig?: JinnConfig["stt"]): boolean {
  if (!sttConfig?.enabled) return false;
  if (sttConfig.backend === "http") return !!(sttConfig.url) && httpSttAvailable;
  return getModelPath(sttConfig.model || "small") !== null;
}

export function getSttStatus(sttConfig?: JinnConfig["stt"], languages?: string[]): SttStatus {
  const model = sttConfig?.model || "small";
  const backend = sttConfig?.backend ?? "local";
  const available = isSttAvailable(sttConfig);
  return {
    available,
    model: available ? model : null,
    downloading,
    progress: downloadProgress,
    languages: languages || ["en"],
    backend,
  };
}

export async function downloadModel(
  model: string,
  onProgress: (progress: number) => void,
): Promise<void> {
  if (downloading) throw new Error("Download already in progress");

  const url = MODEL_URLS[model];
  if (!url) throw new Error(`Unknown model: ${model}`);

  if (getModelPath(model)) {
    onProgress(100);
    return;
  }

  downloading = true;
  downloadProgress = 0;

  const filename = MODEL_FILES[model]!;
  const destPath = path.join(STT_MODELS_DIR, filename);
  const tmpPath = destPath + ".downloading";
  const expectedSize = EXPECTED_SIZES[model] || 466_000_000;

  try {
    fs.mkdirSync(STT_MODELS_DIR, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      const curl = spawn("curl", [
        "-L", // follow redirects
        "-o", tmpPath,
        url,
      ]);

      const progressInterval = setInterval(() => {
        try {
          const stat = fs.statSync(tmpPath, { throwIfNoEntry: false } as fs.StatSyncOptions & { throwIfNoEntry: false });
          if (stat && stat.size > 0) {
            downloadProgress = Math.min(95, Math.round(((stat.size as number) / expectedSize) * 100));
            onProgress(downloadProgress);
          }
        } catch { /* file not created yet */ }
      }, 1000);

      curl.on("close", (code) => {
        clearInterval(progressInterval);
        if (code === 0) resolve();
        else reject(new Error(`curl exited with code ${code}`));
      });

      curl.on("error", (err) => {
        clearInterval(progressInterval);
        reject(err);
      });
    });

    fs.renameSync(tmpPath, destPath);

    downloadProgress = 100;
    onProgress(100);
    logger.info(`STT model '${model}' downloaded to ${destPath}`);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  } finally {
    downloading = false;
  }
}

/**
 * Convert audio to WAV (16kHz mono PCM) using ffmpeg.
 * Required for local whisper-cli.
 */
async function convertToWav(inputPath: string): Promise<string> {
  const wavPath = inputPath.replace(/\.[^.]+$/, "") + ".wav";
  await execFileAsync(FFMPEG, [
    "-i", inputPath,
    "-ar", "16000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    "-y",
    wavPath,
  ], {
    timeout: 2 * 60 * 1000,
  });
  return wavPath;
}

/**
 * POST audio to an OpenAI-compatible STT server via multipart/form-data.
 * Builds multipart manually — avoids requiring FormData (not in ES2022 lib).
 */
async function transcribeViaHttp(
  audioPath: string,
  baseUrl: string,
  language?: string,
): Promise<string> {
  const audioData = fs.readFileSync(audioPath);
  const ext = path.extname(audioPath) || ".webm";
  const mimeType =
    ext === ".wav" ? "audio/wav" :
    ext === ".ogg" ? "audio/ogg" :
    ext === ".mp4" || ext === ".m4a" ? "audio/mp4" :
    "audio/webm";

  const boundary = `----SttBoundary${Date.now().toString(16)}`;
  const CRLF = "\r\n";

  const parts: Buffer[] = [];

  // file field
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="audio${ext}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`,
  ));
  parts.push(audioData);
  parts.push(Buffer.from(CRLF));

  // model field (whisper server accepts "whisper-1" or any value)
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="model"${CRLF}${CRLF}whisper-1${CRLF}`,
  ));

  // language field
  if (language && language !== "auto") {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="language"${CRLF}${CRLF}${language}${CRLF}`,
    ));
  }

  parts.push(Buffer.from(`--${boundary}--${CRLF}`));
  const body = Buffer.concat(parts);

  const url = baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${url}/audio/transcriptions`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
    signal: AbortSignal.timeout(5 * 60 * 1000), // 5 min — CPU STT can be slow
  });

  if (!response.ok) {
    throw new Error(`STT server returned HTTP ${response.status}: ${await response.text().catch(() => "")}`);
  }

  const result = (await response.json()) as { text?: string };
  return (result.text ?? "").trim();
}

export async function transcribe(
  audioPath: string,
  model: string,
  language?: string,
  sttConfig?: JinnConfig["stt"],
): Promise<string> {
  // HTTP backend
  if (sttConfig?.backend === "http" && sttConfig.url) {
    return transcribeViaHttp(audioPath, sttConfig.url, language);
  }

  // Local whisper-cli backend (default)
  const modelPath = getModelPath(model);
  if (!modelPath)
    throw new Error(`Model '${model}' not found. Download it first.`);

  let wavPath = audioPath;
  let needsCleanup = false;
  if (!audioPath.endsWith(".wav")) {
    wavPath = await convertToWav(audioPath);
    needsCleanup = true;
  }

  try {
    const { stdout } = await execFileAsync(WHISPER_CLI, [
      "-m", modelPath,
      "-l", language || "en",
      "--no-timestamps",
      "-f", wavPath,
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });

    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(" ")
      .trim();
  } finally {
    if (needsCleanup) {
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    }
  }
}
