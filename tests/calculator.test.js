function add(a, b) {
  return a + b;
}

test('add returns sum of two numbers', () => {
  expect(add(2, 3)).toBe(5);
});

test('add with negative numbers returns correct sum', () => {
  expect(add(2, -3)).toBe(-1);
});
