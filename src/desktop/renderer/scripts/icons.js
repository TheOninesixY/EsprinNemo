const LUCIDE_ICON_CACHE = new Map();

function toLucideComponentName(name) {
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

function resolveLucideIcon(name) {
    const key = String(name || '');
    if (LUCIDE_ICON_CACHE.has(key)) return LUCIDE_ICON_CACHE.get(key);
    const store = window.lucide && window.lucide.icons ? window.lucide.icons : {};
    const node = store[toLucideComponentName(key)] || null;
    if (!node) console.warn(`[Desktop:WARN] 未找到图标 (name=${key})`);
    LUCIDE_ICON_CACHE.set(key, node);
    return node;
}

function createLucideSvg(name) {
    const node = resolveLucideIcon(name);
    if (!node) return null;
    return window.lucide.createElement(node, { 'stroke-width': 2, 'aria-hidden': 'true', focusable: 'false' });
}

function hydrateLucideIcon(host) {
    if (!host || host.childElementCount > 0) return;
    const name = host.getAttribute('data-lucide');
    if (!name) return;
    const svg = createLucideSvg(name);
    if (svg) host.appendChild(svg);
}

function hydrateLucideIcons(root) {
    const scope = root || document;
    scope.querySelectorAll('.icon[data-lucide]').forEach(hydrateLucideIcon);
}

function setLucideIcon(host, name) {
    if (!host) return;
    host.setAttribute('data-lucide', name);
    host.replaceChildren();
    hydrateLucideIcon(host);
}

function watchLucideIcons() {
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.matches('.icon[data-lucide]')) hydrateLucideIcon(node);
                node.querySelectorAll('.icon[data-lucide]').forEach(hydrateLucideIcon);
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

if (document.body) {
    hydrateLucideIcons(document);
    watchLucideIcons();
} else {
    document.addEventListener('DOMContentLoaded', () => {
        hydrateLucideIcons(document);
        watchLucideIcons();
    });
}
