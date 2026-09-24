import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaleObservationError } from './device.mjs';
import { parseUiAutomatorXml, UiAutomatorDevice } from './uiautomator.mjs';
import { runAgent } from './agent.mjs';

const XML = (overrides = {}) =>
  `<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="${overrides.fieldText ?? ''}" resource-id="com.example.app:id/search" class="android.widget.EditText" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="${overrides.fieldFocused ?? 'true'}" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[16,200][1064,320]" />
    <node index="1" text="Submit" resource-id="com.example.app:id/submit" class="android.widget.Button" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="${overrides.submitEnabled ?? 'true'}" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[16,400][500,520]" />
    <node index="2" text="${overrides.pwText ?? 'hunter2'}" resource-id="com.example.app:id/pw" class="android.widget.EditText" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="true" selected="false" bounds="[16,600][1064,720]" />
  </node>
</hierarchy>`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]);

function fakeUiautomator(overrides = {}) {
  const fixture = {
    ready: true,
    size: 'Physical size: 1080x2400',
    window: 'mCurrentFocus=Window{1a2b3c u0 com.example.app/.MainActivity}',
    keyboard: 'mInputShown=true',
    xml: XML(overrides),
    apps: ['package:com.example.app', 'package:com.google.android.apps.maps'],
    png: PNG,
  };
  const calls = [];
  const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false });
  const run = async (args) => {
    calls.push([...args]);
    const a = args.slice(args[0] === '-s' ? 2 : 0);
    const [cmd, ...rest] = a;
    if (cmd === 'get-state') return ok(fixture.ready ? 'device\n' : 'offline\n');
    if (cmd === 'devices')
      return ok('List of devices attached\nSERIAL1\tdevice\nSERIAL2\toffline\n\n');
    if (cmd !== 'shell') throw new Error(`unexpected adb args: ${JSON.stringify(args)}`);
    const s = rest.join(' ');
    if (s === 'wm size') return ok(`${fixture.size}\n`);
    if (s.startsWith('dumpsys window')) return ok(`${fixture.window}\n`);
    if (s.startsWith('dumpsys input_method')) return ok(`${fixture.keyboard}\n`);
    if (s.startsWith('uiautomator dump'))
      return ok('UI hierarch dumped to: /sdcard/window_dump.xml\n');
    if (s.startsWith('cat /sdcard/window_dump.xml')) return ok(fixture.xml);
    if (s.startsWith('pm list packages')) return ok(`${fixture.apps.join('\n')}\n`);
    if (s.startsWith('cmd package resolve-activity')) return ok('com.example.app/.MainActivity\n');
    if (s.startsWith('input text ')) {
      fixture.xml = XML({
        ...overrides,
        fieldText: s.slice('input text '.length).replace(/^'(.*)'$/, '$1'),
      });
      return ok('');
    }
    if (
      s.startsWith('input tap ') ||
      s.startsWith('input keyevent') ||
      s.startsWith('input swipe') ||
      s.startsWith('am start') ||
      s.includes('keyevent 67')
    )
      return ok('');
    throw new Error(`unexpected shell command: ${s}`);
  };
  const capture = async () => fixture.png;
  return { fixture, calls, device: new UiAutomatorDevice({ serial: 'SERIAL1', run, capture }) };
}

const shellCommands = (fake) =>
  fake.calls
    .filter((args) => args.slice(args[0] === '-s' ? 2 : 0)[0] === 'shell')
    .map((args) => args.slice(args[0] === '-s' ? 2 : 0)[1]);

const shells = (fake, prefix) =>
  fake.calls
    .filter((args) => args.slice(args[0] === '-s' ? 2 : 0)[0] === 'shell')
    .map((args) => args.slice(args[0] === '-s' ? 2 : 0)[1])
    .filter((s) => s.startsWith(prefix));

const allCommands = (fake) => shellCommands(fake);

test('parseUiAutomatorXml maps a nested hierarchy into a11y nodes', () => {
  const root = parseUiAutomatorXml(
    '<hierarchy rotation="0"><node index="0" text="A &amp; B" resource-id="p:id/x" class="android.widget.EditText" enabled="true" focused="true" bounds="[1,2][33,44]"><node index="0" text="kid" class="android.widget.TextView" enabled="true" bounds="[5,6][7,8]" /></node></hierarchy>',
  );
  assert.equal(root.children.length, 1);
  const node = root.children[0];
  assert.equal(node.text, 'A & B');
  assert.equal(node.className, 'android.widget.EditText');
  assert.equal(node.isEditable, true);
  assert.equal(node.isFocused, true);
  assert.deepEqual(node.boundsInScreen, { left: 1, top: 2, right: 33, bottom: 44 });
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].text, 'kid');
});

test('parseUiAutomatorXml rejects malformed input', () => {
  assert.throws(() => parseUiAutomatorXml('<hierarchy></hierarchy>'), /no nodes|not a valid/i);
  assert.throws(() => parseUiAutomatorXml('<node text="a" />'), /not a valid/i);
  assert.throws(
    () => parseUiAutomatorXml('<hierarchy rotation="0"><node text="a"></hierarchy>'),
    /missing <\/node>/,
  );
});

test('observe builds a canonical observation from adb state', async () => {
  const fake = fakeUiautomator();
  const observation = await fake.device.observe();
  assert.equal(observation.deviceId, 'SERIAL1');
  assert.deepEqual(observation.screen, { width: 1080, height: 2400 });
  assert.equal(observation.phone.packageName, 'com.example.app');
  assert.equal(observation.phone.isEditable, true);
  assert.equal(observation.phone.keyboardVisible, true);
  const search = observation.elements.find((e) => e.resourceId === 'com.example.app:id/search');
  assert.ok(search.editable && search.focused);
  assert.equal(observation.phone.inputElementId, search.id);
  const submit = observation.elements.find((e) => e.resourceId === 'com.example.app:id/submit');
  assert.ok(submit.clickable && submit.enabled);
  const pw = observation.elements.find((e) => e.resourceId === 'com.example.app:id/pw');
  assert.equal(pw.text, '[password]');
  assert.equal(pw.password, true);
});

test('observe fingerprint is stable across identical screens', async () => {
  const fake = fakeUiautomator();
  const first = await fake.device.observe();
  const second = await fake.device.observe();
  assert.equal(first.fingerprint, second.fingerprint);
});

test('assertReady and listDevices surface adb state', async () => {
  const fake = fakeUiautomator();
  await assert.doesNotReject(fake.device.assertReady());
  const devices = await fake.device.listDevices();
  assert.deepEqual(devices, [
    { id: 'SERIAL1', name: 'SERIAL1', state: 'device' },
    { id: 'SERIAL2', name: 'SERIAL2', state: 'offline' },
  ]);
  fake.fixture.ready = false;
  await assert.rejects(fake.device.assertReady(), /offline/);
});

test('listApps returns third-party packages', async () => {
  const fake = fakeUiautomator();
  const apps = await fake.device.listApps();
  assert.deepEqual(
    apps.map((a) => a.packageName),
    ['com.example.app', 'com.google.android.apps.maps'],
  );
});

test('screenshot returns the screencap PNG', async () => {
  const fake = fakeUiautomator();
  assert.deepEqual(await fake.device.screenshot(), PNG);
  fake.fixture.png = Buffer.from('not a png');
  await assert.rejects(fake.device.screenshot(), /PNG/);
});

test('act executes taps, swipes, keys, and globals through adb input', async () => {
  const fake = fakeUiautomator();
  await fake.device.act({ type: 'tap', x: 10, y: 20 });
  await fake.device.act({
    type: 'swipe',
    startX: 10,
    startY: 200,
    endX: 10,
    endY: 100,
    duration: 250,
  });
  await fake.device.act({ type: 'key', key: 'enter' });
  await fake.device.act({ type: 'global', name: 'back' });
  const input = shells(fake, 'input');
  assert.ok(input.includes('input tap 10 20'));
  assert.ok(input.some((s) => s === 'input swipe 10 200 10 100 250'));
  assert.ok(input.includes('input keyevent 66'));
  assert.ok(input.includes('input keyevent 4'));
  await fake.device.act({ type: 'open-app', packageName: 'com.example.app' });
  assert.ok(shells(fake, 'am start').some((s) => s.includes('-n com.example.app/.MainActivity')));
  await assert.rejects(
    fake.device.act({ type: 'open-app', packageName: 'com.missing.app' }),
    /installed-app list/,
  );
});

test('act resolves tap-element to the element center', async () => {
  const fake = fakeUiautomator();
  const snapshot = await fake.device.observe();
  const submit = snapshot.elements.find((e) => e.resourceId === 'com.example.app:id/submit');
  await fake.device.act({ type: 'tap-element', elementId: submit.id }, { expected: snapshot });
  // [16,400][500,520] -> (258, 460)
  assert.ok(shells(fake, 'input').includes('input tap 258 460'));
  await assert.rejects(
    (async () => {
      const disabled = fakeUiautomator({ submitEnabled: 'false' });
      const expected = await disabled.device.observe();
      const target = expected.elements.find((e) => e.resourceId === 'com.example.app:id/submit');
      return disabled.device.act({ type: 'tap-element', elementId: target.id }, { expected });
    })(),
    /Element is not actionable/,
  );
  await assert.rejects(
    fake.device.act({ type: 'tap-element', elementId: submit.id }),
    /require their original observation/,
  );
});

test('act rejects coordinates outside the screen', async () => {
  const fake = fakeUiautomator();
  await assert.rejects(fake.device.act({ type: 'tap', x: -1, y: 10 }), /outside|nonnegative/);
  await assert.rejects(
    fake.device.act({ type: 'swipe', startX: 0, startY: 0, endX: 9999, endY: 0 }),
    /outside|exits/,
  );
});

test('act rejects a stale expected observation before dispatch', async () => {
  const fake = fakeUiautomator();
  const fresh = await fake.device.observe();
  const other = fakeUiautomator({ fieldText: 'changed' }).device;
  const stale = await other.observe();
  await assert.rejects(
    fake.device.act({ type: 'tap', x: 1, y: 1 }, { expected: stale }),
    StaleObservationError,
  );
  await assert.doesNotReject(fake.device.act({ type: 'tap', x: 1, y: 1 }, { expected: fresh }));
});

test('type with clear clears by keyevents and quotes shell metacharacters', async () => {
  const fake = fakeUiautomator({ fieldText: 'old value' });
  const receipt = await fake.device.act({ type: 'type', text: `it's;rm -rf`, clear: true });
  const input = shells(fake, 'input');
  assert.ok(input.some((s) => s.startsWith('input keyevent 123;')));
  assert.ok(input.some((s) => s.includes('input keyevent 67')));
  assert.ok(
    allCommands(fake).some((s) => s === `input text 'it'\\''s;rm -rf'`),
    `quoted text: ${JSON.stringify(input)}`,
  );
  assert.ok(receipt.inputVerification);
  assert.equal(receipt.inputVerification.text, `it's;rm -rf`);
});

test('type fails when no editable input is focused', async () => {
  const fake = fakeUiautomator({ fieldFocused: 'false' });
  await assert.rejects(fake.device.act({ type: 'type', text: 'x' }), /Focus an editable field/);
});

test('long clear uses bounded repeated deletes', async () => {
  const fake = fakeUiautomator({ fieldText: 'x'.repeat(500) });
  await fake.device.act({ type: 'clear' });
  assert.ok(shells(fake, 'input').some((s) => s.includes('input keyevent --repeat 200 67')));
});

test('runAgent drives a local uiautomator loop end to end', async () => {
  const fake = fakeUiautomator({ fieldText: 'stale' });
  const policy = {
    calls: 0,
    async decide({ observation }) {
      this.calls++;
      const search = observation.elements.find((e) => e.resourceId === 'com.example.app:id/search');
      const submitted = observation.elements.some((e) => e.text === 'Order 42');
      if (this.calls === 1)
        return {
          status: 'action',
          operation: 'TAP',
          action: { type: 'tap-element', elementId: search.id },
          label: 'Focus search',
        };
      if (this.calls === 2)
        return {
          status: 'action',
          operation: 'TYPE_TEXT',
          action: { type: 'type', text: 'Order 42', clear: true },
          label: 'Type query',
        };
      if (this.calls === 3)
        return {
          status: 'action',
          operation: 'ENTER',
          action: { type: 'key', key: 'enter' },
          label: 'Submit',
        };
      if (this.calls === 4 || submitted)
        return { status: 'done', operation: 'DONE', confidence: 1 };
      return { status: 'action', operation: 'WAIT', action: { type: 'wait' } };
    },
  };
  const result = await runAgent({
    device: fake.device,
    policy,
    goal: 'find order 42',
    texts: ['Order 42'],
    execute: true,
    maxSteps: 6,
  });
  assert.equal(result.status, 'done');
  assert.equal(result.steps, 3);
  assert.ok(shells(fake, 'input').some((s) => s.startsWith('input keyevent 123;')));
  assert.ok(allCommands(fake).some((s) => s.includes("input text 'Order 42'")));
  assert.ok(shells(fake, 'input').some((s) => s === 'input keyevent 66'));
  assert.equal(policy.calls, 4);
});

test('device shell failures surface without key material', async () => {
  const fake = fakeUiautomator();
  fake.device.run = async (args) => ({
    code: 1,
    stdout: '',
    stderr: `adb: device '${args[1] ?? 'SERIAL1'}' not found`,
    timedOut: false,
  });
  await assert.rejects(fake.device.observe(), /not found/);
});
