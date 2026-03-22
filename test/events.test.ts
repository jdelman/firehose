import { describe, expect, test } from 'bun:test';

import { serializeSseEvent } from '../src/server/models/events.ts';

describe('serializeSseEvent', () => {
  test('formats event and JSON payload for SSE', () => {
    const payload = serializeSseEvent({
      type: 'system',
      data: {
        message: 'hello',
      },
    });

    expect(payload).toBe('event: system\ndata: {"message":"hello"}\n\n');
  });
});
