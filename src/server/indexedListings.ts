import {resolveProductIdentityFromUrl,evaluateStrictProductTitleMatch} from './queryBuilder.ts';
import type {AmazonUsProductCandidate} from './amazonSearch.ts';

// An index only supplies leads. Re-open the canonical Amazon listing for its
// own title and product image before it can enter the normal matching process.
export async function discoverIndexedListings(query:string,signal?:AbortSignal,request=fetch,resolve=resolveProductIdentityFromUrl){
  const url=new URL('https://search.brave.com/search');
  url.searchParams.set('q','site:amazon.com '+query);
  const timeout=AbortSignal.timeout(12000);
  const bounded=signal?AbortSignal.any([signal,timeout]):timeout;
  const response=await request(url,{signal:bounded,headers:{Accept:'text/html'}});
  if(!response.ok)return [];
  const html=await response.text();
  const ids=new Set<string>();
  for(const match of html.matchAll(/<a\s[^>]*?href=["']https:\/\/(?:www\.)?amazon\.com\/(?:[^"'?#\s]*?\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})(?=[/"'?#])/gi)){
    ids.add(match[1].toUpperCase());
    if(ids.size===6)break;
  }
  const candidates:AmazonUsProductCandidate[]=[];
  const list=[...ids];
  for(let i=0;i<list.length;i+=3){
    signal?.throwIfAborted();
    if(timeout.aborted)break;
    const rows=await Promise.all(list.slice(i,i+3).map(async asin=>{
      const url='https://www.amazon.com/dp/'+asin;
      const item=await resolve(url,bounded);
      if(!item?.imageUrl||!evaluateStrictProductTitleMatch(item.extractedTitle,query).approved)return null;
      return {asin,url,title:item.extractedTitle,imageUrl:item.imageUrl,ratingCount:0};
    }));
    for(const row of rows)if(row)candidates.push(row);
    if(candidates.length>=2)break;
  }
  return candidates;
}
