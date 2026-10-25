// Reads public search/product sections in existing Chrome pages. Never navigates.
(() => {
 const fields=['creatorType','fullReviewLink','aciContentId','segmentName','productAsin','relatedProductsAsins','videoURL','videoImageUrlUnchanged','hiResVideoImageUrl','videoImageUrl','title'];
 const escape=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const media=url=>{try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['m.media-amazon.com','images-na.ssl-images-amazon.com','images-eu.ssl-images-amazon.com','images-fe.ssl-images-amazon.com'].includes(u.hostname)?u.href:'';}catch{return '';}};
 const waitFor=(predicate,ms)=>new Promise(resolve=>{
  if(predicate()){resolve(true);return;}
  const observer=new MutationObserver(()=>{if(predicate()){clearTimeout(timer);observer.disconnect();resolve(true);}});
  const timer=setTimeout(()=>{observer.disconnect();resolve(false);},ms);
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true});
 });
 const reviewSelector='#reviews-medley-footer,#customer-reviews_feature_div,#reviewsMedley,#cm-cr-dp-review-list,[data-hook="cr-media-gallery"],#cr-media-carousel,#reviews-image-gallery-container,[id*="cr-media"]';
 const revealVideos=async diag=>{
  const hasVideos=()=>Boolean(document.querySelector('[data-video-items]'));
  if(hasVideos()||typeof window==='undefined')return;
  const scope=document.querySelector(reviewSelector);if(!scope)return;
  try{if(scope.scrollIntoView){scope.scrollIntoView({block:'center'});diag.scrolled=true;}}catch{}
  if(await waitFor(hasVideos,3500))return;
  for(let i=0;i<4&&!hasVideos();i++){try{window.scrollBy?.(0,(window.innerHeight||600)*0.8);diag.scrolled=true;}catch{}await new Promise(r=>setTimeout(r,450));}
  if(await waitFor(hasVideos,2000))return;
  const tab=[...scope.querySelectorAll('a,button,[role="tab"],[role="button"],span.a-button-text')].find(node=>{
   const label=(node.getAttribute('aria-label')||node.textContent||'').trim();
   if(label.length>40||!(/^(videos?|customer videos|review videos|الفيديوهات|فيديوهات|فيديو)$/i.test(label)||/^see all videos\b/i.test(label)))return false;
   const href=node.getAttribute('href');return !href||href.startsWith('#')||/^javascript:void\(0\);?$/.test(href);
  });
  try{if(tab?.click){tab.click();diag.clickedTab=true;await waitFor(hasVideos,4000);}}catch{}
 };
 chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||!['cr-read-open-product','cr-read-search'].includes(message?.operation))return false;
  void(async()=>{try{
   const market=location.hostname.replace(/^www\./,'');const asin=location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
   if(!['amazon.com','amazon.eg','amazon.sa','amazon.ae'].includes(market))throw Error('صفحة غير مسموحة');
   const text=document.body?.innerText||'';
   if(/Robot Check|validateCaptcha|Enter the characters you see|verify.*human|Click the button below to continue shopping/i.test(text)||document.querySelector('form[action*="validateCaptcha"],#captchacharacters')){respond({error:'أمازون يعرض صفحة تحقق؛ لم تُقرأ الصفحة. أكملها بنفسك إن رغبت ثم ارجع للموقع.',code:'CAPTCHA'});return false;}
   if(document.querySelector('form[name="signIn"],input[type="password"]')){respond({error:'هذه صفحة تسجيل دخول؛ لم تُقرأ أي بيانات.',code:'LOGIN_WALL'});return false;}
   if(/Sorry! Something went wrong|Service Unavailable/i.test(document.title+' '+text.slice(0,2000))){respond({error:'أمازون يعرض صفحة غير متاحة؛ توقف البحث دون محاولة أخرى.',code:'BLOCKED'});return;}
   if(message.operation==='cr-read-search'){
    if(!/^\/s\/?$/.test(location.pathname))throw Error('الصفحة الحالية ليست نتائج بحث');
    await waitFor(()=>document.querySelector('[data-component-type="s-search-result"][data-asin]')||/No results for|لم نعثر|لا توجد نتائج/i.test(document.body?.innerText||''),7000);
    const rows=[...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')].slice(0,100);
    let html='<html><head><title>Amazon search</title></head><body>';
    for(const row of rows){
     const id=row.getAttribute('data-asin')||'';
     const titleNode=row.querySelector('h2[aria-label],a.a-text-normal h2,a[href*="/dp/"] h2')||row.querySelector('h2');
     const title=titleNode?.getAttribute('aria-label')||titleNode?.textContent?.trim()||row.querySelector('img.s-image')?.getAttribute('alt')||'';
     if(!/^[A-Z0-9]{10}$/.test(id)||!title)continue;
     const count=row.querySelector('a[aria-label*="ratings"],a[aria-label*="تقييم"]')?.getAttribute('aria-label')||row.querySelector('.s-underline-text')?.textContent||'';
     const image=media(row.querySelector('img.s-image')?.getAttribute('src')||'');
     html+=`<div data-component-type="s-search-result" data-asin="${id}"><h2>${escape(title)}</h2><a aria-label="${escape(count)}"></a>${image?`<img class="s-image" src="${escape(image)}">`:''}</div>`;
    }
    if(!rows.length&&/No results for|لم نعثر|لا توجد نتائج/i.test(document.body?.innerText||''))html+='No results for this query';
    html+='</body></html>';respond({html,market,url:location.href,kind:'search'});return;
   }
   if(!asin)throw Error('افتح صفحة المنتج نفسها على أمازون، وليس صفحة البحث');
   await waitFor(()=>document.querySelector('#productTitle'),7000);
   const title=document.querySelector('#productTitle')?.textContent?.trim();
   if(!title)throw Error('صفحة المنتج لم تكتمل أو غير متاحة. لم نقرأها.');
   const pageAsin=document.querySelector('input#ASIN')?.getAttribute('value');
   if(pageAsin&&pageAsin!==asin)throw Error('الاختيار المعروض يخص موديلًا مختلفًا؛ افتح رابط الموديل الصحيح أولًا');
   const imageUrl=media(document.querySelector('#landingImage,#imgBlkFront')?.getAttribute('src')||'');
   const diagnostics={reviews:0,videoBlocks:0,videoItems:0,hasReviewsSection:false,scrolled:false,clickedTab:false};
   await revealVideos(diagnostics);
   diagnostics.reviews=document.querySelectorAll('[data-hook="review"]').length;
   diagnostics.videoBlocks=document.querySelectorAll('[data-video-items]').length;
   diagnostics.hasReviewsSection=Boolean(document.querySelector(reviewSelector));
   let html='<html><head><title>Amazon public product</title></head><body>'+(diagnostics.hasReviewsSection?'<div id="customer-reviews_feature_div"></div>':'');
   for(const node of document.querySelectorAll('[data-video-items]')){
    let items;try{items=JSON.parse(node.getAttribute('data-video-items')||'[]');}catch{continue;}
    if(!Array.isArray(items))continue;
    diagnostics.videoItems+=items.length;
    const clean=items.slice(0,300).map(item=>Object.fromEntries(fields.filter(key=>typeof item?.[key]==='string').map(key=>[key,item[key].slice(0,4096)])));
    html+='<div data-video-items="'+escape(JSON.stringify(clean))+'"></div>';
   }
   for(const review of [...document.querySelectorAll('[data-hook="review"]')].slice(0,100)){
    html+='<div data-hook="review"><a data-hook="review-title">'+escape(review.querySelector('[data-hook="review-title"]')?.textContent)+'</a>';
    const variant=review.querySelector('a[data-hook="format-strip"]')?.getAttribute('href')?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1];
    if(variant)html+='<a data-hook="format-strip" href="/dp/'+variant+'"></a>';
    for(const img of review.querySelectorAll('img[data-hook="review-image-tile"],img.review-image-tile')){
     const url=media(img.getAttribute('data-src')||img.getAttribute('src')||'');if(url)html+='<img data-hook="review-image-tile" src="'+escape(url)+'">';
    }
    html+='</div>';
   }
   html+='</body></html>';
   if(html.length>4*1024*1024)throw Error('بيانات الصفحة أكبر من الحد المسموح');
   respond({html,market,asin,title:title.slice(0,500),imageUrl,url:location.href,kind:'product',diagnostics});
  }catch(error){respond({error:error instanceof Error?error.message:'تعذر قراءة الصفحة',code:'PARSE_EMPTY'});}
  })();return true;
 });
})();
