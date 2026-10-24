import {chromium} from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import type {Browser,Page} from 'playwright';
import {markets,SourceError,type Marketplace,type ProductHit,type VideoSource} from '../types.ts';
import {amazonSelectors as selectors} from '../selectors.amazon.ts';
import {parseCustomerVideoBlocks} from '../parser.ts';
import {parseRatingsCount,signalSleep} from '../utils.ts';

chromium.use(stealth());
const userAgent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36';
class Gate {
 private active=0;private waiting:Array<()=>void>=[];
 private limit=Math.max(1,Math.min(2,Number(process.env.BROWSER_CONCURRENCY)||2));
 async enter(signal?:AbortSignal):Promise<()=>void>{
  signal?.throwIfAborted();
  if(this.active<this.limit)this.active++;
  else await new Promise<void>((resolve,reject)=>{
   const resume=()=>{signal?.removeEventListener('abort',abort);resolve();};
   const abort=()=>{this.waiting=this.waiting.filter(v=>v!==resume);reject(signal?.reason||Error('aborted'));};
   signal?.addEventListener('abort',abort,{once:true});this.waiting.push(resume);
  });
  return()=>{const next=this.waiting.shift();if(next)next();else this.active--;};
 }
}
const gate=new Gate();
export class PublicPageSource implements VideoSource {
 readonly name='public';private browser?:Promise<Browser>;private nextRequest=0;
 constructor(private logger:{warn:(value:unknown,message?:string)=>void}){}
 private async launch(){return this.browser??=chromium.launch({headless:true,args:['--disable-dev-shm-usage']}).catch(e=>{this.browser=undefined;throw e;});}
 async close(){if(this.browser)await(await this.browser).close();this.browser=undefined;}
 private proxies(market:Marketplace){
  const country=markets[market].country.toUpperCase();
  const raw=process.env[`PROXY_URL_${country}`]||(country==='US'?process.env.PROXY_URL:'')||'';
  if(!raw&&process.env.REQUIRE_PROXY==='true')throw new SourceError('CONFIG',`لم يُضبط بروكسي بلد ${country} لهذا المتجر`);
  return raw.split(',').map(v=>v.trim()).filter(Boolean);
 }
 private async visit<T>(url:string,market:Marketplace,read:(page:Page)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  const release=await gate.enter(signal);
  try{
   const proxies=this.proxies(market);
   for(let attempt=0;attempt<3;attempt++){
    signal?.throwIfAborted();const wait=Math.max(0,this.nextRequest-Date.now());this.nextRequest=Date.now()+wait+1500+Math.random()*1500;await signalSleep(wait,signal);
    const proxy=proxies.length?new URL(proxies[attempt%proxies.length]):undefined;
    const context=await(await this.launch()).newContext({userAgent,locale:markets[market].locale,viewport:{width:1365,height:900},...(proxy?{proxy:{server:`${proxy.protocol}//${proxy.host}`,username:decodeURIComponent(proxy.username),password:decodeURIComponent(proxy.password)}}:{})});
    const abort=()=>{void context.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    try{
     const page=await context.newPage();let loginRedirect=false;
     await page.route('**/*',async route=>{
      const request=route.request();const target=new URL(request.url());
      if(request.isNavigationRequest()&&request.frame()===page.mainFrame()){
       if(/\/ap\//.test(target.pathname)){loginRedirect=true;return route.abort();}
       if(target.hostname!==markets[market].host||!(/^\/dp\/[A-Z0-9]{10}(?:\/|$)/i.test(target.pathname)||target.pathname==='/s'))return route.abort();
      }
      if(['image','font','media'].includes(request.resourceType()))return route.abort();
      return route.continue();
     });
     let response;
     try{response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});}
     catch(error){if(loginRedirect)throw new SourceError('LOGIN_WALL','أمازون طلب تسجيل الدخول؛ تم تخطي المنتج');throw error;}
     const status=response?.status()||0;
     if(status===404)throw new SourceError('NOT_FOUND','صفحة المنتج غير موجودة');
     if(status===403||status===503)throw new SourceError('BLOCKED','أمازون حظرت الطلب مؤقتًا، جرّب بعد قليل');
     if(status>=400)throw new SourceError('NETWORK',`تعذر قراءة المصدر (${status})`);
     const text=await page.locator('body').innerText({timeout:5000});
     if(/Robot Check|validateCaptcha|Enter the characters you see below|Type the characters|verify.*human/i.test(text))throw new SourceError('CAPTCHA','أمازون طلب تحققًا بشريًا؛ تم تخطي المنتج');
     if(/automated access|sorry.*something went wrong/i.test(text))throw new SourceError('BLOCKED','أمازون حظرت الطلب مؤقتًا، جرّب بعد قليل');
     await page.locator(selectors.productTitle.join(',')+','+selectors.searchRows.join(',')).first().waitFor({state:'attached',timeout:5000}).catch(()=>{});
     const value=await read(page);signal?.throwIfAborted();return value;
    }catch(error){
     signal?.throwIfAborted();
     const typed=error instanceof SourceError?error:new SourceError('NETWORK','فشل الاتصال بمصدر أمازون');
     this.logger.warn({code:typed.code,snapshot:typed.code==='PARSE_EMPTY'&&typed.snapshot?Buffer.from(typed.snapshot).subarray(0,51200).toString('utf8'):undefined},'public source failed');
     // No login, cookie reuse, CAPTCHA solving, or silent retries without a configured proxy pool.
     if((typed.code==='BLOCKED'||typed.code==='CAPTCHA')&&attempt<2&&proxies.length>1){await signalSleep(1500*2**attempt,signal);continue;}
     throw typed;
    }finally{signal?.removeEventListener('abort',abort);await context.close();}
   }
   throw new SourceError('NETWORK','تعذر الاتصال');
  }finally{release();}
 }
 async search(query:string,market:Marketplace,signal?:AbortSignal):Promise<ProductHit[]>{
  const url=`https://${markets[market].host}/s?k=${encodeURIComponent(query)}`;
  return this.visit(url,market,async page=>{
   const rows=await page.locator(selectors.searchRows.join(',')).all();const hits:ProductHit[]=[];
   for(const row of rows){
    const asin=await row.getAttribute('data-asin');if(!asin||!/^[A-Z0-9]{10}$/.test(asin))continue;
    const heading=await row.locator(selectors.searchTitle[0]).first().textContent().catch(()=>null);
    const title=heading||(await row.locator(selectors.searchTitle[1]).first().getAttribute('alt').catch(()=>''))||'';
    const count=await row.locator(selectors.ratings.join(',')).first().getAttribute('aria-label').catch(()=>null)||await row.locator(selectors.ratings.join(',')).first().textContent().catch(()=>'');
    const ratingText=await row.locator(selectors.rating.join(',')).first().getAttribute('aria-label').catch(()=>null);
    if(title)hits.push({asin,title:title.trim(),ratingsCount:parseRatingsCount(count),rating:ratingText?Number(ratingText.match(/[\d.]+/)?.[0])||undefined:undefined,url:`https://${markets[market].host}/dp/${asin}`});
    if(hits.length>=20)break;
   }
   if(!hits.length){const text=await page.locator('body').innerText();if(/No results for|لم نعثر|لا توجد نتائج/i.test(text))return [];this.logger.warn({title:await page.title(),bodyExcerpt:text.slice(0,1200),asinRows:await page.locator('[data-asin]').count()},'search DOM diagnostic');throw new SourceError('PARSE_EMPTY','تعذر قراءة نتائج المنتجات',await page.content());}
   return [...new Map(hits.map(hit=>[hit.asin,hit])).values()];
  },signal);
 }
 async getCustomerVideos(asin:string,market:Marketplace,signal?:AbortSignal){
  if(!/^[A-Z0-9]{10}$/.test(asin))throw new SourceError('CONFIG','ASIN غير صالح');
  return this.visit(`https://${markets[market].host}/dp/${asin}`,market,async page=>{
   const blocks=await page.locator(selectors.structuredVideos.join(',')).evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-video-items')||''));
   const videos=parseCustomerVideoBlocks(blocks,asin,market);
   const sections=await page.locator(selectors.customerSections.join(',')).count();
   if(!videos.length&&!sections)throw new SourceError('PARSE_EMPTY','الصفحة اتحمّلت لكن قسم مراجعات العملاء غير موجود',await page.content());
   return videos;
  },signal);
 }
}
