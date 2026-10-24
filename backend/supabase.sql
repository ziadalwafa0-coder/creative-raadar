-- Cache metadata and source URLs only. Never video binaries, accounts or cookies.
create table if not exists public.product_media_cache (
 marketplace text not null,
 cache_key text not null,
 payload jsonb not null,
 expires_at timestamptz not null,
 primary key (marketplace, cache_key)
);
create table if not exists public.search_cache (
 marketplace text not null,
 cache_key text not null,
 payload jsonb not null,
 expires_at timestamptz not null,
 primary key (marketplace, cache_key)
);
alter table public.product_media_cache enable row level security;
alter table public.search_cache enable row level security;
revoke all on public.product_media_cache from anon, authenticated;
revoke all on public.search_cache from anon, authenticated;
create index if not exists product_media_cache_expiry on public.product_media_cache(expires_at);
create index if not exists search_cache_expiry on public.search_cache(expires_at);
