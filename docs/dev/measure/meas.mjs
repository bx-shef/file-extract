// Замер (#34): запускает сервис как в стенде, шлёт файлы, меряет время и пик памяти контейнера (cgroup).
// ENV: MAXC (по умолчанию 1), FILES (через запятую, имена в /w/data), REPEAT (1), CONSEC (подряд, а не вместе).
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const maxc = process.env.MAXC || '1';
const files = (process.env.FILES || 'doc-a.docx').split(',');
const key = 'measurement-key-0123456789';
const rd = (p) => { try { return Number(fs.readFileSync(p, 'utf8').trim()); } catch { return NaN; } };
const cur = () => rd('/sys/fs/cgroup/memory.current');
const mb = (n) => Math.round(n / 1048576);

const srv = spawn('node', ['--experimental-strip-types', 'src/main.ts'], {
	cwd: '/app',
	env: { ...process.env, EXTRACT_API_KEY: key, MAX_CONCURRENCY: maxc, MAX_QUEUE: '4', CACHE_DIR: '/cache', CACHE_MAX_BYTES: '201326592', PORT: '3000', HOST: '127.0.0.1' },
	stdio: ['ignore', 'inherit', 'inherit'],
});
let up = false;
for (let i = 0; i < 100 && !up; i++) {
	try { up = (await fetch('http://127.0.0.1:3000/health')).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
}
if (!up) { console.log('сервис не поднялся'); process.exit(1); }

const base = cur();
let peak = base;
const timer = setInterval(() => { const c = cur(); if (c > peak) peak = c; }, 100);

async function one(name) {
	const body = fs.readFileSync(`/w/data/${name}`);
	const t0 = Date.now();
	const res = await fetch('http://127.0.0.1:3000/v1/extract', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'x-file-name': encodeURIComponent(name) }, body });
	const text = await res.text();
	let j = {};
	try { j = JSON.parse(text); } catch { /* not json */ }
	return { name, status: res.status, ms: Date.now() - t0, chars: (j.text || '').length, pages: j.pages, ocr: j.ocr, truncated: j.truncated, code: j.error?.code || j.code };
}
const t0 = Date.now();
let results;
if (process.env.CONSEC) { results = []; for (const f of files) results.push(await one(f)); }
else results = await Promise.all(files.map(one));
const total = Date.now() - t0;
await new Promise((r) => setTimeout(r, 500));
clearInterval(timer);
console.log(JSON.stringify({ maxc, base_mb: mb(base), peak_mb: mb(peak), cgroup_peak_mb: mb(rd('/sys/fs/cgroup/memory.peak')), total_ms: total, results }));
srv.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 300));
process.exit(0);
