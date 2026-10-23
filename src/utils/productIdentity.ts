import { createHash } from 'node:crypto';
import type { Project } from '../types/index.ts';

export function productInputFingerprint(project: Pick<Project, 'name'|'referenceImages'|'productListingUrl'|'userNotes'>): string {
  return createHash('sha256').update(JSON.stringify({
    name: project.name.trim().normalize('NFKC'),
    listing: project.productListingUrl?.trim() || '',
    notes: project.userNotes?.trim() || '',
    images: (project.referenceImages || []).map(image => image.base64Data || image.url),
  })).digest('hex');
}

/** Existing results are retained in history, never relabelled as the new product. */
export function prepareSearchIdentity(project: Project): string {
  const fingerprint = productInputFingerprint(project);
  if (project.searchInputFingerprint !== fingerprint) {
    if (project.candidates.length || project.productProfile) {
      project.previousSearches ??= [];
      project.previousSearches.push({fingerprint: project.searchInputFingerprint, archivedAt: new Date().toISOString(), productProfile: project.productProfile, candidates: project.candidates});
    }
    project.candidates = [];
    project.productProfile = undefined;
    project.searchInputFingerprint = fingerprint;
    project.counters = {...project.counters, candidatesDiscovered: 0, sourcesInspected: 0, visuallyMatchedAssets: 0, downloadedAssets: 0, verifiedAssets: 0, rejectedDuplicates: 0};
  }
  project.candidates = project.candidates.filter(candidate => candidate.projectId === project.id && candidate.searchInputFingerprint === fingerprint);
  return fingerprint;
}
