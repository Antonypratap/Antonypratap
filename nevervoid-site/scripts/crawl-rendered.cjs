// Read-only rendered crawl of www.nevervoid.com (SmugMug loads galleries with JavaScript).
// Usage: NODE_EXTRA_CA_CERTS=... node scripts/crawl-rendered.cjs <seed-urls.txt> <out.json>
// Three tabs, 1s pause per tab between pages; skips robots.txt-disallowed paths and does not follow image pages.
const { chromium } = require('playwright'); const fs=require('fs');
const [,,seedFile,outFile]=process.argv;
const DIS=/^\/(404|access-denied|admin|api|cart|checkout|date|downloads|go|hack|keyword|order|password|popular|search|services|test)(\/|$)/i;
const norm=u=>{try{const x=new URL(u);if(!/(^|\.)nevervoid\.com$/.test(x.hostname))return null;x.protocol='https:';x.hash='';x.search='';let s=x.href;if(s.endsWith('/')&&x.pathname!=='/')s=s.slice(0,-1);return s.replace(/\/$/,'')||s}catch{return null}};
const queue=fs.readFileSync(seedFile,'utf8').split('\n').filter(Boolean).map(norm); const seen=new Set(queue); const out={};
(async()=>{
 const b=await chromium.launch({proxy:{server:process.env.HTTPS_PROXY}});
 const ctx=await b.newContext({userAgent:'Mozilla/5.0 (compatible; NevervoidOwnerSEOAudit/1.0) Chrome'});
 async function worker(){
  while(queue.length){const u=queue.shift(); const p=await ctx.newPage();
   try{const r=await p.goto(u,{waitUntil:'networkidle',timeout:90000}); await p.waitForTimeout(2000);
    for(let i=0;i<10;i++){await p.mouse.wheel(0,5000);await p.waitForTimeout(500);}
    const d=await p.evaluate(()=>({final:location.href,title:document.title,h1:[...document.querySelectorAll('h1')].map(e=>e.innerText.trim()).filter(Boolean),
     h2:[...document.querySelectorAll('h2')].map(e=>e.innerText.trim()).filter(Boolean),
     imgs:[...document.querySelectorAll('img')].map(i=>({src:i.currentSrc||i.src,alt:i.getAttribute('alt')})).filter(i=>/photos\.smugmug\.com/.test(i.src)),
     jsonld:[...document.querySelectorAll('script[type="application/ld+json"]')].map(s=>s.textContent),
     links:[...new Set([...document.querySelectorAll('a[href]')].map(a=>a.href))]}));
    d.status=r?r.status():null; out[u]=d;
    for(const l of d.links){const n=norm(l); if(!n||seen.has(n))continue; const path=new URL(n).pathname;
      if(DIS.test(path)||/\/i-[A-Za-z0-9]+$/.test(path)||/\/n-[A-Za-z0-9]+$/.test(path))continue;
      if(new URL(n).hostname!=='www.nevervoid.com')continue; seen.add(n); queue.push(n);}
    console.log(Object.keys(out).length,queue.length,d.status,u,d.imgs.length);
   }catch(e){out[u]={error:e.message};console.log('ERR',u,e.message.slice(0,80))}
   await p.close(); await new Promise(r=>setTimeout(r,1000));}
 }
 await Promise.all([worker(),worker(),worker()]);
 fs.writeFileSync(outFile,JSON.stringify(out)); await b.close();
})();
