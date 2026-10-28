const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const userStates = new Map();

function getNow() {
  return Date.now();
}

function resetUserState(state, now) {
  state.windowStart = now;
  state.count = 0;
  state.blockedUntil = 0;
  state.lastRequestAt = now;
}

function ensureUserState(userId, now) {
  const existing = userStates.get(userId);
  if (existing) {
    if (existing.blockedUntil && now >= existing.blockedUntil) {
      resetUserState(existing, now);
    }
    return existing;
  }

  const state = {
    userId,
    count: 0,
    windowStart: now,
    blockedUntil: 0,
    lastRequestAt: now,
  };

  userStates.set(userId, state);
  return state;
}

function checkSmsRateLimit(userId) {
  const now = getNow();
  const state = ensureUserState(userId, now);

  if (state.blockedUntil && now < state.blockedUntil) {
    return {
      allowed: false,
      userId,
      count: state.count,
      windowStart: state.windowStart,
      blockedUntil: state.blockedUntil,
      retryAfterMs: state.blockedUntil - now,
    };
  }

  if (now - state.windowStart >= WINDOW_MS) {
    resetUserState(state, now);
  }

  state.count += 1;
  state.lastRequestAt = now;

  if (state.count > MAX_ATTEMPTS) {
    state.blockedUntil = now + WINDOW_MS;
    userStates.set(userId, state);
    return {
      allowed: false,
      userId,
      count: state.count,
      windowStart: state.windowStart,
      blockedUntil: state.blockedUntil,
      retryAfterMs: WINDOW_MS,
    };
  }

  userStates.set(userId, state);
  return {
    allowed: true,
    userId,
    count: state.count,
    windowStart: state.windowStart,
    blockedUntil: state.blockedUntil,
    retryAfterMs: WINDOW_MS - (now - state.windowStart),
  };
}

module.exports = {
  checkSmsRateLimit,
  WINDOW_MS,
  MAX_ATTEMPTS,
};
