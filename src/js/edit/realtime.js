var realtimeStatus = document.getElementById('realtimeStatus');
var realtimeViewers = document.getElementById('realtimeViewers');
var realtimeApplying = false;
var realtimeState = {
    enabled: false,
    socket: null,
    connected: false,
    joined: false,
    currentDocId: null,
    shadowDoc: null,
    shadowVersion: null,
    pending: false,
    dirty: false,
    debounceTimer: null,
    inflightPatch: null,
    inflightBase: null
};
// Must be unique per tab, so never persist it: localStorage is origin-wide
// (and "Duplicate Tab" copies sessionStorage), which would give same-browser
// tabs one shared id and make the doc:patched echo check below drop each
// other's patches as self-echo. Reloads don't need a stable id — rejoin
// refreshes the shadow, and the save header reads this live variable.
var realtimeClientId = 'client-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

function realtimeCloneDoc(doc) {
    return doc ? JSON.parse(JSON.stringify(doc)) : {};
}

// Mirror of the server guard (lib/realtime.js): refuse any patch that could
// reach Object.prototype. window.jsonpatch.apply walks with a bare obj[key] and
// assigns with a bare obj[key] = value, so a hostile or out-of-band patch would
// otherwise pollute the editor page. Run this before every apply(); the server
// screen only covers patches that transit its socket handler.
function realtimeIsUnsafeKey(key) {
    return key === '__proto__'
        || key === 'prototype'
        || key === 'constructor'
        || Object.prototype.hasOwnProperty.call(Object.prototype, key);
}

function realtimePointerHasUnsafeKey(pointer) {
    if (typeof pointer !== 'string') return false;
    var segments = pointer.split('/');
    for (var i = 0; i < segments.length; i++) {
        var segment = segments[i].replace(/~1/g, '/').replace(/~0/g, '~');
        if (realtimeIsUnsafeKey(segment)) return true;
    }
    return false;
}

function realtimeValueHasUnsafeKey(value) {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) {
            if (realtimeValueHasUnsafeKey(value[i])) return true;
        }
        return false;
    }
    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j++) {
        if (realtimeIsUnsafeKey(keys[j]) || realtimeValueHasUnsafeKey(value[keys[j]])) return true;
    }
    return false;
}

function realtimePatchIsUnsafe(patch) {
    if (!Array.isArray(patch)) return true;
    for (var i = 0; i < patch.length; i++) {
        var op = patch[i];
        if (!op || typeof op !== 'object') return true;
        if (realtimePointerHasUnsafeKey(op.path) || realtimePointerHasUnsafeKey(op.from)) return true;
        if (Object.prototype.hasOwnProperty.call(op, 'value') && realtimeValueHasUnsafeKey(op.value)) return true;
    }
    return false;
}

function realtimeSetStatus(connected, message) {
    if (!realtimeStatus) return;
    var label = connected ? '🟢 Online' : 'Offline';
    if (message) {
        label = label + ' (' + message + ')';
    }
    realtimeStatus.textContent = label;
}

function realtimeSetViewers(count) {
    if (!realtimeViewers) return;
    if (count && count > 1) {
        realtimeViewers.textContent = count + ' viewers';
    } else {
        realtimeViewers.textContent = '';
    }
}

function realtimeGetCurrentDoc() {
    var sourceTab = document.getElementById('sourceTab');
    if (sourceTab && sourceTab.checked && sourceEditor) {
        try {
            return JSON.parse(sourceEditor.getSession().getValue());
        } catch (e) {
            return null;
        }
    }
    if (docEditor && typeof docEditor.getValue === 'function') {
        return docEditor.getValue();
    }
    return null;
}

function realtimeSetEditorContents(doc) {
    var ok = true;
    realtimeApplying = true;
    try {
        if (docEditor) {
            docEditor.setValue(doc);
        }
    } catch (e) {
        ok = false;
    }
    try {
        // Keep the source tab in sync when it is the visible editor, so
        // realtimeGetCurrentDoc() never reads text older than the shadow.
        var sourceTab = document.getElementById('sourceTab');
        if (sourceTab && sourceTab.checked && sourceEditor) {
            insync = true;
            try {
                sourceEditor.getSession().setValue(JSON.stringify(doc, null, 2));
                sourceEditor.clearSelection();
            } finally {
                insync = false;
            }
            if (mainTabGroup && mainTabGroup.changeIndex && mainTabGroup.changeIndex.length > 1) {
                mainTabGroup.changeIndex[1] = mainTabGroup.changeIndex[0];
            }
        }
    } catch (e) {
    }
    realtimeApplying = false;
    return ok;
}

function realtimeJoinIfReady() {
    if (!window.realtimeEnabled) return;
    if (!realtimeState.socket || !realtimeState.socket.connected) return;
    if (!schemaName || typeof schemaName !== 'string') return;
    var docId = getDocID();
    if (!docId) return;
    if (realtimeState.currentDocId === docId && realtimeState.joined) return;
    realtimeState.joined = false;
    realtimeState.socket.emit('doc:join', { collection: schemaName, docId: docId }, function (res) {
        if (!res || !res.ok) {
            return;
        }
        var serverDoc = res.doc || {};
        // Base for detecting genuine local edits: the last server state this
        // client synced (rejoin), else the document as loaded into the editor
        // (first join). Never the fresh server doc — diffing against that
        // turns everyone else's newer changes into a bogus local "edit".
        var prevBase = null;
        if (realtimeState.currentDocId === docId && realtimeState.shadowDoc) {
            prevBase = realtimeState.shadowDoc;
        } else if (typeof draftsBaseline === 'string' && draftsBaseline) {
            try {
                prevBase = JSON.parse(draftsBaseline);
            } catch (e) {
            }
        }
        realtimeState.currentDocId = docId;
        realtimeState.joined = true;
        if (typeof res.viewers === 'number') {
            realtimeSetViewers(res.viewers);
        }
        realtimeMergeServerState(serverDoc, typeof res.version === 'number' ? res.version : 0, prevBase);
    });
}

// Adopt a newer server state without discarding edits this browser has made
// but not yet had accepted. `prevBase` is the doc state those local edits were
// made against (the previous shadow, or the initial baseline). We rebase the
// local delta onto the server copy so remote changes and local changes both
// survive; only a genuine conflict (local delta no longer applies) lets the
// server copy win.
function realtimeMergeServerState(serverDoc, serverVersion, prevBase) {
    if (!window.jsonpatch || typeof window.jsonpatch.compare !== 'function') return;
    serverDoc = serverDoc || {};
    var currentDoc = realtimeGetCurrentDoc();
    var localPatch = (prevBase && currentDoc) ? window.jsonpatch.compare(prevBase, currentDoc) : [];
    var target = realtimeCloneDoc(serverDoc);
    var haveLocal = !!(localPatch && localPatch.length);
    if (haveLocal && realtimePatchIsUnsafe(localPatch)) {
        // The local delta would reach Object.prototype; discard it and take the
        // server copy rather than applying it.
        target = realtimeCloneDoc(serverDoc);
        haveLocal = false;
    }
    if (haveLocal) {
        try {
            window.jsonpatch.apply(target, localPatch, true);
        } catch (e) {
            // Local edits collide with the server copy: server wins.
            target = realtimeCloneDoc(serverDoc);
            haveLocal = false;
        }
    }
    // Only rewrite the editor when it actually differs, so a viewer with no
    // pending edits isn't churned (cursor reset) on every remote change.
    if (!currentDoc || window.jsonpatch.compare(currentDoc, target).length) {
        if (!realtimeSetEditorContents(target)) {
            // Editor write failed: leave the shadow untouched (consistent but
            // stale) and force a fresh resync rather than diverging.
            realtimeState.joined = false;
            return;
        }
    }
    realtimeState.shadowDoc = realtimeCloneDoc(serverDoc);
    if (typeof serverVersion === 'number') {
        realtimeState.shadowVersion = serverVersion;
    }
    if (haveLocal) {
        realtimeSchedulePatch();
    }
}

function realtimeSendPatch(patch) {
    if (!realtimeState.socket || !realtimeState.socket.connected) return;
    if (!realtimeState.joined || !realtimeState.currentDocId) return;
    if (realtimeState.pending) {
        realtimeState.dirty = true;
        return;
    }
    if (!window.jsonpatch || typeof window.jsonpatch.apply !== 'function') return;
    infoMsg.textContent = "Saving...";
    realtimeState.pending = true;
    realtimeState.inflightPatch = patch;
    realtimeState.inflightBase = realtimeCloneDoc(realtimeState.shadowDoc || {});
    var payload = {
        collection: schemaName,
        docId: realtimeState.currentDocId,
        baseVersion: realtimeState.shadowVersion,
        patch: patch,
        clientId: realtimeClientId
    };
    realtimeState.socket.emit('doc:patch', payload, function (res) {
        realtimeState.pending = false;
        if (res && res.ok) {
            var nextShadow = realtimeCloneDoc(realtimeState.inflightBase || {});
            try {
                window.jsonpatch.apply(nextShadow, realtimeState.inflightPatch, true);
            } catch (e) {
                nextShadow = realtimeCloneDoc(realtimeGetCurrentDoc());
            }
            realtimeState.shadowDoc = nextShadow;
            realtimeState.shadowVersion = res.newVersion;
            realtimeState.inflightPatch = null;
            realtimeState.inflightBase = null;
            if (draftsCache && draftsCache.remove) {
                draftsCache.cancelSave();
                draftsCache.remove(realtimeState.currentDocId);
                infoMsg.textContent = "Auto saved";
            }
            if (realtimeState.dirty) {
                realtimeState.dirty = false;
                realtimeSchedulePatch();
            }
            return;
        }
        var rejectedBase = realtimeState.inflightBase;
        realtimeState.inflightPatch = null;
        realtimeState.inflightBase = null;
        if (res && res.reason === 'PATCH_INVALID') {
            // Server refused the patch (e.g. it reached Object.prototype).
            // Surface it and stop, rather than clearing "Saving..." never and
            // re-sending the identical rejected patch on every later keystroke.
            infoMsg.textContent = "Save error";
            return;
        }
        if (res && res.reason === 'VERSION_MISMATCH' && res.doc && Object.keys(res.doc).length) {
            // Someone else's version landed first. Rebase this client's edits
            // (both the rejected patch and anything typed since, captured by
            // diffing against the base the rejected patch was built on) onto
            // the server copy instead of discarding them.
            realtimeMergeServerState(res.doc, typeof res.version === 'number' ? res.version : realtimeState.shadowVersion, rejectedBase);
            return;
        }
        if (res && res.reason === 'VERSION_MISMATCH') {
            // Server has no usable copy (e.g. document was deleted). Don't wipe
            // the editor; resync fresh and surface the condition.
            infoMsg.textContent = "Sync error";
            realtimeState.joined = false;
            realtimeJoinIfReady();
            return;
        }
        if (realtimeState.dirty) {
            realtimeState.dirty = false;
            realtimeSchedulePatch();
        }
    });
}

function realtimeSchedulePatch() {
    if (!window.realtimeEnabled) return;
    if (realtimeApplying || draftsSyncing) return;
    if (realtimeState.pending) {
        realtimeState.dirty = true;
        return;
    }
    if (realtimeState.debounceTimer) {
        clearTimeout(realtimeState.debounceTimer);
    }
    var debounceMs = (window.realtimeConfig && window.realtimeConfig.debounceMs) ? window.realtimeConfig.debounceMs : 350;
    realtimeState.debounceTimer = setTimeout(function () {
        if (!realtimeState.socket || !realtimeState.socket.connected) return;
        if (!window.jsonpatch || typeof window.jsonpatch.compare !== 'function') return;
        var currentDoc = realtimeGetCurrentDoc();
        if (!currentDoc) return;
        var patch = window.jsonpatch.compare(realtimeState.shadowDoc || {}, currentDoc);
        if (patch && patch.length) {
            realtimeSendPatch(patch);
        }
    }, debounceMs);
}

function realtimeApplyRemotePatch(data) {
    if (!data || !data.patch) return;
    if (data.clientId && data.clientId === realtimeClientId) return;
    if (!window.jsonpatch || typeof window.jsonpatch.apply !== 'function') return;
    if (realtimePatchIsUnsafe(data.patch)) {
        // Remote patch could pollute Object.prototype; never apply it. Drop the
        // shadow and resync from a clean server copy instead.
        realtimeState.joined = false;
        realtimeJoinIfReady();
        return;
    }
    var prevShadow = realtimeCloneDoc(realtimeState.shadowDoc || {});
    var nextShadow = realtimeCloneDoc(realtimeState.shadowDoc || {});
    try {
        window.jsonpatch.apply(nextShadow, data.patch, true);
    } catch (e) {
        // Shadow diverged from the server; force a fresh join to resync.
        realtimeState.joined = false;
        realtimeJoinIfReady();
        return;
    }
    // Rebase any edits this user has made but not yet committed (the diff
    // between the pre-patch shadow and what's in the editor now) on top of the
    // incoming remote change, rather than overwriting them.
    realtimeMergeServerState(nextShadow, data.newVersion, prevShadow);
}

function initRealtime() {
    if (!window.realtimeEnabled || typeof io === 'undefined') {
        return;
    }
    realtimeState.enabled = true;
    realtimeState.socket = io();
    realtimeSetStatus(false, 'connecting');
    realtimeState.socket.on('connect', function () {
        realtimeState.connected = true;
        realtimeSetStatus(true);
        realtimeJoinIfReady();
    });
    realtimeState.socket.on('disconnect', function () {
        realtimeState.connected = false;
        realtimeState.joined = false;
        // A patch in flight when the socket drops will never be acked, which
        // would leave `pending` stuck true and silently kill all future saves.
        // Clear it so the post-reconnect rejoin re-sends the still-local edits.
        realtimeState.pending = false;
        realtimeState.dirty = false;
        realtimeState.inflightPatch = null;
        realtimeState.inflightBase = null;
        if (realtimeState.debounceTimer) {
            clearTimeout(realtimeState.debounceTimer);
            realtimeState.debounceTimer = null;
        }
        realtimeSetStatus(false);
        realtimeSetViewers(0);
    });
    realtimeState.socket.on('connect_error', function () {
        realtimeSetStatus(false, 'error');
    });
    realtimeState.socket.on('doc:patched', function (data) {
        realtimeApplyRemotePatch(data);
    });
    realtimeState.socket.on('doc:viewers', function (data) {
        if (data && typeof data.count === 'number') {
            realtimeSetViewers(data.count);
        }
    });
}


export {
    realtimeStatus,
    realtimeViewers,
    realtimeApplying,
    realtimeState,
    realtimeClientId,
    realtimeCloneDoc,
    realtimeSetStatus,
    realtimeSetViewers,
    realtimeGetCurrentDoc,
    realtimeJoinIfReady,
    realtimeSetEditorContents,
    realtimeMergeServerState,
    realtimeSendPatch,
    realtimeSchedulePatch,
    realtimeApplyRemotePatch,
    initRealtime
};
