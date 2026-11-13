/* ==========================================================================
   文件端到端加密（图片 / 语音 / 视频 / 文件）
   ---------------------------------------------------------------------------
   思路：
   1. 每个「我 ↔ 对方」有一条稳定的文件密钥（ECDH 派生，不随消息棘轮变化）
   2. 上传前用 AES-256-GCM 加密整个文件，服务器只收到乱码
   3. 下载后本地解密
   4. 密钥存在本机，不上传
   ========================================================================== */
(function(){
'use strict';
if (!globalThis.crypto || !globalThis.crypto.subtle) { window.__e2eeFilesUnsupported = true; return; }

const SUB = globalThis.crypto.subtle;
const TE  = new TextEncoder();
const KEY_CACHE = 'im_e2ee_filekeys';   // { peerId: base64key }

/* ---------------- 工具 ---------------- */
function b64(buf){
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function ub64(str){
  const bin = atob(String(str || ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function loadKeys(){ try{ return JSON.parse(localStorage.getItem(KEY_CACHE) || '{}'); }catch(e){ return {}; } }
function saveKeys(o){ try{ localStorage.setItem(KEY_CACHE, JSON.stringify(o)); }catch(e){} }

/* ---------------- 派生文件密钥 ----------------
   用「我的身份 DH 私钥」+「对方的身份 DH 公钥」做 ECDH，
   再 HKDF 出 32 字节，作为这一对聊天的文件密钥。
   这个值不随消息棘轮变化 → 老文件永远能解开。
------------------------------------------------ */
async function deriveFileKey(myIdentity, peerBundle, peerId){
  const cache = loadKeys();
  if (cache[peerId]) {
    try{
      return await SUB.importKey('raw', ub64(cache[peerId]), { name:'AES-GCM' }, false, ['encrypt','decrypt']);
    }catch(e){}
  }
  if (!myIdentity || !myIdentity.ikDh || !peerBundle || !peerBundle.ikDhPub) return null;

  // 导入对方身份公钥（和 core.js 一致：ECDH P-256）
  const peerPubRaw = ub64(peerBundle.ikDhPub);
  const peerPub = await SUB.importKey('raw', peerPubRaw, { name:'ECDH', namedCurve:'P-256' }, false, []);
  // ECDH
  const shared = await SUB.deriveBits({ name:'ECDH', public: peerPub }, myIdentity.ikDh.privateKey, 256);

  // HKDF 出 AES key
  const ikm = await SUB.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const salt = TE.encode('qiao-file-' + [peerId].join('|'));
  const bits = await SUB.deriveBits({ name:'HKDF', hash:'SHA-256', salt, info: TE.encode('e2ee-file-v1') }, ikm, 256);
  const keyBuf = new Uint8Array(bits);

  cache[peerId] = b64(keyBuf);
  saveKeys(cache);
  return await SUB.importKey('raw', keyBuf, { name:'AES-GCM' }, false, ['encrypt','decrypt']);
}

/* ---------------- 加密整个文件 ----------------
   输出格式：[12字节 IV][密文]
------------------------------------------------ */
async function encryptBlob(blob, key){
  const plain = new Uint8Array(await blob.arrayBuffer());
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await SUB.encrypt({ name:'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return new Blob([out], { type: 'application/octet-stream' });
}

async function decryptBlob(blob, key){
  const all = new Uint8Array(await blob.arrayBuffer());
  if (all.length < 13) throw new Error('密文太短');
  const iv = all.subarray(0, 12);
  const ct = all.subarray(12);
  const plain = await SUB.decrypt({ name:'AES-GCM', iv }, key, ct);
  return new Uint8Array(plain);
}

/* ---------------- 对外 ---------------- */
window.E2EEFiles = {
  deriveFileKey,
  /**
   * 加密一个 File/Blob 并上传
   * @returns {Promise<{id,size,encrypted:true}>} 服务器返回的上传结果
   */
  async uploadEncrypted(file, kind, uploadFn, myIdentity, peerBundle, peerId, duration){
    const key = await deriveFileKey(myIdentity, peerBundle, peerId);
    if (!key) throw new Error('还没有对方的密钥，不能加密上传');
    const enc = await encryptBlob(file, key);
    // 换个名字，避免服务器按扩展名猜类型
    const fake = new File([enc], 'e2ee_' + Date.now() + '.bin', { type: 'application/octet-stream' });
    const r = await uploadFn(fake, kind, duration);
    return r;
  },

  /**
   * 下载并解密
   */
  async downloadDecrypted(id, myIdentity, peerBundle, peerId, fetchFn){
    const key = await deriveFileKey(myIdentity, peerBundle, peerId);
    if (!key) throw new Error('没有文件密钥，无法解密');
    const blob = await fetchFn(id);
    const plain = await decryptBlob(blob, key);
    return new Blob([plain]);
  },

  b64, ub64
};
})();
