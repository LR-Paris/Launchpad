// Tests for mcp-wording.js: over the connector, a fault names the issue queue.
//
//   cd backend && node test/mcp-wording.test.js
const assert = require('assert');
const { forConnector } = require('../src/mcp-wording');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); } catch (err) { failed++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}

test('a transient fault names report_issue instead of Gio', () => {
  const out = forConnector('Try again in a moment. If it keeps happening, tell Gio.');
  assert.strictEqual(out, 'Try again in a moment. If it keeps happening, log it with report_issue and carry on.');
});

test('the shop-name variant keeps the shop name', () => {
  const out = forConnector('Try again. If it keeps failing, tell Gio and include the shop name.');
  assert.strictEqual(out, 'Try again. If it keeps failing, log it with report_issue, with the shop name, and carry on.');
});

test('"Tell Gio: ..." becomes a report', () => {
  assert.strictEqual(forConnector('Tell Gio: a route is missing its shop resolver.'),
    'Log it with report_issue: a route is missing its shop resolver. Then carry on with what still works.');
});

test('the early-shop refusal points at the queue', () => {
  const out = forConnector('Send the DATABASE changes to Giovanni Lupo, who applies them by hand.');
  assert.ok(/report_issue/.test(out) && !/Giovanni/.test(out), out);
});

test('permission refusals keep their person', () => {
  const text = 'Ask Gio to turn on "can create shops" for your account in Launchpad.';
  assert.strictEqual(forConnector(text), text);
  const golive = 'Ask Giovanni Lupo or Arnaud Aubert to make the change.';
  assert.strictEqual(forConnector(golive), golive);
});

test('a resolution that is not a string passes through', () => {
  const obj = { held_by: 'x' };
  assert.strictEqual(forConnector(obj), obj);
  assert.strictEqual(forConnector(undefined), undefined);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
