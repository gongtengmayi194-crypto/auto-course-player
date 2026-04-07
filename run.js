// ==UserScript==
// @name         网课助手 - 稳定最终版
// @namespace    http://tampermonkey.net/
// @version      3.0.0
// @description  自动点击“我知道了”、静音自动播放、自动下一集、轻度防后台暂停；每集仅尝试一次倍速，不后台反复调速
// @match        *://wsdx.nwafu.edu.cn/jjfz/play*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        speed: 2.0,
        mutedAutoplay: true,
        autoNext: true,
        nextDelay: 2200,
        antiPause: true,
        debug: true
    };

    const saved = parseFloat(localStorage.getItem('wsdx_speed') || '');
    if (Number.isFinite(saved) && saved > 0) CONFIG.speed = saved;

    function log(...args) {
        if (CONFIG.debug) console.log('[网课助手]', ...args);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isVisible(el) {
        if (!el) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' &&
               s.visibility !== 'hidden' &&
               s.opacity !== '0' &&
               r.width > 0 &&
               r.height > 0;
    }

    function textOf(el) {
        return (el?.innerText || el?.textContent || '').replace(/\s+/g, '').trim();
    }

    function fireMouseSequence(el) {
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
            el.dispatchEvent(new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window
            }));
        });
    }

    function safeClick(el, label = '') {
        if (!el || !isVisible(el)) return false;

        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        try { fireMouseSequence(el); } catch (e) {}

        try {
            el.click();
            if (label) log('已点击', label);
            return true;
        } catch (e) {}

        return false;
    }

    function clickAtCenter(el, label = '') {
        if (!el || !isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const target = document.elementFromPoint(x, y) || el;

        try {
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                target.dispatchEvent(new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y,
                    view: window
                }));
            });
            if (label) log('已中心点击', label);
            return true;
        } catch (e) {
            return false;
        }
    }

    let currentVideo = null;
    let nextPending = false;
    let lastDialogClickAt = 0;

    function findBestVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (!videos.length) return null;

        const visible = videos.filter(v => isVisible(v));
        if (visible.length === 1) return visible[0];
        if (visible.length > 1) {
            visible.sort((a, b) => {
                const ra = a.getBoundingClientRect();
                const rb = b.getBoundingClientRect();
                return rb.width * rb.height - ra.width * ra.height;
            });
            return visible[0];
        }
        return videos[0];
    }

    function applyMuted(video) {
        if (!video) return;
        if (CONFIG.mutedAutoplay) {
            try {
                video.muted = true;
                video.volume = 0;
            } catch (e) {}
        }
    }

    // 只尝试一次，不做后台守护
    function applySpeedOnce(video) {
        if (!video) return;

        if (video.dataset.wsdxSpeedTried === '1') return;
        video.dataset.wsdxSpeedTried = '1';

        try {
            video.defaultPlaybackRate = CONFIG.speed;
            video.playbackRate = CONFIG.speed;
            log('本集已尝试设置倍速为', CONFIG.speed, '实际读取=', video.playbackRate);
        } catch (e) {
            log('设置倍速失败', e);
        }
    }

    async function tryAutoplay(video) {
        if (!video) return false;

        applyMuted(video);
        applySpeedOnce(video);

        try {
            await video.play();
            log('video.play() 成功');
            return true;
        } catch (e) {
            log('video.play() 失败', e?.name || e);
        }

        const candidates = [
            '.plyr__control--overlaid',
            '.plyr__control[aria-label*="播放"]',
            '.plyr__control[aria-label*="Play"]',
            'button[aria-label*="播放"]',
            'button[aria-label*="Play"]',
            '.wrap_video .plyr',
            '.wrap_video'
        ];

        for (const sel of candidates) {
            const el = document.querySelector(sel);
            if (el && isVisible(el)) {
                safeClick(el, `播放控件 ${sel}`);
                await sleep(300);
                try {
                    applyMuted(video);
                    applySpeedOnce(video);
                    await video.play();
                    log('点击播放控件后 play() 成功');
                    return true;
                } catch (e) {}
            }
        }

        return false;
    }

    function getPromptLayers() {
        const allLayers = Array.from(document.querySelectorAll('.layui-layer, .layui-layer-page, .layui-layer-dialog, [class*="layer"], [class*="dialog"]'))
            .filter(isVisible);

        return allLayers.filter(layer => {
            const txt = textOf(layer);
            return txt.includes('温馨提示') ||
                   txt.includes('您需要完整观看一遍课程视频') ||
                   txt.includes('然后视频可以拖动播放') ||
                   txt.includes('我知道了') ||
                   txt.includes('完整观看');
        });
    }

    function clickKnowDialog() {
        const now = Date.now();
        if (now - lastDialogClickAt < 400) return false;

        const layers = getPromptLayers();

        for (const layer of layers) {
            const btn0 = layer.querySelector('.layui-layer-btn0');
            if (btn0 && isVisible(btn0)) {
                if (safeClick(btn0, '提示框按钮 .layui-layer-btn0') || clickAtCenter(btn0, '提示框按钮中心 .layui-layer-btn0')) {
                    lastDialogClickAt = now;
                    return true;
                }
            }

            const btnArea = layer.querySelector('.layui-layer-btn');
            if (btnArea && isVisible(btnArea)) {
                const btns = Array.from(btnArea.querySelectorAll('a, button, span, div')).filter(isVisible);
                if (btns.length) {
                    const btn = btns[0];
                    if (safeClick(btn, `提示框按钮区第一个 ${textOf(btn)}`) || clickAtCenter(btn, `提示框按钮区中心 ${textOf(btn)}`)) {
                        lastDialogClickAt = now;
                        return true;
                    }
                }
            }

            const candidates = Array.from(layer.querySelectorAll('a, button, span, div')).filter(isVisible);
            for (const el of candidates) {
                const t = textOf(el);
                if (t.includes('我知道了') || t.includes('知道') || t.includes('确定') || t.includes('继续')) {
                    if (safeClick(el, `提示框文本按钮 ${t}`) || clickAtCenter(el, `提示框文本按钮中心 ${t}`)) {
                        lastDialogClickAt = now;
                        return true;
                    }
                }
            }

            const r = layer.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height * 0.82;
            const target = document.elementFromPoint(x, y);
            if (target) {
                try {
                    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                        target.dispatchEvent(new MouseEvent(type, {
                            bubbles: true,
                            cancelable: true,
                            clientX: x,
                            clientY: y,
                            view: window
                        }));
                    });
                    log('已尝试点击提示框底部区域');
                    lastDialogClickAt = now;
                    return true;
                } catch (e) {}
            }
        }

        return false;
    }

    function getCourseLinks() {
        return Array.from(document.querySelectorAll('a[href*="r_id="]')).filter(a => textOf(a).length > 0);
    }

    function findCurrentIndex(links) {
        const currentRid = new URLSearchParams(location.search).get('r_id');
        return links.findIndex(a => {
            try {
                const u = new URL(a.href, location.origin);
                return u.searchParams.get('r_id') === currentRid;
            } catch (e) {
                return a.href.includes(`r_id=${currentRid}`);
            }
        });
    }

    function goNextEpisode() {
        if (!CONFIG.autoNext || nextPending) return false;

        const links = getCourseLinks();
        const idx = findCurrentIndex(links);

        if (idx !== -1 && idx < links.length - 1) {
            nextPending = true;
            const next = links[idx + 1];
            log('准备进入下一集：', next.innerText.trim());

            setTimeout(() => {
                safeClick(next, '下一集');
                setTimeout(() => {
                    nextPending = false;
                    currentVideo = null;
                }, 4000);
            }, CONFIG.nextDelay);

            return true;
        }

        log('未找到下一集');
        return false;
    }

    function bindVideo(video) {
        if (!video) return;

        if (video !== currentVideo) {
            currentVideo = video;
            log('已绑定 video');
        }

        if (video.dataset.wsdxBound === '1') return;
        video.dataset.wsdxBound = '1';

        video.addEventListener('loadedmetadata', () => {
            log('loadedmetadata');
            applyMuted(video);
            applySpeedOnce(video);
        });

        video.addEventListener('canplay', () => {
            log('canplay');
            applyMuted(video);
            applySpeedOnce(video);
        });

        video.addEventListener('play', () => {
            log('play');
            applyMuted(video);
            applySpeedOnce(video);
        });

        video.addEventListener('playing', () => {
            log('playing');
            applyMuted(video);
            applySpeedOnce(video);
        });

        video.addEventListener('pause', () => {
            if (video.ended) return;
            log('pause');
            if (CONFIG.antiPause) {
                setTimeout(() => {
                    if (video.paused && !video.ended) {
                        clickKnowDialog();
                        tryAutoplay(video);
                    }
                }, 600);
            }
        });

        video.addEventListener('ratechange', () => {
            log('ratechange ->', video.playbackRate);
        });

        video.addEventListener('ended', () => {
            log('播放结束');
            setTimeout(clickKnowDialog, 200);
            setTimeout(clickKnowDialog, 600);
            setTimeout(clickKnowDialog, 1200);
            setTimeout(clickKnowDialog, 2000);
            setTimeout(goNextEpisode, 2400);
        });
    }

    function antiBackgroundPause() {
        if (!CONFIG.antiPause) return;

        try {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        } catch (e) {}

        const blocker = e => e.stopImmediatePropagation();
        ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide'].forEach(evt => {
            document.addEventListener(evt, blocker, true);
            window.addEventListener(evt, blocker, true);
        });

        log('已启用轻度防后台暂停');
    }

    async function heartbeat() {
        const clicked = clickKnowDialog();
        const video = findBestVideo();
        if (!video) return;

        bindVideo(video);

        if (clicked) {
            await sleep(500);
            await tryAutoplay(video);
            return;
        }

        if (video.paused && !video.ended) {
            await tryAutoplay(video);
        }
    }

    GM_registerMenuCommand?.(`设置倍速（当前 ${CONFIG.speed}x）`, () => {
        const val = prompt('输入倍速，例如 1.5 / 2 / 2.5 / 3', String(CONFIG.speed));
        if (!val) return;
        const n = parseFloat(val);
        if (!Number.isFinite(n) || n <= 0 || n > 8) {
            alert('倍速无效');
            return;
        }
        localStorage.setItem('wsdx_speed', String(n));
        alert(`已保存为 ${n}x，刷新页面生效`);
    });

    console.log('[网课助手] 脚本已注入', location.href);

    antiBackgroundPause();
    setInterval(clickKnowDialog, 300);
    setInterval(heartbeat, 1000);

    window.addEventListener('load', () => {
        setTimeout(heartbeat, 300);
        setTimeout(heartbeat, 1200);
        setTimeout(heartbeat, 2500);
        setTimeout(heartbeat, 4000);
    });

    const observer = new MutationObserver(() => {
        clickKnowDialog();
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
})();
