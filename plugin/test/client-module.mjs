// Loads plugin/lib/client.js the way DSH's client module loader would, without a
// browser: the module must boot, request only "react", and register the sidebar
// panel plus its main view under the same id.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let boot;
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
};
const documentStub = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', style: {} }),
  head: { appendChild: () => {} },
};
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { boot = definition; } } },
  document: documentStub,
  console,
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
};
vm.runInNewContext(code, sandbox, { filename: 'client.js' });

assert.ok(boot, 'module loader boot called');
assert.equal(boot.id, 'dsh-plugin-task-notify');
const exported = boot.factory((specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`unexpected require: ${specifier}`);
});
assert.equal(typeof exported.apply, 'function');
assert.deepEqual([...exported.inject], ['slots']);

const registrations = [];
const ctx = {
  slots: {
    inject: (name, factory) => { factory(); },
    register: (definition, component) => {
      registrations.push({ definition, component });
      return () => {};
    },
  },
};
exported.apply(ctx);

assert.equal(registrations.length, 2);
const panel = registrations.find((entry) => entry.definition.name === 'sidebar.panellist');
assert.ok(panel, 'sidebar.panellist registered');
assert.equal(panel.definition.id, 'task-notify');
assert.equal(panel.definition.order, 40);
assert.equal(panel.definition.label(), '通知');
assert.equal(typeof panel.component, 'function');
const main = registrations.find((entry) => entry.definition.name === 'main');
assert.ok(main, 'main panel registered');
assert.equal(main.definition.key, 'task-notify');
assert.equal(typeof main.component, 'function');

console.log('PASS client module boots');
console.log('PASS sidebar entry and main panel registered');
