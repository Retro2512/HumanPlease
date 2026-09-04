interface SlugManifest {
  schemaVersion: 1;
  slugs: string[];
}

const manifestCache = new WeakMap<object, { expiresAt: number; slugs: Set<string>; ordered: string[] }>();
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const MAX_SLUGS = 50_000;

export async function loadSlugManifest(namespace: KVNamespace): Promise<{ slugs: Set<string>; ordered: string[] }> {
  const cached = manifestCache.get(namespace as object);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const manifest = await namespace.get<SlugManifest>('manifest:v1', 'json');
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.slugs)) {
    throw new Error('slug_manifest_unavailable');
  }
  const ordered = manifest.slugs.filter((slug): slug is string => typeof slug === 'string' && SLUG.test(slug));
  if (
    ordered.length !== manifest.slugs.length ||
    ordered.length > MAX_SLUGS ||
    new Set(ordered).size !== ordered.length
  ) throw new Error('slug_manifest_invalid');
  const entry = { expiresAt: Date.now() + 300_000, slugs: new Set(ordered), ordered };
  manifestCache.set(namespace as object, entry);
  return entry;
}
