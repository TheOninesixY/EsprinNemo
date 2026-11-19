const APP_ICON_SCRIPT_SRC = (() => {
    try {
        if (document.currentScript && document.currentScript.src) return document.currentScript.src;
    } catch (err) {

    }
    return '';
})();

function appIconSvgCandidates() {
    const candidates = [];
    try {
        if (APP_ICON_SCRIPT_SRC) {
            const scriptPath = decodeURIComponent(new URL(APP_ICON_SCRIPT_SRC).pathname).replace(/^\//, '');
            candidates.push(path.resolve(path.dirname(scriptPath), '..', '..', '..', '..', 'assets', 'tray.svg'));
        }
    } catch (err) {

    }
    try {
        if (typeof __dirname === 'string' && __dirname) {
            candidates.push(path.resolve(__dirname, '..', '..', '..', '..', 'assets', 'tray.svg'));
            candidates.push(path.resolve(__dirname, '..', '..', '..', 'assets', 'tray.svg'));
        }
    } catch (err) {

    }
    return candidates;
}

function readAppIconSvg() {
    for (const file of appIconSvgCandidates()) {
        try {
            if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
        } catch (err) {

        }
    }
    return '';
}

function renderAppCornerIcon() {
    const corner = document.querySelector('.app-corner');
    if (!corner) return;

    const svgText = readAppIconSvg();
    if (!svgText) {
        console.warn('未找到应用图标 tray.svg');
        return;
    }
    const themed = svgText
        .replace(/fill="(?!none)[^"]*"/g, 'fill="currentColor"')
        .replace(/<svg([^>]*)>/, '<svg$1 class="app-corner-icon" aria-hidden="true">');

    corner.innerHTML = themed;
}

renderAppCornerIcon();
