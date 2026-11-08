(function() {
    window.AvisoTaskEngine = {
        
        sleep: function(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        },

        // دالة محاكاة النقر المتقدمة في التبويب الفرعي أيضاً
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

                ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(type => {
                    const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
                    control.dispatchEvent(new Ctor(type, opts));
                });

                control.click();
                return true;
            } catch (e) {
                console.error('خطأ أثناء النقر:', e);
                return false;
            }
        },

        runTask: async function() {
            console.log("Task Script: بدأ العمل داخل التبويب الفرعي.");

            let sek = 15; // وقت عد تنازلي آمن
            console.log(`Task Script: الانتظار لمدة ${sek} ثانية لحين انتهاء العداد...`);
            
            await this.sleep((sek + 3) * 1000);

            let extraBtn = document.querySelector('.btn__notice, #check_timer, .ads-confirm-btn');
            if (extraBtn) {
                try {
                    this.simulateClick(extraBtn);
                    console.log("Task Script: تم النقر على زر إضافي داخل التبويب الفرعي.");
                    await this.sleep(1000);
                } catch(e) {}
            }

            console.log("Task Script: انتهى الوقت، إغلاق التبويب والعودة للرئيسية...");

            // إغلاق التبويب عبر جسر أندرويد
            if (window.AndroidBridge && typeof window.AndroidBridge.closeCurrentTab === 'function') {
                window.AndroidBridge.closeCurrentTab();
            } else {
                window.close();
            }
        }
    };

    setTimeout(() => {
        window.AvisoTaskEngine.runTask();
    }, 1000);

})();
