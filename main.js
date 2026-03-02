// ==UserScript==
// @name         nku选课助手
// @namespace    http://tampermonkey.net/
// @version      2026-03-05
// @description  nku
// @author       Liudade
// @match        https://eamis.nankai.edu.cn/eams/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /******************** 核心配置 ********************/
    let config = {
        PREFERRED_NOS: [''],
        MAX_RETRY: 999,
        BASE_DELAY: 1500,
        RANDOM_DELAY: 2000,
        REQUEST_COOLDOWN: 10000, // 同一门课成功请求后冷却10秒
        isRunning: false,
        isPaused: false,
        timingEnabled: false,
        timingHour: 0,
        timingMinute: 0,
        timingSecond: 0,
        timingTimer: null,
        timingUpdateInterval: null
    };

    // 动态读取的全局ID变量
    let CURRENT_PROFILE_ID = null;
    let CURRENT_SEMESTER_ID = null;

    // 缓存
    let electedIdsCache = new Set();
    let requestedIdsCache = new Map();
    const lessonByNo = {}, lessonByName = {};

    let panel = null;
    let isDragging = false;
    let offsetX = 0, offsetY = 0;

    // 工具函数
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const randDelay = () => config.BASE_DELAY + Math.floor(Math.random() * config.RANDOM_DELAY);
    function log(...args) { console.log(`[南开选课助手]`, ...args); }

    /******************** 自动读取 IDs ********************/

    /**
     * 自动读取 profileId 
     * 仅返回结果，不弹窗，避免时序问题误报
     */
    function getProfileId() {
        // 优先级1: 从URL参数读取 (最常见)
        const urlParams = new URLSearchParams(window.location.search);
        let id = urlParams.get('electionProfile.id') || urlParams.get('profileId');
        if (id) {
            log(`从URL读取到 profileId: ${id}`);
            return id;
        }

        // 优先级2: 从页面隐藏的 input 元素读取
        const inputEl = document.querySelector('input[name="profileId"], input[name="electionProfile.id"]');
        if (inputEl && inputEl.value) {
            log(`从页面元素读取到 profileId: ${inputEl.value}`);
            return inputEl.value;
        }

        // 优先级3: 从全局 JS 变量中搜索 (强智系统常用)
        if (window.electionProfile && window.electionProfile.id) {
            log(`从全局变量读取到 profileId: ${window.electionProfile.id}`);
            return window.electionProfile.id;
        }

        // 兜底: 尝试从页面任意链接中正则匹配
        const pageHtml = document.body.innerHTML;
        const match = pageHtml.match(/(?:electionProfile\.id|profileId)[=:]["']?(\d+)["']?/);
        if (match && match[1]) {
            log(`从页面文本正则匹配到 profileId: ${match[1]}`);
            return match[1];
        }

        // 所有方法都失败，仅打日志，不弹窗
        log('本次读取未找到 profileId，页面可能未完全加载');
        return null;
    }

    /**
     * 自动读取 semesterId 
     */
    function getSemesterId() {
        // 方法1: URL
        const urlParams = new URLSearchParams(window.location.search);
        let id = urlParams.get('semesterId');
        if (id) return id;

        // 方法2: 全局变量
        if (window.semesterId) return window.semesterId;
        if (window.currentSemester && window.currentSemester.id) return window.currentSemester.id;

        // 兜底默认值
        return '4384';
    }

    /**
     * 校验ID是否有效，仅在用户操作时调用
     */
    function validateProfileId() {
        // 每次校验都重新读取一次，确保拿到最新的
        CURRENT_PROFILE_ID = getProfileId();
        CURRENT_SEMESTER_ID = getSemesterId();

        if (!CURRENT_PROFILE_ID) {
            alert('选课助手警告：无法读取选课批次ID，请确保在正确的选课页面！');
            return false;
        }
        return true;
    }

    /******************** 样式 ********************/
    const panelCSS = `
    .mini-elect-panel { position: fixed; top: 20px; right: 20px; width: 290px; background: #fff; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,0.15); z-index: 999999; font-family: system-ui, sans-serif; font-size: 12px; user-select: none; overflow: hidden; border: 1px solid #eee; }
    .mini-elect-head { padding: 8px 10px; background: #2c3e50; color: #fff; cursor: move; display: flex; justify-content: space-between; align-items: center; }
    .mini-elect-body { padding: 10px; }
    .mini-row { margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .mini-row label { width: 70px; color: #555; }
    .mini-row input { flex: 1; padding: 4px 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
    .mini-row .time-input { width: 50px; flex: none; }
    .mini-btn { padding: 5px 8px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; background: #3498db; color: #fff; }
    .mini-btn.success { background: #2ecc71; }
    .mini-btn.warn { background: #f39c12; }
    .mini-btn.danger { background: #e74c3c; }
    .mini-btn.disabled { background: #95a5a6; cursor: not-allowed; }
    .mini-btns { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .mini-btns button { flex: 1; min-width: 50px; }
    .id-display { padding: 4px 6px; background: #e8f4f8; border-radius: 4px; font-size: 10px; color: #2980b9; margin-bottom: 8px; word-break: break-all; }
    .timing-section { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #eee; }
    .timing-status { color: #666; font-size: 11px; margin-top: 4px; word-break: break-all; }
    .timing-active { color: #e74c3c; font-weight: bold; }
    .progress-status { margin-top: 6px; padding: 6px; background: #f8f9fa; border-radius: 4px; font-size: 11px; color: #333; }
    `;

    /******************** 面板创建 ********************/
    function createPanel() {
        // 页面加载时先读取一次ID，用于面板显示，不校验
        CURRENT_PROFILE_ID = getProfileId();
        CURRENT_SEMESTER_ID = getSemesterId();

        // 注入样式
        const style = document.createElement('style');
        style.textContent = panelCSS;
        document.head.appendChild(style);

        // 创建面板
        panel = document.createElement('div');
        panel.className = 'mini-elect-panel';
        panel.innerHTML = `
            <div class="mini-elect-head">
                <span>南开选课助手</span>
                <span id="miniClose" style="cursor:pointer">×</span>
            </div>
            <div class="mini-elect-body">
                <!-- ID 显示区 -->
                <div class="id-display">
                    批次ID: ${CURRENT_PROFILE_ID || '待读取'} | 学期ID: ${CURRENT_SEMESTER_ID}
                </div>

                <div class="mini-row">
                    <label>课程号:</label>
                    <input type="text" id="miniNos" value="${config.PREFERRED_NOS.join(',')}" placeholder="多门用英文逗号分隔">
                </div>
                <div class="mini-row">
                    <label>最大轮次:</label>
                    <input type="number" id="miniMax" value="${config.MAX_RETRY}">
                </div>
                <div class="mini-row">
                    <label>基础延迟:</label>
                    <input type="number" id="miniBase" value="${config.BASE_DELAY}">
                </div>
                <div class="mini-row">
                    <label>随机浮动:</label>
                    <input type="number" id="miniRand" value="${config.RANDOM_DELAY}">
                </div>

                <div class="progress-status" id="progressStatus">
                    待启动 | 目标课程：0门 | 已选：0门 | 剩余：0门
                </div>

                <div class="timing-section">
                    <div class="mini-row">
                        <label>定时开始:</label>
                        <input type="number" id="timingHour" class="time-input" min="0" max="23" placeholder="时" value="0">
                        <input type="number" id="timingMinute" class="time-input" min="0" max="59" placeholder="分" value="0">
                        <input type="number" id="timingSecond" class="time-input" min="0" max="59" placeholder="秒" value="0">
                    </div>
                    <div class="mini-btns">
                        <button class="mini-btn warn" id="setTimingBtn">设置/覆盖定时</button>
                        <button class="mini-btn danger" id="clearTimingBtn">取消定时</button>
                    </div>
                    <div class="timing-status" id="timingStatus">未设置定时</div>
                </div>

                <div class="mini-btns">
                    <button class="mini-btn success" id="miniSave">保存配置</button>
                    <button class="mini-btn" id="miniStart">立即开始</button>
                    <button class="mini-btn warn" id="miniPause" disabled>暂停</button>
                    <button class="mini-btn danger" id="miniStop" disabled>停止</button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        bindMainPanelEvents();
        bindDrag(panel, '.mini-elect-head');
        initLessons(); // 初始化课程数据
    }

    /******************** 事件绑定 ********************/
    function bindMainPanelEvents() {
        // 关闭面板
        panel.querySelector('#miniClose').onclick = () => {
            clearTiming();
            config.isRunning = false;
            panel.remove();
        };

        // 保存配置
        panel.querySelector('#miniSave').onclick = () => {
            config.PREFERRED_NOS = document.getElementById('miniNos').value.split(',').map(s => s.trim()).filter(Boolean);
            config.MAX_RETRY = +document.getElementById('miniMax').value || 1;
            config.BASE_DELAY = +document.getElementById('miniBase').value || 1500;
            config.RANDOM_DELAY = +document.getElementById('miniRand').value || 2000;
            log('配置已保存，目标课程：', config.PREFERRED_NOS);
            initLessons();
            refreshElectedCache();
            updateProgressStatus();
        };

        // 定时相关
        document.getElementById('setTimingBtn').onclick = setTiming;
        document.getElementById('clearTimingBtn').onclick = clearTiming;

        // 按钮状态更新
        const startBtn = document.getElementById('miniStart');
        const pauseBtn = document.getElementById('miniPause');
        const stopBtn = document.getElementById('miniStop');

        function updateBtnStatus() {
            startBtn.disabled = config.isRunning;
            pauseBtn.disabled = !config.isRunning;
            stopBtn.disabled = !config.isRunning;
            pauseBtn.textContent = config.isPaused ? '恢复' : '暂停';
            if (config.timingEnabled) {
                startBtn.classList.add('disabled');
                startBtn.disabled = true;
            } else {
                startBtn.classList.remove('disabled');
            }
        }

        // 立即开始
        startBtn.onclick = async () => {
            if (config.isRunning) return;
            // 【关键】点击时才校验ID，确保页面已加载完成
            if (!validateProfileId()) return;
            if (config.PREFERRED_NOS.length === 0) {
                alert('请先填写课程号并点击【保存配置】！');
                return;
            }
            // 更新面板上的ID显示
            panel.querySelector('.id-display').innerHTML = `批次ID: ${CURRENT_PROFILE_ID} | 学期ID: ${CURRENT_SEMESTER_ID}`;
            // 重置防重缓存
            requestedIdsCache.clear();
            config.isRunning = true;
            config.isPaused = false;
            updateBtnStatus();
            main();
        };

        // 暂停/恢复
        pauseBtn.onclick = () => {
            config.isPaused = !config.isPaused;
            updateBtnStatus();
            log(config.isPaused ? '已暂停' : '已恢复');
        };

        // 停止
        stopBtn.onclick = () => {
            config.isRunning = false;
            config.isPaused = false;
            requestedIdsCache.clear();
            updateBtnStatus();
            log('已手动停止');
        };
    }

    // 面板拖动功能
    function bindDrag(targetPanel, headSelector) {
        const head = targetPanel.querySelector(headSelector);
        head.onmousedown = e => {
            isDragging = true;
            const rect = targetPanel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            targetPanel.style.transition = 'none';
        };
        document.onmousemove = e => {
            if (!isDragging) return;
            const x = e.clientX - offsetX, y = e.clientY - offsetY;
            const maxX = window.innerWidth - targetPanel.offsetWidth - 10, maxY = window.innerHeight - targetPanel.offsetHeight - 10;
            targetPanel.style.left = Math.max(10, Math.min(x, maxX)) + 'px';
            targetPanel.style.top = Math.max(10, Math.min(y, maxY)) + 'px';
            targetPanel.style.right = 'auto';
        };
        document.onmouseup = () => {
            isDragging = false;
            targetPanel.style.transition = 'all 0.2s';
        };
    }

    /******************** 状态检测逻辑 ********************/
    function refreshElectedCache() {
        const newCache = new Set();
        const visited = new Set();
        function search(obj) {
            if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
            visited.add(obj);
            if (obj.id && obj.elected === true) newCache.add(obj.id);
            for (let key in obj) {
                if (['window', 'document', 'top', 'parent'].includes(key)) continue;
                try { search(obj[key]); } catch (e) {}
            }
        }
        search(window);
        electedIdsCache = newCache;
        return newCache;
    }

    function isSelected(lesson) {
        if (!lesson || !lesson.id) return false;
        if (electedIdsCache.has(lesson.id)) return true;
        if (lesson.elected === true || lesson.selected === true || lesson.status === 'ELECTED') return true;
        return false;
    }

    function isInCooldown(lessonId) {
        if (!requestedIdsCache.has(lessonId)) return false;
        return Date.now() - requestedIdsCache.get(lessonId) < config.REQUEST_COOLDOWN;
    }

    function initLessons() {
        if (window.lessonJSONs && Array.isArray(window.lessonJSONs)) {
            lessonByNo.clear();
            lessonByName.clear();
            window.lessonJSONs.forEach(l => {
                lessonByNo[l.no] = l;
                if (!lessonByName[l.name]) lessonByName[l.name] = [];
                lessonByName[l.name].push(l);
            });
        }
    }

    function updateProgressStatus() {
        const el = document.getElementById('progressStatus');
        if (!el) return;
        const total = config.PREFERRED_NOS.length;
        let selectedCount = 0;
        config.PREFERRED_NOS.forEach(no => {
            const lesson = lessonByNo[no];
            if (lesson && isSelected(lesson)) selectedCount++;
        });
        el.innerHTML = `目标课程：${total}门 | 已选：<span style="color:#2ecc71;font-weight:bold;">${selectedCount}</span>门 | 剩余：<span style="color:#e74c3c;font-weight:bold;">${total - selectedCount}</span>门`;
        return { total, selectedCount, remain: total - selectedCount };
    }

    /******************** 定时功能 ********************/
    function setTiming() {
        clearTiming();
        // 设置定时前也校验ID
        if (!validateProfileId()) return;
        if (config.PREFERRED_NOS.length === 0) {
            alert('请先填写课程号并保存配置！');
            return;
        }

        const h = parseInt(document.getElementById('timingHour').value) || 0;
        const m = parseInt(document.getElementById('timingMinute').value) || 0;
        const s = parseInt(document.getElementById('timingSecond').value) || 0;

        if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) {
            alert('请输入合法的时间（时0-23，分0-59，秒0-59）');
            return;
        }

        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s);
        if (target < now) target.setDate(target.getDate() + 1);
        const diff = target - now;

        config.timingEnabled = true;
        config.timingHour = h; config.timingMinute = m; config.timingSecond = s;

        // 主定时器
        config.timingTimer = setTimeout(() => {
            log('定时时间到！');
            config.timingEnabled = false;
            updateTimingStatus();
            requestedIdsCache.clear();
            config.isRunning = true;
            config.isPaused = false;
            document.getElementById('miniStart').classList.remove('disabled');
            document.getElementById('miniPause').disabled = false;
            document.getElementById('miniStop').disabled = false;
            main();
        }, diff);

        // 倒计时UI更新
        config.timingUpdateInterval = setInterval(() => {
            if (!config.timingEnabled) {
                clearInterval(config.timingUpdateInterval);
                return;
            }
            updateTimingStatus(target - new Date());
        }, 1000);

        updateTimingStatus(diff);
        log(`✅ 定时已设置: ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
    }

    function clearTiming() {
        if (config.timingTimer) clearTimeout(config.timingTimer);
        if (config.timingUpdateInterval) clearInterval(config.timingUpdateInterval);
        config.timingEnabled = false;
        updateTimingStatus();
        const startBtn = document.getElementById('miniStart');
        if(startBtn) {
            startBtn.disabled = false;
            startBtn.classList.remove('disabled');
        }
        log('旧定时已清除');
    }

    function updateTimingStatus(diff = 0) {
        const el = document.getElementById('timingStatus');
        if (!el) return;
        if (config.timingEnabled && diff > 0) {
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            el.innerHTML = `<span class="timing-active">定时中: ${config.timingHour.toString().padStart(2, '0')}:${config.timingMinute.toString().padStart(2, '0')}:${config.timingSecond.toString().padStart(2, '0')} (剩 ${timeStr})</span>`;
        } else {
            el.textContent = '未设置定时';
        }
    }

    /******************** 【核心】选课请求逻辑 (使用动态ID) ********************/
    async function refreshCount() {
        if (!CURRENT_PROFILE_ID) return;
        try {
            refreshElectedCache();
            // 使用动态 semesterId
            await fetch(`/eams/stdElectCourse!queryStdCount.action?projectId=1&semesterId=${CURRENT_SEMESTER_ID}&_=${Date.now()}`, {
                credentials: 'include'
            });
        } catch (e) {
            log('刷新人数失败:', e.message);
        }
    }

    async function electLesson(lesson) {
        if (!CURRENT_PROFILE_ID) return false;

        const lessonId = lesson.id;
        if (isSelected(lesson) || isInCooldown(lessonId)) return false;

        try {
            const form = new URLSearchParams();
            // 【关键】使用动态读取的 profileId
            form.append('profileId', CURRENT_PROFILE_ID);
            form.append('optype', 'true');
            form.append('operator0', `${lessonId}:true:0`);
            form.append('lesson0', lessonId);
            form.append(`expLessonGroup_${lessonId}`, 'undefined');

            log(`提交选课: ${lesson.name} [${lesson.no}] (ID:${lessonId})`);
            const res = await fetch(
                // 【关键】URL 也使用动态 profileId
                `/eams/stdElectCourse!batchOperator.action?profileId=${CURRENT_PROFILE_ID}`,
                {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: form.toString()
                }
            );

            // 严格校验 200 OK
            if (res.status === 200 && res.ok) {
                log(`请求成功 (200 OK): ${lesson.name}`);
                requestedIdsCache.set(lessonId, Date.now());
                await refreshCount(); // 立刻刷新状态
                return true;
            } else {
                log(`请求失败 (Status: ${res.status}): ${lesson.name}`);
                return false;
            }
        } catch (e) {
            log(`请求异常: ${lesson.name}`, e.message);
            return false;
        }
    }

    function getAvailableLessons() {
        const list = [];
        for (const no of config.PREFERRED_NOS) {
            const lesson = lessonByNo[no];
            if (!lesson) continue;
            if (isSelected(lesson) || isInCooldown(lesson.id)) continue;

            const count = window.lessonId2Counts?.[lesson.id];
            if (count && count.sc < count.lc) {
                list.push(lesson);
                continue;
            }

            // 同名教学班兜底
            const alts = lessonByName[lesson.name] || [];
            for (const alt of alts) {
                if (alt.id !== lesson.id && !isSelected(alt) && !isInCooldown(alt.id)) {
                    const c = window.lessonId2Counts?.[alt.id];
                    if (c && c.sc < c.lc) list.push(alt);
                }
            }
        }
        // 去重
        return Array.from(new Map(list.map(item => [item.id, item])).values());
    }

    async function main() {
        log('===== 开始抢课 =====');
        initLessons();
        refreshElectedCache();

        const startBtn = document.getElementById('miniStart');
        const pauseBtn = document.getElementById('miniPause');
        const stopBtn = document.getElementById('miniStop');
        const updateBtns = () => {
             if(startBtn) startBtn.disabled = config.isRunning;
             if(pauseBtn) pauseBtn.disabled = !config.isRunning;
             if(stopBtn) stopBtn.disabled = !config.isRunning;
        };

        for (let round = 1; round <= config.MAX_RETRY && config.isRunning; round++) {
            while (config.isPaused && config.isRunning) await sleep(500);
            if (!config.isRunning) break;

            log(`--- 第 ${round} 轮 ---`);
            await refreshCount();
            await sleep(300);

            const { remain } = updateProgressStatus();
            if (remain === 0) {
                log('全部选完！');
                alert('所有课程已选上！');
                config.isRunning = false;
                updateBtns();
                break;
            }

            const available = getAvailableLessons();
            if (available.length === 0) {
                log('无可用课程，等待...');
                await sleep(randDelay());
                continue;
            }

            log(`发现 ${available.length} 门可选`);
            for (const l of available) {
                if (!config.isRunning) break;
                await electLesson(l);
                await sleep(800);
            }
            await sleep(randDelay());
        }

        config.isRunning = false;
        requestedIdsCache.clear();
        updateBtns();
        log('===== 结束 =====');
    }

    // 启动：页面完全加载后1秒创建面板
    window.addEventListener('load', () => setTimeout(createPanel, 1000));
})();
