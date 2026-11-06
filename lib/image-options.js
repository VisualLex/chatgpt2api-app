/** Image preferences and safe size resolution for the DSH Host. */
export const IMAGE_TIERS = Object.freeze(['auto', '1k', '2k', '4k']);
export const DEFAULT_IMAGE_PREFERENCES = Object.freeze({defaultModel:'gpt-image-2', defaultImageTier:'auto'});
const SIZES = Object.freeze({
  '1:1': { '1k':'1024x1024', '2k':'2048x2048', '4k':'4096x4096' },
  '16:9': {'1k':'1920x1088','2k':'2560x1440','4k':'3840x2160'},
  '9:16': {'1k':'1088x1920','2k':'1440x2560','4k':'2160x3840'},
  '3:2': {'1k':'1536x1024','2k':'2400x1600','4k':'3600x2400'},
  '2:3': {'1k':'1024x1536','2k':'1600x2400','4k':'2400x3600'},
  '4:3': {'1k':'1365x1024','2k':'2560x1920','4k':'3840x2880'},
  '3:4': {'1k':'1024x1365','2k':'1920x2560','4k':'2880x3840'}
});
export function validateImageTier(value) {
  const tier = String(value || '').toLowerCase().trim();
  if (!IMAGE_TIERS.includes(tier)) throw new TypeError('分辨率档位只支持 auto、1k、2k、4k');
  return tier;
}
export function validateModel(value) {
  const model = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(model)) throw new TypeError('模型名称无效');
  return model;
}
export function validateImageSize(value) {
  const size = String(value || '').trim();
  if (size === 'auto') return size;
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  if (!match || +match[1] < 256 || +match[2] < 256 || +match[1] > 8192 || +match[2] > 8192) {
    throw new TypeError('图片尺寸必须为 auto 或 256–8192 范围内的 宽x高');
  }
  return size;
}
export function detectAspectRatio(input = {}) {
  const explicit = String(input.aspect_ratio || input.aspectRatio || '').trim();
  if (explicit) {
    if (!Object.hasOwn(SIZES, explicit)) throw new TypeError('暂不支持该图片比例');
    return explicit;
  }
  const text = String(input.prompt || '');
  // Only infer clearly written numeric ratios; never guess based on prose.
  const match = /(?:^|[^\d])(?:比例|画幅|aspect\s*ratio)?\s*(1\s*:\s*1|16\s*:\s*9|9\s*:\s*16|3\s*:\s*2|2\s*:\s*3|4\s*:\s*3|3\s*:\s*4)(?!\d)/i.exec(text);
  return match ? match[1].replace(/\s/g,'') : '';
}
export function resolveImageSize(input = {}, preferences = DEFAULT_IMAGE_PREFERENCES) {
  // Explicit pixel dimensions always win over saved preferences.
  if (input.size !== undefined && input.size !== null && String(input.size).trim()) return validateImageSize(input.size);
  const tier = validateImageTier(input.resolution || input.imageTier || preferences.defaultImageTier || 'auto');
  if (tier === 'auto') return undefined;
  const ratio = detectAspectRatio(input);
  // Without a ratio, do not invent a crop or aspect ratio on behalf of the user.
  if (!ratio) return undefined;
  return SIZES[ratio][tier];
}
