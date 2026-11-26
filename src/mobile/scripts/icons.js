const ICON_CACHE = new Map();

function toComponentName(name) {
    let out = '';
    let upper = false;
    for (const ch of String(name || '')) {
        if (ch === '-' || ch === '_' || ch === ' ') {
            upper = out.length > 0;
            continue;
        }
        out += upper ? ch.toUpperCase() : ch.toLowerCase();
        upper = false;
    }
    return out.charAt(0).toUpperCase() + out.slice(1);
}

function resolveIcon(name) {
    const key = String(name || '');
    if (ICON_CACHE.has(key)) return ICON_CACHE.get(key);
    const store = window.lucide && window.lucide.icons ? window.lucide.icons : {};
    const node = store[toComponentName(key)] || null;
    if (!node) console.warn(`[Mobile:WARN] 未找到图标 (name=${key})`);
    ICON_CACHE.set(key, node);
    return node;
}

function createSvg(name) {
    const node = resolveIcon(name);
    if (!node) return null;
    return window.lucide.createElement(node, { 'stroke-width': 2, 'aria-hidden': 'true', focusable: 'false' });
}

export function hydrateIcon(host) {
    if (!host || host.childElementCount > 0) return;
    const name = host.getAttribute('data-lucide');
    if (!name) return;
    const svg = createSvg(name);
    if (svg) host.appendChild(svg);
}

export function hydrateIcons(root) {
    (root || document).querySelectorAll('.icon[data-lucide]').forEach(hydrateIcon);
}

export function setIcon(host, name) {
    if (!host) return;
    host.setAttribute('data-lucide', name);
    host.replaceChildren();
    hydrateIcon(host);
}

export function icon(name, size = 18) {
    const host = document.createElement('span');
    host.className = `icon icon-s${size}`;
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('data-lucide', name);
    hydrateIcon(host);
    return host.outerHTML;
}

function watchIcons() {
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.matches('.icon[data-lucide]')) hydrateIcon(node);
                node.querySelectorAll('.icon[data-lucide]').forEach(hydrateIcon);
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

if (document.body) {
    hydrateIcons(document);
    watchIcons();
} else {
    document.addEventListener('DOMContentLoaded', () => {
        hydrateIcons(document);
        watchIcons();
    });
}
