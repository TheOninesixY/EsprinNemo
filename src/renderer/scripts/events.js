/* 全局事件绑定：按钮、快捷键与各类入口 */

// Global Event Setup
function setupEvents() {
    // 点击标题栏左上角的应用名（经典布局）：先落盘未保存的编辑，再退出到首页。
    // 注意这里只取消激活标签，不关闭标签页——已打开的标签仍然保留在标签栏中可随时切回。
    // 现代布局下标题栏整条没了，侧边栏里的那份应用名只是展示，
    // 不承担这个入口（改由标签栏最左端的「返回」）。
    const leaveActiveItem = () => {
        if (!State.activeNoteId) return;
        flushPendingSave();
        State.activeNoteId = null;
        renderApp();
    };
    document.getElementById('app-brand').onclick = leaveActiveItem;

    // 现代布局的「返回」（标签栏最左端那枚纯图标，见 styles/mode.css）把当前编辑退回笔记列表；
    // 侧边栏收起时也不换地方，经典布局下这枚不显示
    const tabsBack = document.getElementById('btn-tabs-back');
    if (tabsBack) tabsBack.onclick = leaveActiveItem;

    // 侧边栏顶部的「新建」：现代布局下不再弹菜单，本体直接新建笔记，
    // 悬停时滑出的副本（#btn-new-todo，见 main.html 与 styles/mode.css）新建待办；
    // 经典布局侧边栏只有这一个入口，照旧展开「新建笔记 / 新建待办 / 导入文件」菜单。
    document.getElementById('btn-new-note').onclick = (e) => {
        if (isModernLayout()) createNewNote();
        else toggleNewItemMenu(e.currentTarget);
    };
    document.getElementById('btn-new-todo').onclick = () => createNewTodo();
    // 空状态里的「新建」不在侧边栏、没有可复制的余地，仍走那套菜单
    document.getElementById('btn-empty-new').onclick = (e) => toggleNewItemMenu(e.currentTarget);
    // 导入文件：从「新建」菜单里搬出来独立成按钮，固定在底栏设置按钮左边
    // （废纸篓视图下由 renderCounts 藏起来，见 scripts/render.js）
    document.getElementById('btn-import-note').onclick = () => importNoteFiles();
    document.getElementById('btn-toggle-sidebar').onclick = toggleSidebarCollapsed;

    document.getElementById('input-note-title').oninput = autoSaveActiveItem;
    const contentTextarea = document.getElementById('textarea-note-content');
    contentTextarea.oninput = () => {
        autoSaveActiveItem();
        scheduleRenderMarkdown();
    };
    // Tab / Shift+Tab 用于缩进，避免浏览器默认行为把焦点移出编辑器
    contentTextarea.onkeydown = (e) => {
        if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            handleContentTab(e);
        }
    };

    document.getElementById('editor-folder-select').onchange = (e) => {
        const item = getActiveItem();
        if (item && !isReadOnlyItem(item)) {
            item.folder = e.target.value;
            saveItem(item);
            renderApp();
        }
    };

    // 待办：完成 / 取消完成（顶栏右侧只剩这一个按钮，其余动作都在条目右键菜单里）
    document.getElementById('btn-todo-done').onclick = () => {
        if (State.activeNoteId) toggleTodoDone(State.activeNoteId);
    };
    document.getElementById('btn-empty-trash').onclick = clearTrash;

    document.getElementById('btn-mode-edit').onclick = () => { State.viewMode = 'edit'; updateViewModeUI(); };
    document.getElementById('btn-mode-split').onclick = () => { State.viewMode = 'split'; flushRenderMarkdown(); updateViewModeUI(); };
    document.getElementById('btn-mode-preview').onclick = () => { State.viewMode = 'preview'; flushRenderMarkdown(); updateViewModeUI(); };

    document.getElementById('btn-open-settings').onclick = () => {
        openSettingsTab();
    };

    // 现代布局下设置页是整屏铺开的（工作区连同它的标签栏在那里不占位），
    // 由设置页头部的「返回」按钮回到笔记列表（经典布局下该按钮不显示）
    const btnSettingsBack = document.getElementById('btn-settings-back');
    if (btnSettingsBack) {
        btnSettingsBack.onclick = () => {
            if (State.activeNoteId !== 'settings') return;
            flushPendingSave();
            closeTab('settings');
            renderApp();
        };
    }

    const settingSpellcheck = document.getElementById('setting-spellcheck');
    if (settingSpellcheck) {
        settingSpellcheck.onchange = (e) => {
            State.spellcheck = e.target.checked;
            applySpellcheck();
            saveConfig();
        };
    }

    // 废纸篓自动清理：改完保留期限立刻按新策略清理一次，便于立刻看到效果
    const settingTrashRetention = document.getElementById('setting-trash-retention');
    if (settingTrashRetention) {
        settingTrashRetention.onchange = (e) => {
            State.trashRetentionDays = normalizeTrashRetentionDays(e.target.value);
            e.target.value = String(State.trashRetentionDays);
            saveConfig();

            const removed = purgeExpiredTrashItems();
            renderApp();
            if (!State.trashRetentionDays) {
                showToast('已关闭废纸篓自动清理');
            } else if (removed > 0) {
                showToast(`已自动清理 ${removed} 条超过 ${State.trashRetentionDays} 天的废纸篓内容`);
            } else {
                showToast(`废纸篓中超过 ${State.trashRetentionDays} 天的笔记与待办将被自动删除`);
            }
        };
    }

    // 数据存放位置：更改 / 恢复默认 / 打开文件夹
    const btnDataChange = document.getElementById('btn-data-change');
    if (btnDataChange) btnDataChange.onclick = changeDataDir;
    const btnDataReset = document.getElementById('btn-data-reset');
    if (btnDataReset) btnDataReset.onclick = resetDataDir;
    const btnDataOpen = document.getElementById('btn-data-open');
    if (btnDataOpen) btnDataOpen.onclick = openDataDir;

    document.getElementById('btn-theme-toggle').onclick = () => {
        // 循环切换：跟随系统 (computer) -> 浅色 (light_mode) -> 深色 (dark_mode) -> 跟随系统
        if (State.theme === 'system') {
            State.theme = 'light';
        } else if (State.theme === 'light') {
            State.theme = 'dark';
        } else {
            State.theme = 'system';
        }
        applyTheme();
        saveConfig();
    };

    document.getElementById('btn-fullscreen').onclick = () => {
        winControls.toggleFullscreen();
    };

    // 小本本：打开屏幕右下角的便利贴小窗口（已打开时恢复并前置）
    document.getElementById('btn-scratchpad').onclick = () => {
        openScratchpadWindow();
    };

    // AI 助手：右侧问答面板（未配置站点与模型时先引导去设置）
    const btnAiAssistant = document.getElementById('btn-ai-assistant');
    if (btnAiAssistant) btnAiAssistant.onclick = toggleAiAssistant;

    const btnBackupExport = document.getElementById('btn-backup-export');
    if (btnBackupExport) {
        btnBackupExport.onclick = () => {
            const payload = {
                version: '2.0',
                exportDate: new Date().toISOString(),
                notes: State.notes,
                todos: State.todos,
                folders: State.folders
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `esprin_backup_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('已导出完整备份');
        };
    }

    const inputBackupImport = document.getElementById('input-backup-import');
    if (inputBackupImport) {
        inputBackupImport.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (evt) => {
                try {
                    const parsed = JSON.parse(evt.target.result);
                    if (parsed && Array.isArray(parsed.notes)) {
                        // 备份内容先整体规范化：字段类型、id 唯一性与时间戳都在这里落定。
                        // 两侧共用同一份 id 记录，避免生成出来的 id 在笔记与待办之间撞车；
                        // 备份没有 todos 字段时待办保持现状，它们的 id 也要一并避让。
                        const importIds = new Set();
                        if (!Array.isArray(parsed.todos)) {
                            State.todos.forEach(item => { if (item && item.id) importIds.add(item.id); });
                        }
                        State.notes = normalizeImportedItems(parsed.notes, 'note', importIds);
                        // 待办：新备份里带 todos 字段，旧备份没有则保持现状
                        if (Array.isArray(parsed.todos)) {
                            State.todos = normalizeImportedItems(parsed.todos, 'todo', importIds);
                        }
                        const customFolders = Array.isArray(parsed.folders) ? parsed.folders.filter(f => f && f !== '默认') : [];
                        State.folders = ['默认', ...customFolders];
                        // 备份里引用了已不存在的文件夹时退回“默认”，与启动时的处理保持一致
                        [...State.notes, ...State.todos].forEach(item => {
                            if (item.folder !== '默认' && !State.folders.includes(item.folder)) item.folder = '默认';
                        });
                        // 导入的条目同样先标好类型，后续渲染与保存都走常数时间判断
                        markItemKinds(State.notes, State.todos);
                        // 每篇笔记写入自己的 notes/{id}.md（元数据与正文同处一份文件）
                        State.notes.forEach(note => saveNote(note));
                        // 每项待办写入自己的 todos/{id}.md，格式与笔记一致（仅多一行 isDone）
                        State.todos.forEach(todo => saveTodo(todo));
                        // 指向旧数据集的标签页由 renderTabs 自动丢弃，这里无需额外清理
                        saveConfig();
                        renderApp();
                        showToast('备份导入成功');
                    } else {
                        showToast('导入失败，文件格式错误');
                    }
                } catch (err) {
                    console.error('导入备份失败:', err);
                    showToast('导入失败，文件格式错误');
                }
            };
            reader.onerror = () => showToast('读取备份文件失败');
            reader.readAsText(file);
            e.target.value = '';
        };
    }

    document.querySelectorAll('.sidebar .nav-item[data-filter]').forEach(item => {
        item.onclick = () => {
            State.currentFilter = item.getAttribute('data-filter');
            renderApp();
        };
    });

    const searchInput = document.getElementById('input-search');
    const clearSearchBtn = document.getElementById('btn-search-clear');
    // 输入防抖：连续敲键时只在停顿后重新过滤一次列表
    let searchTimer = null;
    searchInput.oninput = (e) => {
        State.searchQuery = e.target.value;
        clearSearchBtn.classList.toggle('hidden', !State.searchQuery);
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderListPanel, 120);
    };
    clearSearchBtn.onclick = () => {
        clearTimeout(searchTimer);
        searchInput.value = '';
        State.searchQuery = '';
        clearSearchBtn.classList.add('hidden');
        renderListPanel();
    };

    document.getElementById('select-sort').onchange = (e) => {
        State.sortBy = e.target.value;
        renderListPanel();
    };

    document.querySelectorAll('.fmt-btn[data-fmt]').forEach(btn => {
        btn.onclick = () => formatMarkdown(btn.getAttribute('data-fmt'));
    });

    // 新建文件夹 / 添加标签：输入框由主进程的独立弹窗窗口承载
    document.getElementById('btn-add-folder').onclick = async () => {
        const name = await showPrompt('请输入新文件夹的名称', {
            title: '新建文件夹',
            placeholder: '文件夹名称...',
            confirmLabel: '创建'
        });
        if (!name) return;
        if (State.folders.includes(name)) {
            showToast('已存在同名文件夹');
            return;
        }
        State.folders.push(name);
        // 文件夹列表属于偏好配置，随 config.json 保存
        saveConfig();
        renderApp();
    };

    document.getElementById('btn-add-tag').onclick = async () => {
        const item = getActiveItem();
        if (!item || isReadOnlyItem(item)) return;
        // 候选项：应用中已有的标签（笔记与待办合在一起），当前条目已添加的不再重复列出
        const added = Array.isArray(item.tags) ? item.tags : [];
        const choices = getAllTags().filter(tag => !added.includes(tag));
        const picked = await showPromptWithChoices('请输入要添加的标签名称', {
            title: '添加标签',
            detail: choices.length
                ? '可直接输入新标签名，或点选下方已有标签（可多选）。'
                : '可直接输入新标签名。',
            placeholder: '标签名称...',
            confirmLabel: '添加',
            choices,
            multiple: true
        });
        if (!picked) return;

        const pending = [...picked.selected];
        if (picked.value) pending.push(picked.value);
        const newTags = pending.filter(tag => !added.includes(tag));
        if (!newTags.length) return;

        if (!item.tags) item.tags = [];
        newTags.forEach(tag => item.tags.push(tag));
        saveItem(item);
        renderApp();
        showToast(newTags.length > 1 ? `已添加 ${newTags.length} 个标签` : '已添加标签');
    };

    window.onkeydown = (e) => {
        // 输入法组合期间的按键 event.key 不一定是字符串，先挡掉再统一取小写
        if (typeof e.key !== 'string') return;
        if (!e.ctrlKey && !e.metaKey) return;
        const key = e.key.toLowerCase();

        // Ctrl+N 新建笔记；Ctrl+Shift+N 新建待办（与「新建」菜单里的两项对应）
        if (key === 'n') {
            e.preventDefault();
            if (e.shiftKey) createNewTodo();
            else createNewNote();
            return;
        }
        // Ctrl+K 聚焦搜索框
        if (key === 'k') {
            e.preventDefault();
            searchInput.focus();
            return;
        }
        // Ctrl+Tab / Ctrl+Shift+Tab 在打开的标签之间循环切换（编辑区里同样生效）；
        // 标签栏收起时（现代布局的「禁用标签页」）界面上没有标签次序可对照，快捷键一并停用
        if (key === 'tab') {
            if (isTabsDisabled()) return;
            e.preventDefault();
            switchTabByStep(e.shiftKey ? -1 : 1);
            return;
        }
        if (key === 's') {
            e.preventDefault();
            const item = getActiveItem();
            // 没有打开任何内容时不要假装“已保存”
            if (!item) {
                showToast('当前没有打开的内容');
                return;
            }
            // 废纸篓中的条目为只读，不写盘也不提示“已保存”
            if (isReadOnlyItem(item)) {
                showToast('废纸篓中的内容为只读');
                return;
            }
            // 快捷键的预期是“按了就落盘”，因此立刻提交，不等自动保存的 300ms 延时
            autoSaveActiveItem();
            flushPendingSave();
            showToast('已保存');
        }
    };
}
