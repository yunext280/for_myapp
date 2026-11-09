/**
 * Aviso main automation script.
 *
 * Runs in the site tab (the "parent" tab). The app injects it and calls
 * `window.BotEngine.runAuto()` (the Kotlin side knows only that generic name).
 *
 * Design rules:
 *  - Seconds are never hardcoded: they are read from the task row (see readSek).
 *  - The countdown is driven by the Aviso tab title, with a timer fallback.
 *  - Every task opens a real popup tab; the app adopts it and injects
 *    task_script.js there with `window.__BOT_TASK__` = {kind, sek, taskId}.
 *  - If no tab opens, the task is skipped and hidden (same as aviso_bot.py's
 *    'rmove true' path).
 *  - Captcha: solved through ru2.sctg.xyz with the key stored in the app
 *    (AndroidBridge.getCaptchaKey()); manual fallback when it fails.
 */
(function () {
    'use strict';

    var SURF_URL = 'https://aviso.bz/tasks-surf';
    var YT_URL = 'https://aviso.bz/tasks-youtube';
    var STATE_KEY = '__bot_state_aviso';
    var OVERLAY_ID = '__bot_overlay';
    var NOTICE_ID = '__bot_notice';

    function loadState() {
        var def = { step: 'IDLE', taskId: null, kind: '', sek: 0, done: {} };
        try {
            var raw = sessionStorage.getItem(STATE_KEY);
            if (!raw) return def;
            var s = JSON.parse(raw);
            if (!s || typeof s !== 'object') return def;
            return {
                step: s.step || 'IDLE',
                taskId: s.taskId || null,
                kind: s.kind || '',
                sek: s.sek || 0,
                done: (s.done && typeof s.done === 'object') ? s.done : {}
            };
        } catch (e) {
            return def;
        }
    }

    var state = loadState();

    var engine = {

        running: true,
        busy: false,
        paused: false,
        emptyCount: 0,

        // ------------------------------------------------------------------ utils

        sleep: function (ms) {
            return new Promise(function (r) { setTimeout(r, ms); });
        },

        bridge: function () {
            try { return window.AndroidBridge || null; } catch (e) { return null; }
        },

        save: function () {
            try { sessionStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {}
        },

        stop: function () {
            this.running = false;
            this.hideCountdown();
        },

        /** Real-looking click: pointer + mouse events, then the native click(). */
        simulateClick: function (control) {
            if (!control) return false;
            try {
                control.scrollIntoView({ behavior: 'auto', block: 'center' });
                var r = control.getBoundingClientRect();
                var x = Math.round(r.left + r.width / 2);
                var y = Math.round(r.top + r.height / 2);
                var opts = {
                    bubbles: true, cancelable: true, view: window, detail: 1,
                    clientX: x, clientY: y, screenX: x, screenY: y,
                    button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false
                };
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (type) {
                    var Ctor = (type.indexOf('pointer') === 0 && window.PointerEvent) ? PointerEvent : MouseEvent;
                    control.dispatchEvent(new Ctor(type, opts));
                });
                control.click();
                return true;
            } catch (e) {
                console.error('[Bot] click failed:', e);
                return false;
            }
        },

        notify: function (message, color) {
            var old = document.getElementById(NOTICE_ID);
            if (old) old.remove();
            var el = document.createElement('div');
            el.id = NOTICE_ID;
            el.textContent = message;
            el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;' +
                'background:' + (color || '#1976D2') + ';color:#fff;padding:12px 18px;' +
                'border-radius:8px;font:bold 14px/1.4 sans-serif;max-width:70vw;' +
                'box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none;';
            document.body.appendChild(el);
            setTimeout(function () { if (el.parentNode) el.remove(); }, 4000);
        },

        // Kept for backward compatibility with older callers.
        showPersistentNotification: function (message, color) {
            this.notify(message, color);
        },

        showCountdown: function (text) {
            var el = document.getElementById(OVERLAY_ID);
            if (!el) {
                el = document.createElement('div');
                el.id = OVERLAY_ID;
                document.body.appendChild(el);
            }
            el.textContent = text;
            el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;' +
                'background:rgba(0,0,0,.86);color:#fff;padding:10px 16px;border-radius:10px;' +
                'font:bold 18px/1.4 sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.45);' +
                'pointer-events:none;';
        },

        hideCountdown: function () {
            var el = document.getElementById(OVERLAY_ID);
            if (el) el.remove();
        },

        /** The hCaptcha widget, only when it is actually visible (not a hidden template). */
        captchaElement: function () {
            var list = document.querySelectorAll('.h-captcha, #h-captcha');
            for (var i = 0; i < list.length; i++) {
                var r = list[i].getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return list[i];
            }
            return null;
        },

        // ------------------------------------------------------------- seconds

        /** Task duration in seconds, read from the task row (never hardcoded). */
        readSek: function (taskId, kind) {
            var fallback = (kind === 'youtube') ? 20 : 15;
            var el = null;

            if (kind === 'youtube') {
                var yid = taskId.replace('ads-link-', 'ads_id_');
                // aviso_bot.py reads `#ads_id_<id> span b[2]`.
                el = document.querySelector('#' + yid + ' > span > b:nth-of-type(2)') ||
                    document.querySelector('#' + yid + ' span b:nth-of-type(2)') ||
                    document.querySelector('#' + yid + ' b:nth-of-type(2)');
                var fromRow = this.clampSek(el ? el.textContent : '', 0);
                if (fromRow) return fromRow;
                // Fallback: the hidden timer input, but never trust a tiny value
                // (templates ship value="5").
                var input = document.getElementById(taskId.replace('ads-link-', 'ads_timer_'));
                var fromInput = input ? this.clampSek(input.value, 0) : 0;
                if (fromInput >= 10) return fromInput;
            } else {
                // The start anchor carries data-timer="20" — the most reliable source.
                var anchor = document.querySelector(
                    '#start-serf-' + taskId.replace('serf-link-', '') + ' a.start-surfing-btn'
                );
                if (anchor) {
                    var fromAttr = this.clampSek(anchor.getAttribute('data-timer'), 0);
                    if (fromAttr) return fromAttr;
                }
                var sid = taskId.replace('serf-link-', 'serf-id-');
                el = document.querySelector('#' + sid + ' > div > b:nth-of-type(2)') ||
                    document.querySelector('#' + sid + ' div b:nth-of-type(2)') ||
                    document.querySelector('#' + sid + ' b:nth-of-type(2)');
            }
            return this.clampSek(el ? el.textContent : '', fallback);
        },

        /** Parse a seconds value; [fallback] 0 means "not found". */
        clampSek: function (text, fallback) {
            var m = String(text || '').match(/\d+/);
            var n = m ? parseInt(m[0], 10) : 0;
            if (n >= 3 && n <= 300) return n;
            return fallback || 0;
        },

        /** Live remaining seconds of this task, from its in-row countdown element. */
        rowSeconds: function (taskId, kind) {
            var id = (kind === 'youtube')
                ? taskId.replace('ads-link-', 'ads_')
                : taskId.replace('serf-link-', 'serf_');
            var el = document.getElementById('timer_' + id);
            return el ? this.clampSek(el.textContent, 0) : 0;
        },

        /** Remaining seconds reported by the Aviso tab title, or null. */
        titleSeconds: function (title, sek) {
            if (!title) return null;
            if (title.indexOf('Подтвердить просмотр') !== -1) return 0;
            var m = title.match(/(\d+)/);
            if (!m) return null;
            var n = parseInt(m[1], 10);
            return (n >= 0 && n <= sek + 5) ? n : null;
        },

        // ------------------------------------------------------------ captcha

        getCaptchaKey: function () {
            var b = this.bridge();
            if (!b || typeof b.getCaptchaKey !== 'function') return '';
            try { return b.getCaptchaKey() || ''; } catch (e) { return ''; }
        },

        solveCaptcha: async function (sitekey, pageUrl) {
            var key = this.getCaptchaKey();
            if (!key || !sitekey) return null;
            var base = 'https://ru2.sctg.xyz';
            for (var attempt = 0; attempt < 3; attempt++) {
                try {
                    var r = await fetch(base + '/in.php?key=' + encodeURIComponent(key) +
                        '&method=hcaptcha&pageurl=' + encodeURIComponent(pageUrl) +
                        '&sitekey=' + encodeURIComponent(sitekey));
                    var txt = (await r.text()).trim();
                    if (txt.indexOf('|') === -1) continue;
                    var taskId = txt.split('|')[1];
                    var started = Date.now();
                    while (Date.now() - started < 300000) {
                        await this.sleep(5000);
                        var p = await fetch(base + '/res.php?key=' + encodeURIComponent(key) +
                            '&id=' + encodeURIComponent(taskId) + '&action=get');
                        var res = (await p.text()).trim();
                        if (res.indexOf('OK|') === 0) return res.split('|')[1];
                        if (res.indexOf('NOT_READY') === -1 && res.indexOf('PROCESSING') === -1) break;
                    }
                } catch (e) {
                    console.warn('[Bot] captcha request failed:', e);
                }
            }
            return null;
        },

        injectCaptchaToken: function (token) {
            var ta = document.querySelector('textarea[name="h-captcha-response"]');
            if (ta) {
                ta.style.display = 'block';
                ta.value = token;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.dispatchEvent(new Event('change', { bubbles: true }));
            }
            var g = document.querySelector('textarea[name="g-recaptcha-response"]');
            if (g) {
                g.value = token;
                g.dispatchEvent(new Event('input', { bubbles: true }));
                g.dispatchEvent(new Event('change', { bubbles: true }));
            }
            var el = document.querySelector('.h-captcha, #h-captcha');
            var cb = el ? el.getAttribute('data-callback') : null;
            if (cb && typeof window[cb] === 'function') {
                window[cb](token);
                return;
            }
            var captchaId = null;
            var scripts = document.getElementsByTagName('script');
            for (var i = 0; i < scripts.length; i++) {
                var m = scripts[i].textContent.match(/let\s+captchaId\s*=\s*['"]([a-fA-F0-9]{32})['"]/);
                if (m) { captchaId = m[1]; break; }
            }
            if (captchaId) {
                fetch('/ajax/captcha.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({ token: token, captcha_id: captchaId })
                }).catch(function () {}).then(function () { window.location.reload(); });
            } else if (ta) {
                var form = ta.closest('form');
                if (form) {
                    var submit = form.querySelector('button[type="submit"], input[type="submit"]');
                    if (submit) submit.click(); else form.submit();
                }
            }
        },

        /** Returns true when a captcha was present (the page may then reload). */
        handleCaptchaIfAny: async function () {
            var el = this.captchaElement();
            if (!el) return false;
            this.paused = true;
            this.showCountdown('🧩 جاري حل الكابتشا…');
            var token = await this.solveCaptcha(el.getAttribute('data-sitekey'), location.href);
            if (!token) {
                this.notify('🧩 تعذّر الحل التلقائي — حلّها يدويًا ثم سيكمل تلقائيًا', '#ff4757');
                for (var i = 0; i < 600; i++) {
                    await this.sleep(500);
                    if (!this.captchaElement()) break;
                }
                this.paused = false;
                this.hideCountdown();
                return true;
            }
            this.notify('✅ تم حل الكابتشا', '#2ed573');
            this.injectCaptchaToken(token);
            await this.sleep(2500);
            this.paused = false;
            this.hideCountdown();
            return true;
        },

        // ----------------------------------------------------------- task flow

        confirmIdFor: function (taskId) {
            if (taskId.indexOf('serf-link-') === 0) return taskId.replace('serf-link-', 'serf_btn_confirm_');
            if (taskId.indexOf('ads-link-') === 0) return taskId.replace('ads-link-', 'ads_btn_confirm_');
            return taskId;
        },

        /**
         * Aviso ships template rows (id present, hidden inputs still hold
         * `{REPORT_ID}` / `{HASH_CONFIRM}`). They can never be started: clicking
         * them does nothing, which looked like "the tab never opened".
         */
        isTemplateRow: function (row) {
            var inputs = row.querySelectorAll('input[id^="ads_report_id_"], input[id^="serf_report_id_"], ' +
                'input[id^="ads_hash_"], input[id^="serf_hash_"]');
            for (var i = 0; i < inputs.length; i++) {
                if (String(inputs[i].value || '').indexOf('{') !== -1) return true;
            }
            return false;
        },

        visibleRows: function () {
            var rows = document.querySelectorAll('.work-serf');
            var out = [];
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                if (!row.id || state.done[row.id]) continue;
                if (row.offsetParent === null) continue;
                if (this.isTemplateRow(row)) continue;
                out.push(row);
            }
            return out;
        },

        /**
         * Click a start control and verify that a task tab really opened
         * (aviso_bot.py: `len(driver.window_handles) > 1`).
         */
        startTask: async function (taskId, kind, clickable, sek) {
            var b = this.bridge();
            if (b && typeof b.setTaskContext === 'function') {
                try {
                    b.setTaskContext(kind, JSON.stringify({ kind: kind, sek: sek, taskId: taskId }));
                } catch (e) {}
            }
            var before = (b && typeof b.getTaskTabCount === 'function') ? b.getTaskTabCount() : -1;
            if (!this.simulateClick(clickable)) return false;
            if (before < 0) return true; // no bridge (desktop testing): assume it worked

            // YouTube needs two hops (notice page -> channel page) before the
            // real tab exists, so wait longer there.
            var tries = (kind === 'youtube') ? 24 : 14;
            for (var i = 0; i < tries; i++) {
                await this.sleep(500);
                if (b.getTaskTabCount() > before) return true;
            }
            return false;
        },

        /** Mark a task as unstartable: hide the row and never retry it. */
        skipTask: function (taskId, reason) {
            state.done[taskId] = true;
            this.save();
            var row = document.getElementById(taskId);
            if (row) {
                row.style.opacity = '0.35';
                row.style.display = 'none';
            }
            this.notify('⚠️ تم تخطي المهمة — ' + reason, '#ff4757');
            var b = this.bridge();
            if (b && typeof b.clearTaskContext === 'function') {
                try { b.clearTaskContext(); } catch (e) {}
            }
        },

        /**
         * Countdown while the task tab runs.
         *
         * The confirm button CANNOT be used as a "done" signal: aviso keeps it in
         * the DOM (visible for surf, display:none for YouTube) even before the task
         * starts. The real signals are the in-row timer (`#timer_serf_<id>` /
         * `#timer_ads_<id>`), the tab title ("20 сек" -> "0 сек" ->
         * "Подтвердить просмотр") and finally the elapsed time.
         */
        watchCountdown: async function (taskId, kind, sek) {
            var started = Date.now();
            var sawTimer = false;
            var left = sek;
            while (this.running) {
                if (this.paused) { await this.sleep(500); continue; }
                if (this.captchaElement()) {
                    await this.handleCaptchaIfAny();
                    continue;
                }
                var rowLeft = this.rowSeconds(taskId, kind);
                if (rowLeft > 0) sawTimer = true;
                var t = this.titleSeconds(document.title, sek);
                var elapsedLeft = Math.max(0, Math.ceil((sek * 1000 - (Date.now() - started)) / 1000));
                if (t === 0) { left = 0; sawTimer = true; }
                else if (t !== null) { left = t; sawTimer = true; }
                else if (rowLeft > 0) { left = rowLeft; }
                else { left = elapsedLeft; }
                this.showCountdown('⏳ ' + left + ' ثانية');
                if (sawTimer && left <= 0) break;
                // The task tab closed itself: the task is over even if the title
                // never reported a countdown.
                var b = this.bridge();
                if (b && typeof b.getTaskTabCount === 'function' &&
                    b.getTaskTabCount() === 0 && Date.now() - started > 3000) break;
                // No countdown ever appeared: don't hang forever.
                if (!sawTimer && Date.now() - started > (sek + 25) * 1000) break;
                await this.sleep(500);
            }
            this.hideCountdown();
            // Give aviso a moment to register the view before confirming.
            await this.sleep(1500 + Math.floor(Math.random() * 2000));
        },

        confirmAndFinish: async function (taskId) {
            var b = this.bridge();
            // Make sure no leftover task tab (two-page YouTube flow) stays open.
            if (b && typeof b.closeTaskTab === 'function') {
                try { b.closeTaskTab(); } catch (e) {}
            }
            var confirmId = this.confirmIdFor(taskId);
            var btn = document.getElementById(confirmId);
            if (btn) {
                this.simulateClick(btn);
                this.notify('✅ تم تأكيد المهمة', '#2ed573');
                await this.sleep(1500);
            } else {
                this.notify('⚠️ زر التأكيد غير متوفر — متابعة', '#ffa502');
            }
            state.done[taskId] = true;
            state.step = 'IDLE';
            state.taskId = null;
            state.kind = '';
            this.save();
        },

        // ------------------------------------------------------------- sections

        Surfing: async function () {
            var rows = this.visibleRows();
            if (!rows.length) {
                this.emptyCount++;
                if (this.emptyCount >= 2) {
                    this.emptyCount = 0;
                    this.notify('↪️ لا مهام تصفح — الانتقال لمهام يوتيوب', '#1976D2');
                    location.href = YT_URL;
                    return 'navigate';
                }
                return 'wait';
            }
            this.emptyCount = 0;

            var taskId = rows[0].id;
            var startBtn = document.getElementById(taskId.replace('serf-link-', 'start-serf-'));
            var clickable = startBtn ? startBtn.querySelector('a.start-surfing-btn') : null;
            if (!clickable) {
                this.skipTask(taskId, 'زر البدء غير متاح');
                return 'next';
            }

            var sek = this.readSek(taskId, 'surf');
            this.notify('▶️ مهمة تصفح ' + taskId + ' — ' + sek + 'ث', '#1976D2');
            var opened = await this.startTask(taskId, 'surf', clickable, sek);
            if (!opened) {
                this.skipTask(taskId, 'لم يُفتح تبويب');
                return 'next';
            }

            state.step = 'CONFIRMING';
            state.taskId = taskId;
            state.kind = 'surf';
            state.sek = sek;
            this.save();
            return 'started';
        },

        av_ytub: async function () {
            var rows = this.visibleRows();
            if (!rows.length) {
                this.emptyCount++;
                if (this.emptyCount >= 2) {
                    this.emptyCount = 0;
                    this.notify('↪️ لا مهام يوتيوب — العودة لمهام التصفح', '#1976D2');
                    location.href = SURF_URL;
                    return 'navigate';
                }
                return 'wait';
            }
            this.emptyCount = 0;

            var taskId = rows[0].id;
            var sek = this.readSek(taskId, 'youtube');
            var startBtn = document.getElementById(taskId.replace('ads-link-', 'link_ads_start_'));
            var clickable = startBtn || null;

            if (clickable) {
                this.notify('▶️ مهمة يوتيوب ' + taskId + ' — ' + sek + 'ث', '#1976D2');
                var opened = await this.startTask(taskId, 'youtube', clickable, sek);
                if (opened) {
                    state.step = 'CONFIRMING';
                    state.taskId = taskId;
                    state.kind = 'youtube';
                    state.sek = sek;
                    this.save();
                    return 'started';
                }
            }

            // Fallback start link (aviso_bot.py line 381).
            var alt = document.querySelector('#' + taskId + ' > tbody > tr > td:nth-child(3) > div > a');
            if (alt) {
                this.notify('🔁 محاولة رابط بديل للمهمة ' + taskId, '#ffa502');
                var openedAlt = await this.startTask(taskId, 'youtube', alt, sek);
                await this.sleep(1500);
                if (openedAlt) {
                    state.step = 'CONFIRMING';
                    state.taskId = taskId;
                    state.kind = 'youtube';
                    state.sek = sek;
                    this.save();
                    return 'started';
                }
            }

            // 'rmove true': the task cannot be started -> drop it.
            this.skipTask(taskId, 'لم يُفتح تبويب');
            return 'next';
        },

        // ----------------------------------------------------------------- loop

        checkAuthAndRun: function () {
            if (location.href.indexOf('/login') !== -1) {
                var self = this;
                setTimeout(function () {
                    self.notify('⚠️ يجب تسجيل الدخول أولاً', '#ff4757');
                }, 500);
                return false;
            }
            return true;
        },

        runAuto: async function () {
            if (this.busy) return;
            this.busy = true;
            try {
                if (!this.checkAuthAndRun()) return;
                for (var guard = 0; guard < 2000; guard++) {
                    if (!this.running) return;

                    var url = location.href;
                    if (url.indexOf('/login') !== -1) { this.checkAuthAndRun(); return; }

                    if (state.step === 'CONFIRMING' && state.taskId) {
                        var taskId = state.taskId;
                        var kind = state.kind;
                        var sek = state.sek || this.readSek(taskId, kind);
                        await this.watchCountdown(taskId, kind, sek);
                        await this.confirmAndFinish(taskId);
                        continue;
                    }

                    if (await this.handleCaptchaIfAny()) {
                        await this.sleep(1500);
                        continue;
                    }

                    var next;
                    if (url.indexOf('tasks-surf') !== -1) next = await this.Surfing();
                    else if (url.indexOf('tasks-youtube') !== -1) next = await this.av_ytub();
                    else {
                        this.notify('↪️ الانتقال إلى مهام التصفح', '#1976D2');
                        location.href = SURF_URL;
                        return;
                    }

                    if (next === 'navigate') return;
                    if (next === 'wait') await this.sleep(4000);
                }
            } catch (e) {
                console.error('[Bot] runAuto crashed:', e);
            } finally {
                this.busy = false;
            }
        }
    };

    // Generic contract for the app + legacy alias for the old Aviso script.
    window.BotEngine = engine;
    window.AvisoMainEngine = engine;

    // postMessage fallback: a task tab reports it is done / needs a captcha.
    window.addEventListener('message', function (ev) {
        var d = ev && ev.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'bot:done') {
            engine.runAuto();
        } else if (d.type === 'bot:captcha') {
            engine.paused = true;
        } else if (d.type === 'bot:resume') {
            engine.paused = false;
        }
    });

    // Hide rows already finished in this session.
    setTimeout(function () {
        Object.keys(state.done).forEach(function (id) {
            var row = document.getElementById(id);
            if (row) { row.style.opacity = '0.35'; row.style.display = 'none'; }
        });
    }, 800);

    window.addEventListener('load', function () {
        setTimeout(function () { engine.runAuto(); }, 1500);
    });

})();
