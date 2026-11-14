import { once } from 'node:events';
import { createServer } from 'node:http';
import { Providers, getChatModelClass } from '@librechat/agents';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GoogleClientOptions } from '@librechat/agents';
import { getGoogleConfig } from './llm';

describe('Google reverse proxy streaming', () => {
  it('delivers text after a keepalive and closes the gateway response on Stop', async () => {
    const gateway = createServer();
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    if (address == null || typeof address === 'string') {
      throw new Error('Google test gateway has no TCP address');
    }

    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(4000)]);
    try {
      const connection = once(gateway, 'request', { signal: AbortSignal.timeout(3000) });
      const { provider, llmConfig } = getGoogleConfig(
        'test-key',
        {
          reverseProxyUrl: `http://127.0.0.1:${address.port}/gemini`,
          authHeader: true,
          modelOptions: { model: 'gemini-3-flash-preview' },
        },
        true,
      );
      expect(provider).toBe(Providers.GOOGLE);
      const Google = getChatModelClass(Providers.GOOGLE);
      const model = new Google({
        ...(llmConfig as GoogleClientOptions),
        _lc_stream_delay: 0,
      });
      const streaming = model.stream('Hello', { signal });
      void streaming.catch(() => undefined);
      const [request, response] = (await connection) as [IncomingMessage, ServerResponse];
      expect(request.url).toBe(
        '/gemini/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse',
      );
      expect(request.headers.authorization).toBe('Bearer test-key');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"candidates":[{"content":{"parts":[{"text":"First"}]}}]}\n\n');
      const stream = await streaming;
      const iterator = stream[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.text).toBe('First');
      response.write(
        ': thinking\n\ndata: {"candidates":[{"content":{"parts":[{"text":"Second"}]}}]}\n\n',
      );
      expect((await iterator.next()).value?.text).toBe('Second');
      const closed = once(response, 'close', { signal: AbortSignal.timeout(4000) });
      const pending = iterator.next();
      stop.abort();
      await expect(pending).rejects.toThrow(/abort/i);
      await closed;
    } finally {
      stop.abort();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });
});
