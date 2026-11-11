// audit log: one line per query, tool, provider call and turn, with timings
export function log(scope: string, msg: string) {
  console.log(`${new Date().toISOString().slice(11, 23)} [${scope}] ${msg}`);
}

// Runs fn, logs what it did and how long it took, and logs failures before rethrowing them.
export function timed<T>(scope: string, msg: string, fn: () => T): T {
  const t = performance.now();
  try {
    const r = fn();
    log(scope, `${msg} ${(performance.now() - t).toFixed(1)}ms`);
    return r;
  } catch (e) {
    log(scope, `${msg} FAILED ${(performance.now() - t).toFixed(1)}ms ${(e as Error).message}`);
    throw e;
  }
}
