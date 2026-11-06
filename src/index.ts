export type CircuitState = 'closed' | 'open' | 'half-open';
export interface BreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  successThreshold?: number;
  maxProbes?: number;
  isFailure?: (error: unknown) => boolean;
  clock?: () => number;
}
export interface BreakerSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  probeSuccesses: number;
  activeProbes: number;
  activeCalls: number;
  retryAt: number | null;
  remainingMs: number;
}
export interface CircuitBreaker {
  execute<T>(operation: () => T | PromiseLike<T>): Promise<T>;
  snapshot(): BreakerSnapshot;
  reset(): void;
  forceOpen(): void;
}
export class CircuitOpenError extends Error {
  constructor(readonly retryAt: number) {
    super('Circuit is open; operation was not invoked.');
    this.name = 'CircuitOpenError';
  }
}
export class ProbeLimitError extends Error {
  constructor() {
    super('Half-open probe capacity reached; operation was not invoked.');
    this.name = 'ProbeLimitError';
  }
}
function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive safe integer.`);
  return value;
}
export function createCircuitBreaker(options: BreakerOptions = {}): CircuitBreaker {
  const failureThreshold = integer(options.failureThreshold ?? 5, 'failureThreshold');
  const successThreshold = integer(options.successThreshold ?? 1, 'successThreshold');
  const maxProbes = integer(options.maxProbes ?? 1, 'maxProbes');
  const cooldown = options.cooldownMs ?? 30000;
  if (!Number.isSafeInteger(cooldown) || cooldown < 0)
    throw new RangeError('cooldownMs must be a nonnegative safe integer.');
  const clock = options.clock ?? Date.now,
    isFailure = options.isFailure ?? (() => true);
  if (typeof clock !== 'function' || typeof isFailure !== 'function')
    throw new TypeError('clock and isFailure must be functions.');
  let state: CircuitState = 'closed',
    failures = 0,
    successes = 0,
    probes = 0,
    active = 0;
  let generation = 0,
    retryAt = 0,
    lastTime = -Infinity;
  const now = (): number => {
    const time = clock();
    if (typeof time !== 'number' || !Number.isFinite(time))
      throw new TypeError('clock must return a finite number.');
    lastTime = Math.max(lastTime, time);
    return lastTime;
  };
  const change = (next: CircuitState): void => {
    const until = next === 'open' ? now() + cooldown : 0;
    if (!Number.isFinite(until)) throw new RangeError('Clock/cooldown exceeds finite time range.');
    generation++;
    state = next;
    probes = 0;
    successes = 0;
    failures = 0;
    retryAt = until;
  };
  return {
    async execute(operation) {
      if (typeof operation !== 'function') throw new TypeError('operation must be a function.');
      if (state === 'open') {
        if (now() < retryAt) throw new CircuitOpenError(retryAt);
        change('half-open');
      }
      const probing = state === 'half-open';
      if (probing && probes >= maxProbes) throw new ProbeLimitError();
      const ticket = generation;
      if (probing) probes++;
      active++;
      let failed = false,
        failure: unknown;
      let result: Awaited<ReturnType<typeof operation>>;
      try {
        result = await operation();
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        if (!failed) {
          if (ticket === generation) {
            if (probing) {
              if (++successes >= successThreshold) change('closed');
            } else failures = 0;
          }
          return result!;
        }
        if (ticket === generation) {
          let counted: boolean;
          try {
            counted = isFailure(failure);
            if (typeof counted !== 'boolean') throw new TypeError('isFailure must return boolean.');
          } catch (policyError) {
            if (probing || ++failures >= failureThreshold) change('open');
            throw new AggregateError(
              [failure, policyError],
              'Operation and failure classifier failed.',
            );
          }
          if (counted && (probing || ++failures >= failureThreshold)) change('open');
        }
        throw failure;
      } finally {
        active--;
        if (probing && ticket === generation) probes--;
      }
    },
    snapshot() {
      return {
        state,
        consecutiveFailures: failures,
        probeSuccesses: successes,
        activeProbes: probes,
        activeCalls: active,
        retryAt: state === 'open' ? retryAt : null,
        remainingMs: state === 'open' ? Math.max(0, retryAt - now()) : 0,
      };
    },
    reset() {
      change('closed');
    },
    forceOpen() {
      change('open');
    },
  };
}
