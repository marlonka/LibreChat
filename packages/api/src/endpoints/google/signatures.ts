import { Providers } from '@librechat/agents';
import { isAIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { TMessage } from 'librechat-data-provider';

/** The Gemini Developer API adapter keys opaque signatures by function call id. */
const functionSignaturesKey = '__gemini_function_call_thought_signatures__';

type ModelOutput = {
  additional_kwargs?: Record<string, unknown>;
  tool_calls?: ReadonlyArray<{ id?: string }>;
};

/** Capture provider metadata independently of the provider reporting token usage. */
export function collectGoogleThoughtSignatures(
  collected: Record<string, string> | null,
  output?: ModelOutput,
): void {
  if (!collected || !output?.tool_calls?.length) {
    return;
  }
  const kwargs = output.additional_kwargs;
  const byId = kwargs?.[functionSignaturesKey];
  /** Vertex exposes a positional signature array instead of a call-id map. */
  const positional = Array.isArray(kwargs?.signatures)
    ? kwargs.signatures.filter((value) => typeof value === 'string' && value !== '')
    : [];
  for (const [index, call] of output.tool_calls.entries()) {
    if (!call.id) {
      continue;
    }
    const signature =
      byId != null && typeof byId === 'object'
        ? Object.prototype.hasOwnProperty.call(byId, call.id) &&
          (byId as Record<string, unknown>)[call.id]
        : positional[index];
    if (typeof signature === 'string' && signature !== '') {
      collected[call.id] = signature;
    }
  }
}

/** Reattach signatures from the selected history row to the tool calls it produced. */
export function restoreGoogleThoughtSignatures(
  messages: readonly BaseMessage[],
  history: readonly Pick<TMessage, 'messageId' | 'isCreatedByUser' | 'metadata'>[],
  provider: string,
): void {
  if (provider !== Providers.GOOGLE && provider !== Providers.VERTEXAI) {
    return;
  }
  const signaturesByMessage = new Map<string, Record<string, unknown>>();
  for (const row of history) {
    const signatures = row.metadata?.thoughtSignatures;
    if (row.isCreatedByUser === false && signatures && typeof signatures === 'object') {
      signaturesByMessage.set(row.messageId, signatures as Record<string, unknown>);
    }
  }
  if (signaturesByMessage.size === 0) {
    return;
  }
  for (const message of messages) {
    if (!isAIMessage(message) || !message.tool_calls?.length) {
      continue;
    }
    const sourceId = message.additional_kwargs.sourceMessageId;
    const signatures = typeof sourceId === 'string' ? signaturesByMessage.get(sourceId) : undefined;
    if (!signatures) {
      continue;
    }
    const byId: Record<string, string> = Object.create(null);
    const positional = message.tool_calls.map(({ id }) => {
      const signature =
        id && Object.prototype.hasOwnProperty.call(signatures, id) ? signatures[id] : undefined;
      if (typeof signature !== 'string' || signature === '' || !id) {
        return '';
      }
      byId[id] = signature;
      return signature;
    });
    if (Object.keys(byId).length > 0) {
      if (provider === Providers.VERTEXAI) {
        message.additional_kwargs.signatures = positional;
      } else {
        message.additional_kwargs[functionSignaturesKey] = byId;
      }
    }
  }
}
