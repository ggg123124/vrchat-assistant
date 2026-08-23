/**
 * 媒体 handler — Boop emoji / Print 相册 / Gallery 图库 / 上传 / 下载
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ctx, log } from '../server-context.js';

export function handleGetBoopEmojis() {
  const categories = [
    {
      name: '表情',
      names: ['Angry', 'Blushing', 'Crying', 'Frown', 'Hand Wave', 'Hang Ten', 'In Love', 'Jack O Lantern', 'Kiss', 'Laugh', 'Skull', 'Smile', 'Spooky Ghost', 'Stoic', 'Sunglasses', 'Thinking', 'Thumbs Down', 'Thumbs Up', 'Tongue Out', 'Wow'],
    },
    {
      name: '指令',
      names: ['Arrow Point', "Can't see", 'Hourglass', 'Keyboard', 'No Headphones', 'No Mic', 'Portal', 'Shush'],
    },
    {
      name: '季节/装饰',
      names: ['Bats', 'Cloud', 'Fire', 'Snow Fall', 'Snowball', 'Splash', 'Web', 'Beer', 'Candy', 'Candy Cane', 'Candy Corn', 'Champagne', 'Drink', 'Gingerbread', 'Ice Cream', 'Pineapple', 'Pizza', 'Tomato', 'Beachball', 'Coal', 'Confetti', 'Gift', 'Gifts', 'Life Ring', 'Mistletoe', 'Money', 'Neon Shades', 'Sun Lotion'],
    },
    {
      name: '通用',
      names: ['Boo', 'Broken Heart', 'Exclamation', 'Go', 'Heart', 'Music Note', 'Question', 'Stop', 'Zzz'],
    },
  ];

  const emojis = [];
  for (const category of categories) {
    for (const name of category.names) {
      emojis.push({
        name,
        emojiId: `default_${name.replace(/ /g, '_').toLowerCase()}`,
        category: category.name,
      });
    }
  }

  return {
    builtinCount: emojis.length,
    format: 'default_<name_lowercase_underscores> (e.g. "Hand Wave" -> default_hand_wave)',
    emojis,
    custom: {
      endpoint: 'POST /file/image (tag: emoji)',
      requiresVRCPlus: true,
      note: '自定义 emoji 用 upload_emoji 工具上传，返回 fileId 用作 emojiId',
    },
  };
}

export async function handleUploadEmoji({ imagePath, animated = false, animationStyle }) {
  const { api } = ctx;
  if (!imagePath) throw new Error('imagePath is required (absolute path to the image file)');
  if (!existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  let fileBuffer;
  try {
    fileBuffer = readFileSync(imagePath);
  } catch (err) {
    throw new Error(`读取图片失败: ${err.message}`);
  }

  const tag = animated ? 'emojianimated' : 'emoji';
  const params = { tag, maskTag: 'square', animationStyle: (animationStyle || 'stop').toLowerCase() };

  const r = await api.uploadImageFile(fileBuffer, imagePath, params);
  if (r.status >= 400) {
    throw new Error(`API error ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  const fileId = r.data?.id;
  if (!fileId) {
    throw new Error(`API 未返回 fileId: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  return { ok: true, fileId, emojiId: fileId, tag, requiresVRCPlus: true };
}

export async function handleUploadPrint({ imagePath, note }) {
  const { api } = ctx;
  if (!imagePath) throw new Error('imagePath is required (absolute path to the image file)');
  if (!existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  let fileBuffer;
  try {
    fileBuffer = readFileSync(imagePath);
  } catch (err) {
    throw new Error(`读取图片失败: ${err.message}`);
  }

  const timestamp = new Date().toISOString().slice(0, 19);
  const r = await api.uploadPrint(fileBuffer, imagePath, { note, timestamp });
  if (r.status >= 400) {
    throw new Error(`API error ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  const printId = r.data?.id;
  if (!printId) {
    throw new Error(`API 未返回 printId: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  return { ok: true, printId, note, timestamp };
}

export async function handleUploadGalleryImage({ imagePath }) {
  const { api } = ctx;
  if (!imagePath) throw new Error('imagePath is required (absolute path to the image file)');
  if (!existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  let fileBuffer;
  try {
    fileBuffer = readFileSync(imagePath);
  } catch (err) {
    throw new Error(`读取图片失败: ${err.message}`);
  }

  const r = await api.uploadGalleryImage(fileBuffer, imagePath);
  if (r.status >= 400) {
    throw new Error(`API error ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  const fileId = r.data?.id;
  if (!fileId) {
    throw new Error(`API 未返回 fileId: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  return { ok: true, fileId, tag: 'gallery' };
}

export async function handleGetPrints({ limit = 100, userId }) {
  const { api } = ctx;
  let targetId = userId;
  if (!targetId) {
    const r = await api._request('GET', '/auth/user');
    if (r.status !== 200) throw new Error(`API error: ${r.status}`);
    targetId = r.data?.id;
  }
  if (!targetId) throw new Error('Unable to determine current user');

  const n = Math.max(1, Math.min(100, Number(limit) || 100));
  const r = await api._request('GET', `/prints/user/${targetId}?n=${n}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const prints = Array.isArray(r.data) ? r.data : [];
  return {
    userId: targetId,
    total: prints.length,
    prints: prints.map(p => ({
      printId: p.id,
      note: p.note,
      createdAt: p.createdAt,
      downloadUrl: p.files?.image,
      timestamp: p.timestamp,
      worldId: p.worldId,
      worldName: p.worldName,
      authorName: p.authorName,
    })),
  };
}

export async function handleRemovePrint({ printId, confirm }) {
  const { api } = ctx;
  if (!printId) throw new Error('printId is required');
  if (!confirm) {
    return { printId, confirmRequired: true, message: '删除相册照片不可逆，请传 confirm: true 确认执行' };
  }
  const r = await api._request('DELETE', `/prints/${printId}`);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { printId, ok: true };
}

export async function handleGetGalleryImages({ limit = 100 }) {
  const { api } = ctx;
  const n = Math.max(1, Math.min(100, Number(limit) || 100));
  const r = await api._request('GET', `/files?tag=gallery&n=${n}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const images = Array.isArray(r.data) ? r.data : [];
  return {
    total: images.length,
    images: images.map(img => {
      const lastVersion = img.versions?.[img.versions.length - 1];
      return {
        fileId: img.id,
        name: img.name,
        extension: img.extension,
        mimeType: img.mimeType,
        downloadUrl: lastVersion?.file?.url,
      };
    }),
  };
}

export async function handleRemoveGalleryImage({ fileId, confirm }) {
  const { api } = ctx;
  if (!fileId) throw new Error('fileId is required');
  if (!confirm) {
    return { fileId, confirmRequired: true, message: '删除图库图片不可逆，请传 confirm: true 确认执行' };
  }
  const r = await api._request('DELETE', `/file/${fileId}`);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { fileId, ok: true };
}

function _extFromContentType(contentType, url) {
  if (contentType) {
    if (contentType.includes('image/png')) return 'png';
    if (contentType.includes('image/jpeg')) return 'jpg';
    if (contentType.includes('image/jpg')) return 'jpg';
    if (contentType.includes('image/gif')) return 'gif';
    if (contentType.includes('image/webp')) return 'webp';
    if (contentType.includes('image/bmp')) return 'bmp';
  }
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (match) return match[1].toLowerCase();
  } catch {}
  return 'png';
}

export async function handleDownloadPrint({ printId, outputDir }) {
  const { api } = ctx;
  if (!printId) throw new Error('printId is required');

  const user = await api.ensureAuth();
  const userId = user?.id;
  if (!userId) throw new Error('Unable to determine current user');

  const r = await api._request('GET', `/prints/user/${userId}?n=100`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const prints = Array.isArray(r.data) ? r.data : [];
  const print = prints.find(p => p.id === printId);
  if (!print) throw new Error(`未找到 printId: ${printId}`);

  const url = print.files?.image;
  if (!url) throw new Error(`未找到 printId: ${printId} 的图片 URL`);

  const buffer = await api.downloadFile(url);

  const ext = _extFromContentType(buffer.contentType, url);
  const dir = outputDir || path.join(ctx.paths.__dirname, 'downloads');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `print_${printId}.${ext}`);
  writeFileSync(filePath, buffer);

  return { ok: true, printId, path: filePath, sizeBytes: buffer.length, url };
}

export async function handleDownloadGalleryImage({ fileId, outputDir }) {
  const { api } = ctx;
  if (!fileId) throw new Error('fileId is required');

  const r = await api._request('GET', `/files?tag=gallery&n=100`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const images = Array.isArray(r.data) ? r.data : [];
  const image = images.find(img => img.id === fileId);
  if (!image) throw new Error(`未找到 fileId: ${fileId}`);

  const lastVersion = image.versions?.[image.versions.length - 1];
  const url = lastVersion?.file?.url;
  if (!url) throw new Error(`未找到 fileId: ${fileId} 的图片 URL`);

  const buffer = await api.downloadFile(url);

  const ext = _extFromContentType(buffer.contentType, url);
  const dir = outputDir || path.join(ctx.paths.__dirname, 'downloads');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `gallery_${fileId}.${ext}`);
  writeFileSync(filePath, buffer);

  return { ok: true, fileId, path: filePath, sizeBytes: buffer.length, url };
}

// ── MCP 自声明工具表 ──
export const tools = [
  {
    "name": "get_boop_emojis",
    "description": "[query] List built-in boop emojis and their emojiId format.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleGetBoopEmojis(args))
  },
  {
    "name": "upload_emoji",
    "description": "[write·vrchat] Upload a custom boop emoji (requires VRChat Plus). Returns fileId to use as emojiId in send_boop.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "imagePath": {
          "type": "string",
          "description": "Absolute path to the image file (e.g. D:/path/emoji.png)"
        },
        "animated": {
          "type": "boolean",
          "description": "Upload as animated emoji",
          "default": false
        },
        "animationStyle": {
          "type": "string",
          "description": "Animation style (e.g. bounce/spin), only used when animated=true"
        }
      },
      "required": [
        "imagePath"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleUploadEmoji(args))
  },
  {
    "name": "upload_print",
    "description": "[write·vrchat] Upload a photo to your VRChat prints album (requires VRChat Plus).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "imagePath": {
          "type": "string",
          "description": "Absolute path to the image file"
        },
        "note": {
          "type": "string",
          "description": "Optional photo note"
        }
      },
      "required": [
        "imagePath"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleUploadPrint(args))
  },
  {
    "name": "upload_gallery_image",
    "description": "[write·vrchat] Upload an image to your VRC+ gallery (requires VRChat Plus).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "imagePath": {
          "type": "string",
          "description": "Absolute path to the image file"
        }
      },
      "required": [
        "imagePath"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleUploadGalleryImage(args))
  },
  {
    "name": "get_prints",
    "description": "[query] List your VRChat prints (VRChat Plus photo album).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "number",
          "default": 100,
          "description": "Max results (1-100, default 100)"
        },
        "userId": {
          "type": "string",
          "description": "VRChat user id (usr_...). Defaults to current user."
        }
      }
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleGetPrints(args))
  },
  {
    "name": "remove_print",
    "description": "[write·vrchat] Remove a print from your VRChat prints album. Requires printId and confirm: true to execute (irreversible).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "printId": {
          "type": "string",
          "description": "Print ID (prnt_...)"
        },
        "confirm": {
          "type": "boolean",
          "description": "Set true to actually remove the print (irreversible). Default false returns preview only."
        }
      },
      "required": [
        "printId"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleRemovePrint(args))
  },
  {
    "name": "get_gallery_images",
    "description": "[query] List your VRChat gallery images (VRChat Plus).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "number",
          "default": 100,
          "description": "Max results (1-100, default 100)"
        }
      }
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleGetGalleryImages(args))
  },
  {
    "name": "remove_gallery_image",
    "description": "[write·vrchat] Remove an image from your VRChat gallery. Requires fileId and confirm: true to execute (irreversible).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "File ID (file_...)"
        },
        "confirm": {
          "type": "boolean",
          "description": "Set true to actually remove the gallery image (irreversible). Default false returns preview only."
        }
      },
      "required": [
        "fileId"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleRemoveGalleryImage(args))
  },
  {
    "name": "download_print",
    "description": "[query] Download a photo from your VRChat prints album to local disk. Returns local file path.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "printId": {
          "type": "string",
          "description": "Print ID (prnt_...)"
        },
        "outputDir": {
          "type": "string",
          "description": "Optional output directory. Defaults to <service>/downloads/"
        }
      },
      "required": [
        "printId"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleDownloadPrint(args))
  },
  {
    "name": "download_gallery_image",
    "description": "[query] Download an image from your VRC+ gallery to local disk. Returns local file path.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fileId": {
          "type": "string",
          "description": "File ID (file_...)"
        },
        "outputDir": {
          "type": "string",
          "description": "Optional output directory. Defaults to <service>/downloads/"
        }
      },
      "required": [
        "fileId"
      ]
    },
    handler: async (args) => ctx.rateLimiter.execute(() => handleDownloadGalleryImage(args))
  }
];
