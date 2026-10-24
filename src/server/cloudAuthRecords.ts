import {get, put, del, BlobPreconditionFailedError} from '@vercel/blob';

// One private object per session/counter, not a whole-file shared session database.
// Cache bypass is required so logout/revocation applies across instances immediately.
export const cloudAuthRecords = {
  async read<T>(key: string): Promise<{value:T; etag:string}|null> {
    const result = await get(`auth/${key}.json`, {access:'private', useCache:false});
    if (!result || result.statusCode !== 200) return null;
    const value = await new Response(result.stream).json() as T;
    return {value, etag:result.blob.etag};
  },
  async write(key: string, value: unknown, etag?: string): Promise<void> {
    await put(`auth/${key}.json`, JSON.stringify(value), {
      access:'private', addRandomSuffix:false, contentType:'application/json',
      ...(etag ? {ifMatch:etag} : {allowOverwrite:false}),
    });
  },
  async remove(key: string): Promise<void> {
    await del(`auth/${key}.json`);
  },
};

export async function updateCloudCounter(key: string, update: (value: {count:number;resetAt:number}|null)=>{count:number;resetAt:number}): Promise<void> {
  for (let attempt=0; attempt<5; attempt++) {
    const before = await cloudAuthRecords.read<{count:number;resetAt:number}>(key);
    try {
      await cloudAuthRecords.write(key, update(before?.value || null), before?.etag);
      return;
    } catch(error) {
      if (!(error instanceof BlobPreconditionFailedError) && !(error instanceof Error && /already exists/i.test(error.message))) throw error;
    }
  }
  throw new Error('Concurrent auth counter update did not settle');
}
