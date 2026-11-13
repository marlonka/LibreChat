import { AIMessage } from '@langchain/core/messages';
import { ContentTypes } from 'librechat-data-provider';
import { formatAgentMessages, Providers } from '@librechat/agents';
import { restoreGoogleThoughtSignatures } from './signatures';

describe('Gemini thought signature replay', () => {
  it.each([Providers.GOOGLE, Providers.VERTEXAI])(
    'restores a saved signature onto its formatted tool call for %s',
    (provider) => {
      const toolCall = {
        type: ContentTypes.TOOL_CALL,
        tool_call: { id: 'first', name: 'lookup', args: '{}', output: 'blue' },
      };
      const { messages } = formatAgentMessages([
        { messageId: 'user-1', role: 'user', content: 'Look up the color.' },
        { messageId: 'assistant-1', role: 'assistant', content: [toolCall] },
        { messageId: 'user-2', role: 'user', content: 'Check the next color.' },
      ]);
      restoreGoogleThoughtSignatures(
        messages,
        [
          {
            messageId: 'assistant-1',
            isCreatedByUser: false,
            metadata: { thoughtSignatures: { first: 'stored-signature' } },
          },
          {
            messageId: 'user-2',
            isCreatedByUser: true,
            metadata: { thoughtSignatures: { first: 'untrusted' } },
          },
        ],
        provider,
      );
      const message = messages.find((entry) => AIMessage.isInstance(entry));
      expect(message?.additional_kwargs).toMatchObject(
        provider === Providers.VERTEXAI
          ? { signatures: ['stored-signature'] }
          : { __gemini_function_call_thought_signatures__: { first: 'stored-signature' } },
      );
    },
  );

  it('preserves an unsigned sibling and scopes lookups to the source message', () => {
    const replay = new AIMessage({
      content: '',
      additional_kwargs: { sourceMessageId: 'assistant-1' },
      tool_calls: [
        { id: 'first', name: 'lookup', args: {} },
        { id: 'parallel', name: 'lookup', args: {} },
      ],
    });
    restoreGoogleThoughtSignatures(
      [replay],
      [
        {
          messageId: 'assistant-1',
          isCreatedByUser: false,
          metadata: { thoughtSignatures: { first: 'signed' } },
        },
        {
          messageId: 'assistant-2',
          isCreatedByUser: false,
          metadata: { thoughtSignatures: { parallel: 'other' } },
        },
      ],
      Providers.VERTEXAI,
    );
    expect(replay.additional_kwargs.signatures).toEqual(['signed', '']);
  });
});
