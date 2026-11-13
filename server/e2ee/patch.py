#!/usr/bin/env python3
"""给 im-server 的任一前端 app.js 打上端到端加密补丁（幂等，可重复运行）"""
import re, sys, pathlib

CORE = pathlib.Path(__file__).parent.parent / 'e2ee' / 'core.js'
BRIDGE = pathlib.Path(__file__).parent.parent / 'e2ee' / 'bridge.js'

def patch(target):
    p = pathlib.Path(target)
    s = p.read_text()
    changed = []

    # ① 内联加密内核
    if 'window.E2EE' not in s:
        core = CORE.read_text()
        s = core + '\n' + s
        changed.append('内核')

    # ② 发送钩子
    if 'function __sendPayloadRaw' not in s:
        old = 'function sendPayload(payload){'
        assert s.count(old) == 1, '找不到 sendPayload'
        s = s.replace(old, """function sendPayload(payload){
  // E2EE：单聊文字消息先在本机加密，再交给原有发送逻辑
  try{
    if(payload && payload.t==='send' && typeof payload.body==='string'
       && !payload.e2ee && window.__e2eeEncrypt){
      window.__e2eeEncrypt(payload).then(function(enc){
        __sendPayloadRaw(enc || payload);
      }).catch(function(){ __sendPayloadRaw(payload); });
      return;
    }
  }catch(e){}
  __sendPayloadRaw(payload);
}

function __sendPayloadRaw(payload){""")
        changed.append('发送钩子')

    # ③ 渲染钩子
    if 'window.__e2eeView) m = window.__e2eeView(m)' not in s:
        old = 'function renderMsg(m,c){'
        assert s.count(old) == 1, '找不到 renderMsg'
        s = s.replace(old, """function renderMsg(m,c){
  // E2EE：若是密文，渲染成明文（未解出前显示锁图标并异步解密）
  try{ if(window.__e2eeView) m = window.__e2eeView(m); }catch(e){}
""")
        changed.append('渲染钩子')

    # ④ 接入层
    if '__e2eeEncrypt = encryptPayload' not in s:
        s = s.rstrip() + '\n\n' + BRIDGE.read_text()
        changed.append('接入层')

    p.write_text(s)
    print(('已更新 ' + str(p) + '：' + ('、'.join(changed) if changed else '本来就有，无需改')))

if __name__ == '__main__':
    for t in sys.argv[1:]:
        patch(t)
