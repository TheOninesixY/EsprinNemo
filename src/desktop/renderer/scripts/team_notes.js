let teamNotesData = null;

let teamNotesBusy = false;

let teamNotesFetchedAt = 0;

let teamRequestsKnown = null;
const TEAM_NOTES_REFRESH_MS = 5000;

function teamNotesEnabled() {
    return typeof isSyncEnabled === 'function' && isSyncEnabled();
}

function setTeamNotesStatus(text, tone) {
    const status = document.getElementById('team-status');
    if (!status) return;
    status.textContent = text;
    status.dataset.tone = tone || '';
}

async function loadTeamNotes() {
    if (!teamNotesEnabled()) {
        teamNotesData = null;
        teamRequestsKnown = null;
        teamNotesFetchedAt = Date.now();
        return null;
    }
    try {
        const result = await ipcRenderer.invoke('sync:shares');
        teamNotesData = result && result.ok ? {
            ...result,

            incoming: Array.isArray(result.incoming) ? result.incoming : [],
            received: Array.isArray(result.received) ? result.received : [],
            outgoing: Array.isArray(result.outgoing) ? result.outgoing : []
        } : null;
        if (!result || !result.ok) {
            setTeamNotesStatus(`读取共享列表失败：${(result && result.error) || '与主进程通信异常'}`, 'error');
        }
    } catch (err) {
        console.error('读取共享列表失败:', err);
        teamNotesData = null;
        setTeamNotesStatus('读取共享列表失败：与主进程通信异常，请重试', 'error');
    }
    teamNotesFetchedAt = Date.now();
    announceTeamRequests();
    return teamNotesData;
}

function announceTeamRequests() {
    if (!teamNotesData) return;
    const pending = Array.isArray(teamNotesData.incoming) ? teamNotesData.incoming.length : 0;
    if (teamRequestsKnown !== null && pending > teamRequestsKnown) {
        showToast(`收到 ${pending - teamRequestsKnown} 条共享请求：可在「设置 → 数据与同步 → 团队笔记」中处理`);
    }
    teamRequestsKnown = pending;
}

async function refreshTeamNotes() {
    await loadTeamNotes();
    syncTeamNotesSettingsUI();
}

function refreshTeamNotesSoon() {
    if (!teamNotesEnabled()) {
        teamNotesData = null;
        syncTeamNotesSettingsUI();
        return;
    }
    if (Date.now() - teamNotesFetchedAt < TEAM_NOTES_REFRESH_MS) {
        syncTeamNotesSettingsUI();
        return;
    }
    refreshTeamNotes().catch(() => {});
}

function teamLocalItemId(record, isOwner) {
    return isOwner ? String(record.noteId) : sharedItemId(record.owner, record.noteId);
}

function teamNoteTitle(record, isOwner) {
    const item = typeof getItemById === 'function' ? getItemById(teamLocalItemId(record, isOwner)) : null;
    if (item) return itemDisplayTitle(item);
    return record.title || '未命名笔记';
}

function createTeamRow({ icon, title, meta }) {
    const row = document.createElement('div');
    row.className = 'team-item';

    const main = document.createElement('div');
    main.className = 'team-item-main';
    const iconEl = document.createElement('span');
    iconEl.className = 'ms-icon sm';
    iconEl.textContent = icon;
    const text = document.createElement('div');
    text.className = 'team-item-text';
    const titleEl = document.createElement('span');
    titleEl.className = 'team-item-title';
    titleEl.textContent = title;
    const metaEl = document.createElement('span');
    metaEl.className = 'team-item-meta';
    metaEl.textContent = meta;
    text.append(titleEl, metaEl);
    main.append(iconEl, text);

    const actions = document.createElement('div');
    actions.className = 'team-item-actions';

    row.append(main, actions);
    return { row, actions };
}

function teamActionButton(label, title, variant, onClick) {
    const button = document.createElement('button');
    button.className = variant ? `settings-btn ${variant}` : 'settings-btn';
    button.textContent = label;
    if (title) button.title = title;
    button.disabled = teamNotesBusy;
    button.onclick = onClick;
    return button;
}

function teamEmptyRow(text) {
    const empty = document.createElement('div');
    empty.className = 'team-empty';
    empty.textContent = text;
    return empty;
}

function openTeamNote(record, isOwner) {
    const itemId = teamLocalItemId(record, isOwner);
    if (!getItemById(itemId)) {
        showToast('这篇笔记还没同步到本地：同步一次后即可打开');
        return;
    }
    openTab(itemId);
    renderApp();
}

function syncTeamNotesSettingsUI() {
    const requests = document.getElementById('team-requests');
    const shared = document.getElementById('team-shared');
    if (!requests || !shared) return;

    requests.innerHTML = '';
    shared.innerHTML = '';

    if (!teamNotesEnabled()) {
        requests.appendChild(teamEmptyRow('自建同步尚未启用：启用后填写服务器地址与账户，即可收发共享请求。'));
        shared.appendChild(teamEmptyRow('暂无共享。'));
        setTeamNotesStatus('自建同步已关闭：不会读取也不会发出任何共享请求。');
        return;
    }

    const data = teamNotesData;
    if (!data) {
        requests.appendChild(teamEmptyRow('尚未读到共享列表：点「刷新」重试。'));
        shared.appendChild(teamEmptyRow('暂无共享。'));
        return;
    }

if (!data.incoming.length) {
        requests.appendChild(teamEmptyRow('暂无共享请求：别人把笔记共享过来时会出现在这里。'));
    } else {
        data.incoming.forEach((record) => {
            const { row, actions } = createTeamRow({
                icon: 'mark_email_unread',
                title: `${record.ownerName} 请求共享《${teamNoteTitle(record, false)}》`,
                meta: `来自账户 ${record.owner} · 同意后这篇笔记会同时出现在双方的笔记列表里`
            });
            actions.append(
                teamActionButton('拒绝', '不接收这篇笔记，对方会看到请求被拒绝', '', () => respondTeamShare(record, false)),
                teamActionButton('同意', '接收这篇笔记并立即同步到本地', 'primary', () => respondTeamShare(record, true))
            );
            requests.appendChild(row);
        });
    }

const rows = [];
    data.received.forEach((record) => {
        const itemId = teamLocalItemId(record, false);
        const local = getItemById(itemId);
        rows.push({
            record,
            isOwner: false,
            icon: 'group',
            title: `来自 ${record.ownerName}：《${teamNoteTitle(record, false)}》`,
            meta: local ? '共享笔记：正文可以直接编辑，改动会同步给所有者' : '尚未同步到本地：同步一次后即可打开'
        });
    });
    data.outgoing.forEach((record) => {
        rows.push({
            record,
            isOwner: true,
            icon: 'share',
            title: `《${teamNoteTitle(record, true)}》 → ${record.targetName}`,
            meta: record.status === 'accepted' ? '已共享：对方可以编辑这篇笔记' : '等待对方同意'
        });
    });

    if (!rows.length) {
        shared.appendChild(teamEmptyRow('暂无共享：右键一篇笔记选「共享…」即可邀请某个账户。'));
    } else {
        rows.forEach((entry) => {
            const { row, actions } = createTeamRow(entry);
            if (entry.isOwner) {
                actions.append(
                    teamActionButton('打开', '在标签页打开这篇笔记', '', () => openTeamNote(entry.record, true)),
                    teamActionButton('撤销', '停止与这个账户共享，对方本地那份会随之移除', '', () => revokeTeamShare(entry.record))
                );
            } else {
                actions.append(
                    teamActionButton('打开', '在标签页打开这篇笔记', '', () => openTeamNote(entry.record, false)),
                    teamActionButton('退出共享', '从列表中移除这篇笔记，所有者那份不受影响', '', () => leaveTeamShare(entry.record))
                );
            }
            shared.appendChild(row);
        });
    }

    const total = data.incoming.length + data.received.length + data.outgoing.length;
    setTeamNotesStatus(total
        ? `共 ${total} 条：待确认 ${data.incoming.length} 条 · 已共享到手 ${data.received.length} 条 · 已共享出去 ${data.outgoing.length} 条`
        : `暂无共享记录（账户 ${data.user || '未知'}）。`);
}

function applyTeamShareResult(result, message) {
    const synced = result && result.synced;
    if (synced && (synced.written || synced.deleted)) {
        adoptDataDir(DATA_DIR, { message: synced.summary || message });
    }
    if (result && result.syncError) {
        setTeamNotesStatus(`${message}；但同步未成功：${result.syncError}`, 'error');
        showToast(`${message}（同步未成功）`);
        return;
    }
    showToast(message);
}

function setTeamActionButtonsDisabled(disabled) {
    document.querySelectorAll('#settings-view .team-item-actions button').forEach((button) => {
        button.disabled = disabled;
    });
}

async function runTeamShareAction(channel, payload, pendingText) {
    if (teamNotesBusy) return null;
    teamNotesBusy = true;
    setTeamActionButtonsDisabled(true);
    setTeamNotesStatus(pendingText);
    try {
        const result = await ipcRenderer.invoke(channel, payload);
        if (!result || !result.ok) {
            setTeamNotesStatus(`操作失败：${(result && result.error) || '与主进程通信异常'}`, 'error');
            return null;
        }
        return result;
    } catch (err) {
        console.error('共享操作失败:', err);
        setTeamNotesStatus('操作失败：与主进程通信异常，请重试', 'error');
        return null;
    } finally {
        teamNotesBusy = false;
        setTeamActionButtonsDisabled(false);
    }
}

async function respondTeamShare(record, accept) {
    if (!accept) {
        const confirmed = await showConfirm(`拒绝《${teamNoteTitle(record, false)}》的共享请求？`, {
            title: '拒绝共享',
            detail: `${record.ownerName} 会看到这条请求被拒绝；对方可以再次发出请求。`,
            type: 'warning',
            icon: 'block',
            confirmLabel: '拒绝',
            danger: true
        });
        if (!confirmed) return;
    }

    const result = await runTeamShareAction('sync:share-respond', { id: record.id, accept },
        accept ? '正在同意并同步…' : '正在拒绝…');
    if (result) applyTeamShareResult(result, accept ? '已同意共享' : '已拒绝共享请求');
    await refreshTeamNotes();
}

async function revokeTeamShare(record) {
    const confirmed = await showConfirm(`撤销与 ${record.targetName} 的共享？`, {
        title: '撤销共享',
        detail: `撤销后《${teamNoteTitle(record, true)}》会从对方的数据里移除；对方此前改过的内容仍留在笔记里。`,
        type: 'warning',
        icon: 'link_off',
        confirmLabel: '撤销共享',
        danger: true
    });
    if (!confirmed) return;

    const result = await runTeamShareAction('sync:share-revoke', { id: record.id }, '正在撤销共享…');
    if (result) applyTeamShareResult(result, '已撤销共享');
    await refreshTeamNotes();
}

async function leaveTeamShare(record) {
    const confirmed = await showConfirm(`退出《${teamNoteTitle(record, false)}》的共享？`, {
        title: '退出共享',
        detail: `这篇笔记由 ${record.ownerName} 共享过来；退出后它会从本地列表中移除，对方那份不受影响。`,
        type: 'warning',
        icon: 'link_off',
        confirmLabel: '退出共享',
        danger: true
    });
    if (!confirmed) return;

    const result = await runTeamShareAction('sync:share-leave', { id: record.id }, '正在退出共享…');
    if (result) applyTeamShareResult(result, '已退出共享');
    await refreshTeamNotes();
}

async function shareNoteFromMenu(itemId) {
    const item = getItemById(itemId);
    if (!item) return;
    if (isTodoItem(item)) {
        showToast('团队笔记目前只支持笔记');
        return;
    }
    if (isSharedItem(item)) {
        showToast('这是别人共享过来的笔记，无法再次共享');
        return;
    }
    if (!teamNotesEnabled()) {
        showToast('共享需要先启用自建同步');
        return;
    }

    const data = await loadTeamNotes();
    if (!data) {
        showToast('读取共享列表失败：请在设置里检查服务器地址与访问令牌');
        return;
    }

    const notePath = `notes/${item.id}.md`;
    const existing = data.outgoing.filter((record) => record.note === notePath);
    const summary = existing.length
        ? `已共享给：${existing.map((record) => `${record.targetName}（${record.status === 'accepted' ? '已同意' : '待确认'}）`).join('、')}`
        : '尚未共享给任何人';

    const target = await showPrompt(`把《${itemDisplayTitle(item)}》共享给谁？`, {
        title: '共享笔记',
        icon: 'share',
        label: '对方的用户 ID',
        placeholder: '例如：alice',
        confirmLabel: '发送请求',
        detail: `${summary}。填写对方的用户 ID 或账户名：对方在「设置 → 数据与同步 → 团队笔记」里同意之后，`
            + '这篇笔记会同时出现在双方的笔记列表里，双方都能编辑；共享者可以随时在同一个分区里撤销。'
    });
    if (target === null) return;

    const wanted = String(target).trim();
    if (!wanted) {
        showToast('请填写对方的用户 ID');
        return;
    }

    teamNotesBusy = true;
    setTeamNotesStatus('正在共享…');
    try {

        flushPendingSave();
        await ipcRenderer.invoke('sync:now');
    } catch (err) {
        console.error('共享前同步失败:', err);
    } finally {
        teamNotesBusy = false;
    }

    const result = await runTeamShareAction('sync:share-request', { path: notePath, target: wanted }, '正在共享…');
    if (result) {
        showToast(`已向 ${wanted} 发出共享请求`);
        setTeamNotesStatus(`已向 ${wanted} 发出共享请求；对方同意后这篇笔记会出现在双方的列表里。`);
    }
    await refreshTeamNotes();
}

async function leaveSharedNoteFromMenu(itemId) {
    const item = getItemById(itemId);
    if (!isSharedItem(item)) return;

    const data = await loadTeamNotes();
    const record = data
        ? data.received.find((entry) => entry.owner === item.shared.owner && entry.noteId === item.shared.noteId)
        : null;
    if (!record) {
        showToast('找不到这条共享记录：请先在设置里刷新「团队笔记」');
        return;
    }
    await leaveTeamShare(record);
}

function initTeamNotesSettings() {
    const refreshBtn = document.getElementById('btn-team-refresh');
    if (refreshBtn) {
        refreshBtn.onclick = () => {
            refreshTeamNotes().then(() => showToast('已刷新共享列表'));
        };
    }
    syncTeamNotesSettingsUI();
}
