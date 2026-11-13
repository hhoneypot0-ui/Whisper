/* ==========================================================================
   端到端加密：接入层
   - 只有【密聊会话】(conv.isSecret) 才做端到端加密
   - 普通聊天完全不动：继续走服务器 AES，管理后台/搜索照常
   - 群聊暂不启用 E2E（ENABLE_GROUP_E2EE = false，代码留着）
   - 图片 / 语音 / 文件：不加密
   - 私钥只存在本机 localStorage，服务器只收到公钥和密文
   - 解出的明文按消息 id 记住，同一条密文绝不重复解密（消息密钥一次性）
   ========================================================================== */
(function(){
  'use strict';
  var C = window.E2EE;
  if (!C) return;
  var TD = new TextDecoder(), TE = new TextEncoder();
  var ID_KEY = 'e2ee_identity_v1';
  var SESS_PREFIX = 'e2ee_sess_v1_';
  var GROUP_PREFIX = 'e2ee_group_v1_';
  var PLAIN_KEY = 'e2ee_plain_v1';
  var OWN_KEY = 'e2ee_own_v1';
  var MAX_PLAIN = 500, MAX_OWN = 200;
  // 群聊 E2E 先关着（需求：这次只做单聊密聊）。要开就改 true。
  var ENABLE_GROUP_E2EE = false;

  var identity = null, booted = false, uploading = false;
  var decrypting = {};
  var plainMap = lsGet(PLAIN_KEY) || {};
  var ownMap = lsGet(OWN_KEY) || {};

  function lsGet(k){ try{ return JSON.parse(localStorage.getItem(k) || 'null'); }catch(e){ return null; } }
  function lsSet(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }

  function trim(obj, max){
    var ks = Object.keys(obj);
    if (ks.length <= max) return;
    for (var i = 0; i < ks.length - Math.floor(max * 0.8); i++) delete obj[ks[i]];
  }
  function rememberPlain(id, text){
    if (!id || text == null) return;
    plainMap[id] = text;
    trim(plainMap, MAX_PLAIN);
    lsSet(PLAIN_KEY, plainMap);
  }
  function rememberOwn(clientId, text){
    if (!clientId || text == null) return;
    ownMap[clientId] = text;
    trim(ownMap, MAX_OWN);
    lsSet(OWN_KEY, ownMap);
  }

  /* ---------------- 身份 ---------------- */
  async function loadIdentity(){
    if (identity) return identity;
    var raw = lsGet(ID_KEY);
    if (!raw) return null;
    try{ identity = await C.deserializeIdentity(raw); return identity; }
    catch(e){ console.warn('[e2ee] 身份读不出来', e); return null; }
  }
  async function createIdentity(){
    var id = await C.newIdentity();
    var raw = await C.serializeIdentity(id);
    lsSet(ID_KEY, raw);
    identity = await C.deserializeIdentity(raw);
    return identity;
  }
  async function ensureIdentity(){ return (await loadIdentity()) || (await createIdentity()); }

  async function uploadBundle(){
    if (uploading || !state || !state.me) return;
    uploading = true;
    try{
      var id = await ensureIdentity();
      var b = await C.makeBundle(id, state.me.name || 'me');
      await api('POST', '/api/e2ee/bundle', { bundle: b });
    }catch(e){ /* 服务器没升级也不影响本机 */ }
    finally{ uploading = false; }
  }

  /* ---------------- 会话（一对一双棘轮） ---------------- */
  async function loadSession(peerId){
    var raw = lsGet(SESS_PREFIX + peerId);
    if (!raw) return null;
    try{ return await C.Session.fromJSON(raw); }catch(e){ return null; }
  }
  async function saveSession(peerId, sess){
    try{ lsSet(SESS_PREFIX + peerId, await sess.toJSON()); }catch(e){}
  }

  function findConv(convId){
    return (state.convs || []).find(function(x){ return x.id === convId; })
      || (state.activeConv && state.activeConv.id === convId ? state.activeConv : null);
  }
  function peerOf(convId){
    var c = findConv(convId);
    if (!c || c.type !== 'direct') return null;
    var peer = c.peer;
    if (!peer && c.members) peer = c.members.find(function(x){ return x.id !== state.me.id; });
    return peer && peer.id ? peer : null;
  }

  /** 与某人建立（或复用）一对一会话，取不到公钥就返回 null */
  async function sessionWith(peerId, id){
    var sess = await loadSession(peerId);
    if (sess) return { sess: sess, first: null };
    var r = await api('GET', '/api/e2ee/bundle/' + encodeURIComponent(peerId)).catch(function(){ return null; });
    if (!r || !r.bundle) return null;
    if (!(await C.verifyBundle(r.bundle))) return null;
    var s = await C.startSession(id, r.bundle, peerId);
    return { sess: s.sess, first: s.first };
  }

  /* ================= 单聊 ================= */
  async function encryptDirect(payload, id){
    var peer = peerOf(payload.convId);
    if (!peer) return null;
    var got = await sessionWith(peer.id, id);
    if (!got) return null;                       // 对方没开 E2EE → 照旧发明文
    var env = await got.sess.encrypt(payload.body);
    await saveSession(peer.id, got.sess);
    var wire = { v:1, x3dh: got.first, header: env.header, iv: env.iv, ct: env.ct, ts: Date.now() };
    var out = Object.assign({}, payload);
    out.body = 'E2EE1.' + C.b64(TE.encode(JSON.stringify(wire)));
    out.e2ee = 1;
    return out;
  }

  /* ================= 群聊（Sender Key） ================= */
  function groupMembers(conv){
    return (conv.members || []).filter(function(m){ return m.id && m.id !== state.me.id; });
  }

  /** 把自己的发送链分发给每个成员（各自用一对一会话加密） */
  async function distributeSenderKey(conv, sk, members, id){
    var full = await C.packSenderKey(sk);
    var sig = await C.signSenderKeyPack(full, id.ikSig.privateKey);
    var pub = {};
    for (var k in full) if (k !== 'signingPriv') pub[k] = full[k];
    var packet = { convId: conv.id, epoch: sk.epoch, fromId: state.me.id, pack: pub, sig: sig };

    var dists = [];
    for (var i = 0; i < members.length; i++){
      var m = members[i];
      try{
        var got = await sessionWith(m.id, id);
        if (!got) continue;                       // 该成员没开 E2EE，跳过
        var env = await got.sess.encrypt(JSON.stringify(packet));
        await saveSession(m.id, got.sess);
        dists.push({
          targetId: m.id,
          payload: { v:1, x3dh: got.first, header: env.header, iv: env.iv, ct: env.ct }
        });
      }catch(e){ console.warn('[e2ee] 分发给 ' + m.id + ' 失败', e); }
    }
    if (dists.length){
      await api('POST', '/api/e2ee/group/senderkey',
        { convId: conv.id, epoch: sk.epoch, distributions: dists }).catch(function(){});
    }
    return dists.length;
  }

  async function encryptGroup(conv, text, id){
    var members = groupMembers(conv);
    if (!members.length) return null;             // 只有自己，没必要加密

    var key = GROUP_PREFIX + conv.id;
    var g = lsGet(key) || { epoch: 0, sig: '', peers: {} };
    var sig = members.map(function(m){ return m.id; }).sort().join(',');

    // 第一次发言，或群成员变了 → 换新一代密钥（退群的人立刻失效）
    if (!g.my || g.sig !== sig){
      var epoch = (g.epoch || 0) + 1;
      var sk = await C.createSenderKey(conv.id, state.me.id, epoch);
      await distributeSenderKey(conv, sk, members, id);
      g = { epoch: epoch, sig: sig, my: await C.serializeSenderKey(sk), peers: g.peers || {} };
      lsSet(key, g);
    }

    var mine = await C.deserializeSenderKey(g.my);
    var env = await C.encryptGroupText(mine, text);
    g.my = await C.serializeSenderKey(mine);
    lsSet(key, g);

    return 'E2EEG1.' + C.b64(TE.encode(JSON.stringify(env)));
  }

  /** 取某人在这个群里的发送链（没有就去服务器领） */
  async function peerSenderKey(convId, senderId, id){
    var key = GROUP_PREFIX + convId;
    var g = lsGet(key) || { epoch: 0, sig: '', peers: {} };
    var p = g.peers[senderId];
    if (p && p.state) return p;

    var r = await api('GET', '/api/e2ee/group/senderkey/' + encodeURIComponent(convId) + '/' + encodeURIComponent(senderId))
      .catch(function(){ return null; });
    if (!r || !r.payload) throw new Error('等待密钥同步');

    var got = await sessionWith(senderId, id);
    if (!got) throw new Error('缺少与该成员的会话');
    var pt = await got.sess.decrypt(r.payload);
    if (!pt) throw new Error('密钥包解密失败');
    await saveSession(senderId, got.sess);

    var packet = JSON.parse(TD.decode(pt));
    var b = await api('GET', '/api/e2ee/bundle/' + encodeURIComponent(senderId)).catch(function(){ return null; });
    if (!b || !b.bundle) throw new Error('取不到对方身份公钥');
    if (!(await C.verifySenderKeyPack(packet.pack, packet.sig, C.ub64(b.bundle.ikSigPub)))){
      throw new Error('SenderKey 验签失败（可能是伪造）');
    }
    var sk = await C.openSenderKeyPack(packet.pack);
    sk.signing = null;                            // 接收方不持有别人的签名私钥
    p = { epoch: packet.epoch, pub: packet.pack.signingPub, state: await C.serializeSenderKey(sk) };
    g.peers[senderId] = p;
    lsSet(key, g);
    return p;
  }

  async function decryptGroup(payloadB64, convId, senderId){
    var payload = JSON.parse(TD.decode(C.ub64(payloadB64.slice(8))));
    var id = await ensureIdentity();
    var conv = payload.header && payload.header.c ? payload.header.c : convId;
    var from = payload.header && payload.header.s ? payload.header.s : senderId;
    var p = await peerSenderKey(conv, from, id);
    var st = await C.deserializeSenderKey(p.state);
    var pt = await C.decryptGroupText(st, payload, p.pub);
    // 保存推进后的链
    var key = GROUP_PREFIX + conv;
    var g = lsGet(key) || { peers: {} };
    p.state = await C.serializeSenderKey(st);
    g.peers = g.peers || {};
    g.peers[from] = p;
    lsSet(key, g);
    return TD.decode(pt);
  }

  /* ================= 统一入口 ================= */
  /**
   * 返回值约定：
   *   对象  = 加密后的 payload（照这个发）
   *   null  = 普通会话，原样发（不做任何加密）
   *   false = 密聊会话但发不出去（会在内部提示原因，调用方不要发）
   */
  async function encryptPayload(payload){
    if (!state || !state.me) return null;
    if (payload.kind && payload.kind !== 'text') return null;    // 只加密文字
    var conv = findConv(payload.convId);
    if (!conv) return null;

    // ★ 只有密聊会话才走 E2E；普通聊天一行都不碰
    var isGroup = (conv.type === 'group' || conv.type === 'channel');
    if (isGroup){
      if (!ENABLE_GROUP_E2EE || !conv.isSecret) return null;
    }else if (!conv.isSecret){
      return null;
    }

    try{
      var id = await ensureIdentity();
      await uploadBundle();

      if (isGroup){
        var body = await encryptGroup(conv, payload.body, id);
        if (!body) return null;
        if (payload.clientId) rememberOwn(payload.clientId, payload.body);
        return Object.assign({}, payload, { body: body, e2ee: 1 });
      }

      var direct = await encryptDirect(payload, id);
      if (!direct){
        // 密聊会话里发不出去，绝不能退回明文发出去
        var why = await secretSendBlocker(conv);
        console.error('[e2ee] 密聊发送失败:', why);
        if (typeof toast === 'function') toast(why || '密聊消息发送失败');
        showSecretError(why || '密聊消息发送失败');
        return false;
      }
      if (payload.clientId) rememberOwn(payload.clientId, payload.body);
      return direct;
    }catch(e){
      console.error('[e2ee] 加密失败', e);
      var m2 = '密聊加密失败：' + ((e && e.message) || '未知');
      if (typeof toast === 'function') toast(m2);
      showSecretError(m2);
      return false;
    }
  }

  /** 在聊天界面上挂一条红色错误提示（比 toast 显眼，不会一闪而过） */
  function showSecretError(msg){
    try{
      var host = document.querySelector('#view-chat #msgs') || document.querySelector('#view-chat');
      if (!host) return;
      var old = document.getElementById('secret-error-bar');
      if (old) old.remove();
      var bar = document.createElement('div');
      bar.id = 'secret-error-bar';
      bar.style.cssText = 'position:sticky;bottom:8px;left:0;right:0;margin:8px 12px;padding:10px 14px;' +
        'border-radius:12px;background:#fee2e2;color:#b91c1c;font-size:13px;line-height:1.5;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.12);z-index:50;display:flex;gap:8px;align-items:flex-start';
      bar.innerHTML = '<span style="flex:none">⚠️</span><span style="flex:1">' + msg + '</span>';
      bar.addEventListener('click', function(){ bar.remove(); });
      host.appendChild(bar);
      setTimeout(function(){ try{ bar.remove(); }catch(e){} }, 8000);
    }catch(e){}
  }

  /** 密聊发不出去时，给用户一个人话原因 */
  async function secretSendBlocker(conv){
    var peer = peerOf(conv.id);
    if (!peer) return '找不到对方，无法建立密聊';
    var r = await api('GET', '/api/e2ee/bundle/' + encodeURIComponent(peer.id)).catch(function(){ return null; });
    if (!r || !r.bundle) return '对方还没开启密聊，先发普通消息';
    return '密聊通道异常，稍后再试';
  }

  /* ================= 接收 ================= */
  function isCipher(body){
    if (typeof body !== 'string') return false;
    return (body.indexOf('E2EE1.') === 0 || body.indexOf('E2EEG1.') === 0) && body.length < 200000;
  }

  function viewMessage(m){
    if (!m || typeof m.body !== 'string') return m;
    if (plainMap[m.id] != null) return Object.assign({}, m, { body: plainMap[m.id] });
    if (m.clientId && ownMap[m.clientId] != null){
      rememberPlain(m.id, ownMap[m.clientId]);
      return Object.assign({}, m, { body: ownMap[m.clientId] });
    }
    if (!isCipher(m.body)) return m;
    if (m.__plain != null) return Object.assign({}, m, { body: m.__plain });

    var tag = m.id + '@' + (m.body.slice(0, 16));
    if (!decrypting[tag]){
      decrypting[tag] = true;
      decryptOne(m).finally(function(){ delete decrypting[tag]; });
    }
    return Object.assign({}, m, { body: m.body.indexOf('E2EEG1.') === 0 ? '🔒 等待密钥同步…' : '🔒 解密中…' });
  }

  async function decryptOne(m){
    try{
      var text;
      if (m.body.indexOf('E2EEG1.') === 0){
        text = await decryptGroup(m.body, m.convId, m.senderId);
      }else{
        var id = await ensureIdentity();
        var wire = JSON.parse(TD.decode(C.ub64(m.body.slice(6))));
        var sess = await loadSession(m.senderId);
        if (wire.x3dh){
          var r = await api('GET', '/api/e2ee/bundle/' + encodeURIComponent(m.senderId)).catch(function(){ return null; });
          if (!r || !r.bundle) throw new Error('取不到对方公钥');
          if (!(await C.verifyBundle(r.bundle))) throw new Error('公钥验签失败');
          sess = await C.acceptSession(id, wire.x3dh, C.ub64(r.bundle.ikDhPub));
        }
        if (!sess) throw new Error('缺乏会话密钥');
        var pt = await sess.decrypt(wire);
        if (!pt) throw new Error('认证失败');
        text = TD.decode(pt);
        await saveSession(m.senderId, sess);
      }
      m.__plain = text;
      m.body = text;
      rememberPlain(m.id, text);
      if (typeof updateMsgInPlace === 'function') updateMsgInPlace(m);
    }catch(e){
      var tip = '⚠️ 这条消息解不开（' + ((e && e.message) || '未知原因') + '）';
      m.__plain = tip;
      m.body = tip;
      console.warn('[e2ee] 解密失败', e);
      if (typeof updateMsgInPlace === 'function') updateMsgInPlace(m);
    }
  }

  window.__e2eeEncrypt = encryptPayload;
  // 给文件加密模块用：拿当前身份
  window.__e2eeGetIdentity = function(){ return ensureIdentity(); };
  window.__e2eeView = viewMessage;

  /** 编辑消息用：密聊返回密文，普通会话返回 null（调用方保持原文） */
  window.__e2eeEncryptText = async function(convId, text){
    try{
      var enc = await encryptPayload({ t:'send', convId: convId, body: text, kind: 'text' });
      return (enc && enc.body) ? enc.body : null;
    }catch(e){ return null; }
  };

  /* ================= 启动 ================= */
  var boot = setInterval(function(){
    if (booted || !state || !state.me) return;
    booted = true;
    clearInterval(boot);
    ensureIdentity().then(uploadBundle).catch(function(e){ console.warn('[e2ee] 初始化失败', e); });
  }, 700);

  /* ================= 调试/维护 ================= */
  window.e2eeStatus = async function(){
    if (!window.E2EE) return { ok:false, reason:'当前环境不支持 WebCrypto' };
    var id = await loadIdentity();
    var out = { ok: !!id, self: id ? C.b64(await C.pubRaw(id.ikDh)) : null, peer: null, safety: null };
    var conv = state && state.activeConv;
    if (!conv) return out;
    if (conv.type === 'group' || conv.type === 'channel'){
      var g = lsGet(GROUP_PREFIX + conv.id);
      out.group = { epoch: g ? g.epoch : 0, members: (conv.members || []).length,
                    peers: g && g.peers ? Object.keys(g.peers).length : 0 };
      return out;
    }
    var peer = peerOf(conv.id);
    if (id && peer){
      var r = await api('GET', '/api/e2ee/bundle/' + encodeURIComponent(peer.id)).catch(function(){ return null; });
      if (r && r.bundle){
        out.peer = r.bundle.ikDhPub;
        out.safety = await C.safetyNumber(out.self, r.bundle.ikDhPub);
      }
    }
    return out;
  };

  /** 群里强制换一代密钥（怀疑有人不该能看时用） */
  window.e2eeRotateGroup = async function(){
    var conv = state && state.activeConv;
    if (!conv || (conv.type !== 'group' && conv.type !== 'channel')) return '不是群聊';
    var key = GROUP_PREFIX + conv.id;
    var g = lsGet(key) || { epoch: 0, peers: {} };
    g.sig = '';                       // 让下次发言时重新分发
    lsSet(key, g);
    return '下次发言会重新分发密钥（epoch ' + ((g.epoch || 0) + 1) + '）';
  };

  window.e2eeReset = function(){
    try{
      Object.keys(localStorage).forEach(function(k){
        if (k === ID_KEY || k === PLAIN_KEY || k === OWN_KEY
            || k.indexOf(SESS_PREFIX) === 0 || k.indexOf(GROUP_PREFIX) === 0) localStorage.removeItem(k);
      });
      location.reload();
    }catch(e){}
  };
})();