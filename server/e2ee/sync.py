#!/usr/bin/env python3
"""把 e2ee/core.js + bridge.js 同步进前端 app.js（幂等，可重复跑）"""
import sys, pathlib

CORE_MARK = "/* ==========================================================================\n   端到端加密内核"
BRIDGE_MARK = "/* ==========================================================================\n   端到端加密：接入层"

def sync(target, core, bridge, hooks=True):
    p = pathlib.Path(target)
    s = p.read_text()

    # ① 内核：整段替换
    if CORE_MARK in s:
        i = s.index(CORE_MARK)
        j = s.index('window.E2EE = {', i)
        j = s.index('};', j) + 2
        j = s.index('})();', j) + len('})();')
        s = s[:i] + core.rstrip() + s[j:]
    else:
        s = core + '\n' + s

    # ② 发送 / 渲染钩子
    if hooks:
        old_hook_head = 'function sendPayload(payload){'
        new_hook = """function sendPayload(payload){
  // E2EE：只有密聊会话的文字消息才在本机加密，普通聊天原样发
  try{
    if(payload && payload.t==='send' && typeof payload.body==='string'
       && !payload.e2ee && window.__e2eeEncrypt){
      window.__e2eeEncrypt(payload).then(function(enc){
        if(enc === false) return;          // 密聊但发不出去，已提示，别退化成明文
        __sendPayloadRaw(enc || payload);
      }).catch(function(){ __sendPayloadRaw(payload); });
      return;
    }
  }catch(e){}
  __sendPayloadRaw(payload);
}

function __sendPayloadRaw(payload){"""
        if 'function __sendPayloadRaw' in s:
            i = s.index(old_hook_head)
            j = s.index('function __sendPayloadRaw(payload){', i) + len('function __sendPayloadRaw(payload){')
            s = s[:i] + new_hook + s[j:]
        else:
            assert s.count(old_hook_head) == 1
            s = s.replace(old_hook_head, new_hook)
    if hooks and 'window.__e2eeView) m = window.__e2eeView(m)' not in s:
        old = 'function renderMsg(m,c){'
        assert s.count(old) == 1
        s = s.replace(old, """function renderMsg(m,c){
  // E2EE：密文渲染成明文（未解出前显示锁图标并异步解密）
  try{ if(window.__e2eeView) m = window.__e2eeView(m); }catch(e){}
""")

    # ②b 通知预览：密聊不要弹密文
    if hooks and "body = '🔒 加密消息'" not in s:
        old = "  else body = (msg.body || '').slice(0, 60);"
        assert s.count(old) == 1, '找不到通知预览'
        s = s.replace(old, "  else if (c && c.isSecret) body = '🔒 加密消息';\n  else body = (msg.body || '').slice(0, 60);")

    # ②c 编辑消息：密聊要重新加密后再提交
    if hooks and '__e2eeEncryptText(m.convId' not in s:
        old = "        const r=await api('POST',`/api/messages/${m.id}/edit`,{body:t});"
        assert s.count(old) == 1, '找不到编辑消息'
        s = s.replace(old, """        let __t2 = t;
        try{ if(window.__e2eeEncryptText){ const __e = await window.__e2eeEncryptText(m.convId, t); if(__e) __t2 = __e; } }catch(e){}
        const r=await api('POST',`/api/messages/${m.id}/edit`,{body:__t2});""")

    # ②d 会话列表预览：密聊不要显示 E2EE1 乱码
    if hooks and "const __secPreview" not in s:
        old = "      preview=pre+body;"
        assert s.count(old) == 1, '找不到预览拼接'
        s = s.replace(old, "      const __secPreview = (c.isSecret && /^E2EE/.test(String(body||''))) ? '🔒 加密消息' : body;\n      preview=pre+__secPreview;")

    # ③ 接入层：整段替换到尾
    if BRIDGE_MARK in s:
        i = s.index(BRIDGE_MARK)
        s = s[:i] + bridge
    else:
        s = s.rstrip() + '\n\n' + bridge

    p.write_text(s)
    print('已同步', target, '→', len(s.splitlines()), '行')

if __name__ == '__main__':
    base = pathlib.Path(__file__).parent
    core = base.joinpath('core.js').read_text()
    bridge = base.joinpath('bridge.js').read_text()
    secret_file = base.joinpath('secret.js')
    if secret_file.exists():
        bridge = bridge.rstrip() + '\n\n' + secret_file.read_text()
    for t in sys.argv[1:]:
        sync(t, core, bridge)
