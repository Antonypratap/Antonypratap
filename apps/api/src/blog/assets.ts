import { createHash } from 'node:crypto';
import type { WebFiles } from '../http/web-static';

/**
 * The blog's own stylesheet and script, served by the website from memory at content-hashed
 * addresses (cached for a year). The stylesheet uses Veyrafy's design tokens (the same values as
 * apps/web/src/design-system/tokens.css) and the website's own font files, found in the web build
 * by name. Pages work completely without the script: it only sends analytics events, and only
 * after the visitor has agreed.
 */
export interface BlogAssets {
  css: { path: string; body: Buffer };
  js: { path: string; body: Buffer };
  /** Font files to preload (their build paths). */
  preload: string[];
}

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 12);

function fontFaces(web: WebFiles | null): { css: string; preload: string[] } {
  const find = (prefix: string) =>
    web
      ? [...web.files.keys()].find((p) => p.startsWith(`/assets/${prefix}`) && p.endsWith('.woff2'))
      : undefined;
  const inter = find('inter-latin-opsz-normal-');
  const display = find('bricolage-grotesque-latin-wght-normal-');
  const latin =
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+20B9, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
  const faces = [
    inter
      ? `@font-face{font-family:'Inter Variable';font-style:normal;font-display:swap;font-weight:100 900;src:url(${inter}) format('woff2-variations');unicode-range:${latin}}`
      : '',
    display
      ? `@font-face{font-family:'Bricolage Grotesque Variable';font-style:normal;font-display:swap;font-weight:200 800;src:url(${display}) format('woff2-variations');unicode-range:${latin}}`
      : '',
  ];
  return { css: faces.join(''), preload: [inter, display].filter((x): x is string => !!x) };
}

const CSS = String.raw`
:root{--font-sans:'Inter Variable','Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;--font-display:'Bricolage Grotesque Variable',var(--font-sans);
--canvas:#f6f1e7;--surface:#fff;--sunken:#efe8da;--raised:#fbf9f4;--line:#e6dece;--line-strong:#d9cfba;
--ink:#0d0f12;--ink-2:#3b4048;--ink-3:#5f656e;--ink-4:#9a9fa6;--accent:#145c46;--accent-hover:#0f4a38;--accent-soft:#e9f2ee;--accent-line:#c5ddd3;--bright:#03a874;
--attention:#9a5a0b;--attention-soft:#fbf2e4;--attention-line:#efd8b4;--inverse:#0f1a16;--inverse-ink:#f3f1ea;--inverse-ink-2:#b9c2bd;--inverse-accent:#5fd3a6;
--radius:12px;--radius-sm:8px;--measure:42rem;--wide:72rem}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--canvas);color:var(--ink);font-family:var(--font-sans);font-size:1rem;line-height:1.6;font-feature-settings:'cv11','ss01','ss03';-webkit-font-smoothing:antialiased}
img{max-width:100%;height:auto;display:block}
a{color:var(--accent);text-underline-offset:.18em;text-decoration-thickness:1px}
a:hover{color:var(--accent-hover)}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
.skip{position:absolute;left:-9999px;top:0;background:var(--ink);color:#fff;padding:.5rem 1rem;z-index:100}
.skip:focus{left:1rem;top:1rem}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.wrap{width:100%;max-width:var(--wide);margin:0 auto;padding:0 1rem}
@media(min-width:40rem){.wrap{padding:0 1.5rem}}
.site{border-bottom:1px solid var(--line);background:rgb(246 241 231 / .92)}
.bar{display:flex;align-items:center;gap:1rem;min-height:4rem;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:.5rem;color:var(--ink);text-decoration:none;font-family:var(--font-display);font-weight:650;font-size:1.25rem;letter-spacing:-.01em}
.brand img{width:1.75rem;height:1.75rem}
.nav{display:flex;gap:.25rem;margin-left:auto;flex-wrap:wrap}
.nav a{padding:.5rem .65rem;border-radius:var(--radius-sm);color:var(--ink-2);text-decoration:none;font-size:.9375rem}
.nav a:hover,.nav a[aria-current=page]{color:var(--ink);background:var(--sunken)}
.nav .cta{background:var(--accent);color:#fff}
.nav .cta:hover{background:var(--accent-hover);color:#fff}
main{display:block;padding:2rem 0 4rem}
.crumbs{font-size:.875rem;color:var(--ink-3);margin:0 0 1.25rem}
.crumbs ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.25rem}
.crumbs li+li::before{content:'/';margin-right:.25rem;color:var(--ink-4)}
.crumbs a{color:var(--ink-3)}
.kicker{font-size:.75rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:0 0 .5rem}
h1,h2,h3{font-family:var(--font-display);letter-spacing:-.02em;line-height:1.12;color:var(--ink)}
.page-title{font-size:clamp(2rem,1.4rem + 2.6vw,3.25rem);margin:0 0 .75rem}
.lede{font-size:clamp(1.0625rem,.98rem + .36vw,1.25rem);color:var(--ink-2);max-width:var(--measure);margin:0 0 1.5rem}
.search{display:flex;gap:.5rem;max-width:30rem;margin:0 0 2rem}
.search input{flex:1;min-width:0;font:inherit;padding:.65rem .85rem;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--ink)}
.search button,.button{font:inherit;font-weight:600;padding:.65rem 1rem;border-radius:var(--radius-sm);border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem}
.search button:hover,.button:hover{background:var(--accent-hover);color:#fff}
.button.secondary{background:transparent;color:var(--accent)}
.cats{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;padding:0;margin:0 0 2rem}
.cats a{display:inline-block;padding:.4rem .8rem;border:1px solid var(--line-strong);border-radius:999px;color:var(--ink-2);text-decoration:none;font-size:.875rem;background:var(--surface)}
.cats a:hover,.cats a[aria-current=page]{border-color:var(--accent);color:var(--accent)}
.grid{display:grid;grid-template-columns:1fr;gap:1.25rem;list-style:none;padding:0;margin:0}
@media(min-width:40rem){.grid{grid-template-columns:repeat(2,1fr)}}
@media(min-width:64rem){.grid{grid-template-columns:repeat(3,1fr)}}
.card{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;height:100%}
.card img,.card .ph{aspect-ratio:1200/630;object-fit:cover;width:100%;background:var(--sunken)}
.thumb{display:block;text-decoration:none}
.ph{display:grid;place-items:center;padding:1.5rem;text-align:center;color:var(--accent);font-family:var(--font-display);font-weight:600;font-size:1.375rem;line-height:1.2;background:linear-gradient(135deg,var(--accent-soft),var(--sunken))}
.featured .ph{font-size:clamp(1.5rem,1.2rem + 1.2vw,2rem)}
.card-body{padding:1rem 1.1rem 1.25rem;display:flex;flex-direction:column;gap:.5rem;flex:1}
.card h2,.card h3{font-size:1.1875rem;margin:0;line-height:1.25}
.card h2 a,.card h3 a{color:var(--ink);text-decoration:none}
.card h2 a:hover,.card h3 a:hover{color:var(--accent)}
.card p{margin:0;color:var(--ink-2);font-size:.9375rem}
.meta{font-size:.8125rem;color:var(--ink-3);display:flex;flex-wrap:wrap;gap:.35rem .75rem;margin-top:auto}
.featured{display:grid;gap:1.5rem;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin:0 0 2.5rem}
.featured img,.featured .ph{width:100%;aspect-ratio:1200/630;object-fit:cover}
.featured .card-body{padding:1.25rem 1.25rem 1.5rem}
.featured h2{font-size:clamp(1.5rem,1.2rem + 1.2vw,2.125rem);margin:0}
@media(min-width:56rem){.featured{grid-template-columns:1.2fr 1fr;align-items:center}.featured .card-body{padding:2rem}}
.section-title{font-size:1.5rem;margin:0 0 1rem}
.pager{display:flex;justify-content:space-between;gap:1rem;margin:2.5rem 0 0;flex-wrap:wrap}
.pager span{color:var(--ink-3);align-self:center}
.empty{background:var(--surface);border:1px dashed var(--line-strong);border-radius:var(--radius);padding:2rem;color:var(--ink-2)}
.article-head{max-width:var(--measure);margin:0 auto}
.article-head .page-title{font-size:clamp(2rem,1.35rem + 2.6vw,3rem)}
.byline{display:flex;flex-wrap:wrap;gap:.25rem 1rem;color:var(--ink-3);font-size:.9375rem;margin:0 0 1.5rem}
.byline strong{color:var(--ink-2);font-weight:600}
.hero-img{max-width:56rem;margin:0 auto 2rem}
.hero-img img{border-radius:var(--radius);width:100%;aspect-ratio:1200/630;object-fit:cover}
.layout{display:grid;gap:2rem;max-width:var(--measure);margin:0 auto}
@media(min-width:76rem){.layout.has-toc{max-width:none;grid-template-columns:minmax(0,1fr) minmax(0,var(--measure)) minmax(0,1fr);column-gap:2.5rem}.layout.has-toc .prose{grid-column:2;grid-row:1}.layout.has-toc .toc{grid-column:3;grid-row:1;position:sticky;top:1.5rem;align-self:start;max-width:15rem}}
.toc{background:var(--raised);border:1px solid var(--line);border-radius:var(--radius);padding:1rem 1.1rem;font-size:.9375rem}
.toc h2{font-family:var(--font-sans);font-size:.8125rem;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin:0 0 .5rem}
.toc ol{margin:0;padding-left:1.1rem}.toc li{margin:.25rem 0}.toc .sub{margin-left:.75rem;list-style:circle}
.toc a{color:var(--ink-2);text-decoration:none}.toc a:hover{color:var(--accent);text-decoration:underline}
.prose{font-size:1.0625rem;color:var(--ink-2);min-width:0}
.prose>*{margin:0 0 1.25rem}
.prose h2{font-size:clamp(1.5rem,1.25rem + .9vw,1.875rem);margin:2.5rem 0 1rem;scroll-margin-top:1.5rem}
.prose h3{font-size:1.25rem;margin:2rem 0 .75rem;scroll-margin-top:1.5rem}
.prose strong{color:var(--ink)}
.prose code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:var(--sunken);padding:.1em .35em;border-radius:4px}
.prose ul,.prose ol{padding-left:1.4rem}.prose li{margin:.35rem 0}
.prose blockquote{border-left:3px solid var(--accent);margin-left:0;padding:.25rem 0 .25rem 1.1rem;color:var(--ink);font-size:1.125rem}
.prose blockquote footer{font-size:.875rem;color:var(--ink-3);margin-top:.5rem}
.prose figure{margin:1.75rem 0}.prose figure img{border-radius:var(--radius-sm)}
.prose figcaption{font-size:.875rem;color:var(--ink-3);margin-top:.5rem}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface)}
.prose table{border-collapse:collapse;width:100%;font-size:.9375rem}
.prose caption{caption-side:top;text-align:left;padding:.75rem;color:var(--ink-3);font-size:.875rem}
.prose th,.prose td{text-align:left;padding:.6rem .75rem;border-bottom:1px solid var(--line);vertical-align:top}
.prose th{background:var(--raised);color:var(--ink);font-weight:600}
.callout{border-radius:var(--radius-sm);padding:1rem 1.1rem;border:1px solid var(--accent-line);background:var(--accent-soft);color:var(--ink)}
.callout.warning{border-color:var(--attention-line);background:var(--attention-soft)}
.faq{margin-top:2.5rem}.faq h2{margin-top:0}
.faq details{border-top:1px solid var(--line);padding:.85rem 0}.faq details:last-child{border-bottom:1px solid var(--line)}
.faq summary{cursor:pointer;font-weight:600;color:var(--ink);list-style-position:outside}
.faq details>div{margin-top:.5rem}
.cta-box{background:var(--inverse);color:var(--inverse-ink);border-radius:var(--radius);padding:1.5rem;margin:3rem 0 0}
.cta-box h2{color:var(--inverse-ink);font-size:1.5rem;margin:0 0 .5rem}
.cta-box p{color:var(--inverse-ink-2);margin:0 0 1rem}
.cta-box .button{background:var(--inverse-accent);border-color:var(--inverse-accent);color:var(--inverse)}
.cta-box .button:hover{background:#7fe0ba;color:var(--inverse)}
.tags{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;padding:0;margin:2rem 0 0}
.tags a{font-size:.8125rem;padding:.25rem .65rem;border-radius:999px;background:var(--sunken);color:var(--ink-2);text-decoration:none}
.share{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:2rem 0 0;font-size:.875rem;color:var(--ink-3)}
.share a{color:var(--ink-2)}
.related{max-width:var(--wide);margin:3.5rem auto 0}
.author-box{display:flex;gap:1rem;border-top:1px solid var(--line);padding-top:1.5rem;margin-top:2.5rem;font-size:.9375rem}
.author-box p{margin:.25rem 0 0}
.preview-banner{background:var(--attention);color:#fff;text-align:center;padding:.6rem 1rem;font-weight:600}
.error-page{max-width:var(--measure);margin:2rem auto;text-align:left}
footer.site-foot{border-top:1px solid var(--line);padding:2rem 0;color:var(--ink-3);font-size:.875rem}
footer.site-foot nav{display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:.75rem}
footer.site-foot a{color:var(--ink-2)}
.consent{position:fixed;inset:auto 1rem 1rem 1rem;max-width:34rem;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius);padding:1rem 1.1rem;box-shadow:0 10px 30px rgb(15 26 22 / .14);z-index:60;font-size:.9375rem}
.consent p{margin:0 0 .75rem;color:var(--ink-2)}
.consent form{display:flex;gap:.5rem;flex-wrap:wrap}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
@media print{.site,.consent,.cta-box,.share,.related,footer.site-foot,.toc{display:none}}
`;

/**
 * Analytics events, only on a page that loaded Google's tag (the visitor agreed): clicks on calls
 * to action (data-cta), and reading depth (half and nine-tenths of the article seen).
 */
const JS = `(function(){var s=document.currentScript;var id=s&&s.getAttribute('data-ga');if(!id)return;window.dataLayer=window.dataLayer||[];function gtag(){window.dataLayer.push(arguments)}window.gtag=gtag;gtag('js',new Date());gtag('config',id,{anonymize_ip:true});var page=s.getAttribute('data-page')||'';document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('[data-cta]');if(a)gtag('event','cta_click',{cta:a.getAttribute('data-cta'),page:page});});var body=document.querySelector('[data-article]');if(!body)return;var sent={};function check(){var r=body.getBoundingClientRect();var seen=(window.innerHeight-r.top)/Math.max(1,r.height);[50,90].forEach(function(p){if(!sent[p]&&seen>=p/100){sent[p]=1;gtag('event','article_read',{percent:p,page:page});}});}window.addEventListener('scroll',check,{passive:true});check();})();`;

export function buildBlogAssets(web: WebFiles | null): BlogAssets {
  const fonts = fontFaces(web);
  const css = Buffer.from(fonts.css + CSS.replace(/\n/g, ''), 'utf8');
  const js = Buffer.from(JS, 'utf8');
  return {
    css: { path: `/blog/assets/blog.${hash(css)}.css`, body: css },
    js: { path: `/blog/assets/blog.${hash(js)}.js`, body: js },
    preload: fonts.preload,
  };
}
