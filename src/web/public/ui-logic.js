/**
 * Jarvis Local AI: pure UI decisions shared by the chat and dashboard modules. No DOM access, so node:test imports it.
 * Authority: FEAT-004
 */

/** A monotonically increasing token: only the most recent `next()` caller is still `isCurrent`. */
export function createRequestGate() {
  let latest = 0;
  return {
    next: () => ++latest,
    /** Invalidates every outstanding token without starting a new request. */
    invalidate: () => void ++latest,
    isCurrent: (token) => token === latest,
  };
}

const TITLE_LIMIT = 40;

/** The sidebar title for a chat that starts with `prompt`: one line, trimmed, cut on a code point boundary. */
export function deriveSessionTitle(prompt) {
  const oneLine = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'New Conversation';
  const points = [...oneLine];
  return points.length > TITLE_LIMIT ? `${points.slice(0, TITLE_LIMIT - 1).join('').trimEnd()}…` : oneLine;
}

/**
 * Splits a batch of picked files into those that fit under the attachment cap and a count of the rest.
 * Non-image files are ignored silently (they were never attachable); only real overflow is reported.
 */
export function planImageFiles(files, currentCount, max) {
  const images = files.filter((file) => typeof file.type === 'string' && file.type.startsWith('image/'));
  const room = Math.max(0, max - currentCount);
  return { accepted: images.slice(0, room), rejectedCount: Math.max(0, images.length - room) };
}

export function attachmentLimitMessage(max, rejectedCount) {
  return `At most ${max} images per message; ${rejectedCount} not added.`;
}

const TERMINAL_TOOL_STATES = new Set(['done', 'error', 'denied']);

/**
 * Groups streamed tool frames into one chip per call. The stream carries no call id, so a `requested` frame opens
 * a new call and any later frame belongs to the newest call of that name that has not finished.
 */
export function createToolChipTracker() {
  const calls = [];
  return {
    update(tool) {
      let call = null;
      if (tool.state !== 'requested') {
        for (let i = calls.length - 1; i >= 0; i--) {
          if (calls[i].name === tool.name && !calls[i].finished) {
            call = calls[i];
            break;
          }
        }
      }
      const isNew = !call;
      if (!call) {
        call = { id: calls.length, name: tool.name, states: [], finished: false };
        calls.push(call);
      }
      if (!call.states.includes(tool.state)) call.states.push(tool.state);
      if (TERMINAL_TOOL_STATES.has(tool.state)) call.finished = true;
      const failed = tool.state === 'error' || tool.state === 'denied';
      const detail = tool.detail ? String(tool.detail) : '';
      return {
        callId: call.id,
        isNew,
        state: tool.state,
        text: `tool: ${tool.name} - ${call.states.join(' - ')}${failed && detail ? ` (${detail.slice(0, 160)})` : ''}`,
        title: detail,
      };
    },
  };
}

/** Phone card cells. A device that could not be read has no measured battery or sync time, so they read 'unknown'. */
export function deviceStatusCells(device) {
  const readable = device.connected === true;
  const battery = readable && Number.isFinite(device.batteryLevel) ? `${Math.round(device.batteryLevel)}%` : 'unknown';
  return {
    battery,
    charging: readable && typeof device.isCharging === 'boolean' ? (device.isCharging ? 'yes' : 'no') : 'unknown',
    lastSync: readable && device.lastSyncTime ? device.lastSyncTime : null,
    reason: typeof device.unavailableReason === 'string' && device.unavailableReason ? device.unavailableReason : null,
  };
}

/** True when the sidebar must be removed from the tab order and the accessibility tree. */
export function isDrawerHidden(isNarrow, isOpen) {
  return isNarrow && !isOpen;
}

/** Delay before the next automatic model-list retry: 3 s, doubling to a 30 s ceiling. */
export function modelRetryDelayMs(attempt) {
  return Math.min(30_000, 3_000 * 2 ** Math.max(0, attempt));
}
