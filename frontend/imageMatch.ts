export type ImageEvidence={embedding:number[];hash:number[];contrast:number};
export type ImageComparison={id:string;cosine:number;structure:number;accepted:boolean};
export function compareEvidence(reference:ImageEvidence,candidate:ImageEvidence,id:string):ImageComparison{
 const a=reference.embedding,b=candidate.embedding;
 let dot=0,aa=0,bb=0;
 if(a.length!==b.length||!a.length)return{id,cosine:0,structure:0,accepted:false};
 for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
 const cosine=dot/Math.sqrt(aa*bb);
 const validHashes=reference.hash.length===64&&candidate.hash.length===64;
 const structure=validHashes?reference.hash.filter((v,i)=>v===candidate.hash[i]).length/64:0;
 // Absolute gates, not a top-k/softmax: even the best result can be rejected.
 // These are conservative similarity heuristics, not proof of an exact SKU.
 const accepted=Number.isFinite(cosine)&&cosine>=0.92&&structure>=0.875&&reference.contrast>=0.025&&candidate.contrast>=0.025;
 return {id,cosine:Number.isFinite(cosine)?cosine:0,structure,accepted};
}
export function imageShape(rgb:Uint8Array|Uint8ClampedArray,channels:number):Pick<ImageEvidence,'hash'|'contrast'>{
 const gray=Array.from({length:72},(_,i)=>(rgb[i*channels]+rgb[i*channels+1]+rgb[i*channels+2])/765);
 const mean=gray.reduce((a,b)=>a+b,0)/gray.length;
 const contrast=Math.sqrt(gray.reduce((n,x)=>n+(x-mean)**2,0)/gray.length);
 const hash:number[]=[];for(let y=0;y<8;y++)for(let x=0;x<8;x++)hash.push(Number(gray[y*9+x]>gray[y*9+x+1]));
 return {hash,contrast};
}
