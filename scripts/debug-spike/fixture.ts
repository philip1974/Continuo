type NestedFixture = {
  answer: number;
  inner: {
    k: string;
  };
};

function makeClosure(base: number) {
  const nested: NestedFixture = { answer: 42, inner: { k: 'v' } };
  const arr = [1, 2, 3];

  return function runClosure(extra: number) {
    const sum = arr.reduce((total, value) => total + value, base + extra);
    const checkpoint = { nested, arr, sum }; // Breakpoint target: nested, arr, and sum are assigned here.
    console.log(
      'debug-spike checkpoint',
      checkpoint.nested.answer,
      checkpoint.arr.length,
      checkpoint.sum,
    );
    return checkpoint;
  };
}

const result = makeClosure(10)(5);
console.log('debug-spike result', result.nested.inner.k, result.sum);
