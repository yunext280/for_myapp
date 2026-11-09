(function() {
    // حالة البوت في الذاكرة الحية للسكريبت فقط (In-Memory State) بدون localStorage
    let botState = {
        taskId: null,
        step: 'IDLE', // الحالة تبدأ كـ خمول IDLE
        sek: 10,
        currentIndex: 0 // مؤشر التتبع التسلسلي j
    };

    window.AvisoMainEngine = {
        
        sleep: function(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        },

        // دالة محاكاة النقر الحقيقي (سلسلة المؤشر والفأرة)
        simulateClick: function(control) {
            if (!control) return false;
            try {
                control.scrollIntoView({ behavior: 'auto', block: 'center' });

                const r = control.getBoundingClientRect();
                const x = Math.round(r.left + r.width / 2);
                const y = Math.round(r.top + r.height / 2);
                const opts = {
                    bubbles: true, cancelable: true, view: window, detail: 1,
                    clientX: x, clientY: y, screenX: x, screenY: y,
                    button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false
                };

                // سلسلة أحداث الفأرة والمؤشر
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(type => {
                    const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
                    control.dispatchEvent(new Ctor(type, opts));
                });

                // نقرة أصلية أخيرة لتفعيل الحدث الأصلي
                control.click();
                return true;
            } catch (e) {
                console.error('خطأ أثناء النقر:', e);
                return false;
            }
        },

        // فحص تسجيل الدخول والتوجيه
        checkAuthAndRun: function() {
            const url_login = "https://aviso.bz/login";
            const member_url = "https://aviso.bz/members";
            const currentUrl = window.location.href;

            if (currentUrl.includes(url_login)) {
                setTimeout(() => {
                    console.log("[Aviso Auth] المستخدم لم يقم بتسجيل الدخول.");
                    this.showPersistentNotification("⚠️ يجب عليك تسجيل الدخول أولاً!", "#ff4757");
                }, 1000);
                return false;
            } 
            return true;
        },

        runAuto: async function() {
            if (!this.checkAuthAndRun()) return;

            let url = window.location.href;

            console.log("AvisoMain State:", botState.step, "TaskID:", botState.taskId, "Index j:", botState.currentIndex);

            // إذا كنا قد عدنا من التبويب الفرعي وننتظر التأكيد
            if (botState.step === 'CONFIRMING' && botState.taskId) {
                await this.confirmAndFinish(botState.taskId);
                return;
            }

            // إذا كنا في حالة الخمول (IDLE)، نبدأ بالبحث وتطبيق المؤشر
            if (botState.step === 'IDLE') {
                if (url.includes('tasks-surf')) {
                    this.Surfing();
                } else if (url.includes('tasks-youtube')) {
                    this.av_ytub();
                } else {
                    window.location.href = "https://aviso.bz/tasks-surf";
                }
            }
        },

        // أ. تصفح الإعلانات باستخدام المؤشر j في الذاكرة
        Surfing: async function() {
            let ads = document.querySelectorAll('.work-serf');
            if (!ads || ads.length === 0) {
                console.log("لا توجد مهام تصفح حالياً، إعادة المحاولة قريباً...");
                window.location.href = "https://aviso.bz/tasks-youtube";
                //setTimeout(() => this.runAuto(), 4000);
                return;
            }

            let j = botState.currentIndex;

            // إذا وصلنا لنهاية عناصر القائمة الحالية، ننتقل بسلاسة للقسم التالي
            if (j >= ads.length) {
                console.log("تم إنجاز كافة المهام الظاهرة في هذه الصفحة. الانتقال لمهام يوتيوب...");
                botState.currentIndex = 0;
                window.location.href = "https://aviso.bz/tasks-youtube";
                return;
            }

            let ad = ads[j];
            if (!ad) {
                botState.currentIndex++;
                this.runAuto();
                return;
            }

            let serId = ad.id;
            let startBtnId = serId.replace('serf-link-', 'start-serf-');
            let startBtn = document.getElementById(startBtnId);

            if (startBtn) {
                // aviso يضع معالج النقر على الرابط الداخلي <a class="start-surfing-btn">
                // وليس على الحاوية <div id="start-serf-*">، فالنقر على الحاوية لا يفتح المهمة.
                let clickable = startBtn.querySelector('a.start-surfing-btn');
                if (!clickable) {
                    // مهمة غير متاحة (Заявка не найдена) — تجاوزها بدل التعليق في CONFIRMING
                    botState.currentIndex++;
                    this.runAuto();
                    return;
                }

                let serfIdElem = document.getElementById(serId.replace('serf-link-', 'serf-id-'));
                let sek = 10;
                if (serfIdElem) {
                    let bTags = serfIdElem.querySelectorAll('b');
                    if (bTags.length >= 2) {
                        let match = bTags[1].textContent.match(/\d+/);
                        if (match) sek = parseInt(match[0]);
                    }
                }

                // حفظ بيانات المهمة مؤقتاً في الذاكرة الحية (In-Memory)
                botState.taskId = serId;
                botState.step = 'CONFIRMING';
                botState.sek = sek;

                // النقر الحقيقي المتقدم عبر simulateClick
                this.simulateClick(clickable);
            } else {
                botState.currentIndex++;
                this.runAuto();
            }
        },

        // ب. يوتيوب باستخدام المؤشر j في الذاكرة
        av_ytub: async function() {
            let allTube = document.querySelectorAll('.work-serf');
            if (!allTube || allTube.length === 0) {
                console.log("لا توجد فيديوهات يوتيوب حالياً، إعادة المحاولة...");
                setTimeout(() => this.runAuto(), 4000);
                return;
            }

            let j = botState.currentIndex;

            if (j >= allTube.length) {
                console.log("تم إنجاز كافة فيديوهات يوتيوب. العودة لقسم التصفح...");
                botState.currentIndex = 0;
                window.location.href = "https://aviso.bz/tasks-surf";
                return;
            }

            let tube = allTube[j];
            if (!tube) {
                botState.currentIndex++;
                this.runAuto();
                return;
            }

            let tubId = tube.id;
            let sekId = tubId.replace('ads-link-', 'ads_id_');
            let sekElem = document.getElementById(sekId);
            let sek = 20;
            if (sekElem) {
                let match = sekElem.textContent.match(/\d+/);
                if (match) sek = parseInt(match[0]);
            }

            let startBtnId = tubId.replace('ads-link-', 'link_ads_start_');
            let startBtn = document.getElementById(startBtnId);

            if (startBtn) {
                botState.taskId = tubId;
                botState.step = 'CONFIRMING';
                botState.sek = sek;

                this.simulateClick(startBtn);
            } else {
                botState.currentIndex++;
                this.runAuto();
            }
        },

        // ج. تأكيد المهمة وزيادة المؤشر j++ دون تحديث الصفحة
        confirmAndFinish: async function(taskId) {
            console.log("جاري تأكيد المهمة في الصفحة الرئيسية للفهرس j =", botState.currentIndex);
            
            await this.sleep(1500);

            let conferId = taskId.replace('serf-link-', 'serf_btn_confirm_')
                                 .replace('ads-link-', 'ads_btn_confirm_');
            
            let confirmBtn = document.getElementById(conferId);

            if (confirmBtn) {
                this.simulateClick(confirmBtn);
                console.log("تم النقر على زر التأكيد بنجاح واحتساب الأرباح!");
                await this.sleep(1500);
            } else {
                console.log("تنبيه: زر التأكيد غير متوفر.");
            }

            // إعادة ضبط المهمة الحالية وزيادة مؤشر التتبع j الانتقالي فوراً
            botState.taskId = null;
            botState.step = 'IDLE';
            botState.currentIndex++;

            await this.sleep(1000);
            this.runAuto();
        },

        showPersistentNotification: function(message, bgColor) {
            const oldNotice = document.getElementById('auth-notice');
            if (oldNotice) oldNotice.remove();

            const notice = document.createElement('div');
            notice.id = 'auth-notice';
            notice.innerHTML = message;
            notice.style.cssText = `position:fixed;top:20px;right:20px;background:${bgColor};color:#fff;padding:14px 22px;z-index:99999;border-radius:6px;font-weight:bold;box-shadow:0 4px 6px rgba(0,0,0,0.3);`;
            document.body.appendChild(notice);
        }
    };

    window.addEventListener('load', () => {
        setTimeout(() => {
            window.AvisoMainEngine.runAuto();
        }, 1500);
    });

})();
