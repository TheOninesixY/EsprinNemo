function setupEvents() {

document.getElementById('btn-new-item').onclick = () => createItemForCurrentFilter();

    if (typeof initFilterDrawer === 'function') initFilterDrawer();

    document.getElementById('input-note-title').oninput = autoSaveActiveItem;
    const contentTextarea = document.getElementById('textarea-note-content');
    contentTextarea.oninput = () => {
        autoSaveActiveItem();
        scheduleRenderMarkdown();
    };

    contentTextarea.onkeydown = (e) => {
        if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            handleContentTab(e);
        }
    };

contentTextarea.addEventListener('paste', async (event) => {
        const item = getActiveItem();
        if (!item || isReadOnlyItem(item)) return;
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;

        const files = [];
        if (clipboardData.files && clipboardData.files.length) {
            for (let i = 0; i < clipboardData.files.length; i++) {
                files.push(clipboardData.files[i]);
            }
        } else if (clipboardData.items && clipboardData.items.length) {
            for (let i = 0; i < clipboardData.items.length; i++) {
                const it = clipboardData.items[i];
                if (it.kind === 'file') {
                    const file = it.getAsFile();
                    if (file) files.push(file);
                }
            }
        }

        if (!files.length) return;

        event.preventDefault();
        const saved = [];
        for (const file of files) {
            try {
                let filePath = '';
                if (typeof webUtils !== 'undefined' && typeof webUtils.getPathForFile === 'function') {
                    filePath = webUtils.getPathForFile(file);
                } else if (file.path) {
                    filePath = file.path;
                }

                if (filePath && fs.existsSync(filePath)) {
                    const asset = saveAssetFile(filePath);
                    if (asset) saved.push(asset);
                } else {
                    const arrayBuffer = await file.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    const asset = saveAssetFile(null, buffer, file.name);
                    if (asset) saved.push(asset);
                }
            } catch (err) {
                console.error('[Desktop:ERROR] 粘贴文件保存失败:', err);
            }
        }

        if (saved.length) {
            insertAssetReferences(saved);
        }
    });

const editorPane = document.getElementById('editor-pane');
    if (editorPane) {
        editorPane.addEventListener('dragover', (event) => {
            const types = event.dataTransfer && event.dataTransfer.types;
            if (!types || !Array.from(types).includes('Files')) return;
            const item = getActiveItem();
            if (!item || isReadOnlyItem(item)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        });

        editorPane.addEventListener('drop', async (event) => {
            const types = event.dataTransfer && event.dataTransfer.types;
            if (!types || !Array.from(types).includes('Files')) return;
            const item = getActiveItem();
            if (!item || isReadOnlyItem(item)) return;
            event.preventDefault();

            const dtFiles = event.dataTransfer.files;
            if (!dtFiles || !dtFiles.length) return;

            const saved = [];
            for (let i = 0; i < dtFiles.length; i++) {
                const file = dtFiles[i];
                try {
                    let filePath = '';
                    if (typeof webUtils !== 'undefined' && typeof webUtils.getPathForFile === 'function') {
                        filePath = webUtils.getPathForFile(file);
                    } else if (file.path) {
                        filePath = file.path;
                    }

                    if (filePath && fs.existsSync(filePath)) {
                        const asset = saveAssetFile(filePath);
                        if (asset) saved.push(asset);
                    } else {
                        const arrayBuffer = await file.arrayBuffer();
                        const buffer = Buffer.from(arrayBuffer);
                        const asset = saveAssetFile(null, buffer, file.name);
                        if (asset) saved.push(asset);
                    }
                } catch (err) {
                    console.error('[Desktop:ERROR] 拖拽文件保存失败:', err);
                }
            }

            if (saved.length) {
                insertAssetReferences(saved);
                showToast(`已插入 ${saved.length} 个文件`);
            }
        });
    }

    document.getElementById('editor-folder-select').onchange = (e) => {
        const item = getActiveItem();
        if (item && !isReadOnlyItem(item)) {
            item.folder = e.target.value;
            saveItem(item);
            renderApp();
        }
    };

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

    const settingSpellcheck = document.getElementById('setting-spellcheck');
    if (settingSpellcheck) {
        settingSpellcheck.onchange = (e) => {
            State.spellcheck = e.target.checked;
            applySpellcheck();
            saveConfig();
        };
    }

const settingTrashRetention = document.getElementById('setting-trash-retention');
    if (settingTrashRetention) {
        settingTrashRetention.onchange = (e) => {
            State.trashRetentionDays = normalizeTrashRetentionDays(e.target.value);
            e.target.value = String(State.trashRetentionDays);
            saveConfig();

            const removed = purgeExpiredTrashItems();
            renderApp();
            if (removed > 0) ipcRenderer.send('settings:data-changed');
            if (!State.trashRetentionDays) {
                showToast('已关闭废纸篓自动清理');
            } else if (removed > 0) {
                showToast(`已自动清理 ${removed} 条超过 ${State.trashRetentionDays} 天的废纸篓内容`);
            } else {
                showToast(`废纸篓中超过 ${State.trashRetentionDays} 天的笔记与待办将被自动删除`);
            }
        };
    }

const btnDataChange = document.getElementById('btn-data-change');
    if (btnDataChange) btnDataChange.onclick = changeDataDir;
    const btnDataReset = document.getElementById('btn-data-reset');
    if (btnDataReset) btnDataReset.onclick = resetDataDir;
    const btnDataOpen = document.getElementById('btn-data-open');
    if (btnDataOpen) btnDataOpen.onclick = openDataDir;

    const btnDataImport = document.getElementById('btn-data-import');
    if (btnDataImport) btnDataImport.onclick = () => importNoteFiles();

    document.getElementById('btn-theme-toggle').onclick = () => {

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

    const fullscreenButton = document.getElementById('btn-fullscreen');
    if (fullscreenButton) {
        fullscreenButton.onclick = () => {
            winControls.toggleFullscreen();
        };
    }

document.getElementById('btn-scratchpad').onclick = () => {
        openScratchpadWindow();
    };

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

const importIds = new Set();
                        if (!Array.isArray(parsed.todos)) {
                            State.todos.forEach(item => { if (item && item.id) importIds.add(item.id); });
                        }
                        State.notes = normalizeImportedItems(parsed.notes, 'note', importIds);

                        if (Array.isArray(parsed.todos)) {
                            State.todos = normalizeImportedItems(parsed.todos, 'todo', importIds);
                        }
                        const customFolders = Array.isArray(parsed.folders) ? parsed.folders.filter(f => f && f !== '默认') : [];
                        State.folders = ['默认', ...customFolders];

                        [...State.notes, ...State.todos].forEach(item => {
                            if (item.folder !== '默认' && !State.folders.includes(item.folder)) item.folder = '默认';
                        });

                        markItemKinds(State.notes, State.todos);

                        State.notes.forEach(note => saveNote(note));

                        State.todos.forEach(todo => saveTodo(todo));

                        saveConfig();
                        renderApp();
                        showToast('备份导入成功');
                    } else {
                        showToast('导入失败，文件格式错误');
                    }
                } catch (err) {
                    console.error('[Desktop:ERROR] 导入备份失败:', err);
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
            const wasSettings = State.activeNoteId === 'settings';
            if (wasSettings) {
                flushPendingSave();
                closeTab('settings');
                State.activeNoteId = null;
            }
            State.currentFilter = item.getAttribute('data-filter');
            renderApp();
        };
    });

    const searchInput = document.getElementById('input-search');
    const clearSearchBtn = document.getElementById('btn-search-clear');

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

    const fmtHeadingMenu = document.getElementById('fmt-heading-menu');
    if (fmtHeadingMenu) {
        fmtHeadingMenu.onchange = () => {
            const value = fmtHeadingMenu.value;
            if (value) formatMarkdown(value);
            fmtHeadingMenu.value = '';
        };
    }

    const fmtInsertMenu = document.getElementById('fmt-insert-menu');
    if (fmtInsertMenu) {
        fmtInsertMenu.onchange = () => {
            const value = fmtInsertMenu.value;
            if (value === 'asset') pickAndInsertAssets();
            else if (value) formatMarkdown(value);
            fmtInsertMenu.value = '';
        };
    }

    const btnFileManager = document.getElementById('btn-file-manager');
    if (btnFileManager) {
        btnFileManager.onclick = () => toggleFileManager();
    }

    const btnFmClose = document.getElementById('btn-fm-close');
    if (btnFmClose) {
        btnFmClose.onclick = () => {
            State.fmPanelOpen = false;
            applyFileManagerVisibility();
        };
    }

    const btnFmExplorer = document.getElementById('btn-fm-explorer');
    if (btnFmExplorer) {
        btnFmExplorer.onclick = async () => {
            const item = getActiveItem();
            if (!item) return;
            const result = await ipcRenderer.invoke('fm:open-folder', { itemId: item.id });
            if (result && !result.ok && result.error) {
                showToast('无法打开文件夹: ' + result.error);
            }
        };
    }

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

        saveConfig();
        renderApp();
    };

    document.getElementById('btn-add-tag').onclick = async () => {
        const item = getActiveItem();
        if (!item || isReadOnlyItem(item)) return;
        await promptAddItemTags(item);
    };

    window.onkeydown = (e) => {

        if (typeof IS_SETTINGS_WINDOW !== 'undefined' && IS_SETTINGS_WINDOW) return;
        if (typeof e.key !== 'string') return;
        if (!e.ctrlKey && !e.metaKey) return;
        const key = e.key.toLowerCase();

if (key === 'n') {
            e.preventDefault();
            if (e.shiftKey) createNewTodo();
            else createNewNote();
            return;
        }

        if (key === 'k') {
            e.preventDefault();

if (searchInput.offsetParent === null && State.activeNoteId === 'settings') {
                closeTab('settings');
                renderApp();
            }
            searchInput.focus();
            return;
        }

if (key === 'tab') {
            e.preventDefault();
            switchTabByStep(e.shiftKey ? -1 : 1);
            return;
        }
        if (key === 's') {
            e.preventDefault();
            const item = getActiveItem();

            if (!item) {
                showToast('当前没有打开的内容');
                return;
            }

            if (isReadOnlyItem(item)) {
                showToast('废纸篓中的内容为只读');
                return;
            }

            autoSaveActiveItem();
            flushPendingSave();
            showToast('已保存');
        }
    };
}
