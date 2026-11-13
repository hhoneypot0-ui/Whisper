/* ==========================================================================
   密聊模式：入口与视觉标识
   - 只有密聊会话才走端到端加密（普通聊天完全不动）
   - 入口①：聊天页顶部 🔒 按钮（升级 / 切换）
   - 入口②：会话列表里密聊带 🔒 标签
   ========================================================================== */
(function(){
  'use strict';
  if (!window.E2EE) return;

  var STYLE_ID = 'secret-style';
  function injectStyle(){
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      .pin-tag.secret{background:#eef1ff;color:#4b5bd6;font-weight:600}
      .secret-bar{display:flex;align-items:center;gap:6px;margin:0 12px 6px;
        padding:6px 10px;border-radius:9px;background:#eef1ff;color:#4b5bd6;
        font-size:12px;line-height:1.4}
      .hidden-secret{display:none!important}
      #btn-secret.locked{color:#4b5bd6}
    `;
    document.head.appendChild(st);
  }

  function convById(id){
    return ((typeof state !== 'undefined' && state.convs) || []).find(function(c){ return c.id === id; }) || null;
  }
  function isSecret(conv){ return !!(conv && conv.isSecret); }

  /* ---------------- 会话列表标识 ---------------- */
  function decorateConvs(){
    var list = document.getElementById('conv-list');
    if (!list) return;
    var rows = list.querySelectorAll('.conv[data-id]');
    for (var i = 0; i < rows.length; i++){
      var row = rows[i];
      var conv = convById(row.getAttribute('data-id'));
      var nameEl = row.querySelector('.conv-name');
      if (!conv || !nameEl) continue;
      var tag = nameEl.querySelector('.pin-tag.secret');
      if (isSecret(conv) && !tag){
        tag = document.createElement('span');
        tag.className = 'pin-tag secret';
        tag.textContent = '🔒 密聊';
        nameEl.appendChild(tag);
      }else if (!isSecret(conv) && tag){
        tag.remove();
      }
      // 预览行：密文不要直接显示乱码
      var last = row.querySelector('.conv-last');
      if (last && isSecret(conv) && /^E2EE/.test(last.textContent || '')){
        last.textContent = '🔒 加密消息';
      }
    }
  }

  /* ---------------- 聊天页标识 ---------------- */
  function decorateChat(){
    var view = document.getElementById('view-chat');
    if (!view || view.classList.contains('hidden')) return;
    var conv = (typeof state !== 'undefined') && state.activeConv;
    var status = document.getElementById('chat-status');
    var bar = document.getElementById('secret-bar');
    var composer = document.getElementById('composer');

    if (isSecret(conv)){
      if (status && !/端到端加密/.test(status.textContent || '')) status.textContent = '🔒 端到端加密';
      if (!bar && composer){
        bar = document.createElement('div');
        bar.id = 'secret-bar';
        bar.className = 'secret-bar';
        bar.textContent = '🔒 此对话已端到端加密，服务器读不到内容（换设备后看不到记录）';
        composer.parentNode.insertBefore(bar, composer);
      }
      var btn = document.getElementById('btn-secret');
      if (btn) btn.classList.add('locked');
    }else{
      if (bar) bar.remove();
      var btn2 = document.getElementById('btn-secret');
      if (btn2) btn2.classList.remove('locked');
    }
  }

  /* ---------------- 顶部按钮 ---------------- */
  function ensureButton(){
    var info = document.getElementById('btn-info');
    if (!info || document.getElementById('btn-secret')) return;
    var b = document.createElement('button');
    b.id = 'btn-secret';
    b.className = 'ibtn round';
    b.title = '密聊';
    b.setAttribute('aria-label', '密聊');
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
    b.addEventListener('click', function(e){
      e.stopPropagation();
      openSecretSheet();
    });
    info.parentNode.insertBefore(b, info);
  }

  /* ---------------- 密聊面板 ---------------- */
  function openSecretSheet(){
    var conv = (typeof state !== 'undefined') && state.activeConv;
    if (!conv){ return; }
    if (conv.type !== 'direct'){
      toast('密聊只支持一对一聊天');
      return;
    }
    var peer = conv.peer || ((conv.members || []).find(function(m){ return m.id !== state.me.id; }));
    var peerName = (peer && peer.name) || '对方';

    var box = document.createElement('div');
    box.className = 'sheet';
    var already = isSecret(conv);
    box.innerHTML = `<div class="sheet-inner">
      <h3>${already ? '🔒 当前是密聊' : '开启密聊'}</h3>
      <p class="hint">${already
        ? '这个会话已经端到端加密。服务器和管理后台都看不到内容。'
        : '开启后，你和「' + esc(peerName) + '」的对话只有你们两台手机能解开。'}</p>
      <div class="invite-box" style="font-size:12px;line-height:1.7">${
        already
          ? '· 消息密钥只在两台设备上\n· 换设备 / 清缓存后看不到记录\n· 不参与服务器搜索'
          : '· 服务器读不到内容（管理后台也读不到）\n· 换手机会丢失密聊记录\n· 已经发过的消息不会补加密\n· 对方也要用新版 App'
      }</div>
      <div class="row" style="margin-top:14px">
        <button class="ghost" id="sc-cancel">取消</button>
        <button class="primary" id="sc-ok">${already ? '切回普通聊天' : '开启密聊'}</button>
      </div>
    </div>`;
    document.body.appendChild(box);
    box.addEventListener('click', function(e){ if (e.target === box) box.remove(); });
    box.querySelector('#sc-cancel').addEventListener('click', function(){ box.remove(); });
    box.querySelector('#sc-ok').addEventListener('click', async function(){
      box.remove();
      if (!peer || !peer.id) return toast('找不到对方');
      try{
        if (already){
          // 切回普通会话
          var r = await api('POST', '/api/conversations', { peerId: peer.id });
          var cid = r.conversationId || (r.conversation && r.conversation.id);
          if (cid){ try{ await refreshConvs(); }catch(e){} await openConv(cid); toast('已切回普通聊天'); }
          else toast('切不回去了，稍后再试');
          return;
        }
        toast('正在建立密聊…');
        var rr = await api('POST', '/api/conversations/secret', { peerId: peer.id });
        if (!rr || !rr.conversationId){ toast('开启失败'); return; }
        // 关键：等会话列表刷完再打开，否则 activeConv 里没有 peer，第一条就发不出去
        try{ await refreshConvs(); }catch(e){}
        if (!convById(rr.conversationId)){
          // 极端情况下列表还没带上，手动补一条，保证 peer 可用
          if (!state.convs) state.convs = [];
          state.convs.push({
            id: rr.conversationId, type: 'direct', peer: peer,
            members: rr.members || [state.me, peer], isSecret: true,
            lastMessage: null, unread: 0
          });
          renderConvs();
        }
        await openConv(rr.conversationId);
        toast('密聊已开启');
      }catch(e){
        toast('操作失败：' + ((e && e.message) || '未知'));
      }
    });
  }

  /* ---------------- 观察界面变化 ---------------- */
  function run(){
    injectStyle();
    ensureButton();
    decorateConvs();
    decorateChat();
  }

  var mo = new MutationObserver(function(){
    if (mo._t) return;
    mo._t = setTimeout(function(){ mo._t = null; run(); }, 60);
  });
  try{
    mo.observe(document.body, { childList: true, subtree: true });
  }catch(e){}
  setInterval(run, 1500);
  run();

  window.Secret = {
    isSecret: isSecret,
    openSheet: openSecretSheet,
    createSecretConv: async function(peerId){
      var r = await api('POST', '/api/conversations/secret', { peerId });
      return r && r.conversationId;
    },
    decorate: run
  };
})();