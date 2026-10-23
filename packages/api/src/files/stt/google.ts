import path from 'path';
import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';
import { logger } from '@librechat/data-schemas';
import { extractEnvVariable } from 'librechat-data-provider';
import type { TGoogleSTTConfig } from 'librechat-data-provider';
import type { AxiosRequestConfig } from 'axios';
import { getVertexMultiRegionEndpoint } from '~/endpoints/google/llm';
import { resolveConfigSecret } from '~/admin/secrets';
import { applyAxiosProxyConfig } from '~/utils/proxy';
import { getSafeErrorMetadata } from '~/utils/errors';
import { loadServiceKey } from '~/utils/key';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_LOCATION = 'global';

const locationPattern = /^[a-z0-9-]+$/;
const languageCodePattern = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
const transcriptionModelPattern = /transcribe/i;

/** General Gemini models transcribe on instruction; dedicated transcription models take no text. */
const TRANSCRIPTION_PROMPT =
  'Transcribe the speech in this audio verbatim. Reply with the transcript only, without commentary, labels or timestamps. If there is no speech, reply with nothing.';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  /** Where the Gemini API returns a transcription model's output; Agent Platform uses `text`. */
  audioTranscription?: { text?: string };
}

interface AudioTranscriptionConfig {
  languageCodes?: string[];
  customVocabulary?: string[];
  mode?: TGoogleSTTConfig['mode'];
}

interface GeminiTranscriptionBody {
  contents: Array<{ role: 'user'; parts: GeminiPart[] }>;
  generationConfig?: { audioTranscriptionConfig: AudioTranscriptionConfig };
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  promptFeedback?: { blockReason?: string };
}

interface GeminiRequest {
  url: string;
  headers: Record<string, string>;
}

export interface GoogleTranscriptionParams {
  config: TGoogleSTTConfig;
  audio: Buffer;
  mimeType: string;
  /** BCP-47 code of the spoken language; omitted or invalid leaves detection to the model. */
  language?: string;
}

/** The Agent Platform host for `location`, validated first because it becomes the hostname. */
function getVertexHost(location: string): string {
  if (!locationPattern.test(location)) {
    throw new Error(`Invalid Google STT location: ${location}`);
  }
  return getVertexMultiRegionEndpoint(location) ?? `${location}-aiplatform.googleapis.com`;
}

function buildTranscriptionBody({
  config,
  audio,
  mimeType,
  language,
}: GoogleTranscriptionParams): GeminiTranscriptionBody {
  const languageCode = language && languageCodePattern.test(language) ? language : undefined;
  const audioPart: GeminiPart = {
    inlineData: {
      mimeType: mimeType.split(';')[0].trim().toLowerCase(),
      data: audio.toString('base64'),
    },
  };

  if (!transcriptionModelPattern.test(config.model)) {
    const prompt = languageCode
      ? `${TRANSCRIPTION_PROMPT} The expected language is ${languageCode}.`
      : TRANSCRIPTION_PROMPT;
    return { contents: [{ role: 'user', parts: [{ text: prompt }, audioPart] }] };
  }

  const audioTranscriptionConfig: AudioTranscriptionConfig = {};
  if (languageCode) {
    audioTranscriptionConfig.languageCodes = [languageCode];
  }
  if (config.customVocabulary?.length) {
    audioTranscriptionConfig.customVocabulary = config.customVocabulary;
  }
  if (config.mode) {
    audioTranscriptionConfig.mode = config.mode;
  }
  return {
    contents: [{ role: 'user', parts: [audioPart] }],
    generationConfig: { audioTranscriptionConfig },
  };
}

/** Text chunks join as streamed; transcription segments are separate utterances. */
function appendPart(transcript: string, part: GeminiPart): string {
  if (part.thought) {
    return transcript;
  }
  if (part.text) {
    return transcript + part.text;
  }
  const segment = part.audioTranscription?.text;
  if (!segment) {
    return transcript;
  }
  return transcript ? `${transcript} ${segment}` : segment;
}

/** Joins the first candidate's transcript, skipping thought summaries. */
function getTranscript(data: GeminiGenerateContentResponse): string {
  const blockReason = data.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`Google STT request was blocked: ${blockReason}`);
  }
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts) {
    throw new Error('Missing data in response from the Google STT API');
  }
  return parts.reduce(appendPart, '').trim();
}

function getGeminiApiRequest(model: string, apiKey: string): GeminiRequest {
  return {
    url: `${GEMINI_API_URL}/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'x-goog-api-key': apiKey },
  };
}

/**
 * Authenticates with the configured service account, or with Application Default
 * Credentials (workload identity, `GOOGLE_APPLICATION_CREDENTIALS`) when no key file loads.
 */
async function getVertexRequest(config: TGoogleSTTConfig): Promise<GeminiRequest> {
  const location = extractEnvVariable(config.location ?? '') || DEFAULT_LOCATION;
  const host = getVertexHost(location);
  const serviceKeyPath =
    extractEnvVariable(config.serviceKeyFile ?? '') ||
    process.env.GOOGLE_SERVICE_KEY_FILE ||
    path.join(process.cwd(), 'api', 'data', 'auth.json');
  const serviceKey = await loadServiceKey(serviceKeyPath);
  const knownProjectId = extractEnvVariable(config.projectId ?? '') || serviceKey?.project_id;

  const auth = new GoogleAuth({
    scopes: CLOUD_PLATFORM_SCOPE,
    ...(serviceKey && { credentials: serviceKey }),
  });
  const [projectId, accessToken] = await Promise.all([
    knownProjectId ?? auth.getProjectId(),
    auth.getAccessToken(),
  ]);
  if (!accessToken) {
    throw new Error('Google STT could not obtain an access token');
  }

  const model = `projects/${encodeURIComponent(projectId)}/locations/${location}/publishers/google/models/${encodeURIComponent(config.model)}`;
  return {
    url: `https://${host}/v1/${model}:generateContent`,
    headers: { Authorization: `Bearer ${accessToken}` },
  };
}

/**
 * Transcribes audio with Gemini: through the Gemini API when `apiKey` is set, otherwise
 * through the Gemini Enterprise Agent Platform (Vertex AI). Dedicated transcription models
 * receive `audioTranscriptionConfig`; any other Gemini model is instructed to transcribe.
 * @returns The transcript, empty when the audio holds no speech.
 */
export async function transcribeWithGoogle(params: GoogleTranscriptionParams): Promise<string> {
  const { config } = params;
  const apiKey = resolveConfigSecret(config.apiKey);

  try {
    const { url, headers } = apiKey
      ? getGeminiApiRequest(config.model, apiKey)
      : await getVertexRequest(config);
    const options: AxiosRequestConfig = {
      headers: { 'Content-Type': 'application/json', ...headers },
      /** Inline audio travels base64-encoded and can pass axios' default 10 MB body cap. */
      maxBodyLength: Infinity,
    };
    applyAxiosProxyConfig(options, url);

    const response = await axios.post<GeminiGenerateContentResponse>(
      url,
      buildTranscriptionBody(params),
      options,
    );
    return getTranscript(response.data);
  } catch (error) {
    logger.error('[STT] Request failed for provider google:', getSafeErrorMetadata(error));
    throw error;
  }
}
