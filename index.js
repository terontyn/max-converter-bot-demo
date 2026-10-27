import fs from 'fs';
import path from 'path';
import https from 'https';
import tls from 'tls';
import axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp';
import { convertToJpeg, convertImageToPdf } from './lib/conversion.mjs';
import dotenv from 'dotenv';

dotenv.config();

function readTrustedCaFile(filePath) {
  const value = String(filePath || '').trim();
  if (!value) return null;

  const resolvedPath = path.resolve(value);
  try {
    return fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(`MAX_TRUSTED_CA_FILE is set but cannot be read: ${resolvedPath}. ${err.message}`);
  }
}

function createHttpsAgent(maxSockets = 20, trustedCa = null) {
  const options = {
    keepAlive: true,
    maxSockets,
    maxFreeSockets: Math.max(5, Math.floor(maxSockets / 2))
  };

  if (trustedCa) {
    options.ca = [...tls.rootCertificates, trustedCa];
  }

  return new https.Agent(options);
}

const MAX_API = String(process.env.MAX_API_URL || 'https://platform-api2.max.ru').trim().replace(/\/+$/, '');
const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN;
const OUTPUT_MODE = process.env.OUTPUT_MODE || 'both';
const POLL_TIMEOUT = Number(process.env.POLL_TIMEOUT || 30);
const POLL_LIMIT = Number(process.env.POLL_LIMIT || 50);
const MARKER_FILE = process.env.MARKER_FILE || '.max_marker';
const PREFS_FILE = process.env.PREFS_FILE || '.chat_prefs.json';
const MAX_TRUSTED_CA_FILE = process.env.MAX_TRUSTED_CA_FILE || process.env.MINCIFRA_CA_FILE || '';

const BITRIX_WEBHOOK_BASE_URL = process.env.BITRIX_WEBHOOK_BASE_URL || '';
const BITRIX_FOLDER_ID = process.env.BITRIX_FOLDER_ID || '';
const ATTACHMENT_BATCH_WINDOW_MS = 1500;
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
const BITRIX_DISCOVERY_TIMEOUT_MS = 30000;
const POLL_REQUEST_TIMEOUT_MS = Math.max(DEFAULT_REQUEST_TIMEOUT_MS, (POLL_TIMEOUT + 15) * 1000);
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp']);
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jfif',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/webp'
]);
const SUPPORTED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp']);
const SUPPORTED_INPUT_FORMATS_TEXT = 'JFIF, JPG, JPEG (.jpeg), PNG, WEBP';

if (!MAX_BOT_TOKEN) {
  throw new Error('MAX_BOT_TOKEN не задан');
}

const maxTrustedCa = readTrustedCaFile(MAX_TRUSTED_CA_FILE);

const pollHttpsAgent = createHttpsAgent(6, maxTrustedCa);
const apiHttpsAgent = createHttpsAgent(20, maxTrustedCa);
const transferHttpsAgent = createHttpsAgent(20, maxTrustedCa);

const maxPollClient = axios.create({
  baseURL: MAX_API,
  headers: {
    Authorization: MAX_BOT_TOKEN
  },
  httpsAgent: pollHttpsAgent
});

const maxClient = axios.create({
  baseURL: MAX_API,
  headers: {
    Authorization: MAX_BOT_TOKEN
  },
  httpsAgent: apiHttpsAgent
});

const binaryTransferClient = axios.create({
  httpsAgent: transferHttpsAgent,
  maxBodyLength: Infinity,
  maxContentLength: Infinity
});

const pendingAttachmentBatches = new Map();
const batchProcessingChains = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function logInfo(message, details = null) {
  if (details == null) {
    console.log(message);
    return;
  }
  console.log(`${message} ${safeJson(details)}`);
}

function logWarn(message, details = null) {
  if (details == null) {
    console.warn(message);
    return;
  }
  console.warn(`${message} ${safeJson(details)}`);
}

function logError(message, details = null) {
  if (details == null) {
    console.error(message);
    return;
  }
  console.error(`${message} ${safeJson(details)}`);
}

function formatAxiosError(err) {
  return {
    status: err?.response?.status || null,
    code: err?.response?.data?.code || err?.code || null,
    message: err?.message || 'Unknown error',
    apiMessage: err?.response?.data?.message || null,
    data: err?.response?.data || null
  };
}

function createAbortSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      signal: undefined,
      cleanup: () => {}
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(`Request timed out after ${timeoutMs}ms`);
  }, timeoutMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer)
  };
}

async function requestWithTimeout(client, config, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const { signal, cleanup } = createAbortSignal(timeoutMs);

  try {
    return await client.request({
      ...config,
      signal
    });
  } catch (err) {
    if (signal?.aborted && err?.code === 'ERR_CANCELED' && !err?.response) {
      err.code = 'REQUEST_TIMEOUT';
      err.message = typeof signal.reason === 'string' ? signal.reason : `Request timed out after ${timeoutMs}ms`;
    }
    throw err;
  } finally {
    cleanup();
  }
}

function readTextFile(filePath, fallback = null) {
  try {
    return fs.readFileSync(path.resolve(filePath), 'utf8');
  } catch {
    return fallback;
  }
}

function writeTextFile(filePath, value) {
  fs.writeFileSync(path.resolve(filePath), String(value), 'utf8');
}

function readJsonFile(filePath, fallback = {}) {
  try {
    const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(path.resolve(filePath), JSON.stringify(value, null, 2), 'utf8');
}

function readMarker() {
  const value = readTextFile(MARKER_FILE, null);
  return value ? value.trim() : null;
}

function writeMarker(marker) {
  if (!marker) return;
  writeTextFile(MARKER_FILE, marker);
}

function getChatKey(target) {
  if (target.chatId) return `chat:${target.chatId}`;
  if (target.userId) return `user:${target.userId}`;
  return null;
}

function normalizePrefs(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      out[key] = { mode: value, greeted: false, menuMid: null };
    } else if (value && typeof value === 'object') {
      out[key] = {
        mode: value.mode || OUTPUT_MODE,
        greeted: Boolean(value.greeted),
        menuMid: value.menuMid || null
      };
    }
  }
  return out;
}

function getChatPrefs(target) {
  const key = getChatKey(target);
  if (!key) return { mode: OUTPUT_MODE, greeted: false, menuMid: null };
  const prefs = normalizePrefs(readJsonFile(PREFS_FILE, {}));
  return prefs[key] || { mode: OUTPUT_MODE, greeted: false, menuMid: null };
}

function saveChatPrefs(target, nextPrefs) {
  const key = getChatKey(target);
  if (!key) return;
  const prefs = normalizePrefs(readJsonFile(PREFS_FILE, {}));
  prefs[key] = {
    mode: nextPrefs.mode || OUTPUT_MODE,
    greeted: Boolean(nextPrefs.greeted),
    menuMid: nextPrefs.menuMid || null
  };
  writeJsonFile(PREFS_FILE, prefs);
}

function getSavedMode(target) {
  return getChatPrefs(target).mode || OUTPUT_MODE;
}

function saveMode(target, mode) {
  const current = getChatPrefs(target);
  saveChatPrefs(target, { ...current, mode });
}

function getSavedMenuMid(target) {
  return getChatPrefs(target).menuMid || null;
}

function saveMenuMid(target, menuMid) {
  const current = getChatPrefs(target);
  saveChatPrefs(target, { ...current, menuMid });
}

function isFirstSeen(target) {
  return !getChatPrefs(target).greeted;
}

function markGreeted(target) {
  const current = getChatPrefs(target);
  saveChatPrefs(target, { ...current, greeted: true });
}

function extOf(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function baseNameWithoutExt(filename) {
  const ext = extOf(filename);
  if (!ext) return String(filename || 'image');
  return String(filename).slice(0, -ext.length) || 'image';
}

function isSupportedImageExtension(filename) {
  return SUPPORTED_IMAGE_EXTENSIONS.has(extOf(filename));
}

function trimToNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = trimToNull(value);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeMimeType(value) {
  return String(value || '').trim().toLowerCase();
}

function isSupportedImageMimeType(mimeType) {
  return SUPPORTED_IMAGE_MIME_TYPES.has(normalizeMimeType(mimeType));
}

function normalizeSharpFormat(format) {
  const value = String(format || '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'jpg') return 'jpeg';
  return value;
}

function formatModeLabel(mode) {
  if (mode === 'jpeg') return 'JPG';
  if (mode === 'pdf') return 'PDF';
  if (mode === 'both') return 'JPG + PDF';
  return String(mode || OUTPUT_MODE).toUpperCase();
}

function getRuCountForm(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) return 'one';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
  return 'many';
}

function formatFileCount(count) {
  const form = getRuCountForm(count);
  if (form === 'one') return `${count} файл`;
  if (form === 'few') return `${count} файла`;
  return `${count} файлов`;
}

function buildProcessedPhrase(count) {
  return getRuCountForm(count) === 'one'
    ? `обработан ${formatFileCount(count)}`
    : `обработано ${formatFileCount(count)}`;
}

function buildSkippedPhrase(count) {
  return getRuCountForm(count) === 'one'
    ? `пропущен ${formatFileCount(count)}`
    : `пропущено ${formatFileCount(count)}`;
}

function buildModeSavedText(mode) {
  return `Режим: ${formatModeLabel(mode)}. Пришлите изображение.`;
}

function buildIdleMenuText() {
  return 'Пришлите изображение или нажмите «Меню».';
}

function buildCompactMenuText() {
  return 'Нажмите «Меню», чтобы сменить режим.';
}

function parseModeFromText(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t === '/jpeg' || t === '/jpg' || t === 'jpeg' || t === 'jpg') return 'jpeg';
  if (t === '/pdf' || t === 'pdf') return 'pdf';
  if (t === '/both' || t === 'both' || t === 'оба') return 'both';
  return null;
}

function buildHelpText(currentMode) {
  return [
    'Я конвертирую изображения в JPG и PDF.',
    '',
    `Режим: ${formatModeLabel(currentMode)}`,
    '',
    'Поддержка: JFIF, JPG, JPEG, PNG, WEBP.',
    'Подходят обычные фото, файлы без сжатия и пересланные сообщения.',
    '',
    'Сменить режим можно кнопками ниже или командами /jpeg, /pdf, /both.'
  ].join('\n');
}

function buildModeKeyboard(currentMode) {
  return {
    inline_keyboard: [
      [
        { text: currentMode === 'jpeg' ? '✅ JPG' : 'JPG', callback_data: 'mode:jpeg' },
        { text: currentMode === 'pdf' ? '✅ PDF' : 'PDF', callback_data: 'mode:pdf' }
      ],
      [
        { text: currentMode === 'both' ? '✅ JPG + PDF' : 'JPG + PDF', callback_data: 'mode:both' }
      ],
      [
        { text: 'ℹ️ Как работает', callback_data: 'menu:help' },
        { text: '📌 Текущий режим', callback_data: 'menu:status' }
      ]
    ]
  };
}

function buildCompactMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🗂 Меню', callback_data: 'menu:home' }
      ]
    ]
  };
}

function convertKb(replyMarkup) {
  if (!replyMarkup || !replyMarkup.inline_keyboard) return null;

  const maxButtons = [];
  for (const row of replyMarkup.inline_keyboard) {
    const maxRow = [];
    for (const btn of row) {
      if (btn.callback_data) {
        maxRow.push({
          type: 'callback',
          text: String(btn.text),
          payload: String(btn.callback_data)
        });
      } else if (btn.url) {
        maxRow.push({
          type: 'link',
          text: String(btn.text),
          url: String(btn.url)
        });
      }
    }
    maxButtons.push(maxRow);
  }

  return [
    {
      type: 'inline_keyboard',
      payload: { buttons: maxButtons }
    }
  ];
}

function extractMid(respJson) {
  if (!respJson || typeof respJson !== 'object') return null;

  if (respJson.message_id) return respJson.message_id;
  if (respJson.mid) return respJson.mid;

  if (respJson.result && typeof respJson.result === 'object') {
    if (respJson.result.message_id) return respJson.result.message_id;
    if (respJson.result.body && respJson.result.body.mid) return respJson.result.body.mid;
  }

  if (respJson.message && typeof respJson.message === 'object') {
    if (respJson.message.body && respJson.message.body.mid) return respJson.message.body.mid;
  }

  return null;
}

async function deleteMessageById(messageId) {
  if (!messageId) return;
  try {
    await requestWithTimeout(maxClient, {
      method: 'delete',
      url: `/messages?message_id=${encodeURIComponent(messageId)}`
    });
  } catch (err) {
    logWarn('Ошибка удаления сообщения', {
      messageId,
      error: formatAxiosError(err)
    });
  }
}

async function cleanupOldMenu(target, exceptMid = null) {
  const prevMenuMid = getSavedMenuMid(target);
  if (prevMenuMid && prevMenuMid !== exceptMid) {
    await deleteMessageById(prevMenuMid);
  }
  if (!exceptMid) {
    saveMenuMid(target, null);
  }
}

function extractIncomingFileInfo(att) {
  const payload = att?.payload || {};
  const filePayload = payload.file || {};
  const imagePayload = payload.image || {};
  const documentPayload = payload.document || {};

  const candidates = [
    att?.url,
    payload.url,
    payload.download_url,
    payload.downloadUrl,
    payload.file_url,
    payload.fileUrl,
    payload.link,
    filePayload.url,
    filePayload.download_url,
    filePayload.downloadUrl,
    filePayload.file_url,
    filePayload.fileUrl,
    imagePayload.url,
    imagePayload.download_url,
    imagePayload.downloadUrl,
    imagePayload.file_url,
    imagePayload.fileUrl,
    documentPayload.url,
    documentPayload.download_url,
    documentPayload.downloadUrl,
    documentPayload.file_url,
    documentPayload.fileUrl
  ].map(trimToNull).filter(Boolean);

  const fileName = firstNonEmpty(
    payload.file_name,
    payload.fileName,
    payload.name,
    payload.filename,
    payload.title,
    filePayload.file_name,
    filePayload.fileName,
    filePayload.name,
    filePayload.filename,
    imagePayload.file_name,
    imagePayload.fileName,
    imagePayload.name,
    imagePayload.filename,
    documentPayload.file_name,
    documentPayload.fileName,
    documentPayload.name,
    documentPayload.filename,
    att?.file_name,
    att?.fileName,
    att?.name,
    att?.filename,
    'image'
  );

  const mimeType = firstNonEmpty(
    payload.mime_type,
    payload.mimeType,
    payload.content_type,
    payload.contentType,
    filePayload.mime_type,
    filePayload.mimeType,
    filePayload.content_type,
    filePayload.contentType,
    imagePayload.mime_type,
    imagePayload.mimeType,
    imagePayload.content_type,
    imagePayload.contentType,
    documentPayload.mime_type,
    documentPayload.mimeType,
    documentPayload.content_type,
    documentPayload.contentType,
    att?.mime_type,
    att?.mimeType,
    att?.content_type,
    att?.contentType
  );

  const token = firstNonEmpty(
    payload.token,
    filePayload.token,
    imagePayload.token,
    documentPayload.token,
    att?.token
  );

  return {
    url: candidates[0] || null,
    fileName,
    mimeType,
    token
  };
}

function collectAttachmentEntries(message) {
  const entries = [];
  const visited = new WeakSet();

  function pushAttachments(list, sourcePath, sourceMid) {
    if (!Array.isArray(list)) return;
    list.forEach((attachment, index) => {
      entries.push({
        attachment,
        sourcePath: `${sourcePath}[${index}]`,
        sourceMid,
        index
      });
    });
  }

  function visit(node, sourcePath = 'message', inheritedMid = null, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (visited.has(node)) return;
    visited.add(node);

    const currentMid = node?.body?.mid || node?.mid || inheritedMid || null;

    pushAttachments(node?.body?.attachments, `${sourcePath}.body.attachments`, currentMid);
    pushAttachments(node?.attachments, `${sourcePath}.attachments`, currentMid);

    const children = [
      ['link', node.link],
      ['message', node.message],
      ['forward', node.forward],
      ['forwarded_message', node.forwarded_message],
      ['forwardedMessage', node.forwardedMessage],
      ['source', node.source]
    ];

    for (const [key, value] of children) {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${sourcePath}.${key}[${index}]`, currentMid, depth + 1));
      } else {
        visit(value, `${sourcePath}.${key}`, currentMid, depth + 1);
      }
    }
  }

  visit(message, 'message', message?.body?.mid || message?.mid || null, 0);
  return entries;
}

function classifyIncomingAttachment(rawType, info) {
  const type = String(rawType || '').trim().toLowerCase();
  const mimeType = normalizeMimeType(info.mimeType);
  const supportedExt = isSupportedImageExtension(info.fileName);
  const imageMime = mimeType.startsWith('image/');
  const directImageType = type === 'image' || type === 'photo';
  const fileType = type === 'file' || type === 'document';

  if (!info.url) {
    return {
      shouldAttempt: false,
      skipCode: 'skip:no_url',
      reason: 'нет URL для скачивания',
      classification: 'skip:no_url'
    };
  }

  if (directImageType) {
    return {
      shouldAttempt: true,
      skipCode: null,
      reason: 'тип image/photo',
      classification: 'image_type'
    };
  }

  if (supportedExt || isSupportedImageMimeType(mimeType)) {
    return {
      shouldAttempt: true,
      skipCode: null,
      reason: 'подходит по MIME/расширению',
      classification: 'image_metadata'
    };
  }

  if (imageMime) {
    return {
      shouldAttempt: true,
      skipCode: null,
      reason: 'MIME указывает на изображение, нужна проверка формата',
      classification: 'image_mime_verify'
    };
  }

  if (fileType && (!mimeType || !extOf(info.fileName))) {
    return {
      shouldAttempt: true,
      skipCode: null,
      reason: 'file/document с неполными метаданными',
      classification: 'file_verify'
    };
  }

  if (fileType) {
    return {
      shouldAttempt: false,
      skipCode: 'skip:file_not_image',
      reason: 'file/document не похож на поддерживаемое изображение',
      classification: 'skip:file_not_image'
    };
  }

  return {
    shouldAttempt: false,
    skipCode: 'skip:unsupported_type',
    reason: `тип ${type || 'unknown'} не поддерживается`,
    classification: 'skip:unsupported_type'
  };
}

function normalizeIncomingAttachmentEntry(entry) {
  const info = extractIncomingFileInfo(entry.attachment);
  const rawType = String(entry.attachment?.type || '').toLowerCase();
  const decision = classifyIncomingAttachment(rawType, info);
  const dedupeKey = info.token
    ? `token:${info.token}`
    : info.url
      ? `url:${info.url}`
      : `${entry.sourceMid || 'no-mid'}:${entry.index}`;

  return {
    dedupeKey,
    rawType,
    sourcePath: entry.sourcePath,
    sourceMid: entry.sourceMid,
    index: entry.index,
    attachment: entry.attachment,
    url: info.url,
    token: info.token,
    fileName: info.fileName || 'image',
    mimeType: info.mimeType || null,
    shouldAttempt: decision.shouldAttempt,
    skipCode: decision.skipCode,
    skipReason: decision.shouldAttempt ? null : decision.reason,
    classification: decision.classification,
    detectionReason: decision.reason
  };
}

function collectIncomingAttachments(message) {
  const rawEntries = collectAttachmentEntries(message);
  const normalized = [];
  const seen = new Set();

  for (const entry of rawEntries) {
    const item = normalizeIncomingAttachmentEntry(entry);
    if (seen.has(item.dedupeKey)) {
      continue;
    }
    seen.add(item.dedupeKey);
    normalized.push(item);
  }

  return {
    rawEntries,
    normalized
  };
}

async function downloadIncomingFile(url) {
  const response = await requestWithTimeout(binaryTransferClient, {
    method: 'get',
    url,
    responseType: 'arraybuffer',
    headers: {
      Authorization: MAX_BOT_TOKEN
    }
  });

  return {
    buffer: Buffer.from(response.data),
    contentType: response.headers['content-type'] || null
  };
}

function createAttachmentProcessingError(summaryReason, userMessage = null, details = null, code = 'processing_error') {
  const error = new Error(userMessage || summaryReason);
  error.summaryReason = summaryReason;
  error.userMessage = userMessage || summaryReason;
  error.details = details || null;
  error.summaryCode = code;
  return error;
}

async function ensureSupportedImageBuffer(buffer, candidate, downloadContentType = null) {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch (err) {
    throw createAttachmentProcessingError(
      `${candidate.fileName}: файл не удалось распознать как изображение`,
      'Это не изображение.',
      err?.message || err,
      'not_image'
    );
  }

  const format = normalizeSharpFormat(meta?.format);
  if (!SUPPORTED_INPUT_FORMATS.has(format)) {
    const readableFormat = format
      ? format.toUpperCase()
      : normalizeMimeType(downloadContentType || candidate.mimeType || 'unknown').toUpperCase();

    throw createAttachmentProcessingError(
      `${candidate.fileName}: формат ${readableFormat} не поддерживается`,
      `Формат не поддерживается. Нужны ${SUPPORTED_INPUT_FORMATS_TEXT}.`,
      {
        format,
        mimeType: candidate.mimeType,
        downloadContentType
      },
      'unsupported_format'
    );
  }

  return meta;
}

async function getMaxUploadUrl(type) {
  const { data } = await requestWithTimeout(maxClient, {
    method: 'post',
    url: `/uploads?type=${type}`
  });
  if (!data?.url) {
    throw new Error(`MAX /uploads не вернул url для type=${type}`);
  }
  return data.url;
}

async function uploadBufferToMax(buffer, filename, mimeType, type) {
  const uploadUrl = await getMaxUploadUrl(type);

  const form = new FormData();
  form.append('data', buffer, {
    filename,
    contentType: mimeType
  });

  const { data } = await requestWithTimeout(binaryTransferClient, {
    method: 'post',
    url: uploadUrl,
    data: form,
    headers: {
      ...form.getHeaders(),
      Authorization: MAX_BOT_TOKEN
    }
  });

  return {
    type,
    payload: data
  };
}

async function sendMessageToMax({ userId, chatId, text, attachments = [], replyMarkup = null }) {
  const params = new URLSearchParams();

  if (chatId) params.set('chat_id', String(chatId));
  else if (userId) params.set('user_id', String(userId));
  else throw new Error('Не указан ни chatId, ни userId');

  const body = {
    text,
    notify: true
  };

  const kbAttachments = convertKb(replyMarkup);

  if (attachments.length > 0 && kbAttachments) {
    throw new Error('Нельзя отправлять файл и клавиатуру в одном сообщении.');
  }

  if (attachments.length > 0) {
    body.attachments = attachments;
  } else if (kbAttachments) {
    body.attachments = kbAttachments;
  }

  let lastErr;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { data } = await requestWithTimeout(maxClient, {
        method: 'post',
        url: `/messages?${params.toString()}`,
        data: body
      });
      return data;
    } catch (err) {
      lastErr = err;
      const code = err?.response?.data?.code || '';
      const message = err?.response?.data?.message || '';

      if (code === 'attachment.not.ready' || String(message).includes('attachment')) {
        logWarn('MAX attachment ещё не готов, повторяем отправку', {
          attempt,
          target: chatId || userId,
          code,
          message
        });
        await sleep(attempt * 1200);
        continue;
      }

      throw err;
    }
  }

  throw lastErr;
}

async function answerMaxCallback(callbackId) {
  if (!callbackId) return;
  try {
    await requestWithTimeout(maxClient, {
      method: 'post',
      url: `/answers?callback_id=${encodeURIComponent(callbackId)}`,
      data: {}
    });
  } catch (err) {
    logWarn('Ошибка answer callback', {
      callbackId,
      error: formatAxiosError(err)
    });
  }
}

async function uploadToBitrixDrive(buffer, fileName, mimeType) {
  if (!BITRIX_WEBHOOK_BASE_URL || !BITRIX_FOLDER_ID) {
    return null;
  }

  const step1Url =
    `${BITRIX_WEBHOOK_BASE_URL}/disk.folder.uploadfile.json` +
    `?id=${encodeURIComponent(BITRIX_FOLDER_ID)}` +
    `&data[NAME]=${encodeURIComponent(fileName)}` +
    `&generateUniqueName=Y`;

  const step1 = await requestWithTimeout(binaryTransferClient, {
    method: 'post',
    url: step1Url,
    data: null
  }, BITRIX_DISCOVERY_TIMEOUT_MS);

  const uploadUrl = step1?.data?.result?.uploadUrl;
  const fieldName = step1?.data?.result?.field || 'file';

  if (!uploadUrl) {
    throw new Error('Bitrix24 не вернул uploadUrl');
  }

  const form = new FormData();
  form.append(fieldName, buffer, {
    filename: fileName,
    contentType: mimeType
  });

  const step2 = await requestWithTimeout(binaryTransferClient, {
    method: 'post',
    url: uploadUrl,
    data: form,
    headers: form.getHeaders()
  });

  return step2?.data || null;
}

function buildTarget(update) {
  const message = update?.message || {};
  const recipient = message?.recipient || {};
  const sender = message?.sender || {};

  return {
    chatId: recipient?.chat_id || null,
    userId: recipient?.chat_id ? null : sender?.user_id || null
  };
}

function describeTarget(target) {
  return getChatKey(target) || 'unknown-target';
}

function describeUpdate(update) {
  const message = update?.message || {};
  const body = message?.body || {};
  const recipient = message?.recipient || {};
  const sender = message?.sender || {};

  return {
    updateType: update?.update_type || 'unknown',
    chatId: recipient?.chat_id || null,
    userId: sender?.user_id || null,
    mid: body?.mid || message?.mid || null,
    text: trimToNull(body?.text),
    timestamp: update?.timestamp || null
  };
}

function extractUpdatesPayload(data) {
  const updates =
    data?.updates ||
    data?.result ||
    data?.items ||
    [];

  const marker =
    data?.marker ||
    data?.next_marker ||
    data?.nextMarker ||
    null;

  return {
    updates: Array.isArray(updates) ? updates : [],
    marker
  };
}

async function fetchUpdates(marker) {
  const params = {
    timeout: POLL_TIMEOUT,
    limit: POLL_LIMIT
  };

  if (marker) params.marker = marker;

  const { data } = await requestWithTimeout(maxPollClient, {
    method: 'get',
    url: '/updates',
    params
  }, POLL_REQUEST_TIMEOUT_MS);
  return extractUpdatesPayload(data);
}

async function sendFullMenu(target, prefixText = null, sourceMid = null) {
  const currentMode = getSavedMode(target);

  if (sourceMid) {
    await deleteMessageById(sourceMid);
  }
  await cleanupOldMenu(target, sourceMid);

  const text = prefixText
    ? `${prefixText}\n\n${buildHelpText(currentMode)}`
    : buildHelpText(currentMode);

  const resp = await sendMessageToMax({
    ...target,
    text,
    replyMarkup: buildModeKeyboard(currentMode)
  });

  const newMid = extractMid(resp);
  saveMenuMid(target, newMid);
}

async function sendCompactMenu(target, text = buildCompactMenuText(), sourceMid = null) {
  if (sourceMid) {
    await deleteMessageById(sourceMid);
  }
  await cleanupOldMenu(target, sourceMid);

  const resp = await sendMessageToMax({
    ...target,
    text,
    replyMarkup: buildCompactMenuKeyboard()
  });

  const newMid = extractMid(resp);
  saveMenuMid(target, newMid);
}

function getSkippedReasonLabel(code) {
  if (code === 'skip:file_not_image' || code === 'skip:unsupported_type' || code === 'not_image') {
    return 'не изображение';
  }

  if (code === 'unsupported_format') {
    return 'формат не поддерживается';
  }

  if (code === 'download_failed' || code === 'skip:no_url') {
    return 'файл недоступен';
  }

  if (code === 'jpg_send_failed' || code === 'pdf_send_failed' || code === 'result_send_failed') {
    return 'ошибка при отправке результата';
  }

  return 'ошибка обработки';
}

function formatSkippedSummary(skipped) {
  if (!skipped.length) return '';

  const grouped = new Map();
  for (const item of skipped) {
    const key = item.code || 'other';
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }

  const parts = Array.from(grouped.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([code, count]) => {
      const label = getSkippedReasonLabel(code);
      return count === skipped.length ? label : `${count}: ${label}`;
    });

  return parts.join(', ');
}

function buildBatchCompletionText({ convertedImages, skipped }) {
  if (convertedImages > 0 && skipped.length === 0) {
    return `Готово: ${buildProcessedPhrase(convertedImages)}.`;
  }

  if (convertedImages > 0) {
    return `Готово: ${buildProcessedPhrase(convertedImages)}, ${buildSkippedPhrase(skipped.length)} (${formatSkippedSummary(skipped)}).`;
  }

  if (skipped.length > 0) {
    return `Ничего не обработано: ${formatSkippedSummary(skipped)}.`;
  }

  return `Не нашёл подходящих изображений. Поддерживаются ${SUPPORTED_INPUT_FORMATS_TEXT}.`;
}

function buildUniqueBaseName(fileName, usedNames) {
  const baseName = baseNameWithoutExt(fileName) || 'image';
  const normalized = baseName.toLowerCase();
  const count = (usedNames.get(normalized) || 0) + 1;
  usedNames.set(normalized, count);
  return count === 1 ? baseName : `${baseName}-${count}`;
}

async function uploadAndSendResult(target, text, buffer, filename, mimeType, attachmentType) {
  const attachment = await uploadBufferToMax(buffer, filename, mimeType, attachmentType);
  await sendMessageToMax({
    ...target,
    text,
    attachments: [attachment]
  });
}

async function processConvertibleAttachment(target, candidate, mode, usedNames) {
  let downloaded;
  try {
    downloaded = await downloadIncomingFile(candidate.url);
  } catch (err) {
    throw createAttachmentProcessingError(
      `${candidate.fileName}: не удалось скачать файл из MAX`,
      'Не удалось получить файл из MAX.',
      formatAxiosError(err),
      'download_failed'
    );
  }

  await ensureSupportedImageBuffer(downloaded.buffer, candidate, downloaded.contentType);

  const uniqueBaseName = buildUniqueBaseName(candidate.fileName, usedNames);
  const outputs = [];
  const issues = [];

  if (mode === 'jpeg' || mode === 'both') {
    try {
      const jpegBuffer = await convertToJpeg(downloaded.buffer);
      const jpegName = `${uniqueBaseName}.jpg`;
      await uploadAndSendResult(target, `Готово: ${jpegName}`, jpegBuffer, jpegName, 'image/jpeg', 'image');

      try {
        await uploadToBitrixDrive(jpegBuffer, jpegName, 'image/jpeg');
      } catch (err) {
        logWarn('Ошибка загрузки JPG в Bitrix24', {
          fileName: jpegName,
          error: formatAxiosError(err)
        });
      }

      outputs.push(jpegName);
    } catch (err) {
      issues.push({
        fileName: `${uniqueBaseName}.jpg`,
        reason: 'ошибка при отправке JPG',
        code: 'jpg_send_failed',
        error: err
      });
    }
  }

  if (mode === 'pdf' || mode === 'both') {
    try {
      const pdfBuffer = await convertImageToPdf(downloaded.buffer);
      const pdfName = `${uniqueBaseName}.pdf`;
      await uploadAndSendResult(target, `Готово: ${pdfName}`, pdfBuffer, pdfName, 'application/pdf', 'file');

      try {
        await uploadToBitrixDrive(pdfBuffer, pdfName, 'application/pdf');
      } catch (err) {
        logWarn('Ошибка загрузки PDF в Bitrix24', {
          fileName: pdfName,
          error: formatAxiosError(err)
        });
      }

      outputs.push(pdfName);
    } catch (err) {
      issues.push({
        fileName: `${uniqueBaseName}.pdf`,
        reason: 'ошибка при отправке PDF',
        code: 'pdf_send_failed',
        error: err
      });
    }
  }

  if (!outputs.length && issues.length) {
    const firstIssue = issues[0];
    throw createAttachmentProcessingError(
      `${candidate.fileName}: ${firstIssue.reason}`,
      'Не удалось отправить результат.',
      firstIssue.error,
      'result_send_failed'
    );
  }

  for (const issue of issues) {
    logWarn('Частичная ошибка обработки вложения', {
      sourceFileName: candidate.fileName,
      outputFileName: issue.fileName,
      reason: issue.reason,
      error: formatAxiosError(issue.error)
    });
  }

  return { outputs, issues };
}

function createBatch(key, target) {
  return {
    key,
    target,
    items: [],
    explicitMode: null,
    lastSourceMid: null,
    timer: null
  };
}

function scheduleAttachmentBatchFlush(batchKey) {
  const batch = pendingAttachmentBatches.get(batchKey);
  if (!batch) return;

  if (batch.timer) {
    clearTimeout(batch.timer);
  }

  batch.timer = setTimeout(() => {
    const readyBatch = pendingAttachmentBatches.get(batchKey);
    if (!readyBatch) return;

    pendingAttachmentBatches.delete(batchKey);
    readyBatch.timer = null;
    void queueBatchProcessing(batchKey, readyBatch);
  }, ATTACHMENT_BATCH_WINDOW_MS);
}

function queueBatchProcessing(batchKey, batch) {
  const previous = batchProcessingChains.get(batchKey) || Promise.resolve();

  const next = previous
    .catch(() => {})
    .then(() => flushAttachmentBatch(batch));

  batchProcessingChains.set(batchKey, next);

  next.finally(() => {
    if (batchProcessingChains.get(batchKey) === next) {
      batchProcessingChains.delete(batchKey);
    }
  });
}

function enqueueAttachmentBatch({ target, sourceMid, explicitMode, candidates }) {
  const batchKey = getChatKey(target);
  if (!batchKey) {
    throw new Error('Не удалось определить ключ буфера для target');
  }

  const batch = pendingAttachmentBatches.get(batchKey) || createBatch(batchKey, target);
  batch.target = target;
  batch.lastSourceMid = sourceMid || batch.lastSourceMid || null;

  if (explicitMode) {
    batch.explicitMode = explicitMode;
  }

  for (const candidate of candidates) {
    batch.items.push({
      ...candidate,
      queuedAt: Date.now()
    });
  }

  pendingAttachmentBatches.set(batchKey, batch);
  scheduleAttachmentBatchFlush(batchKey);

  logInfo('Вложение добавлено в буфер обработки', {
    batchKey,
    itemsInBatch: batch.items.length,
    explicitMode: batch.explicitMode,
    windowMs: ATTACHMENT_BATCH_WINDOW_MS
  });
}

async function flushAttachmentBatch(batch) {
  const target = batch.target;
  const mode = batch.explicitMode || getSavedMode(target);
  const usedNames = new Map();
  const skipped = [];
  let convertedImages = 0;

  if (isFirstSeen(target)) {
    markGreeted(target);
  }

  if (batch.explicitMode) {
    saveMode(target, batch.explicitMode);
  }

  logInfo('Начинаю обработку буфера вложений', {
    batchKey: batch.key,
    target: describeTarget(target),
    items: batch.items.length,
    mode
  });

  for (const candidate of batch.items) {
    if (!candidate.shouldAttempt) {
      skipped.push({
        fileName: candidate.fileName,
        code: candidate.skipCode || 'skip:unsupported_type',
        reason: candidate.skipReason || 'вложение пропущено'
      });
      logInfo('Вложение пропущено без обработки', {
        batchKey: batch.key,
        fileName: candidate.fileName,
        reason: candidate.skipReason,
        sourcePath: candidate.sourcePath
      });
      continue;
    }

    try {
      const result = await processConvertibleAttachment(target, candidate, mode, usedNames);
      if (result.outputs.length > 0) {
        convertedImages += 1;
      }
      if (result.issues.length > 0) {
        for (const issue of result.issues) {
          skipped.push({
            fileName: issue.fileName,
            code: issue.code || 'processing_error',
            reason: issue.reason
          });
        }
      }
      logInfo('Вложение обработано', {
        batchKey: batch.key,
        fileName: candidate.fileName,
        outputs: result.outputs,
        issues: result.issues.map(item => ({
          fileName: item.fileName,
          reason: item.reason
        }))
      });
    } catch (err) {
      const reason = err?.summaryReason || 'неизвестная ошибка при обработке';
      skipped.push({
        fileName: candidate.fileName,
        code: err?.summaryCode || 'processing_error',
        reason
      });
      logWarn('Ошибка обработки вложения', {
        batchKey: batch.key,
        fileName: candidate.fileName,
        reason,
        error: formatAxiosError(err)
      });
    }
  }

  try {
    await sendCompactMenu(target, buildBatchCompletionText({
      convertedImages,
      skipped
    }));
  } catch (err) {
    logError('Не удалось отправить итоговое служебное сообщение', {
      batchKey: batch.key,
      error: formatAxiosError(err)
    });
  }
}

function logAttachmentScan(target, rawEntries, normalized) {
  logInfo('Проверка входящих вложений', {
    target: describeTarget(target),
    rawAttachmentCount: rawEntries.length,
    normalizedCount: normalized.length,
    processableCount: normalized.filter(item => item.shouldAttempt).length,
    skippedCount: normalized.filter(item => !item.shouldAttempt).length,
    items: normalized.map(item => ({
      fileName: item.fileName,
      type: item.rawType,
      mimeType: item.mimeType,
      shouldAttempt: item.shouldAttempt,
      classification: item.classification,
      reason: item.shouldAttempt ? item.detectionReason : item.skipReason,
      sourcePath: item.sourcePath
    }))
  });
}

async function handleCommandWithoutAttachment(target, text, sourceMid) {
  const mode = parseModeFromText(text);

  if (mode) {
    saveMode(target, mode);
    markGreeted(target);
    await deleteMessageById(sourceMid);
    await sendCompactMenu(target, buildModeSavedText(mode));
    return true;
  }

  const t = String(text || '').trim().toLowerCase();

  if (
    t === '/start' ||
    t === '/help' ||
    t === '/menu' ||
    t === 'start' ||
    t === 'help' ||
    t === 'menu'
  ) {
    markGreeted(target);
    await sendFullMenu(target, null, sourceMid);
    return true;
  }

  if (isFirstSeen(target)) {
    markGreeted(target);
    await sendFullMenu(target, 'Привет!', sourceMid);
    return true;
  }

  await sendCompactMenu(target, buildIdleMenuText());
  return true;
}

async function handleCallbackUpdate(update) {
  const target = buildTarget(update);
  const callback = update?.callback || {};
  const payload = String(callback?.payload || '');
  const sourceMid = update?.message?.body?.mid || null;

  logInfo('Получен callback update', {
    target: describeTarget(target),
    payload,
    sourceMid
  });

  await answerMaxCallback(callback?.callback_id);

  if (payload.startsWith('mode:')) {
    const mode = payload.split(':')[1];
    if (['jpeg', 'pdf', 'both'].includes(mode)) {
      saveMode(target, mode);
      markGreeted(target);
      await sendCompactMenu(target, buildModeSavedText(mode), sourceMid);
    }
    return;
  }

  if (payload === 'menu:help' || payload === 'menu:home') {
    markGreeted(target);
    await sendFullMenu(target, null, sourceMid);
    return;
  }

  if (payload === 'menu:status') {
    const mode = getSavedMode(target);
    await sendFullMenu(target, `Сейчас выбран режим: ${formatModeLabel(mode)}.`, sourceMid);
  }
}

async function processUpdate(update) {
  const updateType = update?.update_type;
  logInfo('Получен update', describeUpdate(update));

  if (updateType === 'message_callback') {
    await handleCallbackUpdate(update);
    return;
  }

  if (updateType === 'bot_started') {
    const target = buildTarget(update);
    markGreeted(target);
    await sendFullMenu(target, 'Привет!');
    return;
  }

  if (updateType !== 'message_created') return;

  const message = update?.message || {};
  const sender = message?.sender || {};
  const body = message?.body || {};
  const text = String(body?.text || '');
  const sourceMid = body?.mid || message?.mid || null;

  if (sender?.is_bot) return;

  const target = buildTarget(update);
  const { rawEntries, normalized } = collectIncomingAttachments(message);

  logAttachmentScan(target, rawEntries, normalized);

  if (!normalized.length) {
    await handleCommandWithoutAttachment(target, text, sourceMid);
    return;
  }

  enqueueAttachmentBatch({
    target,
    sourceMid,
    explicitMode: parseModeFromText(text),
    candidates: normalized
  });
}

async function main() {
  let marker = readMarker();
  logInfo('Polling started', {
    marker: marker || '<empty>',
    maxApi: MAX_API,
    trustedCa: Boolean(maxTrustedCa) || Boolean(process.env.NODE_EXTRA_CA_CERTS)
  });

  while (true) {
    try {
      const payload = await fetchUpdates(marker);
      const updates = payload.updates || [];

      if (payload.marker) {
        marker = payload.marker;
        writeMarker(marker);
      }

      if (updates.length) {
        logInfo('Получено updates', {
          count: updates.length,
          marker: marker || '<empty>'
        });
      }

      for (const update of updates) {
        try {
          await processUpdate(update);
        } catch (err) {
          logError('Ошибка обработки update', {
            update: describeUpdate(update),
            error: formatAxiosError(err)
          });
        }
      }
    } catch (err) {
      logError('Polling error', formatAxiosError(err));
      await sleep(3000);
    }
  }
}

main().catch(err => {
  logError('Fatal error', formatAxiosError(err));
  process.exit(1);
});
