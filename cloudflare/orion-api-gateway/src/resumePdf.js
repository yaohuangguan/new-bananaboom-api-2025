// Browser Run replacement for legacy /api/resumes/export-pdf.
// Only a hard-coded public Orion page can be rendered; no arbitrary URLs,
// cookies or credential-bearing headers are forwarded into the browser.
const WEBSITE = 'https://samyao.me/profile';
const LANGUAGE = new Set(['zh', 'en', 'zh-HK', 'fr', 'ja', 'ru', 'de', 'es']);
const PAPER = new Set(['a4', 'a3', 'a5']);
const MODE = new Set(['single-page', 'multi-page']);
const PARAMS = new Set(['user', 'slug', 'lang', 'pdfMode', 'paperSize', 'pageLimit']);

export function resumePdfParameters(sourceUrl) {
  const params = new URL(sourceUrl).searchParams;
  if ([...params.keys()].some((key) => !PARAMS.has(key)) ||
      [...PARAMS].some((key) => params.getAll(key).length > 1)) {
    return null;
  }
  const slug = params.get('user') || params.get('slug') || 'yaob@miamioh.edu';
  const lang = params.get('lang') || 'zh';
  const mode = params.get('pdfMode') || 'multi-page';
  const paper = (params.get('paperSize') || 'a4').toLowerCase();
  const pagesRaw = params.get('pageLimit') || '0';
  if (!/^[a-z0-9@._-]{1,120}$/i.test(slug) || !LANGUAGE.has(lang) ||
      !MODE.has(mode) || !PAPER.has(paper) ||
      !/^\d{1,2}$/.test(pagesRaw) || Number(pagesRaw) > 20) return null;
  const url = new URL(WEBSITE);
  url.searchParams.set('tab', 'resume');
  url.searchParams.set('user', slug);
  url.searchParams.set('lang', lang);
  url.searchParams.set('print', 'true');
  url.searchParams.set('pdfMode', mode);
  url.searchParams.set('paperSize', paper);
  if (Number(pagesRaw)) url.searchParams.set('pageLimit', pagesRaw);
  return { url: url.href, slug, lang, paper, mode, pageLimit: Number(pagesRaw) };
}

export async function serveResumePdf(request, env) {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
  const opts = resumePdfParameters(request.url);
  if (!opts) return Response.json({ message: 'Invalid PDF export parameters' }, { status: 400 });
  if (!env.BROWSER || typeof env.BROWSER.quickAction !== 'function') {
    return Response.json({ message: 'Browser Run PDF exporter is not configured' }, { status: 503 });
  }
  try {
    const pdf = await env.BROWSER.quickAction('pdf', {
      url: opts.url,
      viewport: { width: 1280, height: 1400 },
      gotoOptions: { waitUntil: 'networkidle2', timeout: 30000 },
      pdfOptions: {
        format: opts.paper,
        printBackground: true,
        preferCSSPageSize: true,
        ...(opts.pageLimit ? { pageRanges: '1-' + opts.pageLimit } : {})
      },
      addStyleTag: [{
        content: '@media print { body { background: white !important; } .resume-paper-sheet { box-shadow: none !important; border: none !important; } }'
      }]
    });
    if (!pdf.ok) return Response.json({ message: 'PDF exporter unavailable' }, { status: 502 });
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    if (bytes.length < 9 || bytes.length > 20_000_000 ||
        new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
      return Response.json({ message: 'PDF exporter returned invalid content' }, { status: 502 });
    }
    const fileSafe = opts.slug.replace(/[^a-z0-9._-]/gi, '_');
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="Resume_' + fileSafe + '_' + opts.lang + '.pdf"',
        'cache-control': 'private, no-store',
        'x-orion-pdf-renderer': 'browser-run'
      }
    });
  } catch (error) {
    console.error('resume-browser-run-failed', error?.name || 'Error');
    return Response.json({ message: 'PDF exporter temporarily unavailable' }, { status: 503 });
  }
}
