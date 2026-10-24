export const markets = {
 'amazon.com': {host:'www.amazon.com',country:'us',locale:'en-US'},
 'amazon.eg': {host:'www.amazon.eg',country:'eg',locale:'ar-EG'},
 'amazon.sa': {host:'www.amazon.sa',country:'sa',locale:'ar-SA'},
 'amazon.ae': {host:'www.amazon.ae',country:'ae',locale:'en-AE'},
} as const;
export type Marketplace=keyof typeof markets;
export interface ProductHit {asin:string;title:string;ratingsCount:number;rating?:number;url:string}
export interface ReviewVideo {url:string;type:'mp4'|'hls';poster?:string;title?:string;sentiment?:'positive'|'negative'|'mixed';sourceAsin:string;sourceUrl:string;customerReview:true}
export interface VideoSource {
 readonly name:string;
 search(query:string,marketplace:Marketplace,signal?:AbortSignal):Promise<ProductHit[]>;
 getCustomerVideos(asin:string,marketplace:Marketplace,signal?:AbortSignal):Promise<ReviewVideo[]>;
 close?():Promise<void>;
}
export type ErrorCode='LOGIN_WALL'|'CAPTCHA'|'NOT_FOUND'|'BLOCKED'|'PARSE_EMPTY'|'CONFIG'|'PROVIDER_ERROR'|'NETWORK';
export class SourceError extends Error {
 constructor(public code:ErrorCode,message:string,public snapshot?:string){super(message);}
}
export type SearchEvent = ({type:'video';video:ReviewVideo}|{type:'progress';index:number;total:number;asin?:string;cached?:boolean}|{type:'warn';reason:string;code?:string}|{done:true;count:number}) & {id:string};
