/* EsprinNemo 官网交互
   主题切换与提示条的实现方式与应用端保持一致。 */

(function () {
    'use strict';

    var THEME_KEY = 'en-site-theme';

    var root = document.documentElement;

    /* --------------------------------------------------------------
       主题：浅色 / 深色 / 跟随系统三态循环
       -------------------------------------------------------------- */
    var THEME_ORDER = ['system', 'light', 'dark'];
    var THEME_META = {
        system: { icon: '#i-auto', label: '跟随系统' },
        light: { icon: '#i-sun', label: '浅色' },
        dark: { icon: '#i-moon', label: '深色' }
    };

    function readTheme() {
        try {
            var stored = localStorage.getItem(THEME_KEY);
            return THEME_ORDER.indexOf(stored) >= 0 ? stored : 'system';
        } catch (e) {
            return 'system';
        }
    }

    function writeTheme(value) {
        try {
            localStorage.setItem(THEME_KEY, value);
        } catch (e) {
            /* 隐私模式下忽略 */
        }
    }

    function systemPrefersLight() {
        return window.matchMedia('(prefers-color-scheme: light)').matches;
    }

    var theme = readTheme();

    function renderTheme() {
        var isLight = theme === 'light' || (theme === 'system' && systemPrefersLight());
        root.classList.toggle('light', isLight);

        var meta = THEME_META[theme];
        var use = document.getElementById('theme-icon-use');
        if (use) {
            use.setAttribute('href', meta.icon);
            use.setAttribute('xlink:href', meta.icon);
        }
        var button = document.getElementById('btn-theme');
        if (button) {
            button.title = '主题：' + meta.label + '（点击切换）';
            button.setAttribute('aria-label', button.title);
        }
        syncThemeColorMeta();
    }

    function syncThemeColorMeta() {
        var metaColor = document.querySelector('meta[name="theme-color"]');
        if (!metaColor) return;
        var bg = getComputedStyle(root).getPropertyValue('--bg-body').trim();
        if (bg) metaColor.setAttribute('content', bg);
    }

    /* --------------------------------------------------------------
       提示条：与应用内 Toast 同款
       -------------------------------------------------------------- */
    var toastTimer = null;

    function showToast(message) {
        var box = document.getElementById('toast-box');
        if (!box) return;
        box.innerHTML = '';

        var item = document.createElement('div');
        item.className = 'toast-item';
        item.innerHTML = '<svg class="icon xs" aria-hidden="true"><use href="#i-check"/></svg>';
        var text = document.createElement('span');
        text.textContent = message;
        item.appendChild(text);
        box.appendChild(item);

        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
            item.style.transition = 'opacity 0.2s, transform 0.2s';
            item.style.opacity = '0';
            item.style.transform = 'translateY(8px)';
            window.setTimeout(function () { item.remove(); }, 220);
        }, 2200);
    }

    /* --------------------------------------------------------------
       入场动画与导航高亮
       -------------------------------------------------------------- */
    function setupReveal() {
        var items = document.querySelectorAll('.reveal');
        if (!('IntersectionObserver' in window)) {
            items.forEach(function (item) { item.classList.add('visible'); });
            return;
        }

        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            });
        }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });

        items.forEach(function (item, index) {
            item.style.transitionDelay = Math.min(index % 6, 5) * 40 + 'ms';
            observer.observe(item);
        });
    }

    function setupNavHighlight() {
        var links = Array.prototype.slice.call(document.querySelectorAll('#site-nav .tab-item'));
        if (!links.length || !('IntersectionObserver' in window)) return;

        var sections = links
            .map(function (link) { return document.querySelector(link.getAttribute('href')); })
            .filter(Boolean);

        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                links.forEach(function (link) {
                    link.classList.toggle('active', link.getAttribute('href') === '#' + entry.target.id);
                });
            });
        }, { rootMargin: '-45% 0px -50% 0px' });

        sections.forEach(function (section) { observer.observe(section); });
    }

    /* --------------------------------------------------------------
       绑定
       -------------------------------------------------------------- */
    function setupEvents() {
        var themeButton = document.getElementById('btn-theme');
        if (themeButton) {
            themeButton.addEventListener('click', function () {
                theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
                writeTheme(theme);
                renderTheme();
            });
        }

        // 跟随系统时，系统主题变化要即时生效
        var media = window.matchMedia('(prefers-color-scheme: light)');
        var onMediaChange = function () {
            if (theme === 'system') renderTheme();
        };
        if (media.addEventListener) media.addEventListener('change', onMediaChange);
        else if (media.addListener) media.addListener(onMediaChange);

        document.querySelectorAll('[data-copy]').forEach(function (button) {
            button.addEventListener('click', function () {
                var text = button.dataset.copy.replace(/&#10;/g, '\n');

                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text)
                        .then(function () { showToast('已复制到剪贴板'); })
                        .catch(function () { showToast('复制失败，请手动选择'); });
                    return;
                }

                var area = document.createElement('textarea');
                area.value = text;
                area.style.position = 'fixed';
                area.style.opacity = '0';
                document.body.appendChild(area);
                area.select();
                try {
                    document.execCommand('copy');
                    showToast('已复制到剪贴板');
                } catch (e) {
                    showToast('复制失败，请手动选择');
                }
                area.remove();
            });
        });
    }

    function init() {
        renderTheme();

        setupEvents();
        setupReveal();
        setupNavHighlight();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
