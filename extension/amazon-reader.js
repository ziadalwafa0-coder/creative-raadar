// Only reads a product page the user has already opened. Never navigates or solves a challenge.
(() => {
 const fields=['creatorType','fullReviewLink','aciContentId','segmentName','productAsin','relatedProductsAsins','videoURL','videoImageUrlUnchanged','hiResVideoImageUrl','videoImageUrl','title'];
 const escape=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const media=url=>{try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['m.media-amazon.com','images-na.ssl-images-amazon.com','images-eu.ssl-images-amazon.com','images-fe.ssl-images-amazon.com'].includes(u.hostname)?u.href:'';}catch{return '';}};
 chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||message?.operation!=='cr-read-open-product')return false;
  try{
   const market=location.hostname.replace(/^www\./,'');const asin=location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
   if(!['amazon.com','amazon.eg','amazon.sa','amazon.ae'].includes(market)||!asin)throw Error('افتح صفحة المنتج نفسها على أمازون، وليس صفحة البحث');
   const text=document.body?.innerText||'';
   if(/Robot Check|validateCaptcha|Enter the characters you see|verify.*human|Click the button below to continue shopping/i.test(text)||document.querySelector('form[action*="validateCaptcha"],#captchacharacters')){respond({error:'أمازون يعرض صفحة تحقق؛ لم تُقرأ الصفحة. أكملها بنفسك إن رغبت ثم ارجع للموقع.',code:'CAPTCHA'});return false;}
   if(document.querySelector('form[name="signIn"],input[type="password"]')){respond({error:'هذه صفحة تسجيل دخول؛ لم تُقرأ أي بيانات.',code:'LOGIN_WALL'});return false;}
   const title=document.querySelector('#productTitle')?.textContent?.trim();
   if(!title)throw Error('صفحة المنتج لم تكتمل أو غير متاحة. لم نقرأها.');
   const pageAsin=document.querySelector('input#ASIN')?.getAttribute('value');
   if(pageAsin&&pageAsin!==asin)throw Error('الاختيار المعروض يخص موديلًا مختلفًا؛ افتح رابط الموديل الصحيح أولًا');
   const imageUrl=media(document.querySelector('#landingImage,#imgBlkFront')?.getAttribute('src')||'');
   let html='<html><head><title>Amazon public product</title></head><body><div id="customer-reviews_feature_div"></div>';
   for(const node of document.querySelectorAll('[data-video-items]')){
    let items;try{items=JSON.parse(node.getAttribute('data-video-items')||'[]');}catch{continue;}
    if(!Array.isArray(items))continue;
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
   respond({html,market,asin,title:title.slice(0,500),imageUrl});
  }catch(error){respond({error:error instanceof Error?error.message:'تعذر قراءة الصفحة',code:'PARSE_EMPTY'});}
  return false;
 });
})();
