import { spawn } from 'node:child_process';
import { GLOBAL_ACTIONS, KEYS, assertFresh, summarizeState } from './device.mjs';
import { prepareInputVerification } from './input-verification.mjs';

// Android keycodes for the operations the Jev space offers (Mobilerun uses its own enum).
const ANDROID_KEYS = { back: 4, home: 3, recent: 187 };
const ANDROID_KEYCODES = { enter: 66, tab: 61, delete: 67, forward_delete: 112 };
// uiautomator XML has no isEditable flag; derive it the same way the Mobilerun tree does.
const EDITABLE_CLASSES = new Set([
  'android.widget.EditText',
  'android.widget.AutoCompleteTextView',
  'android.widget.MultiAutoCompleteTextView',
  'android.widget.SearchView$SearchAutoComplete',
  'android.webkit.WebView',
  'org.chromium.mywebview.AwContents',
  'com.google.android.inputmethod.latin.LatinTextView',
]);
const DUMP_FILE = '/sdcard/window_dump.xml';

export function parseUiAutomatorXml(xml) {
  if (typeof xml !== 'string' || !xml.includes('<hierarchy'))
    throw new Error('uiautomator dump output is not a valid hierarchy XML.');
  const parseNode = (from) => {
    const open = xml.indexOf('<node', from);
    if (open < 0) return null;
    const tagEnd = xml.indexOf('>', open);
    if (tagEnd < 0) throw new Error('Malformed uiautomator XML: unclosed node tag.');
    const attributes = {};
    for (const match of xml.slice(open, tagEnd).matchAll(/([\w-]+)="([^"]*)"/g)) {
      attributes[match[1]] = decodeXmlEntities(match[2]);
    }
    const selfClosing = xml[tagEnd - 1] === '/';
    const bool = (name) => attributes[name] === 'true';
    const node = {
      text: attributes.text ?? '',
      className: attributes.class ?? '',
      resourceId: attributes['resource-id'] ?? '',
      contentDescription: attributes['content-desc'] ?? '',
      hint: '', // uiautomator dump does not expose hint text
      isVisibleToUser: true, // uiautomator dump only contains nodes visible on screen
      isClickable: bool('clickable'),
      isEditable: EDITABLE_CLASSES.has(attributes.class ?? ''),
      isScrollable: bool('scrollable'),
      isEnabled: attributes.enabled !== 'false',
      isFocused: bool('focused'),
      isCheckable: bool('checkable'),
      isChecked: bool('checked'),
      isSelected: bool('selected'),
      isPassword: bool('password'),
      boundsInScreen: {},
      children: [],
    };
    const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attributes.bounds ?? '');
    if (bounds) {
      node.boundsInScreen = {
        left: +bounds[1],
        top: +bounds[2],
        right: +bounds[3],
        bottom: +bounds[4],
      };
    }
    if (selfClosing) return { node, end: tagEnd + 1 };
    const close = xml.indexOf('</node>', tagEnd);
    if (close < 0) throw new Error('Malformed uiautomator XML: missing </node>.');
    let cursor = tagEnd + 1;
    while (true) {
      const child = parseNode(cursor);
      if (!child || child.end > close) break;
      node.children.push(child.node);
      cursor = child.end;
    }
    return { node, end: close + '</node>'.length };
  };
  const root = { children: [] };
  let cursor = xml.indexOf('>', 0);
  while (cursor >= 0) {
    const child = parseNode(cursor);
    if (!child) break;
    root.children.push(child.node);
    cursor = xml.indexOf('>', child.end);
  }
  if (!root.children.length) throw new Error('uiautomator hierarchy contains no nodes.');
  return root;
}

function decodeXmlEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(+code))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Quote for the on-device shell: single quotes are bulletproof; only the quote itself escapes.
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function spawnAdb(adbPath, timeoutMs) {
  return (args) =>
    new Promise((resolve) => {
      let stdout = '',
        stderr = '',
        timedOut = false;
      const child = spawn(adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (part) => (stdout += part));
      child.stderr.on('data', (part) => (stderr += part));
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr, timedOut });
      });
    });
}

function spawnAdbCapture(adbPath, timeoutMs) {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('screencap timed out.'));
      }, timeoutMs);
      const chunks = [];
      child.stdout.on('data', (part) => chunks.push(part));
      child.stderr.on('data', () => {});
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`screencap failed: ${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`screencap failed with exit code ${code}.`));
        resolve(Buffer.concat(chunks));
      });
    });
}

// Local ADB/UiAutomator transport with the same observe/act contract as MobilerunDevice:
// observations carry full accessibility evidence, mutations are validated against a fresh
// tree before dispatch, and executed text input is re-read and confirmed locally.
export class UiAutomatorDevice {
  constructor({
    serial = process.env.ADB_SERIAL,
    adb = process.env.ADB || 'adb',
    run,
    capture,
    timeoutMs = 30_000,
  } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000)
      throw new Error('timeoutMs must be at least 1000.');
    this.serial = serial;
    this.adb = adb;
    this.timeoutMs = timeoutMs;
    this.run = run ?? spawnAdb(adb, timeoutMs);
    this.capture = capture ?? spawnAdbCapture(adb, timeoutMs);
  }

  get deviceId() {
    return this.serial || 'device';
  }

  async #runChecked(args, label) {
    const full = this.serial && args[0] !== 'devices' ? ['-s', this.serial, ...args] : args;
    const result = await this.run(full);
    if (result.timedOut) throw new Error(`${label} timed out after ${this.timeoutMs}ms.`);
    if (result.code !== 0)
      throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    return result.stdout;
  }

  #shell(command, label) {
    return this.#runChecked(['shell', command], label);
  }

  async assertReady() {
    const out = await this.#runChecked(['get-state'], 'adb get-state');
    const state = out.trim();
    if (state !== 'device')
      throw new Error(
        `Device ${this.serial || '(default)'} is in state "${state}"; connect and unlock it.`,
      );
    return { id: this.serial, name: this.serial, state: 'ready' };
  }

  async listDevices() {
    const out = await this.#runChecked(['devices'], 'adb devices');
    return out
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('*'))
      .map((line) => {
        const [id, state] = line.split(/\s+/);
        return { id, name: id, state };
      });
  }

  // Labels are package names: without an on-device agent there is no label database.
  async listApps() {
    const out = await this.#shell('pm list packages -3', 'pm list packages');
    return out
      .split('\n')
      .map((line) => line.replace(/^package:/, '').trim())
      .filter(Boolean)
      .map((packageName) => ({ id: packageName, label: packageName, packageName }));
  }

  async screenshot() {
    const png = await this.capture(
      this.serial
        ? ['-s', this.serial, 'exec-out', 'screencap', '-p']
        : ['exec-out', 'screencap', '-p'],
    );
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
      throw new Error('screencap did not return a PNG.');
    return png;
  }

  async observe() {
    const shell = (command, label) => this.#shell(command, label);
    const [sizeOut, windowOut, keyboardOut, xml] = await Promise.all([
      shell('wm size', 'wm size'),
      shell('dumpsys window windows', 'dumpsys window'),
      shell('dumpsys input_method', 'dumpsys input_method'),
      (async () => {
        await shell(`uiautomator dump ${DUMP_FILE}`, 'uiautomator dump');
        return shell(`cat ${DUMP_FILE}`, 'read uiautomator dump');
      })(),
    ]);
    const sizeLine = sizeOut
      .split('\n')
      .reverse()
      .find((line) => / size: \d+x\d+/.test(line));
    const size = /(?:Physical|Override) size: (\d+)x(\d+)/.exec(sizeLine ?? '');
    if (!size) throw new Error(`Could not read screen size from: ${sizeOut.trim() || '(empty)'}`);
    const a11y_tree = parseUiAutomatorXml(xml);
    const window = /u0\s+([a-zA-Z0-9._]+)\/[^\s}]+/.exec(windowOut);
    let isEditable = false;
    const walk = (node) => {
      if (isEditable) return;
      if (EDITABLE_CLASSES.has(node.className) && node.isFocused) isEditable = true;
      node.children.forEach(walk);
    };
    a11y_tree.children.forEach(walk);
    return summarizeState(
      {
        device_context: { screen_bounds: { width: +size[1], height: +size[2] } },
        phone_state: {
          packageName: window ? window[1] : '',
          currentApp: window ? window[1] : '',
          isEditable,
          keyboardVisible: /mInputShown=true/.test(keyboardOut),
        },
        a11y_tree,
      },
      this.deviceId,
    );
  }

  async act(action, { expected, maxAgeMs = 30_000 } = {}) {
    if (!action || typeof action !== 'object') throw new Error('An action object is required.');
    if (action.type === 'open-app') {
      if (expected && expected.deviceId !== this.deviceId)
        throw new Error('Observation belongs to a different device.');
      const installed = await this.listApps();
      if (!installed.some((app) => app.packageName === action.packageName))
        throw new Error('The app was not observed in the installed-app list.');
      const brief = await this.#shell(
        `cmd package resolve-activity --brief ${shellQuote(action.packageName)}`,
        'resolve-activity',
      );
      const component = brief
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
      if (!/^[a-zA-Z0-9._]+\/[a-zA-Z0-9._*]+$/.test(component ?? ''))
        throw new Error(`No launcher activity found for ${action.packageName}.`);
      await this.#shell(
        `am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${component}`,
        'am start',
      );
      return;
    }
    const current = await this.observe();
    if (expected) assertFresh(current, expected, action, maxAgeMs);
    const { width, height } = current.screen;
    const point = (x, y) => {
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0)
        throw new Error(`Coordinates ${x},${y} must be nonnegative integers.`);
      if (x >= width || y >= height)
        throw new Error(`Coordinates ${x},${y} are outside the ${width}x${height} screen.`);
    };
    let command;
    let inputVerification;
    switch (action.type) {
      case 'global': {
        if (
          !Object.hasOwn(GLOBAL_ACTIONS, action.name) ||
          !Object.hasOwn(ANDROID_KEYS, action.name)
        )
          throw new Error('Unsupported global action.');
        command = `input keyevent ${ANDROID_KEYS[action.name]}`;
        break;
      }
      case 'tap': {
        point(action.x, action.y);
        command = `input tap ${action.x} ${action.y}`;
        break;
      }
      case 'tap-element': {
        if (!expected) throw new Error('Element taps require their original observation.');
        const node = current.elements.find((entry) => entry.id === action.elementId);
        if (!node?.enabled || !(node.clickable || node.editable))
          throw new Error('Element is not actionable.');
        command = `input tap ${Math.floor((node.bounds.left + node.bounds.right) / 2)} ${Math.floor(
          (node.bounds.top + node.bounds.bottom) / 2,
        )}`;
        break;
      }
      case 'swipe': {
        const duration = action.duration ?? 300;
        if (!Number.isInteger(duration) || duration < 10)
          throw new Error('duration must be an integer >= 10.');
        let { startX, startY, endX, endY } = action;
        point(startX, startY);
        point(endX, endY);
        if (action.regionId && expected) {
          const before = expected.elements.find((e) => e.id === action.regionId)?.bounds;
          const after = current.elements.find((e) => e.id === action.regionId)?.bounds;
          if (!before || !after) throw new Error('Scroll region is not in the current screen.');
          // Resolve the same relative gesture in current geometry (e.g. a collapsing toolbar).
          const project = (value, oldStart, oldEnd, newStart, newEnd) => {
            const fraction = (value - oldStart) / (oldEnd - oldStart);
            if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1)
              throw new Error('Swipe leaves its observed region.');
            return Math.floor(newStart + fraction * (newEnd - newStart));
          };
          startX = project(startX, before.left, before.right, after.left, after.right);
          startY = project(startY, before.top, before.bottom, after.top, after.bottom);
          endX = project(endX, before.left, before.right, after.left, after.right);
          endY = project(endY, before.top, before.bottom, after.top, after.bottom);
          point(startX, startY);
          point(endX, endY);
        }
        command = `input swipe ${startX} ${startY} ${endX} ${endY} ${duration}`;
        break;
      }
      case 'type': {
        if (!current.phone.isEditable) throw new Error('Focus an editable field before typing.');
        if (
          typeof action.text !== 'string' ||
          (action.clear !== undefined && typeof action.clear !== 'boolean')
        )
          throw new Error('Text must be a string and clear must be boolean.');
        if (action.clear) {
          const target = current.elements.find((e) => e.id === current.phone.inputElementId);
          if (target?.editable) await this.#clearField(target);
        }
        if (action.text) {
          await this.#shell(`input text ${shellQuote(action.text)}`, 'input text');
          // The local transport can read the whole tree, which is stronger than the
          // server-side Mobilerun completion: always verify a complete replacement.
          inputVerification = prepareInputVerification(current, action);
        }
        break;
      }
      case 'clear': {
        if (!current.phone.isEditable) throw new Error('Focus an editable field before clearing.');
        const target = current.elements.find((e) => e.id === current.phone.inputElementId);
        if (target?.editable) await this.#clearField(target);
        break;
      }
      case 'key': {
        if (!Object.hasOwn(KEYS, action.key) || !Object.hasOwn(ANDROID_KEYCODES, action.key))
          throw new Error('Unsupported keyboard key.');
        command = `input keyevent ${ANDROID_KEYCODES[action.key]}`;
        break;
      }
      default:
        throw new Error('Unsupported action type.');
    }
    if (command) await this.#shell(command, command.split(' ')[0]);
    return inputVerification ? { inputVerification } : undefined;
  }

  // Replace the focused field with DELETE keyevents; the value length comes from the fresh
  // observation, never from the model. MOVE_END first so the cursor is deterministic.
  async #clearField(target) {
    const count = Math.min((target.text ?? '').length, 10_000);
    if (!count) return;
    const short = count <= 400;
    const steps = short ? count : Math.ceil(count / 200);
    const delete_ = short ? 'input keyevent 67' : 'input keyevent --repeat 200 67';
    await this.#shell(
      `input keyevent 123; for i in $(seq 1 ${steps}); do ${delete_}; done`,
      'clear field',
    );
  }
}
