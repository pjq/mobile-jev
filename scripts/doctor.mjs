import { execFileSync } from 'node:child_process';
import { loadEnvironment } from './env.mjs';
import { MobilerunDevice } from './mobile-agent/device.mjs';
import { UiAutomatorDevice } from './mobile-agent/uiautomator.mjs';

loadEnvironment();
const transport = process.argv[2] === 'uia' ? 'uiautomator' : 'mobilerun';
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}
check('Node.js', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node);
if (transport === 'uiautomator') {
  try {
    const output = execFileSync('adb', ['version'], { encoding: 'utf8' });
    check('adb', true, output.split('\n')[0]);
  } catch {
    check('adb', false, 'Install Android platform-tools and put adb on PATH.');
  }
  check(
    'TypeSafe API key',
    Boolean(process.env.TYPESAFE_API_KEY),
    'Presence checked; no paid inference is made by doctor.',
  );
  check(
    'adb serial',
    Boolean(process.env.ADB_SERIAL),
    'Run pnpm agent --transport uiautomator devices, then set ADB_SERIAL (or pass --device).',
  );
  if (checks.find((c) => c.name === 'adb')?.ok && process.env.ADB_SERIAL) {
    try {
      const device = new UiAutomatorDevice();
      const info = await device.assertReady();
      check('Device connection', true, `${info.id}: ${info.state}`);
      const observation = await device.observe();
      check(
        'UI observation',
        true,
        `${observation.elements.length} elements, ${observation.screen.width}×${observation.screen.height}, app ${observation.phone.packageName || 'unknown'}`,
      );
      const png = await device.screenshot();
      check('Screenshot', png.length > 1024, `${(png.length / 1024).toFixed(1)} KiB PNG`);
    } catch (error) {
      check('Device connection', false, error.message);
    }
  }
} else {
  try {
    const output = execFileSync('curl', ['--version'], { encoding: 'utf8' });
    const version = output.match(/^curl (\d+)\.(\d+)/);
    check(
      'curl',
      Boolean(version && (+version[1] > 7 || (+version[1] === 7 && +version[2] >= 70))),
      output.split('\n')[0].split(' (')[0],
    );
  } catch {
    check('curl', false, 'Install curl 7.70 or newer.');
  }
  check(
    'Mobilerun API key',
    Boolean(process.env.MOBILERUN_API_KEY || process.env.MOBILERUN_CLOUD_API_KEY),
    'Set MOBILERUN_API_KEY in .env.local.',
  );
  check(
    'TypeSafe API key',
    Boolean(process.env.TYPESAFE_API_KEY),
    'Presence checked; no paid inference is made by doctor.',
  );
  check(
    'Device ID',
    Boolean(process.env.MOBILERUN_DEVICE_ID),
    'Run pnpm devices, then set MOBILERUN_DEVICE_ID.',
  );
  if (checks.find((c) => c.name === 'Mobilerun API key')?.ok && process.env.MOBILERUN_DEVICE_ID) {
    try {
      const device = new MobilerunDevice();
      const info = await device.assertReady();
      const capabilities = await device.api(device.path('/capabilities'));
      check('Device connection', true, `${info.name || info.id}: ${info.state}`);
      check(
        'Accessibility',
        capabilities.capabilities?.accessibility === true,
        'A readable accessibility tree is required.',
      );
      const observation = await device.observe();
      check(
        'UI observation',
        true,
        `${observation.elements.length} elements, ${observation.screen.width}×${observation.screen.height}`,
      );
    } catch (error) {
      check('Device connection', false, error.message);
    }
  }
}
console.log(`Transport: ${transport}`);
for (const item of checks)
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}: ${item.detail}`);
if (checks.some((c) => !c.ok)) process.exitCode = 1;
