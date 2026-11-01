export function reviewTone(title:string,stars?:number){
  if(stars && stars>=1 && stars<=5)return stars>=4?'إيجابي':stars<=2?'سلبي':'محايد';
  const text=(title||'').toLowerCase().replace(/[’‘]/g,"'");
  const negative=/\b(?:not good|not great|not worth|not recommended|wouldn't recommend|do not recommend|don't recommend|doesn't work|didn't work|stopped working|disappointed|terrible|broke|waste of money|worst)\b|سيئ|وحش جدا|مابنصحش|مش حلو/.test(text);
  const positive=/\b(?:love it|love this|works great|works perfectly|highly recommend|worth every penny|excellent|amazing|great product|easy to use)\b|ممتاز|تحفة|أنصح به/.test(text);
  if(negative && positive)return 'مختلط';
  return negative?'سلبي':positive?'إيجابي':'غير واضح';
}
