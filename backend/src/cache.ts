import {createClient,type SupabaseClient} from '@supabase/supabase-js';
import type {Marketplace,ProductHit,ReviewVideo} from './types.ts';
import {normalizeQuery} from './utils.ts';
type Entry={value:unknown;expires:number};
export interface MediaCache {
 getSearch(market:Marketplace,q:string):Promise<ProductHit[]|undefined>;
 setSearch(market:Marketplace,q:string,hits:ProductHit[]):Promise<void>;
 getProduct(market:Marketplace,asin:string):Promise<ReviewVideo[]|undefined>;
 setProduct(market:Marketplace,asin:string,videos:ReviewVideo[]):Promise<void>;
}
export class Cache implements MediaCache {
 private memory=new Map<string,Entry>();private db?:SupabaseClient;
 constructor(private logger:{warn:(value:unknown,message?:string)=>void},url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_KEY){if(url&&key)this.db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});}
 private async get(table:string,market:Marketplace,key:string):Promise<unknown>{
  const id=`${table}:${market}:${key}`;const entry=this.memory.get(id);
  if(entry&&entry.expires>Date.now())return entry.value;if(entry)this.memory.delete(id);
  if(this.db){const {data,error}=await this.db.from(table).select('payload,expires_at').eq('marketplace',market).eq('cache_key',key).gt('expires_at',new Date().toISOString()).maybeSingle();if(error){this.logger.warn({table,code:error.code},'cache read failed');return;}if(data){this.memory.set(id,{value:data.payload,expires:Date.parse(data.expires_at)});return data.payload;}}
 }
 private async set(table:string,market:Marketplace,key:string,value:unknown,ttl:number){
  const expires=Date.now()+ttl;
  for(const [k,v]of this.memory)if(v.expires<=Date.now())this.memory.delete(k);
  if(this.memory.size>=1000)this.memory.delete(this.memory.keys().next().value!);
  this.memory.set(`${table}:${market}:${key}`,{value,expires});
  if(this.db){const {error}=await this.db.from(table).upsert({marketplace:market,cache_key:key,payload:value,expires_at:new Date(expires).toISOString()},{onConflict:'marketplace,cache_key'});if(error)this.logger.warn({table,code:error.code},'cache write failed');}
 }
 async getSearch(m:Marketplace,q:string){const data=await this.get('search_cache',m,normalizeQuery(q));return Array.isArray(data)?data as ProductHit[]:undefined;}
 async setSearch(m:Marketplace,q:string,v:ProductHit[]){await this.set('search_cache',m,normalizeQuery(q),v,3600000);}
 async getProduct(m:Marketplace,a:string){const data=await this.get('product_media_cache',m,a);return Array.isArray(data)?data as ReviewVideo[]:undefined;}
 async setProduct(m:Marketplace,a:string,v:ReviewVideo[]){await this.set('product_media_cache',m,a,v,(v.length?24:6)*3600000);}
}
