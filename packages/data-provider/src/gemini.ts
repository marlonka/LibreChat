export const GEMINI_4_CONTEXT_TOKENS = 1_048_576;

const gemini4Models = {
  'gemini-4-carbon': {
    id: 'gemini-4-carbon',
    defaultThinkingLevel: 'MEDIUM',
    supportsXHigh: false,
    maxOutputTokens: 65_536,
    maxNonStreamingOutputTokens: 32_768,
  },
  'gemini-4-hydrogen': {
    id: 'gemini-4-hydrogen',
    defaultThinkingLevel: 'HIGH',
    supportsXHigh: true,
    maxOutputTokens: 65_536,
    maxNonStreamingOutputTokens: 65_536,
  },
} as const;

/** Native Gemini 4 models with a shared token window and per-request output limits. */
export function getGemini4Model(model?: string | null) {
  if (typeof model !== 'string') {
    return undefined;
  }
  const id = model
    .trim()
    .toLowerCase()
    .split('/')
    .pop()
    ?.replace(/-(?:latest|\d[\d-]*)$/, '');
  if (id === 'gemini-4-carbon' || id === 'gemini-4-hydrogen') {
    return gemini4Models[id];
  }
  return undefined;
}

/** Binary document types accepted inline by Carbon and Hydrogen on GenerateContent. */
export const gemini4OfficeMimeTypes = [
  /^application\/(msword|vnd\.ms-(?:excel|powerpoint))$/,
  /^application\/vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.(?:document|template)|presentationml\.presentation|spreadsheetml\.sheet)$/,
  /^application\/vnd\.oasis\.opendocument\.(?:text|presentation|spreadsheet)$/,
];
