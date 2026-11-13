(function () {
    const root = document.documentElement;

    const WALLPAPER_CLASS = 'has-wallpaper';
    const FRAME_CLASS = 'has-wallpaper-frame';
    const WALLPAPER_VAR = '--desktop-wallpaper';

    let activeUrl = '';
    let pendingUrl = '';
    let preloader = null;
    let initialized = false;
    let lastFrame = null;

    function isDesktopRuntime() {
        try {
            return !!(process.versions && process.versions.electron);
        } catch (error) {
            return false;
        }
    }

    function zoomFactor() {
        try {
            const value = webFrame.getZoomFactor();
            return Number.isFinite(value) && value > 0 ? value : 1;
        } catch (error) {
            return 1;
        }
    }

    function inlineWallpaperUrl() {
        const value = root.style.getPropertyValue(WALLPAPER_VAR) || '';
        const matched = String(value).match(/url\("([^"]+)"\)/);
        return matched ? matched[1] : '';
    }

    function applyFrame(frame) {
        if (!frame) return;
        const zoom = zoomFactor();
        lastFrame = frame;
        root.style.setProperty('--wallpaper-canvas-width', `${frame.canvasWidth / zoom}px`);
        root.style.setProperty('--wallpaper-canvas-height', `${frame.canvasHeight / zoom}px`);
        root.style.setProperty('--wallpaper-origin-x', `${-frame.originX / zoom}px`);
        root.style.setProperty('--wallpaper-origin-y', `${-frame.originY / zoom}px`);
        root.classList.add(FRAME_CLASS);
    }

    function clearWallpaper() {
        activeUrl = '';
        pendingUrl = '';
        preloader = null;
        root.classList.remove(WALLPAPER_CLASS);
        root.style.removeProperty(WALLPAPER_VAR);
    }

    function applyWallpaper(payload) {
        const url = payload && typeof payload.url === 'string' ? payload.url.trim() : '';
        if (!url) {
            clearWallpaper();
            return;
        }
        if (url === activeUrl) {
            root.classList.add(WALLPAPER_CLASS);
            return;
        }
        if (url === pendingUrl) return;

        pendingUrl = url;
        const image = new Image();
        preloader = image;
        image.onload = () => {
            if (preloader !== image) return;
            preloader = null;
            pendingUrl = '';
            activeUrl = url;
            root.style.setProperty(WALLPAPER_VAR, `url("${url}")`);
            root.classList.add(WALLPAPER_CLASS);
        };
        image.onerror = () => {
            if (preloader !== image) return;
            console.warn('[WARN] [Nemo] 桌面壁纸图片不可用，回退主题背景');
            clearWallpaper();
        };
        image.src = url;
    }

    async function initWallpaper() {
        if (initialized) return;
        initialized = true;

        if (!isDesktopRuntime()) {
            clearWallpaper();
            return;
        }

        const preloaded = inlineWallpaperUrl();
        if (preloaded) applyWallpaper({ url: preloaded });

        try {
            const snapshot = await ipcRenderer.invoke('wallpaper:get');
            applyFrame(snapshot && snapshot.frame);
            applyWallpaper(snapshot);
        } catch (error) {
            console.warn('[WARN] [Nemo] 读取桌面壁纸失败，回退主题背景:', error && error.message);
            clearWallpaper();
        }

        ipcRenderer.on('wallpaper:changed', (event, payload) => {
            applyFrame(payload && payload.frame);
            applyWallpaper(payload);
        });
        ipcRenderer.on('wallpaper:frame', (event, frame) => applyFrame(frame));
        window.addEventListener('resize', () => {
            if (lastFrame) applyFrame(lastFrame);
        });
    }

    window.initWallpaper = initWallpaper;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWallpaper);
    } else {
        initWallpaper();
    }
})();
