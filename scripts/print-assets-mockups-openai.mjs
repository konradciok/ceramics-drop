/**
 * Generate the 3 editorial/lifestyle mockups per fine-art print design through
 * the OpenAI image-edit API, using the design's own master artwork as the
 * reference image (no empty frame, no compositing). Scene prompts are the three
 * fenced `text` blocks in docs/research/the-poster-club/mockups/prompts.md;
 * per-design variation (wall, sofa, frame, props, light side) is picked
 * deterministically from the design number.
 *
 * Output: design/uploads/master-images-prints/print-{NNN}/print-{NNN}_mockup-0{1,2,3}.png
 * — exactly what `npm run print-assets:editorial` consumes. `design/` is
 * gitignored, so it lives only in the main checkout: from a git worktree the
 * script resolves the main checkout via the git common dir.
 *
 * Usage:
 *   OPENAI_API_KEY=… node scripts/print-assets-mockups-openai.mjs --product 42
 *   npm run print-assets:mockups-openai -- --range 42-57
 *   npm run print-assets:mockups-openai -- --product 42 --scene 2 --force
 *   npm run print-assets:mockups-openai -- --range 42-57 --dry-run   # print prompts, no API calls
 *
 * The generated image is a model rendition of the artwork, not a pixel copy:
 * review colours/detail against the master before shipping.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPTS_PATH = path.join(ROOT, 'docs', 'research', 'the-poster-club', 'mockups', 'prompts.md');
const MODEL = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const SIZE = '1536x2048'; // 3:4, the artwork's ratio
const SCENES = [1, 2, 3];

const VARIANTS = {
  wall1: ['warm putty-beige plaster wall', 'soft sand lime-wash wall', 'pale greige plaster wall', 'warm off-white plaster wall with a faint clay undertone', 'muted oat-coloured plaster wall'],
  frame: ['natural oak', 'natural oak', 'dark walnut', 'natural oak', 'blackened oak'],
  obj1: ['a partial sculptural white chair', 'a partial sculptural white ceramic vase', 'a partial pale stone stool', 'the edge of a linen curtain', 'a partial low ceramic floor vase'],
  light1: ['from the right', 'from the left', 'from the right', 'from the left'],
  wall2: ['muted warm grey-blue wall', 'soft sage grey-green wall', 'pale warm stone wall', 'dusty warm grey wall', 'muted powder-blue wall'],
  sofa: ['oatmeal-beige textured', 'light taupe linen', 'ivory bouclé', 'warm sand woven'],
  table: ['small polished-metal', 'small pale travertine', 'small dark-oak', 'small pale travertine'],
  stems: ['a few delicate olive stems', 'a few dried pampas stems', 'a few delicate white blossom stems', 'a few delicate eucalyptus stems'],
  tex3: ['oatmeal-beige woven', 'ivory bouclé', 'warm sand linen', 'light taupe woven'],
  diag: ['rising from lower-left to upper-right', 'rising from lower-right to upper-left'],
};

const ACCENT = 'one muted colour sampled from the artwork';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function pick(list, i, offset = 0) {
  return list[(i + offset) % list.length];
}

/** design/ is gitignored, so from a worktree it only exists in the main checkout. */
function resolveSourceRoot(override) {
  if (override) return path.resolve(override);
  const local = path.join(ROOT, 'design', 'uploads', 'master-images-prints');
  if (fs.existsSync(local)) return local;
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
  return path.join(path.dirname(common), 'design', 'uploads', 'master-images-prints');
}

function loadTemplates() {
  const blocks = [...fs.readFileSync(PROMPTS_PATH, 'utf8').matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length !== 3) fail(`Expected 3 prompt blocks in ${PROMPTS_PATH}, found ${blocks.length}`);
  return blocks;
}

export function buildPrompt(template, scene, num) {
  const i = num - 42; // variation cycle is anchored to the first design in the series
  const idx = ((i % 100) + 100) % 100;
  let p = template;
  const vars = {
    '[ARTWORK_REFERENCE]': 'artwork image',
    '[ARTWORK_ORIENTATION]': 'portrait',
    '[FRAME_TONE]': pick(VARIANTS.frame, idx, scene),
    '[MOUNT]': 'no mount',
    '[ACCENT_COLOUR]': ACCENT,
    '[OUTPUT_ASPECT_RATIO]': '3:4',
    '[VERIFIED_PRINT_SURFACE]': 'none supplied',
  };
  for (const [k, v] of Object.entries(vars)) p = p.replaceAll(k, v);
  const rep = (from, to) => {
    if (!p.includes(from)) throw new Error(`prompts.md changed: phrase not found: "${from}"`);
    p = p.replace(from, to);
  };
  if (scene === 1) {
    rep('warm putty-beige plaster wall', pick(VARIANTS.wall1, idx));
    rep('a partial sculptural white chair or ceramic object', pick(VARIANTS.obj1, idx));
    rep('from an unseen tall window', `from an unseen tall window ${pick(VARIANTS.light1, idx)}`);
  } else if (scene === 2) {
    rep('muted warm grey-blue wall', pick(VARIANTS.wall2, idx));
    rep('oatmeal-beige textured sofa', `${pick(VARIANTS.sofa, idx)} sofa`);
    rep('small polished-metal or pale travertine side table', `${pick(VARIANTS.table, idx)} side table`);
    rep(`a few delicate stems in ${ACCENT}`, `${pick(VARIANTS.stems, idx)} in ${ACCENT}`);
  } else {
    rep('oatmeal-beige woven sofa', `${pick(VARIANTS.tex3, idx)} sofa`);
    rep('in a bold diagonal composition', `in a bold diagonal composition ${pick(VARIANTS.diag, idx)}`);
  }
  return p;
}

function parseNumbers({ product, range }) {
  const nums = new Set();
  for (const part of (product ?? '').split(',').filter(Boolean)) {
    const n = Number(part.replace(/^fap0*/i, ''));
    if (!Number.isInteger(n) || n < 1) fail(`Bad --product value: ${part}`);
    nums.add(n);
  }
  if (range) {
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (!m || Number(m[1]) > Number(m[2])) fail(`Bad --range value: ${range} (expected e.g. 42-57)`);
    for (let n = Number(m[1]); n <= Number(m[2]); n++) nums.add(n);
  }
  if (nums.size === 0) fail('Pass --product <n[,n…]> and/or --range <from-to>.');
  return [...nums].sort((a, b) => a - b);
}

async function generate({ apiKey, prompt, sourceJpeg }) {
  const form = new FormData();
  form.append('model', MODEL);
  form.append('prompt', prompt);
  form.append('size', SIZE);
  form.append('quality', 'high');
  form.append('n', '1');
  form.append('image', new Blob([fs.readFileSync(sourceJpeg)], { type: 'image/jpeg' }), 'artwork.jpg');
  const res = await fetch(`${OPENAI_BASE_URL}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${body.error?.message ?? 'request failed'}`), { status: res.status });
  return Buffer.from(body.data[0].b64_json, 'base64');
}

async function main() {
  const { values } = parseArgs({
    options: {
      product: { type: 'string' },
      range: { type: 'string' },
      scene: { type: 'string' },
      'source-root': { type: 'string' },
      concurrency: { type: 'string', default: '4' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });
  const nums = parseNumbers(values);
  const scenes = values.scene ? [Number(values.scene)] : SCENES;
  if (scenes.some((s) => !SCENES.includes(s))) fail('--scene must be 1, 2 or 3');
  const concurrency = Math.max(1, Math.min(8, Number(values.concurrency) || 4));
  const sourceRoot = resolveSourceRoot(values['source-root']);
  const templates = loadTemplates();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!values['dry-run'] && !apiKey) fail('OPENAI_API_KEY is not set.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockups-'));
  const jobs = [];
  for (const num of nums) {
    const num3 = String(num).padStart(3, '0');
    const folder = path.join(sourceRoot, `print-${num3}`);
    const master = path.join(folder, `print-${num3}_30x40.jpg`);
    if (!fs.existsSync(master)) fail(`Missing master artwork: ${master}`);
    for (const scene of scenes) {
      jobs.push({ num, num3, scene, master, out: path.join(folder, `print-${num3}_mockup-0${scene}.png`) });
    }
  }

  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const label = `print-${job.num3} scene ${job.scene}`;
      if (!values.force && fs.existsSync(job.out)) { console.log(`skip  ${label} (exists)`); continue; }
      const prompt = buildPrompt(templates[job.scene - 1], job.scene, job.num);
      if (values['dry-run']) { console.log(`--- ${label} ---\n${prompt}\n`); continue; }
      const jpeg = path.join(tmpDir, `print-${job.num3}.jpg`);
      if (!fs.existsSync(jpeg)) {
        execFileSync('sips', ['-Z', '2048', '-s', 'format', 'jpeg', '-s', 'formatOptions', '95', job.master, '--out', jpeg], { stdio: 'ignore' });
      }
      let done = false;
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        try {
          fs.writeFileSync(job.out, await generate({ apiKey, prompt, sourceJpeg: jpeg }));
          console.log(`ok    ${label}`);
          done = true;
        } catch (err) {
          if (err.status === 401 || err.status === 429) { console.error(`stop  ${label}: ${err.message}`); failed++; return; }
          console.error(`retry ${label} #${attempt}: ${err.message}`);
          await new Promise((r) => setTimeout(r, 4000 * attempt));
        }
      }
      if (!done) { console.error(`FAIL  ${label}`); failed++; }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failed) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
