import { getGemini4StandardRates } from '@librechat/data-schemas';
import { GEMINI_4_CONTEXT_TOKENS, getGemini4Model } from 'librechat-data-provider';
import type { TGoogleTokenConfig } from 'librechat-data-provider';
import type { EndpointTokenConfig } from '~/types';

/** Resolve per-request rates for both transaction accounting and the context-cost display. */
export function getGoogleTokenConfig(
  model: string,
  location?: string,
  configured?: TGoogleTokenConfig,
): EndpointTokenConfig[string] | undefined {
  const profile = getGemini4Model(model);
  if (!profile) {
    return undefined;
  }
  const override = configured?.[model] ?? configured?.[profile.id];
  if (override) {
    return { ...override, context: GEMINI_4_CONTEXT_TOKENS, read: override.cacheRead };
  }
  const rates = getGemini4StandardRates(profile.id, location);
  if (rates == null) {
    return undefined;
  }
  return { ...rates, context: GEMINI_4_CONTEXT_TOKENS, cacheRead: rates.read };
}
