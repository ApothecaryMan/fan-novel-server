import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOML_PATH = join(ROOT, 'wrangler.toml');
const BUCKET = 'fan-novel-releases';
const R2_KEY = 'releases/latest.apk';
const LIVE_VERSION_URL = 'https://fan-novel-server.mohamed1232003.workers.dev/api/v1/app/version';

function usage() {
  console.error(
    'Usage: node scripts/publish-apk.mjs <apk-file> --version <x.y.z> [--min-version <v>] [--notes "a|b"] [--notes-en "a|b"] [--fixes "a|b"] [--fixes-en "a|b"] [--changes "a|b"] [--changes-en "a|b"] [--force] [--dry-run]',
  );
  process.exit(1);
}

const VALUE_FLAGS = [
  'version',
  'min-version',
  'notes',
  'notes-en',
  'fixes',
  'fixes-en',
  'changes',
  'changes-en',
];

const positional = [];
const flags = {};
for (let i = 0; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--') && VALUE_FLAGS.includes(arg.slice(2))) {
    flags[arg.slice(2)] = process.argv[++i];
  } else if (arg === '--force' || arg === '--dry-run') {
    flags[arg.slice(2)] = true;
  } else if (i >= 2 && !arg.startsWith('-') && !arg.endsWith('.mjs')) {
    positional.push(arg);
  }
}

const apkPath = positional[0];
const version = flags.version;
if (!apkPath || !version || !existsSync(apkPath)) usage();

// var name in wrangler.toml → CLI flag that overrides it
const NOTE_VARS = {
  APP_UPDATE_NOTES: 'notes',
  APP_UPDATE_NOTES_EN: 'notes-en',
  APP_UPDATE_FIXES: 'fixes',
  APP_UPDATE_FIXES_EN: 'fixes-en',
  APP_UPDATE_CHANGES: 'changes',
  APP_UPDATE_CHANGES_EN: 'changes-en',
};

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function setTomlVar(toml, name, value) {
  const line = `${name} = "${value}"`;
  const re = new RegExp(`^${name} = ".*"$`, 'm');
  if (!re.test(toml)) throw new Error(`var ${name} not found in wrangler.toml`);
  return toml.replace(re, line);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(`command failed: ${cmd} ${args.join(' ')}`);
}

const sha256 = await sha256File(apkPath);
const size = statSync(apkPath).size;
console.log(`apk: ${apkPath} (${size} bytes)`);
console.log(`sha256: ${sha256}`);
console.log(`version: ${version}`);

let toml = readFileSync(TOML_PATH, 'utf8');
toml = setTomlVar(toml, 'APP_LATEST_VERSION', version);
toml = setTomlVar(toml, 'APP_APK_SHA256', sha256);
if (flags['min-version'] !== undefined) toml = setTomlVar(toml, 'APP_MIN_VERSION', flags['min-version']);
for (const [varName, flagName] of Object.entries(NOTE_VARS)) {
  if (flags[flagName] !== undefined) toml = setTomlVar(toml, varName, flags[flagName]);
}
if (flags.force) toml = setTomlVar(toml, 'APP_UPDATE_FORCE', 'true');

if (flags['dry-run']) {
  console.log('dry-run: wrangler.toml and R2 untouched');
  process.exit(0);
}

writeFileSync(TOML_PATH, toml);
console.log('wrangler.toml updated');

run('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${R2_KEY}`, `--file=${apkPath}`, '--content-type=application/vnd.android.package-archive', '--remote']);
run('npx', ['wrangler', 'deploy']);

const res = await fetch(LIVE_VERSION_URL);
const body = await res.json();
if (body?.data?.latestVersion !== version || body?.data?.apkSha256 !== sha256) {
  throw new Error(`live verification failed: ${JSON.stringify(body?.data)}`);
}
console.log('live verification ok: version and sha256 match');
