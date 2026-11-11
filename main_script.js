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
    // The host this script automates, derived from its own URLs (one source of truth).
    // Used to refuse running on any other site the button may be pressed on.
    var HOME_HOST = (function () {
        try { return new URL(SURF_URL).host.toLowerCase(); } catch (e) { return ''; }
    })();
    var STATE_KEY = '__bot_state_aviso';
    var OVERLAY_ID = '__bot_overlay';
    var NOTICE_ID = '__bot_notice';

    function loadState() {
        var def = { step: 'IDLE', taskId: null, kind: '', sek: 0, phase: '', done: {}, emptySurf: 0, emptyYt: 0 };
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
                phase: s.phase || '',   // '' = a fresh round, 'surf' | 'yt'
                done: (s.done && typeof s.done === 'object') ? s.done : {},
                emptySurf: s.emptySurf || 0,
                emptyYt: s.emptyYt || 0
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
        stuck: false,        // the task tab reported it never reached a real task page
        attempts: {},        // taskId -> failed starts in THIS run (never persisted)

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
            return this.showPersistentNotice(message, color);
        },

        /** A notice that stays on screen (click it to dismiss). */
        showPersistentNotice: function (message, color) {
            var old = document.getElementById(NOTICE_ID);
            if (old) old.remove();
            var el = document.createElement('div');
            el.id = NOTICE_ID;
            el.textContent = message;
            el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;' +
                'background:' + (color || '#2ed573') + ';color:#fff;padding:14px 20px;' +
                'border-radius:10px;font:bold 15px/1.5 sans-serif;max-width:75vw;' +
                'box-shadow:0 6px 20px rgba(0,0,0,.45);cursor:pointer;';
            el.title = 'اضغط للإخفاء';
            el.addEventListener('click', function () { el.remove(); });
            if (document.body) document.body.appendChild(el);
            return el;
        },

        /**
         * The run finished: stop the loop and tell the app so its button returns
         * to ▶ (the script stops itself here, so the app cannot know otherwise).
         */
        finishAll: function () {
            this.running = false;
            this.hideCountdown();
            state.step = 'IDLE';
            state.taskId = null;
            state.kind = '';
            state.sek = 0;
            state.phase = '';        // next ▶ starts a full round from surfing again
            state.emptySurf = 0;
            state.emptyYt = 0;
            this.save();
            this.showPersistentNotice('🏁 انتهت جميع المهام — تم الإيقاف', '#2ed573');
            console.log('[Bot] all sections are empty — stopped');
            var b = this.bridge();
            if (b && typeof b.setAutomationStopped === 'function') {
                try { b.setAutomationStopped(); } catch (e) {}
            }
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

        /**
         * Live remaining seconds of this task, from its own in-row countdown
         * element (`#timer_serf_<id>` / `#timer_ads_<id>`).
         *
         * This is the authoritative source: the page title may join several
         * tasks ("10 сек • 19 сек • Подтвердить просмотр"), so it cannot tell
         * which timer belongs to the current task.
         *
         * @returns {number|null} null when the element does not exist at all.
         */
        rowSeconds: function (taskId, kind) {
            var id = (kind === 'youtube')
                ? taskId.replace('ads-link-', 'ads_')
                : taskId.replace('serf-link-', 'serf_');
            var el = document.getElementById('timer_' + id);
            if (!el) return null;
            var m = String(el.textContent || '').match(/\d+/);
            if (!m) return null;
            var n = parseInt(m[0], 10);
            return (n >= 0 && n <= 300) ? n : null;
        },

        /**
         * Remaining seconds reported by the Aviso tab title, or null.
         * The title may join several timers, so only the first numeric segment
         * is used; the confirm label alone is a fallback for the single-task
         * case (it may also belong to another task).
         */
        titleSeconds: function (title) {
            if (!title) return null;
            var m = String(title).match(/(\d+)\s*(?:сек|sec)/i);
            if (m) {
                var n = parseInt(m[1], 10);
                return (n >= 0 && n <= 300) ? n : null;
            }
            if (String(title).indexOf('Подтвердить просмотр') !== -1) return 0;
            return null;
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
         * Rows this run may still process.
         *
         * `state.done` only holds tasks that were really confirmed. A failed start
         * is tracked in `attempts` (memory only, max 3 tries) and is NEVER hidden
         * or marked done — hiding rows is what made real tasks vanish from the page.
         */
        visibleRows: function () {
            var rows = document.querySelectorAll('.work-serf');
            var out = [];
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                if (!row.id || state.done[row.id]) continue;
                if ((this.attempts[row.id] || 0) >= 3) continue;
                if (row.offsetParent === null) continue;
                out.push(row);
            }
            return out;
        },

        /**
         * Click a start control and verify that a task tab really opened
         * (aviso_bot.py: `len(driver.window_handles) > 1`).
         */
        startTask: async function (taskId, kind, clickable, sek) {
            this.stuck = false;
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
            // real tab exists, so wait longer there. Aviso's start link does an
            // AJAX round-trip first, so 7s was too short (a slow start looked
            // like "no tab" and the row got hidden).
            var tries = (kind === 'youtube') ? 40 : 24;   // 20s / 12s
            for (var i = 0; i < tries; i++) {
                await this.sleep(500);
                if (b.getTaskTabCount() > before) return true;
            }
            return false;
        },

        /**
         * A start attempt failed: remember it for this run only.
         *
         * The row is deliberately NOT hidden and NOT marked as done: aviso may
         * accept the task on a later try, and hiding it made real tasks disappear
         * from the list. After 3 failures in one run `visibleRows` ignores it, but
         * the next run (button ▶ again) starts from zero.
         */
        skipTask: function (taskId, reason) {
            this.attempts[taskId] = (this.attempts[taskId] || 0) + 1;
            var row = document.getElementById(taskId);
            if (row) row.style.opacity = '0.45';
            this.notify('⚠️ تخطي مؤقت (' + this.attempts[taskId] + '/3) — ' + reason, '#ffa502');
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
         * "Подтвердить просмотр") and finally the elapsed time — but the elapsed
         * time is only trusted AFTER the countdown has really started.
         *
         * Why: YouTube shows intermediate pages (notice -> channel) and aviso may
         * show a captcha page; the countdown appears in the tab title only after
         * they are passed. Confirming on elapsed time there closes a task that
         * never counted.
         *
         * The task's own row timer (`#timer_serf_<id>`) is the best proof, but
         * it only counts for surf tasks: for YouTube `#timer_ads_<id>` stays
         * "0" the whole time (verified live), so the title is the fallback.
         *
         * The title may join several tasks ("10 сек • 19 сек • Подтвердить
         * просмотр"), so a number alone proves nothing — it must be *decreasing*
         * across two samples, and it must fit this task's duration (sek + 60).
         * A static number or a bare "Подтвердить просмотр" is never accepted.
         *
         * @returns {'counted'|'no-timer'} whether a real countdown was observed.
         */
        watchCountdown: async function (taskId, kind, sek) {
            var started = Date.now();
            var countStart = 0;   // when the countdown was first seen
            var sawRow = false;   // this task's own row timer counted down
            var sawTitle = false; // the title really counted down (fallback)
            var prevTitleSec = null; // last positive title value (decrease check)
            var left = sek;
            var lastTitle = document.title;
            var titleChangedAt = Date.now();
            var hardCap = (sek + 300) * 1000;
            while (this.running) {
                var b = this.bridge();
                var tabCount = (b && typeof b.getTaskTabCount === 'function')
                    ? b.getTaskTabCount() : -1;

                if (this.captchaElement()) {
                    await this.handleCaptchaIfAny();
                    continue;
                }
                // A task tab that asked for a captcha and then vanished must not
                // freeze the engine forever.
                if (this.paused && tabCount === 0) this.paused = false;
                if (this.paused) { await this.sleep(500); continue; }
                // The task tab says it never reached a real task page
                // (e.g. YouTube video never opened) — stop waiting.
                if (this.stuck && !sawRow && !sawTitle) break;

                if (document.title !== lastTitle) {
                    lastTitle = document.title;
                    titleChangedAt = Date.now();
                }
                var rowLeft = this.rowSeconds(taskId, kind); // null | 0..300
                if (rowLeft !== null && rowLeft > 0) sawRow = true;

                // Title fallback (YouTube rows never count in the row timer).
                var t = (Date.now() - started > 2500) ? this.titleSeconds(document.title) : null;
                if (!sawRow && t !== null && t > 0 && t <= sek + 60) {
                    if (prevTitleSec !== null && t < prevTitleSec) sawTitle = true;
                    prevTitleSec = t;
                } else if (t === 0) {
                    prevTitleSec = 0;   // the countdown of some task just ended
                }

                if (!sawRow && !sawTitle) {
                    // Intermediate / captcha pages: the countdown has not begun, so
                    // the elapsed time proves nothing — just keep waiting.
                    this.showCountdown('⏳ بانتظار بدء العدّاد…');
                    // Nothing is running at all: a stale CONFIRMING state (the page
                    // was reloaded mid-task) or a popup that never opened. Waiting
                    // the full hard cap would stall the bot for minutes.
                    if (tabCount === 0 && Date.now() - started > 20000) break;
                } else {
                    if (!countStart) countStart = Date.now();
                    // Aviso's row timer stops at "1" (it never reaches 0) and the
                    // title switches to "Подтвердить просмотр" instead — that title
                    // is the real end signal once a countdown was seen.
                    if (t === 0) left = 0;
                    else if (sawRow && rowLeft !== null) left = rowLeft;
                    else if (t !== null) left = t;
                    else left = Math.max(0,
                        Math.ceil((sek * 1000 - (Date.now() - countStart)) / 1000));
                    this.showCountdown('⏳ ' + left + ' ثانية');
                    if (left <= 0) break;
                    // Task tab gone and the title stopped moving: the task is over
                    // (a YouTube intermediate tab may hand the video to a child tab,
                    // so this must not fire while the title is still counting).
                    if (tabCount === 0 && Date.now() - titleChangedAt > 15000) break;
                }
                // Absolute safety net (frozen title + frozen timer, or a countdown
                // that never starts at all).
                if (Date.now() - started > hardCap) break;
                await this.sleep(500);
            }
            this.hideCountdown();
            if (!sawRow && !sawTitle) return 'no-timer';
            // Give aviso a moment to register the view before confirming.
            await this.sleep(1500 + Math.floor(Math.random() * 2000));
            return 'counted';
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
                // Wait for aviso to clear its "Подтвердить просмотр" title, so the
                // next task does not start with a stale countdown.
                for (var i = 0; i < 16; i++) {
                    if (document.title.indexOf('Подтвердить просмотр') === -1) break;
                    await this.sleep(500);
                }
                await this.sleep(800);
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

        /** Only the rows this section can actually start (other kinds share the page). */
        rowsOfKind: function (prefix) {
            var rows = this.visibleRows();
            var out = [];
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].id.indexOf(prefix) === 0) out.push(rows[i]);
            }
            return out;
        },

        /**
         * Surf section: start one task.
         * @returns {'started'|'next'|'section-done'}
         */
        Surfing: async function () {
            var rows = this.rowsOfKind('serf-link-');
            if (!rows.length) return 'section-done';

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

        /**
         * YouTube section: start one task.
         * @returns {'started'|'next'|'section-done'}
         */
        av_ytub: async function () {
            var rows = this.rowsOfKind('ads-link-');
            if (!rows.length) return 'section-done';

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

            // 'rmove true': the task cannot be started right now -> retry later.
            this.skipTask(taskId, 'لم يُفتح تبويب');
            return 'next';
        },

        // ----------------------------------------------------------------- loop

        /** True when this page belongs to the site this script automates (any subdomain). */
        onOwnSite: function () {
            var h = (location.host || '').toLowerCase();
            return !!HOME_HOST && (h === HOME_HOST || h.endsWith('.' + HOME_HOST));
        },

        /** Logged out: the login URL, or the login form rendered on any page. */
        isLoggedOut: function () {
            if (location.pathname.indexOf('/login') !== -1) return true;
            if (document.getElementById('login-form')) return true;
            if (document.getElementById('button-login')) return true;
            return false;
        },

        /**
         * The session ended mid-run: stop, drop the task tab, clear the state and
         * tell the app so the button returns to ▶. Without the last step the app
         * keeps the tab in `runningTabs` and the button stays stuck on ■ forever.
         */
        abortSessionEnded: function () {
            this.running = false;
            this.hideCountdown();
            state.step = 'IDLE';
            state.taskId = null;
            state.kind = '';
            state.sek = 0;
            state.phase = '';
            this.save();
            var b = this.bridge();
            if (b && typeof b.closeTaskTab === 'function') {
                try { b.closeTaskTab(); } catch (e) {}
            }
            this.showPersistentNotice('🔒 انتهت الجلسة — سجّل الدخول ثم اضغط ▶', '#ff4757');
            console.log('[Bot] session ended — stopped');
            if (b && typeof b.setAutomationStopped === 'function') {
                try { b.setAutomationStopped(); } catch (e) {}
            }
        },

        /**
         * The app injects this script into whatever tab ▶ was pressed on, so the
         * script itself must refuse to run anywhere but its own site. The button
         * is not tied to the page URL: the script is the single source of truth.
         */
        requireOwnSite: function () {
            if (this.onOwnSite()) return true;
            this.running = false;
            this.hideCountdown();
            this.showPersistentNotice('⚠️ يجب الانتقال إلى موقع ' + HOME_HOST +
                ' — افتحه من القائمة ثم اضغط ▶', '#ff4757');
            console.log('[Bot] wrong site: ' + location.host + ' (expected ' + HOME_HOST + ')');
            var b = this.bridge();
            if (b && typeof b.setAutomationStopped === 'function') {
                try { b.setAutomationStopped(); } catch (e) {}
            }
            return false;
        },

        /** Gate at the start of every run and every loop turn. */
        checkAuthAndRun: function () {
            if (!this.requireOwnSite()) return false;
            if (this.isLoggedOut()) { this.abortSessionEnded(); return false; }
            return true;
        },

        runAuto: async function () {
            if (this.busy) return;
            this.busy = true;
            try {
                if (!this.checkAuthAndRun()) return;
                for (var guard = 0; guard < 2000; guard++) {
                    if (!this.running) return;
                    if (this.isLoggedOut()) { this.abortSessionEnded(); return; }

                    var url = location.href;
                    if (!this.onOwnSite()) { this.requireOwnSite(); return; }

                    // A round always starts at surfing, whatever page ▶ was pressed on
                    // (after a finished run the tab is left on tasks-youtube, and the
                    // YouTube section is empty then — without this the bot stopped
                    // immediately instead of opening the surf section).
                    if (!state.phase) {
                        state.phase = 'surf';
                        this.save();
                        if (url.indexOf('tasks-surf') === -1) {
                            this.notify('↪️ بدء الجولة من مهام التصفح', '#1976D2');
                            location.href = SURF_URL;
                            return;
                        }
                    }

                    if (state.step === 'CONFIRMING' && state.taskId) {
                        var taskId = state.taskId;
                        var kind = state.kind;
                        var sek = state.sek || this.readSek(taskId, kind);
                        var outcome = await this.watchCountdown(taskId, kind, sek);
                        if (!this.running) return;
                        if (outcome === 'no-timer') {
                            // The countdown never started (captcha / intermediate
                            // page / dead tab): confirming now would credit nothing.
                            var tb = this.bridge();
                            if (tb && typeof tb.closeTaskTab === 'function') {
                                try { tb.closeTaskTab(); } catch (e) {}
                            }
                            this.skipTask(taskId, 'لم يبدأ العدّاد');
                            state.step = 'IDLE';
                            state.taskId = null;
                            state.kind = '';
                            this.save();
                            continue;
                        }
                        await this.confirmAndFinish(taskId);
                        // The server may have logged the session out while the task
                        // was being confirmed: stop here instead of looping on /login.
                        if (this.isLoggedOut()) { this.abortSessionEnded(); return; }
                        continue;
                    }

                    if (await this.handleCaptchaIfAny()) {
                        await this.sleep(1500);
                        continue;
                    }

                    // One pass: surf first, then YouTube, then stop.
                    if (url.indexOf('tasks-surf') !== -1) {
                        var r = await this.Surfing();
                        if (r === 'section-done') {
                            state.phase = 'yt';
                            this.save();
                            this.notify('↪️ انتهت مهام التصفح — الانتقال إلى يوتيوب', '#1976D2');
                            location.href = YT_URL;
                            return;
                        }
                        if (r === 'next') await this.sleep(1500);
                        continue;
                    }
                    if (url.indexOf('tasks-youtube') !== -1) {
                        var y = await this.av_ytub();
                        if (y === 'section-done') {
                            // Nothing left in either section: stop, the button
                            // returns to ▶ (finishAll tells the app).
                            this.finishAll();
                            return;
                        }
                        if (y === 'next') await this.sleep(1500);
                        continue;
                    }
                    this.notify('↪️ الانتقال إلى مهام التصفح', '#1976D2');
                    location.href = SURF_URL;
                    return;
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
        } else if (d.type === 'bot:stuck') {
            // The task tab never reached the real task page (YouTube video never
            // opened): the parent must not confirm a view that never counted.
            engine.stuck = true;
            engine.notify('⚠️ لم تُفتح صفحة المهمة — تخطي', '#ff4757');
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
