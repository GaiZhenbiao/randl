// The files of a logged W&B media value (docs/plugins.md#media-data). A single file
// (`image-file`, `video-file`, `audio-file`, ...) is one item; a list logged under one key is
// a collection: `images/separated` lists `filenames`, `videos`, `audio` and `html` list file
// descriptors, and `object3D` lists `objects`. Collections may carry `captions` (or `false`)
// and other arrays parallel to the files. Shared by the backend and the browser bundle.

export type MediaItem = {
  path: string;
  caption?: string;
  sha256?: string;
  width?: number;
  height?: number;
};
type Value = Record<string, any>;
/** The field of each collection type that lists its files as descriptors. */
const descriptorLists: Record<string, string> = {
  videos: 'videos',
  audio: 'audio',
  html: 'html',
  object3D: 'objects',
};
function listKey(value: Value) {
  const key = descriptorLists[value._type];
  if (key && Array.isArray(value[key])) return key;
  return Array.isArray(value.filenames) ? 'filenames' : undefined;
}
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const size = (value: unknown) => (typeof value === 'number' && value > 0 ? value : undefined);

/** The files of a logged value, in logged order; none for values without files. */
export function mediaItems(value: unknown): MediaItem[] {
  if (!value || typeof value !== 'object') return [];
  const v = value as Value,
    key = listKey(v);
  if (!key) return typeof v.path === 'string' ? [item(v, v.caption)] : [];
  const captions = Array.isArray(v.captions) ? v.captions : [];
  return (v[key] as unknown[]).flatMap((entry, index) => {
    if (key === 'filenames')
      return typeof entry === 'string'
        ? [{ ...item({ width: v.width, height: v.height }, captions[index]), path: entry }]
        : [];
    const file = entry as Value;
    return file && typeof file.path === 'string'
      ? [item(file, captions[index] ?? file.caption)]
      : [];
  });
}
function item(file: Value, caption: unknown): MediaItem {
  const result: MediaItem = { path: file.path };
  if (text(caption)) result.caption = caption as string;
  if (text(file.sha256)) result.sha256 = file.sha256;
  if (size(file.width) && size(file.height)) {
    result.width = file.width;
    result.height = file.height;
  }
  return result;
}
/** The number of files of a logged value; a value without files counts as one entry. */
export function mediaCount(value: unknown) {
  if (!value || typeof value !== 'object') return 0;
  const key = listKey(value as Value);
  return key ? (value as Value)[key].length : 1;
}
/**
 * The value with only its first `count` files: the file list and every array parallel to it
 * (captions, durations, sample rates, masks, boxes) are shortened together.
 */
export function limitMedia<T>(value: T, count: number): T {
  if (!value || typeof value !== 'object') return value;
  const v = value as Value,
    key = listKey(v);
  if (!key || v[key].length <= count) return value;
  const length = v[key].length;
  return Object.fromEntries(
    Object.entries(v).map(([name, field]) => [
      name,
      Array.isArray(field) && field.length === length ? field.slice(0, count) : field,
    ]),
  ) as T;
}
