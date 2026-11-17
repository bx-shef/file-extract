// Генерация тестовых файлов для замеров (#34): docx ~30 стр., xlsx ~19 МБ, скан-PDF 30 стр. (только картинки).
import { execFileSync } from 'node:child_process';
import { deflateRawSync, crc32 } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const out = '/w/data';
fs.mkdirSync(out, { recursive: true });
const tmp = '/tmp/gen';
fs.mkdirSync(tmp, { recursive: true });
process.env.HOME = '/tmp/h';
fs.mkdirSync('/tmp/h', { recursive: true });

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const words = 'договор поставка оплата счёт акт сверки сделка клиент менеджер сумма срок отгрузка товар услуга склад накладная налог банк отчёт период квартал заказ позиция цена скидка'.split(' ');
const sentence = () => Array.from({ length: 12 + Math.floor(rnd() * 8) }, () => words[Math.floor(rnd() * words.length)]).join(' ');

// --- docx: HTML → Writer → docx
function html(variant) {
	let h = '<html><head><meta charset="utf-8"></head><body>';
	for (let i = 0; i < 260; i++) {
		h += `<h2>Раздел ${variant}.${i}</h2><p>${sentence()}. ${sentence()}. ${sentence()}. ${sentence()}.</p>`;
		if (i % 20 === 0) {
			h += '<table border="1">' + Array.from({ length: 8 }, () => '<tr>' + Array.from({ length: 5 }, () => `<td>${Math.floor(rnd() * 100000)}</td>`).join('') + '</tr>').join('') + '</table>';
		}
	}
	return h + '</body></html>';
}
function soffice(args) {
	execFileSync('soffice', ['--headless', '--norestore', ...args], { stdio: 'inherit', timeout: 240000 });
}
for (const v of ['a', 'b']) {
	const f = path.join(tmp, `doc-${v}.html`);
	fs.writeFileSync(f, html(v));
	soffice(['--infilter=HTML (StarWriter)', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', out, f]);
}
soffice(['--convert-to', 'pdf', '--outdir', tmp, path.join(out, 'doc-a.docx')]);

// --- скан-PDF: страницы PDF → JPEG → PDF из одних картинок
function makeScan(variant, dpi) {
	const src = path.join(tmp, `doc-${variant}.pdf`);
	if (!fs.existsSync(src)) soffice(['--convert-to', 'pdf', '--outdir', tmp, path.join(out, `doc-${variant}.docx`)]);
	const prefix = path.join(tmp, `pg-${variant}`);
	execFileSync('pdftoppm', ['-r', String(dpi), '-jpeg', '-jpegopt', 'quality=70', '-f', '1', '-l', '30', src, prefix]);
	const pages = fs.readdirSync(tmp).filter((n) => n.startsWith(`pg-${variant}-`) && n.endsWith('.jpg')).sort();
	const objs = [];
	const add = (b) => { objs.push(b); return objs.length; };
	const catalogId = 1, pagesId = 2;
	objs.push(null, null);
	const kids = [];
	for (const n of pages) {
		const jpg = fs.readFileSync(path.join(tmp, n));
		let w = 0, h = 0;
		for (let i = 2; i < jpg.length;) {
			if (jpg[i] !== 0xff) { i++; continue; }
			const m = jpg[i + 1];
			if (m >= 0xc0 && m <= 0xc3) { h = jpg.readUInt16BE(i + 5); w = jpg.readUInt16BE(i + 7); break; }
			i += 2 + jpg.readUInt16BE(i + 2);
		}
		const img = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`), jpg, Buffer.from('\nendstream')]));
		const pw = (w * 72 / dpi).toFixed(2), ph = (h * 72 / dpi).toFixed(2);
		const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
		const cont = add(Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
		kids.push(add(Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${cont} 0 R >>`)));
	}
	objs[0] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
	objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
	const parts = [Buffer.from('%PDF-1.4\n')];
	const offs = [];
	let pos = parts[0].length;
	objs.forEach((b, i) => {
		const head = Buffer.from(`${i + 1} 0 obj\n`), tail = Buffer.from('\nendobj\n');
		offs.push(pos);
		parts.push(head, b, tail);
		pos += head.length + b.length + tail.length;
	});
	let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const o of offs) xref += String(o).padStart(10, '0') + ' 00000 n \n';
	xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
	parts.push(Buffer.from(xref));
	fs.writeFileSync(path.join(out, `scan-${variant}.pdf`), Buffer.concat(parts));
	console.log(`scan-${variant}.pdf pages=${pages.length}`);
}
makeScan('a', 200);
soffice(['--convert-to', 'pdf', '--outdir', tmp, path.join(out, 'doc-b.docx')]);
makeScan('b', 200);

// --- xlsx ~19 МБ
function zip(entries) {
	const locals = [], central = [];
	let pos = 0;
	for (const [name, data] of entries) {
		const nb = Buffer.from(name), comp = deflateRawSync(data, { level: 6 }), crc = crc32(data);
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
		lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
		locals.push(lh, nb, comp);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
		ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(pos, 42);
		central.push(ch, nb);
		pos += 30 + nb.length + comp.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(pos, 16);
	return Buffer.concat([...locals, cd, end]);
}
function xlsx(variant, targetBytes) {
	const small = [
		['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
		['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
		['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Прайс" sheetId="1" r:id="rId1"/></sheets></workbook>'],
		['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
	].map(([n, s]) => [n, Buffer.from(s)]);
	const rows = [];
	let size = 0, r = 1;
	const col = 'ABCDEFGHIJKL';
	// сжатие случайных чисел ≈ 45 %: набираем XML, пока сжатый размер не дойдёт до цели
	while (size < targetBytes / 0.24) {
		let row = `<row r="${r}">`;
		for (let c = 0; c < 12; c++) {
			row += c % 4 === 0
				? `<c r="${col[c]}${r}" t="inlineStr"><is><t>${words[Math.floor(rnd() * words.length)]}${Math.floor(rnd() * 1e6)}</t></is></c>`
				: `<c r="${col[c]}${r}"><v>${(rnd() * 1e7).toFixed(4)}</v></c>`;
		}
		row += '</row>';
		rows.push(row);
		size += row.length;
		r++;
	}
	const sheet = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows.join('') + '</sheetData></worksheet>');
	const buf = zip([...small, ['xl/worksheets/sheet1.xml', sheet]]);
	fs.writeFileSync(path.join(out, `price-${variant}.xlsx`), buf);
	console.log(`price-${variant}.xlsx rows=${r - 1} bytes=${buf.length}`);
}
xlsx('a', 19_000_000);
xlsx('b', 19_000_000);
for (const n of fs.readdirSync(out)) console.log(n, fs.statSync(path.join(out, n)).size);
