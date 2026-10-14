/**
 * Jarvis Local AI: Incremental Server-Sent Events parser for the chat stream.
 * Authority: FEAT-004
 */

/**
 * Feed raw response bytes with `push()`; it returns the `data:` payloads of complete frames only.
 * Network chunks do not line up with SSE frames, so anything after the last `\n\n` stays buffered
 * for the next read, and `TextDecoder` runs with `{ stream: true }` so a multi-byte character split
 * across two chunks is decoded once both halves have arrived.
 */
export function createSseParser() {
  const decoder = new TextDecoder();
  let buffer = '';

  function drain(isFinal) {
    buffer = buffer.replace(/\r\n/g, '\n');
    const payloads = [];
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const data = frameData(buffer.slice(0, separatorIndex));
      buffer = buffer.slice(separatorIndex + 2);
      if (data !== null) payloads.push(data);
      separatorIndex = buffer.indexOf('\n\n');
    }
    if (isFinal && buffer.trim()) {
      const data = frameData(buffer);
      if (data !== null) payloads.push(data);
      buffer = '';
    }
    return payloads;
  }

  return {
    push(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      return drain(false);
    },
    end() {
      buffer += decoder.decode();
      return drain(true);
    },
  };
}

function frameData(frame) {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}
