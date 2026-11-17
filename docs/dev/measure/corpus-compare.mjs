// Сравнение старого (ai-price-import legacy extract-text) и нового (file-extract) разбора на корпусе. Печатает только сводку.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { extractDocumentText } = await import('/old/extract-text.js');
const key = 'corpus-key-0123456789abcdef';
const srv = spawn('node', ['--experimental-strip-types', 'src/main.ts'], {
	cwd: '/app', env: { ...process.env, EXTRACT_API_KEY: key, MAX_CONCURRENCY: '1', CACHE_DIR: '/cache', PORT: '3000', HOST: '127.0.0.1' }, stdio: ['ignore', 'ignore', 'inherit'],
});
for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:3000/health')).ok) break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

const nums = (t) => new Set((t.match(/\d[\d\s.,]{2,}\d/g) || []).map((x) => x.replace(/[\s.,]/g, '')).filter((x) => x.length >= 3));
const words = (t) => new Set((t.toLowerCase().match(/[\p{L}]{4,}/gu) || []));
const taxIds = (t) => new Set((t.match(/(?<!\d)(\d{9}|\d{10}|\d{12})(?!\d)/g) || []));
const jac = (a, b) => { if (!a.size && !b.size) return 1; let i = 0; for (const x of a) if (b.has(x)) i++; return +(i / (a.size + b.size - i)).toFixed(3); };
const only = (a, b) => [...a].filter((x) => !b.has(x)).length;

for (const f of fs.readdirSync('/corpus').sort()) {
	const p = path.join('/corpus', f);
	const label = f.replace(/^(\d+)_.*(\.[^.]+)$/, '$1$2');
	let t0 = Date.now();
	const old = await extractDocumentText(p).catch((e) => ({ error: String(e) }));
	const oldMs = Date.now() - t0;
	t0 = Date.now();
	const res = await fetch('http://127.0.0.1:3000/v1/extract', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'x-file-name': encodeURIComponent(f.replace(/^\d+_/, '')) }, body: fs.readFileSync(p) });
	const j = await res.json().catch(() => ({}));
	const newMs = Date.now() - t0;
	const ot = old?.text || '', nt = j.text || '';
	const row = {
		file: label,
		old: old ? { method: old.method || 'null', chars: ot.length, ms: oldMs } : { method: 'null', chars: 0, ms: oldMs },
		new: { status: res.status, kind: j.kind, ocr: j.ocr, pages: j.pages, chars: nt.length, ms: newMs, err: j.error?.code || j.code },
		numbersJaccard: jac(nums(ot), nums(nt)), onlyOldNums: only(nums(ot), nums(nt)), onlyNewNums: only(nums(nt), nums(ot)),
		wordsJaccard: jac(words(ot), words(nt)),
		taxIds: { old: taxIds(ot).size, new: taxIds(nt).size, same: only(taxIds(ot), taxIds(nt)) === 0 && only(taxIds(nt), taxIds(ot)) === 0 },
	};
	console.log(JSON.stringify(row));
	if (process.env.DUMP) { fs.mkdirSync('/dump', { recursive: true }); fs.writeFileSync(`/dump/${label}.old.txt`, ot); fs.writeFileSync(`/dump/${label}.new.txt`, nt); }
}
srv.kill('SIGTERM');
process.exit(0);
