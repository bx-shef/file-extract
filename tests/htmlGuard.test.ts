import { describe, expect, it } from 'vitest'
import { checkHtml, normalizeHtml, unsafeHtml } from '../src/htmlGuard.ts'
import { MAX_IMAGE_PIXELS } from '../src/imageSize.ts'
import { dataUrl, gifHeader, jpegHeader, png, pngChunk, pngHeader } from './imageFixtures.ts'

const PNG = dataUrl('image/png', png(2, 2))
const SVG_FILE = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="9" height="9"><image href="file:///etc/passwd" width="9" height="9"/></svg>'
const ms = (f: () => unknown): number => {
  const t = performance.now()
  f()
  return performance.now() - t
}
const html = (r: ReturnType<typeof checkHtml>): string => (r.ok ? r.html : `ОТКАЗ: ${r.reason}`)

describe('unsafeHtml: что можно', () => {
  it('обычное КП: таблица, стили, картинка data: и ссылка https', () => {
    expect(unsafeHtml(`<html><head><meta charset="utf-8"><style>td{border:1px solid}</style></head><body><img src="${PNG}"><a href="https://ex.by/x">сайт</a><table><tr><td>1/2</td></tr></table><p>File: прайс; macro: нет; Profile: кратко; data = 2026; action=звонок</p><table border="1" cellpadding="4" width="100%"><tr><th bgcolor="#1e3a8a">№</th><td valign="top">1</td></tr></table></body></html>`)).toBeNull()
  })
  it('образец КП из plan/kp-samples-2026-11-04', () => {
    expect(unsafeHtml('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>КП</title><style>body { font-family: "DejaVu Sans", Arial; } .items th { background: #1e3a8a; }</style></head><body><h1>Коммерческое предложение № <span class="fill">заполнить при оформлении</span></h1><table class="items"><tr><th>№</th><th class="num">Сумма</th></tr></table></body></html>')).toBeNull()
  })
  it('картинки PNG, JPEG (метки jpeg и jpg), GIF87a и GIF89a — по сигнатуре', () => {
    for (const url of [PNG, dataUrl('image/jpeg', jpegHeader(640, 480)), dataUrl('image/jpg', jpegHeader(1, 1)), dataUrl('image/gif', gifHeader(10, 10, '87a')), dataUrl('image/gif', gifHeader(10, 10, '89a')), dataUrl('IMAGE/PNG', png(1, 1)).replace('data:', 'DATA:')]) {
      expect(unsafeHtml(`<img src="${url}">`), url.slice(0, 40)).toBeNull()
    }
  })
  it('url(data:image…) в style= (двойные, одинарные кавычки и без) и в <style>', () => {
    expect(unsafeHtml(`<td style="background:url('${PNG}')">1</td>`)).toBeNull()
    expect(unsafeHtml(`<td style='background:url("${PNG}")'>1</td>`)).toBeNull()
    expect(unsafeHtml(`<td style="background:url(${PNG}) no-repeat">1</td>`)).toBeNull()
    expect(unsafeHtml(`<style>.logo { background: URL( ${PNG} ) }</style><p class="logo">x</p>`)).toBeNull()
    expect(unsafeHtml(`<td style="background:url( '${PNG}' )">1</td>`)).toBeNull()
    expect(unsafeHtml(`<td style='background:url(\n"${PNG}"\n)'>1</td>`)).toBeNull()
  })
  it('ссылки принимаются при любой схеме: они собираются текстом, href до LibreOffice не доходит', () => {
    for (const href of ['https://ex.by/?a=1&amp;b=2', 'HTTPS://EX.BY/', 'mailto:a@ex.by', '#top', ' https://ex.by/', 'http://169.254.169.254/', 'javascript:alert(1)', 'file:///etc/passwd', 'vnd.sun.star.script:x', 'macro:x', '.uno:Open', 'a.html', '', '&#106;avascript:x']) {
      expect(unsafeHtml(`<a href="${href}">x</a>`), href).toBeNull()
    }
  })
  it('<meta charset="utf-8"> в любой записи', () => {
    for (const m of ['<meta charset="utf-8">', "<meta charset='UTF-8' />", '<meta charset=utf-8>', '<META  CHARSET = "Utf-8"  >', '<meta charset="&#117;tf-8">']) {
      expect(unsafeHtml(`<head>${m}</head>`), m).toBeNull()
    }
  })
  it('теги, лишь начинающиеся с запрещённого имени (basefont, formatted…), — можно', () => {
    expect(unsafeHtml('<basefont size=3><formatted>x</formatted><objects/><importance>x</importance><linker>y</linker><scripture>z</scripture>')).toBeNull()
  })
  it('«<», «&lt;» и слова file:, macro:, data в тексте — текст, не отказ', () => {
    expect(unsafeHtml('<p>1 < 2, 5<6, a &lt; b, &gt;, 3 </p><p>file:///etc, macro:x, data:</p>')).toBeNull()
  })
})

describe('unsafeHtml: что нельзя', () => {
  it('локальные файлы, вложенные документы, скрипты, команды LibreOffice', () => {
    for (const bad of ['<img src="file:///etc/passwd">', '<iframe src="x">', '<object data="a">', '<link rel=stylesheet href="s.css">', '<script>x</script>', '<style>@import "a.css"</style>', '<div style="background:url(file:///etc/x)">', '<div style="background:URL(file:///etc/x)">', '<div style="background:Url( file:///etc/x )">', '<img src="/etc/hosts">', '<img src=../../app/src/config.ts>', '<meta http-equiv="refresh" content="0">', '<base href="/">', '<img src="&#x66;ile:&#x2F;&#x2F;&#x2F;etc&#x2F;passwd">', '<div style="background:url(\\66 ile:///etc/x)">', '<style>@\\69mport "a.css"</style>', '<meta charset="utf-7">', '<svg><image href="x"/></svg>', '<img src="https://ex.by/a.png">', '<img src="C:\\x.png">', '<td background="x.png">']) {
      expect(unsafeHtml(bad), bad).not.toBeNull()
    }
  })
  it('каждый из тегов вложенного документа, формы и скрипта', () => {
    for (const tag of ['iframe', 'object', 'embed', 'frame', 'frameset', 'applet', 'link', 'base', 'script', 'svg', 'math', 'form', 'input', 'isindex', 'xml', 'import']) {
      expect(unsafeHtml(`<p>x</p><${tag.toUpperCase()}>`), tag).toMatch(/вложенный документ/)
      expect(unsafeHtml(`<p>x</p><${tag} src=x>`), tag).toMatch(/вложенный документ/)
      expect(unsafeHtml(`<p>x</p><${tag}/>`), tag).toMatch(/вложенный документ/)
    }
  })
  it('«<» с пробелом или переносом перед именем запрещённого тега — тоже отказ (с запасом)', () => {
    for (const bad of ['< iframe src=x>', '<\niframe>', '<\t script>']) expect(unsafeHtml(bad), bad).toMatch(/вложенный документ/)
  })
  it('каждый из атрибутов-адресов: на любом теге — только data:image', () => {
    for (const attr of ['src', 'lowsrc', 'dynsrc', 'background', 'poster', 'data', 'codebase', 'longdesc', 'usemap', 'action', 'formaction', 'xlink:href']) {
      expect(unsafeHtml(`<p ${attr}="x.png">x</p>`), attr).toMatch(new RegExp(`^${attr}: `))
      expect(unsafeHtml(`<p ${attr.toUpperCase()}=x.png>x</p>`), attr).not.toBeNull()
      expect(unsafeHtml(`<p ${attr}="${PNG}">x</p>`), attr).toBeNull()
    }
  })
  it('обход через «>» внутри значения в кавычках: img src, td background (в a — см. «ссылки — текстом»)', () => {
    for (const bad of ['<img alt=">" src="file:///etc/passwd">', '<td title=">" background="file:///etc/passwd">', "<img alt='>' src='file:///etc/passwd'>", '<img alt=">>>" title=">" src=file:///etc/passwd>', '<p title=">" data="file:///etc/passwd">', '<video poster=">" title=">" src="file:///etc/passwd">']) {
      expect(unsafeHtml(bad), bad).not.toBeNull()
    }
  })
  it('обход записью тега: слэш вместо пробела, переносы, регистр, без кавычек', () => {
    for (const bad of ['<img/src="file:///etc/passwd">', '<img\nsrc\n=\n"file:///etc/passwd">', '<IMG SRC=file:///etc/passwd>', '<img alt="1"/background=file:///etc/passwd>', '<img src = \'file:///etc/passwd\'/>']) {
      expect(unsafeHtml(bad), bad).not.toBeNull()
    }
  })
  it('обход через комментарии: --!>, <!-->, <!--->', () => {
    for (const bad of ['<!-- x --!><img src="file:///etc/passwd">', '<!--><img src="file:///etc/passwd">', '<!---><img src="file:///etc/passwd">', '<!-- -- --><img src="file:///etc/passwd">']) {
      expect(unsafeHtml(bad), bad).not.toBeNull()
    }
  })
  it('теги внутри textarea, title, noscript LibreOffice читает как разметку — проверяются', () => {
    for (const tag of ['textarea', 'title', 'noscript', 'xmp', 'plaintext']) {
      expect(unsafeHtml(`<${tag}><img src="file:///etc/passwd"></${tag}>`), tag).not.toBeNull()
    }
  })
  it('<meta> кроме charset="utf-8": любой другой набор атрибутов — отказ', () => {
    for (const m of ['<meta>', '<meta charset>', '<meta charset="">', '<meta charset=" utf-8">', '<meta name="viewport">', '<meta content="utf-8">', '<meta charset="utf-8" charset="utf-8">', '<meta charset="utf-8" name=x>', '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">', '<meta charset="cp1251">']) {
      expect(unsafeHtml(m), m).toMatch(/^тег meta/)
    }
  })
  it('необычные имена тегов и атрибутов — отказ с причиной', () => {
    for (const bad of ['<a"b>', '<scr<!--x-->ipt>x</scr<!--x-->ipt>', '<im<g src=x>', '</p"x>', '<p x"y="1">', '<p =x>', '<p a\'b=1>', '<p \u043a\u043b=1>']) {
      expect(unsafeHtml(bad), bad).toMatch(/^недопустимое имя (тега|атрибута)$/)
    }
  })
  it('незакрытые теги, кавычки, комментарии — отказ с причиной', () => {
    for (const bad of ['<p a=b c', '<img src="x', '<p', '<p class="a', '<p class=', '<p class= ', '<!-- x', '<!--', '<!x', '<?x', '</p', '</ x', '<!doctype html']) {
      expect(unsafeHtml(bad), bad).toMatch(/^не закрыт тег, комментарий или кавычка$/)
    }
  })
  it('управляющие знаки не склеивают запрещённое: <scr\\0ipt>, fi\\0le:', () => {
    expect(unsafeHtml('<scr\u0000ipt>x</script>')).toMatch(/вложенный документ/)
    expect(unsafeHtml('<img src="fi\u0000le:///etc/passwd">')).not.toBeNull()
    expect(unsafeHtml('<p style="background:u\u0001rl(file:///etc/x)">')).not.toBeNull()
  })
  it('<style>: «<» внутри (кроме <!--) — отказ, в том числе </styleX> и закрытие без пробела', () => {
    for (const bad of ['<style>a<b>c</style>', '<style>a{}</styleX><img src="file:///etc/passwd"></style>', '<style>a{} <img src="file:///etc/passwd"></style>', '<style>a{}<style>b{}</style>', '<style>a{} </style']) {
      expect(unsafeHtml(bad), bad).toMatch(/<style>/)
    }
  })
  it('запрещённое, спрятанное сущностями: &lt;iframe&gt;, @import через &commat;, &amp; и &num;', () => {
    expect(unsafeHtml('<p>&lt;iframe src=x&gt;</p>')).toMatch(/вложенный документ/)
    expect(unsafeHtml('<style>&commat;import "a.css"</style>')).toMatch(/@import/)
    expect(unsafeHtml('<style>@IMPORT "a.css"</style>')).toMatch(/@import/)
    expect(unsafeHtml('<style>@Import url(a.css)</style>')).not.toBeNull()
    expect(unsafeHtml('<style>&amp;commat;import "a.css"</style>')).toMatch(/@import/)
    expect(unsafeHtml('<style>&&num;x40;import "a.css"</style>')).toMatch(/@import/)
    expect(unsafeHtml('<style>&amp;amp;#x40;import "a.css"</style>')).toMatch(/@import/)
  })
  it('url() в стиле, записанный сущностями или экранами, — отказ (LibreOffice прочтёт его иначе)', () => {
    for (const bad of ['<p style="background:&bsol;75rl(file:///etc/x)">', '<p style="background:url&lpar;file:///etc/x)">', '<p style="background:url&Tab;(file:///etc/x)">', '<p style="background:url&NewLine;(file:///etc/x)">', `<p style="background:url(&quot;${PNG}&quot;)">`, `<p style="background:u&#114;l(${PNG})">`, `<p style="background:url(${PNG.replace('base64,', 'base64,&#x41;')})">`]) {
      expect(unsafeHtml(bad), bad).toMatch(/сущностями или CSS-экранами|url\(\) в стиле/)
    }
  })
})

describe('unsafeHtml: картинки data: проверяются по содержимому', () => {
  const img = (src: string): string | null => unsafeHtml(`<img src="${src}">`)
  const css = (src: string): string | null => unsafeHtml(`<p style="background:url('${src}')">x</p>`)

  it('svg: под своей меткой, под меткой png и jpeg, text/html — отказ (svg ссылается на локальные файлы)', () => {
    for (const url of [dataUrl('image/svg+xml', SVG_FILE), dataUrl('image/png', SVG_FILE), dataUrl('image/jpeg', SVG_FILE), dataUrl('image/gif', SVG_FILE), dataUrl('text/html', '<html><img src="file:///etc/passwd"></html>'), dataUrl('image/png', ' \n' + SVG_FILE), dataUrl('image/png', '\u00ef\u00bb\u00bf' + SVG_FILE)]) {
      expect(img(url), url.slice(0, 40)).toMatch(/PNG, JPEG или GIF|data:image/)
      expect(css(url), url.slice(0, 40)).toMatch(/^url\(\) в стиле: /)
    }
  })
  it('svg в gzip, PDF, WebP, BMP, TIFF, WMF — отказ: формат только PNG, JPEG, GIF', () => {
    const others = [Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]), Buffer.from('%PDF-1.7 x'), Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'), Buffer.from('BM' + '\u0000'.repeat(40), 'latin1'), Buffer.from('II*\u0000' + '\u0000'.repeat(40), 'latin1'), Buffer.from([0xd7, 0xcd, 0xc6, 0x9a, 0, 0, 0, 0, 0, 0, 0, 0])]
    for (const b of others) expect(img(dataUrl('image/png', b)), b.toString('latin1', 0, 4)).toMatch(/PNG, JPEG или GIF/)
  })
  it('метка не png/jpeg/gif — отказ, даже если внутри настоящий PNG', () => {
    for (const mime of ['image/svg+xml', 'image/webp', 'image/bmp', 'image/tiff', 'image/x-icon', 'text/plain', 'application/octet-stream', 'image/pngx', 'image/png;charset=utf-8']) {
      expect(img(dataUrl(mime, png(2, 2))), mime).toMatch(/data:image\/png/)
    }
  })
  it('запись адреса: только ;base64, и чистый base64 (LibreOffice терпит мусор, проверка — нет)', () => {
    const head = pngHeader(5, 5) // 45 байт: base64 без «=»
    const padded = Buffer.concat([head, Buffer.from([0])]).toString('base64') // 46 байт: «==» в конце
    const plus = Buffer.concat([head, Buffer.from([0xfb, 0xef, 0xbe])]).toString('base64') // «++++» в конце
    expect(padded.endsWith('==')).toBe(true)
    expect(plus.endsWith('++++')).toBe(true)
    const clean = head.toString('base64')
    expect(img(`data:image/png;base64,${clean}`)).toBeNull()
    expect(img(`data:image/png;base64,${padded}`)).toBeNull()
    expect(img(`data:image/png;base64,${plus}`)).toBeNull()
    const bad = [
      `data:image/png,${encodeURIComponent(head.toString('latin1'))}`,
      `data:image/png;charset=utf-8;base64,${clean}`,
      `data:image/png;base64,${clean.slice(0, 30)} ${clean.slice(30)}`,
      `data:image/png;base64,${clean.slice(0, 30)}\n${clean.slice(30)}`,
      `data:image/png;base64,${clean.slice(0, 30)}!${clean.slice(30)}`,
      `data:image/png;base64,${clean.slice(0, 20)}\r\n\r\n${clean.slice(20)}`, // 4 знака: длина по-прежнему кратна 4
      `data:image/png;base64,${clean.slice(0, 20)}    ${clean.slice(20)}`,
      `data:image/png;base64,${clean.slice(0, 20)}\t\t\t\t${clean.slice(20)}`,
      `data:image/png;base64,${padded.replace(/=+$/, '')}`,
      `data:image/png;base64,${padded}AAAA`,
      `data:image/png;base64,${clean}====`,
      `data:image/png;base64,${padded.slice(0, -1)}`,
      `data:image/png;base64,${plus.replaceAll('+', '-')}`,
      `data:image/png;base64,${plus.replaceAll('+', '_')}`,
      'data:image/png;base64,',
      'data:image/png;base64,====',
      ` data:image/png;base64,${clean}`,
      `data:image/png;base64,${clean} `
    ]
    for (const url of bad) expect(img(url), url.slice(0, 60)).not.toBeNull()
  })
  it('повреждённый base64 (длина не кратна 4) назван своим отказом', () => {
    expect(img('data:image/png;base64,iVBORw0KGgoAAAA')).toMatch(/base64 картинки повреждён/)
  })
  it('PNG: первый чанк обязан быть IHDR; короткий, без сигнатуры, нулевые размеры — отказ', () => {
    const sig = png(2, 2).subarray(0, 8)
    const ihdr = png(2, 2).subarray(8, 33)
    const firstText = Buffer.concat([sig, pngChunk('tEXt', Buffer.from('k\u0000v')), ihdr])
    const dims = Buffer.alloc(13)
    dims.writeUInt32BE(5, 0)
    dims.writeUInt32BE(5, 4)
    const shortIhdr = Buffer.concat([sig, pngChunk('IHDR', dims.subarray(0, 12))]) // длина чанка 12, а не 13
    const wrongType = Buffer.concat([sig, pngChunk('IHDX', dims)]) // длина 13, тип не IHDR
    for (const b of [firstText, shortIhdr, wrongType, sig, Buffer.concat([sig, ihdr.subarray(0, 10)]), pngHeader(0, 5), pngHeader(5, 0), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]), ihdr])]) {
      expect(img(dataUrl('image/png', b)), b.toString('hex').slice(0, 40)).not.toBeNull()
    }
    expect(img(dataUrl('image/png', pngHeader(5, 5)))).toBeNull()
  })
  it('JPEG: без SOF, с нулевыми размерами и с сигнатурой не из трёх байт — отказ', () => {
    const noSof = Buffer.concat([jpegHeader(5, 5).subarray(0, 20), Buffer.from([0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])])
    const twoBytes = jpegHeader(5, 5)
    twoBytes[2] = 0x00
    for (const b of [noSof, jpegHeader(0, 5), jpegHeader(5, 0), twoBytes, Buffer.from([0xff, 0xd8])]) {
      expect(img(dataUrl('image/jpeg', b)), b.toString('hex').slice(0, 40)).not.toBeNull()
    }
  })
  it('GIF: только GIF87a и GIF89a, заголовок целиком, размеры ненулевые', () => {
    for (const b of [gifHeader(5, 5, '88a'), gifHeader(0, 5), gifHeader(5, 0), gifHeader(5, 5).subarray(0, 9), Buffer.from('GIF8')]) {
      expect(img(dataUrl('image/gif', b)), b.toString('latin1', 0, 8)).not.toBeNull()
    }
    expect(img(dataUrl('image/gif', gifHeader(5, 5).subarray(0, 10)))).toBeNull()
  })
  it('огромные размеры в заголовке: PNG, JPEG, GIF — отказ до LibreOffice', () => {
    for (const b of [pngHeader(100_000, 100_000), pngHeader(0xffffffff, 0xffffffff), pngHeader(2 ** 31, 1), jpegHeader(65_535, 65_535), gifHeader(65_535, 65_535)]) {
      expect(img(dataUrl('image/png', b)), b.toString('hex').slice(0, 40)).toMatch(/больше 50000000 пикселей/)
      expect(css(dataUrl('image/png', b)), b.toString('hex').slice(0, 40)).toMatch(/больше 50000000 пикселей/)
    }
  })
  it('потолок — MAX_IMAGE_PIXELS, как в разборе OCR: ровно на нём проходит, на пиксель больше — отказ', () => {
    expect(MAX_IMAGE_PIXELS).toBe(50_000_000)
    expect(img(dataUrl('image/png', pngHeader(5_000, 10_000)))).toBeNull()
    expect(img(dataUrl('image/png', pngHeader(10_000, 5_000)))).toBeNull()
    expect(img(dataUrl('image/png', pngHeader(5_000, 10_001)))).toMatch(/пикселей/)
    expect(img(dataUrl('image/png', pngHeader(50_000_001, 1)))).toMatch(/пикселей/)
    expect(img(dataUrl('image/png', pngHeader(50_000_000, 1)))).toBeNull()
  })
  it('потолок по JPEG и GIF: размеры читаются из своих полей', () => {
    expect(img(dataUrl('image/jpeg', jpegHeader(65_535, 762)))).toBeNull() // 49 937 670
    expect(img(dataUrl('image/jpeg', jpegHeader(65_535, 763)))).toMatch(/пикселей/) // 50 003 205
    expect(img(dataUrl('image/gif', gifHeader(65_535, 762)))).toBeNull()
    expect(img(dataUrl('image/gif', gifHeader(65_535, 763)))).toMatch(/пикселей/)
    expect(img(dataUrl('image/gif', gifHeader(763, 65_535)))).toMatch(/пикселей/)
  })
  it('потолок общий на весь документ: картинки в src и в url() складываются', () => {
    const a = dataUrl('image/png', pngHeader(5_000, 5_000))
    expect(unsafeHtml(`<img src="${a}"><img src="${a}">`)).toBeNull()
    expect(unsafeHtml(`<img src="${a}"><img src="${a}"><img src="${dataUrl('image/png', pngHeader(1, 1))}">`)).toMatch(/больше 50000000 пикселей/)
    expect(unsafeHtml(`<img src="${a}"><p style="background:url(${a})">x</p>`)).toBeNull()
    expect(unsafeHtml(`<img src="${a}"><p style="background:url(${a})">x</p><td background="${dataUrl('image/gif', gifHeader(1, 1))}">`)).toMatch(/больше 50000000 пикселей/)
    expect(unsafeHtml(`<td background="${a}"></td><p style="background:url(${a})">x</p><i style="background:url(${dataUrl('image/gif', gifHeader(1, 1))})">`)).toMatch(/больше 50000000 пикселей/)
  })
})

describe('checkHtml: пересборка', () => {
  const rebuilt = (src: string): string => html(checkHtml(src))

  it('каноническая запись: имена в нижнем регистре, значения в двойных кавычках, без «/>»', () => {
    const src = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><HTML><HEAD><META charset=UTF-8><STYLE><!-- p{color:red} --></STYLE></HEAD><BODY BGCOLOR=\'#fff\'><P Class=a title=\'x"y>z\' nowrap>Привет<BR/></P></BODY></HTML>'
    expect(rebuilt(src)).toBe('<!DOCTYPE html><html><head><meta charset="utf-8"><style><!-- p{color:red} --></style></head><body bgcolor="#fff"><p class="a" title="x&quot;y&gt;z" nowrap>Привет<br></p></body></html>')
  })
  it('«<» и «>» в значении, кавычки без кавычек: экранируются в сущности, остальное не трогается', () => {
    expect(rebuilt('<p title="<b>" alt=a"b data-x=\'1&amp;2\'>x</p>')).toBe('<p title="&lt;b&gt;" alt="a&quot;b" data-x="1&amp;2">x</p>')
  })
  it('комментарии, <?…>, <![CDATA[, <!ELEMENT, </> и </ x> отбрасываются', () => {
    for (const drop of ['<!-- c -->', '<!-- a > b -->', '<!-- <img src="file:///etc/passwd"> -->', '<!-->', '<!--->', '<!-- c --!>', '<!--- c --->', '<![CDATA[ c ]]>', '<?php c ?>', '<!ELEMENT c>', '</>', '</ c>']) {
      expect(rebuilt(`x${drop}y`), drop).toBe('xy')
    }
  })
  it('управляющие знаки (в том числе внутри тега) в LibreOffice не уходят', () => {
    expect(rebuilt('a\u0000b\u0001<p\u0002 class=x>c\u001f</p>\u000b')).toBe('ab<p class="x">c</p>')
  })
  it('«<», не начинающая тег, в тексте — &lt;; «<» в конце тоже', () => {
    expect(rebuilt('1 < 2, 5<6, <3 and </')).toBe('1 &lt; 2, 5&lt;6, &lt;3 and &lt;/')
  })
  it('сущности в тексте остаются как написаны', () => {
    expect(rebuilt('<p>&nbsp;&laquo;a&raquo; &amp; &#8470;5 &lt;b&gt;</p>')).toBe('<p>&nbsp;&laquo;a&raquo; &amp; &#8470;5 &lt;b&gt;</p>')
  })
  it('повтор атрибута: действует первый, второй не доходит до LibreOffice', () => {
    expect(rebuilt(`<img src="${PNG}" src="file:///etc/passwd" class=a class=b>`)).toBe(`<img src="${PNG}" class="a">`)
    expect(rebuilt('<td title=a TITLE=b bgcolor=red BGCOLOR=blue>x</td>')).toBe('<td title="a" bgcolor="red">x</td>')
  })
  it('ссылки — текстом: <a> и href не доходят до LibreOffice, текст остаётся', () => {
    expect(rebuilt('<a href="https://evil.example/">оплатить</a>')).toBe('оплатить')
    expect(rebuilt('<p>Оплатите <A HREF=\'https://evil.example/pay?a=1&amp;b=2\' Target=_blank class="btn">здесь</A> сегодня.</p>')).toBe('<p>Оплатите здесь сегодня.</p>')
    expect(rebuilt('<a href="https://ex.by/">https://ex.by/</a>')).toBe('https://ex.by/')
    expect(rebuilt('<a href="https://ex.by/"><b>жирно</b> и <img src="' + PNG + '"></a>')).toBe(`<b>жирно</b> и <img src="${PNG}">`)
    expect(rebuilt('<a name="top"></a><a id=x>1</a><a>2</a>')).toBe('12')
  })
  it('ссылки — текстом при любой схеме и записи: https, mailto, #, javascript, file, пусто, без значения, вложенные', () => {
    for (const href of ['https://ex.by/', 'HTTPS://EX.BY/', 'http://ex.by/', 'mailto:a@ex.by', 'tel:+375', '#top', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html;base64,PHA+', 'vnd.sun.star.script:x', 'macro:x', '.uno:Open', '//ex.by/', 'a.html', '', '&#106;avascript:x']) {
      expect(rebuilt(`<a href="${href}">t</a>`), href).toBe('t')
    }
    expect(rebuilt('<a href>t</a><a href=x>u</a><a/href=x>v</a><A\nHREF = "x"\n>w</A>')).toBe('tuvw')
    expect(rebuilt('<a href="#1"><a href="#2">t</a></a>')).toBe('t')
  })
  it('ссылка с «>» в кавычках не просачивается в текст: хвост тега не выводится', () => {
    expect(rebuilt('<a title=">" href="file:///etc/passwd">x</a>')).toBe('x')
    expect(rebuilt("<a title='>' href='javascript:1'>x</a>")).toBe('x')
    expect(rebuilt('<a href="file:///etc/passwd" title=">">x</a>')).toBe('x')
  })
  it('href на других тегах тоже выбрасывается', () => {
    expect(rebuilt('<map name="m"><area href="https://ex.by/" shape=rect></map>')).toBe('<map name="m"><area shape="rect"></map>')
    expect(rebuilt('<p href="#x" HREF=y class=a>t</p>')).toBe('<p class="a">t</p>')
  })
  it('пробельные знаки между атрибутами и вокруг «=»: пробел, табуляция, перевод строки, возврат каретки', () => {
    for (const ws of [' ', '\t', '\n', '\r', '\r\n', '  \t ']) {
      expect(rebuilt(`<p${ws}class${ws}=${ws}a${ws}title${ws}=${ws}"b"${ws}>x</p>`), JSON.stringify(ws)).toBe('<p class="a" title="b">x</p>')
    }
  })
  it('слэш между атрибутами — пробел: <img/src=…> собирается как <img src=…>', () => {
    expect(rebuilt(`<img/src="${PNG}"/class="a"/>`)).toBe(`<img src="${PNG}" class="a">`)
  })
  it('тег не склеивается из частей вокруг отброшенного: остаётся текстом', () => {
    expect(rebuilt('<<!--x-->script>x')).toBe('&lt;script>x')
    expect(rebuilt('<!--x--><<!--y-->iframe src=x>')).toBe('&lt;iframe src=x>')
    expect(rebuilt('<p>a<!--x-->b</p>')).toBe('<p>ab</p>')
  })
  it('<style>: текст как есть до </style (в любом регистре и с пробелом), незакрытый закрывается', () => {
    expect(rebuilt('<style>p::after{content:"a>b"} a>b{}</style>')).toBe('<style>p::after{content:"a>b"} a>b{}</style>')
    expect(rebuilt('<STYLE type=text/css>a{}</STYLE ><p>x</p>')).toBe('<style type="text/css">a{}</style><p>x</p>')
    expect(rebuilt('<style>a{}')).toBe('<style>a{}</style>')
    expect(rebuilt('<style>a{}</style><style>b{}</style>')).toBe('<style>a{}</style><style>b{}</style>')
    expect(rebuilt('<style media=print>a{}</style foo=bar>x')).toBe('<style media="print">a{}</style>x')
  })
  it('meta собирается как <meta charset="utf-8">; doctype — как <!DOCTYPE html>', () => {
    expect(rebuilt("<meta charset='UTF-8' /><!doctype html>")).toBe('<meta charset="utf-8"><!DOCTYPE html>')
  })
  it('отказ называет причину и не повторяет содержимое документа', () => {
    const r = checkHtml('<p>СЕКРЕТ</p><img src="file:///СЕКРЕТ/passwd">')
    expect(r).toMatchObject({ ok: false })
    expect(JSON.stringify(r)).not.toContain('СЕКРЕТ')
    expect(JSON.stringify(checkHtml('<p СЕКРЕТ"x=1>'))).not.toContain('СЕКРЕТ')
  })
})

describe('checkHtml: время разбора линейное', () => {
  it('200 000 знаков «<» — быстрее 200 мс (было 3,7 с на 100 000: главный поток замирал)', () => {
    expect(ms(() => checkHtml('<'.repeat(200_000)))).toBeLessThan(200)
    expect(checkHtml('<'.repeat(200_000))).toMatchObject({ ok: true })
  })
  it('тяжёлые для регулярных выражений входы разбираются за доли секунды', () => {
    const inputs: Record<string, string> = {
      'тег без «>»': '<a'.repeat(100_000),
      'meta без «>»': '<meta'.repeat(40_000),
      'открытая кавычка': '<p title="'.repeat(20_000),
      'атрибуты без закрытия': '<p ' + 'a=1 '.repeat(50_000),
      'комментарий без конца': '<!--'.repeat(50_000),
      'много комментариев': '<!-- -->'.repeat(30_000),
      '<!-- без --!>': '<!-- x -- -->'.repeat(20_000),
      'много <style>': '<style></style>'.repeat(14_000),
      'много тегов': '<b>'.repeat(70_000),
      'пробелы после «<»': ('<' + ' '.repeat(1_000)).repeat(200),
      'длинное значение': '<p title="' + 'x'.repeat(200_000) + '">',
      'сущности': '&#x41;'.repeat(35_000),
      'сущности без конца': '&#'.repeat(100_000),
      'вложенные сущности': '&amp;'.repeat(40_000),
      'экраны': '\\'.repeat(200_000),
      'экраны с шестнадцатеричными': '\\4'.repeat(100_000),
      'url( без конца': 'url('.repeat(50_000),
      'url с пробелами': 'url' + ' '.repeat(100_000),
      '<p style> с url(': '<p style="' + 'url( '.repeat(30_000) + '">',
      '@import': '@import'.repeat(30_000),
      'base64 в 4 МБ': `<img src="data:image/png;base64,${'A'.repeat(4_000_000)}">`
    }
    for (const [name, src] of Object.entries(inputs)) {
      expect(ms(() => checkHtml(src)), name).toBeLessThan(1_000)
    }
  })
  it('предельный документ (5 МБ) в разумное время', () => {
    const big = '<td class="a" title="x">1 &amp; 2</td>'.repeat(130_000) // ≈ 5 МБ
    expect(big.length).toBeGreaterThan(4_900_000)
    expect(ms(() => checkHtml(big))).toBeLessThan(3_000)
  })
})

describe('normalizeHtml', () => {
  const ENTITIES: Record<string, string> = { colon: ':', sol: '/', bsol: '\\', lpar: '(', rpar: ')', period: '.', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", tab: '\t', newline: '\n', num: '#', commat: '@' }
  it('именованные сущности: каждая из таблицы раскодируется, в любом регистре', () => {
    for (const [name, ch] of Object.entries(ENTITIES)) {
      expect(normalizeHtml(`&${name};`), name).toBe(ch)
      expect(normalizeHtml(`&${name.toUpperCase()};`), name).toBe(ch)
    }
  })
  it('незнакомая сущность остаётся как есть; свойства Object — не сущности', () => {
    expect(normalizeHtml('&nbsp; &constructor; &toString; &__proto__; &hasOwnProperty;')).toBe('&nbsp; &constructor; &toString; &__proto__; &hasOwnProperty;')
  })
  it('числовые сущности: шестнадцатеричные и десятичные, с «;» и без', () => {
    expect(normalizeHtml('&#x66;&#X66;&#102;')).toBe('fff')
    expect(normalizeHtml('&#x66&#102 x')).toBe('ff x')
  })
  it('числовая сущность и CSS-экран с кодом больше U+10FFFF не падают', () => {
    expect(normalizeHtml('&#x110000;')).toBe('\u{10ffff}')
    expect(normalizeHtml('&#1114112;')).toBe('\u{10ffff}')
    expect(normalizeHtml('\\ffffff x')).toBe('\u{10ffff}x')
  })
  it('CSS-экраны: шестнадцатеричные (с пробелом после), символьные, перенос строки', () => {
    expect(normalizeHtml('\\66 ile \\/ \\u\\rl \\\nx \\69mport')).toBe('file / url x import')
  })
  it('вложенные кодировки раскрываются до трёх слоёв', () => {
    expect(normalizeHtml('&amp;#x66;')).toBe('f')
    expect(normalizeHtml('&amp;amp;#x66;')).toBe('f')
    expect(normalizeHtml('&amp;amp;amp;#x66;')).toBe('&#x66;')
  })
  it('управляющие знаки убираются, табуляция и перевод строки остаются', () => {
    expect(normalizeHtml('a\u0000b\u0001c\u000bd\u000ce\u001ff\tg\nh\ri')).toBe('abcdef\tg\nh\ri')
  })
})
