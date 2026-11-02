type Asset={platform?:string;sourceUrl?:string;mediaUrl?:string;mediaType?:string;sha256?:string};
export function videoKeys(asset:Asset):string[]{
  if(asset.mediaType!=='video')return asset.mediaUrl?[asset.mediaUrl]:[];
  const keys:string[]=[];
  if(asset.sha256)keys.push('hash:'+asset.sha256);
  const post=asset.sourceUrl?.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/i)?.[1];
  if(post)keys.push('tiktok:'+post);
  if(asset.mediaUrl)try{
    const media=new URL(asset.mediaUrl);
    const stream=media.pathname.match(/vse-vms-transcoding-artifact[^/]*\/([^/]+)\//i)?.[1];
    if(stream)keys.push('amazon:'+stream.toLowerCase());
    keys.push(media.origin+media.pathname);
  }catch{keys.push(asset.mediaUrl);}
  return keys;
}
