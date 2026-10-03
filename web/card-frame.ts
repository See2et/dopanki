import { escapeHtml, type RenderedCard } from '../src/lib/render';

export function frameDocument(rendered: RenderedCard): string {
  const parsed = new DOMParser().parseFromString(rendered.html, 'text/html');
  for (const forbidden of parsed.querySelectorAll('script,iframe,object,embed,base,meta,link,form,input,button,textarea,style')) forbidden.remove();
  for (const element of parsed.body.querySelectorAll('*')) {
    for (const attr of [...element.attributes]) {
      if (/^on/i.test(attr.name) || ['srcdoc','formaction','action'].includes(attr.name) || (['href','src','xlink:href'].includes(attr.name) && /^\s*(javascript|vbscript):/i.test(attr.value))) element.removeAttribute(attr.name);
    }
    for (const name of ['src', 'poster']) {
      const value = element.getAttribute(name);
      if (value && !value.startsWith('data:')) element.setAttribute(name, `${location.origin}/media/${encodeURIComponent(value.replace(/^\/?media\//,''))}`);
    }
    element.removeAttribute('srcset');
    if (element.tagName === 'A') { element.removeAttribute('href'); element.removeAttribute('target'); }
  }
  const css = rendered.css.replace(/<\//g,'<\\/');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escapeHtml(location.origin)} data:; media-src ${escapeHtml(location.origin)}; style-src 'unsafe-inline'; font-src ${escapeHtml(location.origin)} data:;"><style>
    html{color-scheme:light}body{margin:0;padding:24px 20px;overflow-wrap:anywhere;color:#252923;background:#fff;font:20px/1.7 -apple-system,BlinkMacSystemFont,'Noto Sans',sans-serif;text-align:center}.card{background:transparent!important;color:inherit}img{max-width:100%;height:auto}hr{border:0;border-top:1px solid #e7e9e3;margin:22px 0}.cloze{color:#285f46;font-weight:700}.expected-answer{font-size:1.3em;font-weight:600} ${css}
    </style></head><body class="card">${parsed.body.innerHTML}</body></html>`;
}
