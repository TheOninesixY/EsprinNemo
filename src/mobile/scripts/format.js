export const META_HEADER = 'EsprinData';
export const TITLE_MAX_LENGTH = 60;

const META_BLOCK = /^<!--[ \t]*EsprinData[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?[ \t]*-->[ \t]*(?=\r?\n|$)/;
const ITEM_FILE_NAME = /^([A-Za-z0-9_-]{1,64})\.md$/i;
const CANONICAL_KEYS = new Set([
    'type', 'title', 'folder', 'tags', 'isPinned', 'isTrashed',
    'isHidden', 'isLocked', 'isDone', 'createdAt', 'updatedAt'
]);

export function itemIdFromPath(path) {
    const matched = /^items\/([^/]+)$/.exec(String(path || ''));
    if (!matched) return '';
    const name = ITEM_FILE_NAME.exec(matched[1]);
    return name ? name[1] : '';
}

export function parseItemFile(raw) {
    const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
    const matched = text.match(META_BLOCK);
    if (!matched) return { meta: null, content: text };

    const meta = {};
    matched[1].split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        const separator = trimmed.indexOf(':');
        if (separator <= 0) return;
        meta[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    });

    let content = text.slice(matched[0].length);
    const gap = content.match(/^(?:\r?\n){1,2}/);
    if (gap) content = content.slice(gap[0].length);
    if (!content.trim()) content = '';

    return { meta, content };
}

export function formatMetaValue(value) {
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    const text = typeof value === 'string' ? value : '';
    return text ? JSON.stringify(text) : '';
}

function metaLine(key, value) {
    const text = formatMetaValue(value);
    return text ? `    ${key}: ${text}` : `    ${key}:`;
}
export function serializeItem(item) {
    const type = item.type === 'todo' ? 'todo' : 'note';
    const folder = item.folder && item.folder !== '默认' ? item.folder : '';

    const lines = [
        `<!--${META_HEADER}`,
        metaLine('type', type),
        metaLine('title', item.title || ''),
        metaLine('folder', folder),
        metaLine('tags', Array.isArray(item.tags) ? item.tags : []),
        metaLine('isPinned', !!item.isPinned),
        metaLine('isTrashed', !!item.isTrashed)
    ];

    if (item.isHidden === true) lines.push(metaLine('isHidden', true));
    if (item.locked === true) lines.push(metaLine('isLocked', true));
    if (type === 'todo') lines.push(metaLine('isDone', !!item.isDone));

    (item.unknownMeta || []).forEach(([key, value]) => {
        if (!key || CANONICAL_KEYS.has(key)) return;
        lines.push(value ? `    ${key}: ${value}` : `    ${key}:`);
    });

    lines.push(metaLine('createdAt', Number(item.createdAt) || Date.now()));
    lines.push(metaLine('updatedAt', Number(item.updatedAt) || Date.now()));
    lines.push('-->');

    const content = String(item.content || '');
    return content ? `${lines.join('\n')}\n\n${content}` : `${lines.join('\n')}\n`;
}

export function readMetaString(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return '';
    if (value.startsWith('"')) {
        try {
            const parsed = JSON.parse(value);
            return typeof parsed === 'string' ? parsed : '';
        } catch (err) {
            return value.replace(/^"+|"+$/g, '');
        }
    }
    return value;
}

export function readMetaNumber(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(typeof raw === 'string' ? raw.trim() : raw);
    return Number.isFinite(value) ? Math.round(value) : fallback;
}

export function readMetaBoolean(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return !!fallback;
    const value = String(raw).trim().toLowerCase();
    if (value === 'true' || value === '1' || value === 'yes') return true;
    if (value === 'false' || value === '0' || value === 'no') return false;
    return !!fallback;
}

export function normalizeTags(raw) {
    const tags = [];
    (Array.isArray(raw) ? raw : []).forEach((item) => {
        const tag = typeof item === 'string' ? item.trim().replace(/^#+/, '').trim() : '';
        if (tag && !tags.includes(tag)) tags.push(tag);
    });
    return tags;
}

export function readMetaTags(raw) {
    if (Array.isArray(raw)) return normalizeTags(raw);
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return [];
    if (value.startsWith('[')) {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return normalizeTags(parsed);
        } catch (err) {
        }
    }
    return normalizeTags(value.split(/[,，\s]+/));
}

export function isSecretEnvelope(text) {
    return typeof text === 'string' && text.startsWith('-----ESPRIN SECRET-----');
}

export function deriveTitle(content) {
    const line = String(content || '').split('\n').map((item) => item.trim()).find((item) => item.length) || '';
    const cleaned = line.replace(/^#{1,6}\s*/, '').replace(/^[-*+>]\s+/, '').trim();
    return cleaned.length > TITLE_MAX_LENGTH ? cleaned.slice(0, TITLE_MAX_LENGTH) : cleaned;
}

export function displayTitle(item) {
    if (!item) return '';
    const title = readMetaString(item.title);
    if (title) return title;
    return deriveTitle(item.content) || '未命名笔记';
}

export function buildItem({ id, path, raw, time }) {
    const parsed = parseItemFile(raw);
    const meta = parsed.meta || {};
    const statTime = Number.isFinite(time) ? Math.round(time) : Date.now();
    const createdAt = readMetaNumber(meta.createdAt, statTime);

    const hasType = typeof meta.type === 'string' && meta.type.trim();
    const type = hasType
        ? (readMetaString(meta.type) === 'todo' ? 'todo' : 'note')
        : (meta.isDone !== undefined ? 'todo' : 'note');

    return {
        id,
        path,
        type,
        title: readMetaString(meta.title),
        folder: readMetaString(meta.folder),
        tags: readMetaTags(meta.tags),
        isPinned: readMetaBoolean(meta.isPinned, false),
        isTrashed: readMetaBoolean(meta.isTrashed, false),
        isHidden: readMetaBoolean(meta.isHidden, false),
        locked: readMetaBoolean(meta.isLocked, false) && isSecretEnvelope(parsed.content),
        isDone: readMetaBoolean(meta.isDone, false),
        createdAt,
        updatedAt: readMetaNumber(meta.updatedAt, Math.max(createdAt, statTime)),
        content: parsed.content,
        hasMeta: !!parsed.meta,
        unknownMeta: Object.keys(meta)
            .filter((key) => !CANONICAL_KEYS.has(key))
            .map((key) => [key, meta[key]])
    };
}

export function snippet(content, limit = 140) {
    const text = String(content || '')
        .replace(/^---[\s\S]*?---\s*/, '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^\s*[-*+>]\s+/gm, '')
        .replace(/\[[ xX]\]\s+/g, '')
        .replace(/[*_`~]/g, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function formatRelative(timestamp) {
    const value = Number(timestamp) || 0;
    if (!value) return '';
    const diff = Date.now() - value;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;

    const date = new Date(value);
    const now = new Date();
    const sameYear = date.getFullYear() === now.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return sameYear ? `${month}-${day}` : `${date.getFullYear()}-${month}-${day}`;
}

export function formatBytes(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

export function byteLength(text) {
    try {
        return new TextEncoder().encode(String(text == null ? '' : text)).length;
    } catch (err) {
        return String(text == null ? '' : text).length;
    }
}
