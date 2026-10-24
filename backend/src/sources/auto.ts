import {SourceError,type Marketplace,type VideoSource} from '../types.ts';
export class AutoSource implements VideoSource {
 readonly name='auto';lastSource='public';
 private warnings:SourceError[]=[];
 drainWarnings(){return this.warnings.splice(0);}
 constructor(private publicSource:VideoSource,private provider:VideoSource,private warn:(error:SourceError)=>void){}
 private async fallback<T>(run:(source:VideoSource)=>Promise<T[]>):Promise<T[]>{
  try{this.lastSource='public';const result=await run(this.publicSource);if(result.length)return result;}
  catch(error){if(!(error instanceof SourceError))throw error;this.warnings.push(error);this.warn(error);}
  this.lastSource='provider';return run(this.provider);
 }
 search(q:string,m:Marketplace,s?:AbortSignal){return this.fallback(source=>source.search(q,m,s));}
 getCustomerVideos(a:string,m:Marketplace,s?:AbortSignal){return this.fallback(source=>source.getCustomerVideos(a,m,s));}
 async close(){await this.publicSource.close?.();await this.provider.close?.();}
}
