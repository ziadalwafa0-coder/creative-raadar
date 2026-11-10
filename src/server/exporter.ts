import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import type { Response } from 'express';
import type { Project, CandidateAsset } from '../types/index.ts';
import { sanitizeCsvField } from '../utils/security.server.ts';
import { getExportFolderName } from '../utils/rules.ts';
import { pinCachedFile, resolveBestLocalMediaForAsset } from './downloader.ts';

export function makeSafeAsciiZipFilename(
  index: number,
  platform: string,
  idOrAsin: string,
  ext: string
): string {
  const cleanPlatform = (platform || 'media').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'media';
  const cleanId = (idOrAsin || `item_${index + 1}`)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 36) || `item_${index + 1}`;
  const cleanExt = (ext || 'mp4').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'mp4';
  const prefix = String(index + 1).padStart(2, '0');
  return `${prefix}_${cleanPlatform}_${cleanId}.${cleanExt}`;
}

export function makeSafeAsciiRootDirName(rawName: string, dateStr: string): string {
  const asciiPart = (rawName || 'Creative_Radaar_Export')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 36);
  return `${asciiPart || 'Creative_Radaar_Export'}_${dateStr}`;
}

/**
 * Builds and streams a ZIP export archive to the client.
 * Returns HTTP 409 with an Arabic JSON error if zero items/files/links are available.
 */
export async function streamExportArchive(
  project: Project,
  assets: CandidateAsset[],
  res: Response
): Promise<void> {
  if (!assets || assets.length === 0) {
    res.status(409).json({
      error: 'لا توجد عناصر محددة للتصدير. يرجى تحديد عنصر واحد على الأقل.',
      code: 'NO_ASSETS_SELECTED',
    });
    return;
  }

  // Prepare all selected items before sending ZIP headers
  const preparedItems = await Promise.all(
    assets.map(async (asset, idx) => {
      const resolved = await resolveBestLocalMediaForAsset(asset, AbortSignal.timeout(20_000));
      if (resolved.status === 'ready' && resolved.localFilePath) {
        asset.downloadStatus = 'verified_available';
        asset.localFilePath = resolved.localFilePath;
        asset.fileSizeBytes = resolved.fileSizeBytes || asset.fileSizeBytes;
      }
      return { asset, idx, resolved };
    })
  );

  const readyCount = preparedItems.filter((p) => p.resolved.status === 'ready').length;
  const linkOnlyCount = preparedItems.filter((p) => p.resolved.status === 'link_only').length;

  if (readyCount === 0 && linkOnlyCount === 0) {
    res.status(409).json({
      error: 'لا توجد ملفات أو روابط صالحة للتصدير في العناصر المحددة.',
      code: 'NO_EXPORTABLE_ITEMS',
    });
    return;
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const rootDirName = makeSafeAsciiRootDirName(
    project.productProfile?.suggestedNameEn || project.name || 'Creative_Radaar_Export',
    dateStr
  );

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${rootDirName}.zip"`
  );

  const unpins: Array<() => void> = [];
  const cleanupAllPins = () => {
    while (unpins.length > 0) {
      const u = unpins.pop();
      try {
        u?.();
      } catch {}
    }
  };

  res.on('close', cleanupAllPins);

  const archive = new ZipArchive({
    store: true,
    zlib: { level: 0 },
  });

  const streamDonePromise = new Promise<void>((resolve, reject) => {
    res.on('close', () => resolve());
    res.on('finish', () => resolve());
    archive.on('error', (err) => reject(err));
  });

  archive.on('warning', (err: any) => {
    if (err.code === 'ENOENT') {
      console.warn('[Export Archive] Non-fatal ENOENT warning:', err.message);
    } else {
      console.warn('[Export Archive] Warning:', err);
    }
  });

  archive.on('error', (err) => {
    cleanupAllPins();
    console.error('[Export Archive Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Archive generation failed' });
    }
  });

  archive.pipe(res);

  const manifestHeaders = [
    'title',
    'source',
    'url',
    'embed_url',
    'status',
    'reason',
    'tier',
    'filename',
  ];
  const manifestRows: string[] = [manifestHeaders.map(sanitizeCsvField).join(',')];
  const linksLines: string[] = [
    `# Creative Radaar Export Links — ${project.name} (${new Date().toISOString()})`,
    `# Total Selected: ${assets.length} | Ready Files: ${readyCount} | Link-Only: ${linkOnlyCount}`,
    '',
  ];

  const usedFilenames = new Set<string>();

  for (const { asset, idx, resolved } of preparedItems) {
    let zipRelativePath = '';
    if (resolved.status === 'ready' && resolved.localFilePath && fs.existsSync(resolved.localFilePath)) {
      const unpin = pinCachedFile(resolved.localFilePath);
      unpins.push(unpin);

      const folder = getExportFolderName(asset);
      const ext =
        path.extname(resolved.localFilePath).slice(1) ||
        (asset.mediaType === 'video' ? 'mp4' : 'jpg');
      let safeFile = makeSafeAsciiZipFilename(
        idx,
        asset.platform || 'amazon',
        asset.asin || asset.platformAssetId || asset.id,
        ext
      );
      while (usedFilenames.has(`${folder}/${safeFile}`)) {
        safeFile = `${idx + 1}_${Date.now().toString(36)}_${safeFile}`;
      }
      usedFilenames.add(`${folder}/${safeFile}`);
      zipRelativePath = `${rootDirName}/${folder}/${safeFile}`;

      archive.append(fs.createReadStream(resolved.localFilePath), { name: zipRelativePath });
    }

    const canonicalUrl = asset.sourceUrl || asset.productListingUrl || asset.mediaUrl || '';
    const embedUrl =
      asset.platform === 'tiktok' && canonicalUrl.includes('/video/')
        ? `https://www.tiktok.com/embed/v2/${canonicalUrl.split('/video/')[1]?.split(/[?#]/)[0] || ''}`
        : canonicalUrl;
    const itemStatus =
      resolved.status === 'ready'
        ? 'ready'
        : resolved.status === 'link_only'
        ? 'link_only'
        : `failed:${resolved.reason || 'unavailable'}`;
    const itemTier = asset.verdictTier || asset.matchCategory || 'exact';

    manifestRows.push(
      [
        asset.title || '',
        asset.platform || 'amazon',
        canonicalUrl,
        embedUrl,
        itemStatus,
        resolved.reason || '',
        itemTier,
        zipRelativePath,
      ]
        .map(sanitizeCsvField)
        .join(',')
    );

    linksLines.push(
      `[${idx + 1}] (${asset.platform} | ${itemStatus} | tier=${itemTier}) ${asset.title || asset.id}`
    );
    linksLines.push(`    URL: ${canonicalUrl}`);
    if (embedUrl && embedUrl !== canonicalUrl) {
      linksLines.push(`    Embed: ${embedUrl}`);
    }
    if (zipRelativePath) {
      linksLines.push(`    File: ${zipRelativePath}`);
    }
    linksLines.push('');
  }

  const manifestCsv = '\uFEFF' + manifestRows.join('\r\n');
  archive.append(manifestCsv, { name: `${rootDirName}/manifest.csv` });
  archive.append(manifestCsv, { name: `${rootDirName}/Sources.csv` });
  archive.append(linksLines.join('\r\n'), { name: `${rootDirName}/links.txt` });
  archive.append(
    JSON.stringify(
      {
        project: {
          id: project.id,
          name: project.name,
          exportedAt: new Date().toISOString(),
        },
        assetsCount: assets.length,
        readyFilesCount: readyCount,
        linkOnlyCount,
        assets,
      },
      null,
      2
    ),
    { name: `${rootDirName}/Sources.json` }
  );

  try {
    await archive.finalize();
    await streamDonePromise;
  } finally {
    cleanupAllPins();
  }
}
