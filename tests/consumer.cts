import { createCircuitBreaker } from '@lp-labs/circuit-breaker';
const breaker = createCircuitBreaker();
const output: Promise<string> = breaker.execute(() => 'ok');
void output;
