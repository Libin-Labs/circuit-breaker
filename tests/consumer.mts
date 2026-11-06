import { createCircuitBreaker, CircuitOpenError, ProbeLimitError } from '@lp-labs/circuit-breaker';
import type { CircuitBreaker, BreakerSnapshot } from '@lp-labs/circuit-breaker';
const breaker: CircuitBreaker = createCircuitBreaker({
  isFailure: (error) => !(error instanceof TypeError),
});
const value: Promise<number> = breaker.execute(async () => 1);
const snapshot: BreakerSnapshot = breaker.snapshot();
void value;
void snapshot;
void CircuitOpenError;
void ProbeLimitError;
breaker.reset();
breaker.forceOpen();
// @ts-expect-error operation must be callable
breaker.execute(1);
// @ts-expect-error classifier must return boolean
createCircuitBreaker({ isFailure: () => 'yes' });
