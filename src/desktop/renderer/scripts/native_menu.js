const nativeMenuBridge = (() => {
    const { ipcRenderer } = require('electron');
    const isMac = process.platform === 'darwin';

    function toNativeEntry(entry) {
        if (!entry || typeof entry !== 'object') return null;
        if (entry.type === 'separator') return { type: 'separator' };
        if (entry.type === 'submenu') {
            const items = (entry.items || []).map(toNativeEntry).filter(Boolean);
            if (!items.length || typeof entry.label !== 'string' || !entry.label) return null;
            return { type: 'submenu', label: entry.label, items };
        }
        return {
            type: entry.type,
            action: entry.action,
            label: entry.label,
            icon: entry.icon,
            disabled: entry.disabled === true
        };
    }

    async function popup(entries) {
        if (!isMac || !Array.isArray(entries) || !entries.length) return null;

        const items = entries.map(toNativeEntry).filter(Boolean);
        if (!items.length) return null;

        try {
            return await ipcRenderer.invoke('menu:popup', { items });
        } catch (err) {
            return null;
        }
    }

    return { isMac, popup };
})();
