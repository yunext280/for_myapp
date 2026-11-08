(function () {
    'use strict';

    /*
     * Task-tab script.
     *
     * aviso opens one of two interstitial pages for a YouTube task (and a similar
     * one for surf tasks). Both need a click before the view counts:
     *
     *   1) "Просмотр видео"  -> <a class="btn__notice">Start Watching</a>
     *                            <span id="timer">40</span>
     *   2) "channel" page    -> <a id="youtube_views-channel-link">…</a>
     *
     * The old script slept a fixed 18 s, clicked, and closed immediately, so the
     * view was never counted. This one mirrors aviso_bot.py:
     *   click the interaction right away, wait the real required time, then close.
     *
     * The required seconds come from the main page row of this very task
     * (ads_id_<id> b[2] / serf-id-<id> b[2]) while we are still on aviso.bz,
     * because window.opener is same-origin there. After the redirect to
     * youtube.com the value is kept in window.name (survives navigations).
     */

    var DEFAULT_SEK = 40;   // aviso's usual YouTube watch time
    var MARGIN = 5;         // extra seconds after the required time
    var NAME_KEY = '|aviso_sek=';

    function digits(el) {
        if (!el) return 0;
        var m = (el.textContent || '').match(/\d+/);
        return m ? parseInt(m[0], 10) : 0;
    }

    // Our own URL carries the task id: /go/create-task-view.php?id=8301696
    function taskId() {
        var m = location.href.match(/[?&]id=(\d+)/);
        return m ? m[1] : '';
    }

    // Real required seconds, read from the opener's task row (same origin on aviso).
    function sekFromOpener() {
        try {
            var id = taskId();
            if (!id || !window.opener) return 0;
            var doc = window.opener.document;
            var row = doc.getElementById('ads_id_' + id) || doc.getElementById('serf-id-' + id);
            if (!row) return 0;
            var bs = row.querySelectorAll('b');
            if (bs.length >= 2) return digits(bs[1]);
        } catch (e) { /* cross-origin after the redirect */ }
        return 0;
    }

    function sekFromName() {
        try {
            var n = String(window.name || '');
            var i = n.indexOf(NAME_KEY);
            if (i < 0) return 0;
            var m = n.slice(i + NAME_KEY.length).match(/^\d+/);
            return m ? parseInt(m[0], 10) : 0;
        } catch (e) { return 0; }
    }

    function remember(sek) {
        try {
            var n = String(window.name || '');
            var i = n.indexOf(NAME_KEY);
            if (i >= 0) n = n.slice(0, i);
            window.name = n + NAME_KEY + sek;
        } catch (e) { /* ignore */ }
    }

    function currentSek() {
        var fromBridge = Number(window.__avisoSek) || 0;      // optional, set by the app
        return fromBridge || sekFromOpener() || digits(document.getElementById('timer')) ||
            sekFromName() || DEFAULT_SEK;
    }

    function simulateClick(control) {
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
                var Ctor = type.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
                control.dispatchEvent(new Ctor(type, opts));
            });

            control.click();
            return true;
        } catch (e) {
            console.error('[task] click failed:', e);
            return false;
        }
    }

    function visible(el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    // The two aviso interstitial variants (+ older confirm buttons), in order.
    function interaction() {
        var candidates = [
            document.querySelector('.btn__notice'),
            document.getElementById('youtube_views-channel-link'),
            document.querySelector('.ads-confirm-btn'),
            document.querySelector('.h-captcha, #h-captcha')
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (visible(candidates[i])) return candidates[i];
        }
        return null;
    }

    function isCaptcha(el) {
        if (!el) return false;
        if (el.id === 'h-captcha') return true;
        return !!(el.classList && el.classList.contains('h-captcha'));
    }

    function closeTab() {
        try {
            if (window.AndroidBridge && typeof window.AndroidBridge.closeCurrentTab === 'function') {
                window.AndroidBridge.closeCurrentTab();
                return;
            }
        } catch (e) { /* fall through */ }
        try { window.close(); } catch (e) { /* WebView ignores it */ }
    }

    function runTask() {
        var sek = currentSek();
        remember(sek);

        var startedAt = Date.now();
        var clickedOnce = false;

        console.log('[task] required watch time: ' + sek + 's (' + location.href + ')');

        function tick() {
            var el = interaction();

            if (el && isCaptcha(el)) {
                // Needs an external solver; leave the tab to the safety timeout.
                console.log('[task] hCaptcha found — cannot solve it here');
            } else if (el && !clickedOnce) {
                clickedOnce = true;
                console.log('[task] clicking interaction: ' + (el.id || el.className));
                simulateClick(el);
                // Give the page time to navigate; the new document restarts us.
                setTimeout(tick, 1200);
                return;
            }

            if (Date.now() - startedAt >= (sek + MARGIN) * 1000) {
                console.log('[task] done — closing the task tab');
                closeTab();
                return;
            }

            setTimeout(tick, 1000);
        }

        setTimeout(tick, 600);
    }

    // Kept for compatibility with anything that called the engine explicitly.
    window.AvisoTaskEngine = {
        sleep: function (ms) {
            return new Promise(function (resolve) { setTimeout(resolve, ms); });
        },
        simulateClick: simulateClick,
        runTask: runTask
    };

    setTimeout(runTask, 800);
})();
