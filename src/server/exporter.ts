import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive, type ZipEntryData } from 'archiver';
import type { Response } from 'express';
import type { Project, CandidateAsset } from '../types/index.ts';
import { sanitizeCsvField } from '../utils/security.server.ts';
import { getExportFolderName } from '../utils/rules.ts';

/**
 * Builds and streams a ZIP export archive to the client.
 * Blocks empty ZIP archives with an informative message.
 */
export async function streamExportArchive(
  project: Project,
  assets: CandidateAsset[],
  res: Response
): Promise<void> {
  // Requirement 5: Block empty ZIP as video/photo success
  if (!assets || assets.length === 0) {
    res.status(400).json({
      error: 'لا توجد عناصر محددة للتصدير. يرجى تحديد عنصر واحد على الأقل.',
      code: 'NO_ASSETS_SELECTED',
    });
    return;
  }

  // Auto-download any assets that have a valid mediaUrl but haven't been saved to disk yet
  const pendingToDownload = assets.filter(
    (a) =>
      (!a.localFilePath || !fs.existsSync(a.localFilePath)) &&
      a.mediaUrl &&
      !a.mediaUrl.includes('youtube.com') &&
      !a.mediaUrl.includes('youtu.be')
  );
  if (pendingToDownload.length > 0) {
    try {
      const { downloadMedia } = await import('./downloader.ts');
      const batchSize = 6;
      for (let i = 0; i < pendingToDownload.length; i += batchSize) {
        const batch = pendingToDownload.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (asset) => {
            if (!asset.mediaUrl) return;
            const resDl = await downloadMedia(asset.mediaUrl, asset.id, asset.mediaType);
            if (resDl.status === 'verified_available' && resDl.localFilePath) {
              asset.downloadStatus = 'verified_available';
              asset.localFilePath = resDl.localFilePath;
              asset.sha256 = resDl.sha256 || asset.sha256;
              asset.fileSizeBytes = resDl.fileSizeBytes || asset.fileSizeBytes;
            }
          })
        );
      }
    } catch {}
  }

  const downloadedAssets = assets.filter(
    (a) => a.downloadStatus === 'verified_available' && a.localFilePath && fs.existsSync(a.localFilePath)
  );
  if (downloadedAssets.length === 0) {
    res.status(400).json({
      error: 'لا توجد ملفات تم تنزيلها بنجاح لتضمينها في الحزمة. يمكنك فتح الروابط المباشرة للمصادر أو إضافة روابط يدوياً.',
      code: 'NO_DOWNLOADED_FILES',
    });
    return;
  }

  const sanitizeName = (name: string) => name.replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, '_').slice(0, 40);
  const dateStr = new Date().toISOString().split('T')[0];
  const rootDirName = `${sanitizeName(project.productProfile?.suggestedNameEn || project.name || 'Creative_Radaar_Export')}_${dateStr}`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(rootDirName)}.zip"`
  );

  const archive = new ZipArchive({
    store: true,
  });

  archive.on('error', (err) => {
    console.error('[Export Archive Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Archive generation failed' });
    }
  });

  archive.pipe(res);

  // 1. Generate Sources.csv with formula injection protection
  const csvHeaders = [
    'Asset ID',
    'Filename',
    'Media Type',
    'Platform',
    'Reviewer / Channel',
    'Product URL',
    'Review URL',
    'Platform Source ID',
    'Provenance Classification',
    'Verified Purchase Evidence',
    'Incentive Disclosure',
    'Match Category',
    'Visible Differences',
    'Content Description',
    'Sentiment',
    'Duration (sec)',
    'Dimensions',
    'Audio Available',
    'Download Status',
    'Verification Status',
    'Collection Timestamp',
    'Rights Status',
  ];

  const csvRows: string[] = [csvHeaders.map(sanitizeCsvField).join(',')];

  for (const asset of assets) {
    const ext = asset.localFilePath
      ? path.extname(asset.localFilePath).slice(1) || (asset.mediaType === 'video' ? 'mp4' : 'jpg')
      : asset.mediaType === 'video'
      ? 'mp4'
      : 'jpg';
    const isDownloaded = asset.downloadStatus === 'verified_available' && asset.localFilePath && fs.existsSync(asset.localFilePath);
    const filename = isDownloaded ? `${asset.id}_${asset.matchCategory}.${ext}` : '';

    const row = [
      asset.id,
      filename,
      asset.mediaType,
      asset.platform,
      asset.reviewerOrChannel || '',
      asset.productListingUrl || '',
      asset.sourceUrl,
      asset.platformAssetId || asset.reviewId || '',
      asset.provenance,
      asset.verifiedPurchaseEvidence || '',
      asset.incentiveDisclosure || '',
      asset.matchCategory,
      (asset.visibleDifferences || []).join('; '),
      asset.contentDescription,
      asset.sentiment || 'neutral',
      asset.durationSeconds ? String(asset.durationSeconds) : '',
      asset.dimensions ? `${asset.dimensions.width}x${asset.dimensions.height}` : '',
      asset.hasAudio ? 'Yes' : 'No',
      asset.downloadStatus,
      isDownloaded ? 'Verified' : 'Source_Only',
      asset.collectedAt,
      asset.rightsStatus || 'unknown',
    ];

    csvRows.push(row.map(sanitizeCsvField).join(','));
  }

  const csvContent = '\uFEFF' + csvRows.join('\r\n'); // UTF-8 BOM for Excel compatibility
  archive.append(csvContent, { name: `${rootDirName}/Sources.csv` });

  // 2. Generate Sources.json
  const jsonContent = JSON.stringify(
    {
      project: {
        id: project.id,
        name: project.name,
        mediaTypeRequested: project.mediaTypeRequested,
        targetVideoCount: project.targetVideoCount,
        targetPhotoCount: project.targetPhotoCount,
        exportedAt: new Date().toISOString(),
        productProfile: project.productProfile,
      },
      assetsCount: assets.length,
      downloadedCount: downloadedAssets.length,
      assets,
    },
    null,
    2
  );
  archive.append(jsonContent, { name: `${rootDirName}/Sources.json` });

  // 3. Generate README.txt
  const readmeContent = `Creative Radaar Product Media Export Package
=====================================================
المشروع: ${project.name}
فئة المنتج: ${project.productProfile?.category || 'General'}
اسم المنتج المقترح: ${project.productProfile?.suggestedNameAr || project.name}
تاريخ التصدير: ${new Date().toISOString()}
إجمالي الأصول: ${assets.length} (المحملة فعلياً: ${downloadedAssets.length})
=====================================================

محتويات الحزمة وتوزيع المجلدات:
- /Customer_Reviews/       : مراجعات وفيديوهات المشترين الحقيقيين وشارات الشراء المؤكد.
- /Creator_Reviews/        : استعراضات صناع المحتوى وتجارب التفكيك والمقارنة.
- /Seller_Demos/           : فيديوهات الكتالوج الرسمي للبائع والمصنع.
- /Photos/                 : الصور المرفوعة أو المستخرجة للمنتج.
- Sources.csv              : سجل التدقيق والتحقق الشامل (محمي ضد Formula Injection).
- Sources.json             : ملف البيانات التقنية المنسق بصيغة JSON.

ملاحظة حقوق النشر والاستخدام التجاري:
Creative Radaar توثق مصدر ومطابقة ميديا المنتج. تنزيل هذه الملفات كأرشيف
لا يمنح ترخيصاً حصرياً أو حقوق ملكية فكرية تجارية لاستخدامها في الحملات الإعلانية المدفوعة
دون إذن صريح من أصحاب المحتوى والمنصات الأصلية.
`;
  archive.append(readmeContent.trim(), { name: `${rootDirName}/README.txt` });

  // 4. Append only real verified downloaded files into respective subfolders
  for (const asset of downloadedAssets) {
    if (asset.localFilePath && fs.existsSync(asset.localFilePath)) {
      const folder = getExportFolderName(asset);
      const ext = path.extname(asset.localFilePath).slice(1) || (asset.mediaType === 'video' ? 'mp4' : 'jpg');
      const fileName = `${asset.id}_${asset.matchCategory}.${ext}`;
      const filePathInZip = `${rootDirName}/${folder}/${fileName}`;
      const zipEntry: ZipEntryData = { name: filePathInZip, store: true };
      archive.file(asset.localFilePath, zipEntry);
    }
  }

  await archive.finalize();
}
