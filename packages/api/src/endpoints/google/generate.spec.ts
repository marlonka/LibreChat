import { initializeModel, Providers } from '@librechat/agents';
import { AuthKeys, ThinkingLevel } from 'librechat-data-provider';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { GoogleClientOptions } from '@librechat/agents';
import { restoreGoogleThoughtSignatures, collectGoogleThoughtSignatures } from './signatures';
import { getGoogleConfig } from './llm';

const documentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const tool = {
  type: 'function' as const,
  function: {
    name: 'lookup',
    description: 'Looks up a fictional inventory code.',
    parameters: { type: 'object', properties: {} },
  },
};

function reply(parts: object[]): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 4100,
        cachedContentTokenCount: 4096,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 8,
        totalTokenCount: 4113,
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

it('sends native Developer API media and replays a stored tool signature with XHIGH', async () => {
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      reply([{ functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'opaque-signature' }]),
    )
    .mockResolvedValueOnce(reply([{ text: 'RIVET47' }]));
  const { llmConfig } = getGoogleConfig(
    { [AuthKeys.GOOGLE_API_KEY]: 'test-key' },
    {
      modelOptions: { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.xhigh },
      streaming: false,
    },
  );
  const model = initializeModel({
    provider: Providers.GOOGLE,
    clientOptions: llmConfig as GoogleClientOptions,
    tools: [tool],
  });
  const input = [
    new SystemMessage('Use inventory codes exactly.'),
    new HumanMessage({
      content: [
        { type: 'text', text: 'Look up the attached item.' },
        { type: 'media', mimeType: documentType, data: 'aW52ZW50b3J5' },
      ],
    }),
  ];
  const first: AIMessage = await model.invoke(input);
  const bodyOf = (index: number) => JSON.parse(String(fetch.mock.calls[index]?.[1]?.body));
  expect(fetch.mock.calls[0]?.[0]).toEqual(
    expect.stringContaining('/models/gemini-4-hydrogen:generateContent'),
  );
  expect(bodyOf(0)).toMatchObject({
    systemInstruction: { parts: [{ text: 'Use inventory codes exactly.' }] },
    generationConfig: { maxOutputTokens: 65_536, thinkingConfig: { thinkingLevel: 'XHIGH' } },
    contents: [
      {
        role: 'user',
        parts: expect.arrayContaining([
          { inlineData: { mimeType: documentType, data: 'aW52ZW50b3J5' } },
        ]),
      },
    ],
  });
  expect(first.usage_metadata).toMatchObject({
    input_tokens: 4100,
    output_tokens: 13,
    input_token_details: { cache_read: 4096 },
  });

  const signatures: Record<string, string> = {};
  collectGoogleThoughtSignatures(signatures, first);
  const replay = new AIMessage({
    content: '',
    tool_calls: first.tool_calls,
    additional_kwargs: { sourceMessageId: 'assistant-1' },
  });
  restoreGoogleThoughtSignatures(
    [replay],
    [
      {
        messageId: 'assistant-1',
        isCreatedByUser: false,
        metadata: { thoughtSignatures: signatures },
      },
    ],
    Providers.GOOGLE,
  );
  const id = replay.tool_calls?.[0]?.id;
  if (!id) {
    throw new Error('Expected a provider tool call');
  }
  await expect(
    model.invoke([
      ...input,
      replay,
      new ToolMessage({ name: 'lookup', tool_call_id: id, content: 'RIVET47' }),
    ]),
  ).resolves.toMatchObject({ content: 'RIVET47' });
  expect(bodyOf(1).contents).toEqual(
    expect.arrayContaining([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'lookup', args: {}, id }, thoughtSignature: 'opaque-signature' },
        ],
      },
      {
        role: 'user',
        parts: [
          expect.objectContaining({
            functionResponse: expect.objectContaining({ name: 'lookup', id }),
          }),
        ],
      },
    ]),
  );
});
