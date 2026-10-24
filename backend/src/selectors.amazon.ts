// Verified against the public /dp/B0DQK9MPS2 DOM and its search results on 2026-10-24.
// Regional layouts must fail explicitly if these observed selectors are absent.
export const amazonSelectors={
 searchRows:['[data-component-type="s-search-result"][data-asin]'],
 searchTitle:['h2','img.s-image'],
 ratings:['a[aria-label*="ratings"]','.s-underline-text'],
 rating:['a[aria-label*="out of 5 stars"]'],
 productTitle:['#productTitle','#title'],
 customerSections:['#customer-reviews_feature_div','#localTopReviews','#localTopReviewsList'],
 structuredVideos:['[data-video-items]'],
};
