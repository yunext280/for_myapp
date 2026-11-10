/**
 * Generic task-tab script.
 *
 * The app injects it into every task (popup) tab and, right before it, sets
 *
 *     window.__BOT_TASK__ = { kind, sek, taskId }   // sent by main_script.js
 *
 * `kind` is opaque to the app: the site's main script picks it. New kinds are
 * added by extending the `handlers` map below — the Kotlin side never changes.
 */
(function () {
    'use strict';

    var OVERLAY_ID = '__bot_task_overlay';

    if (window.__botTaskStarted) return;
    window.__botTaskStarted = true;

    var ctx = (window.__BOT_TASK__ && typeof window.__BOT_TASK__ === 'object') ? window.__BOT_TASK__ : {};
    var kind = String(ctx.kind || 'default');
    var sek = (typeof ctx.sek === 'number' && ctx.sek >= 3 && ctx.sek <= 300) ? ctx.sek : 20;

    var engine = {

        sleep: function (ms) {
            return new Promise(function (r) { setTimeout(r, ms); });
        },

        bridge: function () {
            try { return window.AndroidBridge || null; } catch (e) { return null; }
        },

        post: function (type, extra) {
            try {
                if (window.opener && !window.opener.closed) {
                    var msg = { type: type, taskId: ctx.taskId || null, kind: kind };
                    if (extra) { for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k]; }
                    window.opener.postMessage(msg, '*');
                }
            } catch (e) {}
        },

        show: function (text) {
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

        hide: function () {
            var el = document.getElementById(OVERLAY_ID);
            if (el) el.remove();
        },

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
                return false;
            }
        },

        // ---------------------------------------------------------- captcha

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
                } catch (e) {}
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

        captchaElement: function () {
            var list = document.querySelectorAll('.h-captcha, #h-captcha');
            for (var i = 0; i < list.length; i++) {
                var r = list[i].getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return list[i];
            }
            return null;
        },

        handleCaptcha: async function () {
            var el = this.captchaElement();
            if (!el) return false;
            this.post('bot:captcha');
            this.show('🧩 جاري حل الكابتشا…');
            var token = await this.solveCaptcha(el.getAttribute('data-sitekey'), location.href);
            if (!token) {
                this.show('🧩 حلّها يدويًا…');
                for (var i = 0; i < 600; i++) { // wait up to 5 min for a manual solve
                    await this.sleep(500);
                    if (!this.captchaElement()) break;
                }
                this.post('bot:resume');
                return true;
            }
            this.injectCaptchaToken(token);
            await this.sleep(2500);
            this.post('bot:resume');
            return true;
        },

        // ------------------------------------------------------------ helpers

        /**
         * True only when this tab really shows a YouTube video page.
         * Aviso opens intermediate pages (notice / channel link) before the video,
         * and a captcha page may appear too — none of them count a view, so the
         * URL is verified instead of assumed.
         */
        isYouTubeVideo: function () {
            try {
                var host = String(location.hostname || '').toLowerCase();
                if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return false;
                var path = String(location.pathname || '');
                if (path.indexOf('/watch') !== -1) return true;
                if (path.indexOf('/shorts/') !== -1) return true;
                if (host.indexOf('youtu.be') !== -1 && path.length > 1) return true;
                return false;
            } catch (e) {
                return false;
            }
        },

        childCount: function () {
            var b = this.bridge();
            if (!b || typeof b.getTaskTabCount !== 'function') return 0;
            try { return b.getTaskTabCount() | 0; } catch (e) { return 0; }
        },

        waitFor: async function (selectors, timeoutMs) {
            var started = Date.now();
            while (Date.now() - started < timeoutMs) {
                for (var i = 0; i < selectors.length; i++) {
                    var el = document.querySelector(selectors[i]);
                    if (el) return el;
                }
                await this.sleep(500);
            }
            return null;
        },

        // ------------------------------------------------------------ handlers

        /** Plain "stay on the page for N seconds, then wait to be closed". */
        watch: async function () {
            var started = Date.now();
            var hardMs = (sek + 120) * 1000;
            while (Date.now() - started < hardMs) {
                if (this.captchaElement()) {
                    await this.handleCaptcha();
                    continue;
                }
                var left = Math.max(0, Math.ceil((sek * 1000 - (Date.now() - started)) / 1000));
                this.show(left > 0 ? ('⏳ ' + left + ' ثانية') : '⏳ بانتظار تأكيد المهمة…');
                this.post('bot:tick', { remaining: left });
                if (left <= 0) break;
                await this.sleep(500);
            }
            // Small grace period so the site registers the view.
            await this.sleep(2000);
            var extra = document.querySelector('.btn__notice, #check_timer, .ads-confirm-btn');
            if (extra) {
                this.simulateClick(extra);
                await this.sleep(1000);
            }
            // `sek` is only a lower bound: the site's main tab owns the real
            // countdown (it reads the page title) and closes this tab through the
            // bridge when the task is really finished. Closing ourselves early
            // made the parent confirm before the view was counted.
            this.post('bot:done');
            this.show('⏳ بانتظار إغلاق التبويب…');
            var t0 = Date.now();
            while (Date.now() - t0 < 120000) {
                await this.sleep(1000);
            }
            this.hide();
        },

        /**
         * YouTube: the popup may first land on an intermediate page with a
         * "continue" button (aviso_bot.py: .btn__notice /
         * #youtube_views-channel-link), which can open a second tab, and a
         * captcha page may appear as well.
         *
         * The countdown only belongs to a real video page, so this handler keeps
         * resolving the intermediate pages until the URL is YouTube — it never
         * pretends the view was counted.
         */
        youtube: async function () {
            var started = Date.now();
            while (Date.now() - started < 180000) {
                if (this.isYouTubeVideo()) {
                    await this.watch();
                    return;
                }
                if (this.captchaElement()) {
                    await this.handleCaptcha();
                    continue;
                }
                // A child tab may own the video now — wait for it to finish.
                if (this.childCount() > 0) {
                    this.show('⏳ بانتظار تبويب الفيديو…');
                    var t0 = Date.now();
                    while (this.childCount() > 0 && Date.now() - t0 < 180000) {
                        await this.sleep(1000);
                    }
                    this.hide();
                    return;
                }
                var el = document.querySelector('.btn__notice, #youtube_views-channel-link');
                if (el) {
                    this.show('↪️ فتح الفيديو…');
                    this.simulateClick(el);
                    await this.sleep(2000);
                    continue;
                }
                this.show('⏳ بانتظار صفحة الفيديو…');
                await this.sleep(500);
            }

            // Still not on YouTube: report it so the parent skips the task instead
            // of confirming a view that never happened.
            this.post('bot:stuck', { reason: 'not-youtube', url: String(location.href) });
            this.show('⚠️ لم تُفتح صفحة الفيديو');
            var t1 = Date.now();
            while (Date.now() - t1 < 60000) { await this.sleep(1000); }
            this.hide();
        },

        /** Like / subscribe: click the target control, wait, close. */
        click: async function (selectors) {
            var el = await this.waitFor(selectors, 20000);
            if (el) {
                this.show('👆 تنفيذ المهمة…');
                this.simulateClick(el);
                await this.sleep(1500);
            }
            await this.watch();
        },

        // --------------------------------------------------------------- flow

        finish: function () {
            this.post('bot:done');
            this.hide();
            var b = this.bridge();
            if (b && typeof b.closeCurrentTab === 'function') {
                b.closeCurrentTab();
            } else {
                window.close();
            }
        },

        run: async function () {
            this.post('bot:hello');
            try {
                var handler = this.handlers[kind];
                if (handler) {
                    await handler.call(this);
                } else {
                    // Unknown kind: safest behaviour is a plain countdown.
                    await this.watch();
                }
            } catch (e) {
                console.error('[BotTask] handler failed:', e);
            }
            this.finish();
        }
    };

    /**
     * Kind -> behaviour. Add new kinds here; the app needs no changes.
     * `default`/`surf` = plain countdown.
     */
    engine.handlers = {
        'default': engine.watch,
        'surf': engine.watch,
        'watch': engine.watch,
        'youtube': engine.youtube,
        'like': function () { return this.click(['#like-button', '.ytd-toggle-button-renderer', '[aria-label*="like" i]']); },
        'subscribe': function () { return this.click(['#subscribe-button', 'ytd-subscribe-button-renderer', '[aria-label*="subscribe" i]']); }
    };

    window.BotTaskEngine = engine;

    setTimeout(function () { engine.run(); }, 800);

})();
