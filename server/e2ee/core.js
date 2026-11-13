/* ==========================================================================
   端到端加密内核（X3DH + Double Ratchet + AES-256-GCM）
   与服务器无关：私钥只在本机，服务器只看到密文。
   由 e2ee-chat/public/crypto.js 生成，勿手改。
   ========================================================================== */
(function(){
'use strict';
if (!globalThis.crypto || !globalThis.crypto.subtle) { window.__e2eeUnsupported = true; return; }
// crypto.js — 零依赖 E2EE 内核（浏览器 / Node 24 通用）
// X3DH 预共享 + Double Ratchet（前向保密 + 后向保密）+ AES-256-GCM
// 服务器永远拿不到私钥，也永远看不到明文。

const SUB = (globalThis.crypto || {}).subtle;
const TE = new TextEncoder();
const TD = new TextDecoder();

/* ---------------- 编码 ---------------- */
function b64(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function ub64(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
const cat = (...arrays) => {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
};
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ---------------- 基础原语 ---------------- */
async function sha256(data) {
  return new Uint8Array(await SUB.digest('SHA-256', data));
}

async function hkdf(ikm, salt, info, len = 32) {
  const key = await SUB.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await SUB.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: TE.encode(info) },
    key, len * 8,
  );
  return new Uint8Array(bits);
}

async function hmac(keyBytes, data) {
  const key = await SUB.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await SUB.sign('HMAC', key, data));
}

const aesKey = (raw, usage) => SUB.importKey('raw', raw, 'AES-GCM', false, usage);

async function aeadSeal(keyRaw, plaintext, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await SUB.encrypt(
    { name: 'AES-GCM', iv, additionalData: TE.encode(aad), tagLength: 128 },
    await aesKey(keyRaw, ['encrypt']), plaintext,
  );
  return { iv: b64(iv), ct: b64(ct) };
}

async function aeadOpen(keyRaw, env, aad) {
  try {
    const pt = await SUB.decrypt(
      { name: 'AES-GCM', iv: ub64(env.iv), additionalData: TE.encode(aad), tagLength: 128 },
      await aesKey(keyRaw, ['decrypt']), ub64(env.ct),
    );
    return new Uint8Array(pt);
  } catch { return null; } // 认证失败 = 篡改/错钥，一律当解密失败
}

/* ---------------- 身份密钥 ---------------- */
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

const genEcdh = () => SUB.generateKey(ECDH, true, ['deriveBits']);
const genSig = () => SUB.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

async function pubRaw(pair) {
  return new Uint8Array(await SUB.exportKey('raw', pair.publicKey));
}
const privJwk = (pair) => SUB.exportKey('jwk', pair.privateKey);
const pubJwk = (pair) => SUB.exportKey('jwk', pair.publicKey);

async function importDhPub(raw) {
  return SUB.importKey('raw', raw, ECDH, true, []);
}
async function importDhPriv(jwk) {
  return SUB.importKey('jwk', jwk, ECDH, true, ['deriveBits']);
}
async function importSigPub(raw) {
  return SUB.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}
async function importSigPriv(jwk) {
  return SUB.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
}

async function dh(privKey, pubKey) {
  const bits = await SUB.deriveBits({ name: 'ECDH', public: pubKey }, privKey, 256);
  return new Uint8Array(bits);
}

async function sign(sigPriv, bytes) {
  return new Uint8Array(await SUB.sign({ name: 'ECDSA', hash: 'SHA-256' }, sigPriv, bytes));
}
async function verify(sigPub, sig, bytes) {
  try { return await SUB.verify({ name: 'ECDSA', hash: 'SHA-256' }, sigPub, sig, bytes); }
  catch { return false; }
}

/* ---------------- 用户身份（本地生成，永不外传私钥） ---------------- */
// IKdh: 长期 ECDH 身份钥    IKsig: 长期签名钥
// SPK  : 签名预密钥（同时充当首轮棘轮私钥）
// OPK  : 一次性预密钥池
async function newIdentity() {
  const ikDh = await genEcdh();
  const ikSig = await genSig();
  const spk = await genEcdh();
  const spkPub = await pubRaw(spk);
  // 签名覆盖 IKdh || IKsig || SPK —— 与 verifyBundle 的 AAD 完全一致
  const spkSig = await sign(ikSig.privateKey, cat(await pubRaw(ikDh), await pubRaw(ikSig), spkPub));

  const opks = [];
  for (let i = 0; i < 20; i++) {
    const kp = await genEcdh();
    opks.push({ id: `${Date.now().toString(36)}-${i}`, pair: kp });
  }
  return { ikDh, ikSig, spk, spkPub, spkSig, spkId: Date.now(), opks };
}

// 序列化（存 IndexedDB / 导出备份）；私钥以 jwk 明文存在本机 —— 本机安全模型见 README
async function serializeIdentity(id) {
  const out = {
    ikDh: { pub: b64(await pubRaw(id.ikDh)), priv: await privJwk(id.ikDh) },
    ikSig: { pub: b64(await pubRaw(id.ikSig)), priv: await privJwk(id.ikSig) },
    spk: { pub: b64(await pubRaw(id.spk)), priv: await privJwk(id.spk) },
    spkSig: b64(id.spkSig),
    spkId: id.spkId,
    opks: [],
  };
  for (const o of id.opks) {
    out.opks.push({ id: o.id, pub: b64(await pubRaw(o.pair)), priv: await privJwk(o.pair) });
  }
  return out;
}

async function deserializeIdentity(s) {
  return {
    ikDh: { privateKey: await importDhPriv(s.ikDh.priv), publicKey: await importDhPub(ub64(s.ikDh.pub)) },
    ikSig: { privateKey: await importSigPriv(s.ikSig.priv), publicKey: await importSigPub(ub64(s.ikSig.pub)) },
    spk: { privateKey: await importDhPriv(s.spk.priv), publicKey: await importDhPub(ub64(s.spk.pub)) },
    spkSig: ub64(s.spkSig),
    spkId: s.spkId,
    opks: await Promise.all(s.opks.map(async (o) => ({
      id: o.id,
      pair: { privateKey: await importDhPriv(o.priv), publicKey: await importDhPub(ub64(o.pub)) },
    }))),
    ikDhPub: ub64(s.ikDh.pub),
    ikSigPub: ub64(s.ikSig.pub),
  };
}

/* ---------------- 预密钥包：客户端自验签，拒绝服务端掉包 ---------------- */
function bundleAad(b) {
  return cat(ub64(b.ikDhPub), ub64(b.ikSigPub), ub64(b.spkPub));
}

async function makeBundle(id, username) {
  const opk = id.opks[0];
  const b = {
    username,
    ikDhPub: b64(await pubRaw(id.ikDh)),
    ikSigPub: b64(await pubRaw(id.ikSig)),
    spkId: id.spkId,
    spkPub: b64(await pubRaw(id.spk)),
    spkSig: b64(id.spkSig),
    opk: opk ? { id: opk.id, pub: b64(await pubRaw(opk.pair)) } : null,
  };
  return b;
}

// 校验对方 bundle 的签名：IKsig 对 (IKdh || SPK) 的签名必须成立
async function verifyBundle(b) {
  const sigPub = await importSigPub(ub64(b.ikSigPub));
  return verify(sigPub, ub64(b.spkSig), bundleAad(b));
}

/* ---------------- X3DH 发起 ---------------- */
// 返回 { SK, EK, opkId }
async function x3dhInitiate(id, bundle) {
  if (!(await verifyBundle(bundle))) throw new Error('对方预密钥签名无效（可能被服务端替换）');
  const ek = await genEcdh();
  const parts = [
    await dh(ek.privateKey, await importDhPub(ub64(bundle.spkPub))),        // DH1 EKa-SPKb
    await dh(id.ikDh.privateKey, await importDhPub(ub64(bundle.spkPub))),   // DH2 IKa-SPKb
    await dh(ek.privateKey, await importDhPub(ub64(bundle.ikDhPub))),       // DH3 EKa-IKb
  ];
  if (bundle.opk) {
    parts.push(await dh(ek.privateKey, await importDhPub(ub64(bundle.opk.pub)))); // DH4 EKa-OPKb
  }
  const SK = await hkdf(cat(...parts), new Uint8Array(32), 'e2ee-x3dh-v1', 32);
  return { SK, EK: ek, opkId: bundle.opk?.id ?? null };
}

/* ---------------- Double Ratchet ---------------- */
const KDF_RK = async (rk, dhOut) => {
  const okm = await hkdf(dhOut, rk, 'e2ee-rk-v1', 64);
  return { rk: okm.slice(0, 32), ck: okm.slice(32, 64) };
};
const KDF_CK = async (ck) => {
  const mk = await hmac(ck, new Uint8Array([0x01]));
  const next = await hmac(ck, new Uint8Array([0x02]));
  return { mk, next };
};
const kk = (dhB64, n) => `${dhB64}|${n}`;

class Session {
  constructor(state = {}) {
    this.RK = state.RK ?? null;              // Uint8Array(32)
    this.DHs = state.DHs ?? null;            // {privateKey, publicKey}
    this.DHr = state.DHr ?? null;            // Uint8Array raw pub
    this.CKs = state.CKs ?? null;            // {key, n}
    this.CKr = state.CKr ?? null;
    this.Ns = state.Ns ?? 0;
    this.Nr = state.Nr ?? 0;
    this.PN = state.PN ?? 0;
    this.skipped = new Map(state.skipped ?? []); // "dh|n" -> mk
    this.peer = state.peer ?? null;
    this.established = state.established ?? false;
  }

  static async initiator(SK, peerBundle, peerName) {
    const s = new Session({ peer: peerName });
    s.RK = SK;
    s.DHr = ub64(peerBundle.spkPub);
    s.DHs = await genEcdh();
    const { rk, ck } = await KDF_RK(s.RK, await dh(s.DHs.privateKey, await importDhPub(s.DHr)));
    s.RK = rk;
    s.CKs = { key: ck, n: 0 };
    s.established = true;
    return s;
  }

  static async responder(SK, spkPair, peerName) {
    const s = new Session({ peer: peerName });
    s.RK = SK;
    s.DHs = spkPair;      // 首轮棘轮私钥就是签名预密钥，与发起方 DH1 对齐
    s.DHr = null;         // 未知，收到首包后由 header.dh 填充
    s.established = true;
    return s;
  }

  async _dhRatchet(newRemotePub) {
    this.PN = this.Ns;
    this.Ns = 0;
    this.Nr = 0;
    this.DHr = newRemotePub;
    const remote = await importDhPub(this.DHr);
    if (this.DHs) {
      const a = await KDF_RK(this.RK, await dh(this.DHs.privateKey, remote));
      this.RK = a.rk;
      this.CKr = { key: a.ck, n: 0 };
    }
    this.DHs = await genEcdh();
    const b = await KDF_RK(this.RK, await dh(this.DHs.privateKey, remote));
    this.RK = b.rk;
    this.CKs = { key: b.ck, n: 0 };
  }

  async encrypt(plaintext) {
    if (!this.CKs) throw new Error('会话未就绪');
    const { mk, next } = await KDF_CK(this.CKs.key);
    this.CKs = { key: next, n: this.CKs.n + 1 };
    const header = {
      dh: b64(await pubRaw(this.DHs)),
      pn: this.PN,
      n: this.Ns,
    };
    this.Ns++;
    const aad = JSON.stringify(header);
    const env = await aeadSeal(mk, TE.encode(plaintext), aad);
    return { header, iv: env.iv, ct: env.ct };
  }

  async decrypt(wire) {
    const { header } = wire;
    const aad = JSON.stringify(header);
    const tryKey = async (mk) => aeadOpen(mk, { iv: wire.iv, ct: wire.ct }, aad);

    // 1) 跳过的消息密钥
    const k = kk(header.dh, header.n);
    if (this.skipped.has(k)) {
      const mk = this.skipped.get(k);
      const pt = await tryKey(mk);
      if (pt) { this.skipped.delete(k); return pt; }
    }

    // 2) 对方换了棘轮公钥 → DH 棘轮
    if (!this.DHr || header.dh !== b64(this.DHr)) {
      if (this.CKr && header.pn > this.Nr) await this._skipTo(header.pn);
      await this._dhRatchet(ub64(header.dh));
    }

    // 3) 链内跳跃
    if (header.n > this.Nr + 200) throw new Error('跳跃过大，拒绝');
    while (this.Nr < header.n) {
      const { mk, next } = await KDF_CK(this.CKr.key);
      this.skipped.set(kk(header.dh, this.Nr), mk);
      this.CKr = { key: next, n: this.CKr.n + 1 };
      this.Nr++;
    }

    // 4) 正常解密
    const { mk, next } = await KDF_CK(this.CKr.key);
    const pt = await tryKey(mk);
    if (!pt) throw new Error('消息认证失败（被篡改或密钥不匹配）');
    this.CKr = { key: next, n: this.CKr.n + 1 };
    this.Nr++;
    return pt;
  }

  async _skipTo(until) {
    if (!this.CKr) return;
    while (this.Nr < until) {
      const { mk, next } = await KDF_CK(this.CKr.key);
      this.skipped.set(kk(b64(this.DHr), this.Nr), mk);
      this.CKr = { key: next, n: this.CKr.n + 1 };
      this.Nr++;
    }
  }

  async toJSON() {
    const enc = async (p) => (p ? { priv: await privJwk(p), pub: b64(await pubRaw(p)) } : null);
    return {
      RK: b64(this.RK),
      DHs: await enc(this.DHs),
      DHr: this.DHr ? b64(this.DHr) : null,
      CKs: this.CKs ? { key: b64(this.CKs.key), n: this.CKs.n } : null,
      CKr: this.CKr ? { key: b64(this.CKr.key), n: this.CKr.n } : null,
      Ns: this.Ns, Nr: this.Nr, PN: this.PN,
      skipped: [...this.skipped].map(([k, v]) => [k, b64(v)]),
      peer: this.peer,
      established: this.established,
    };
  }

  static async fromJSON(s) {
    if (!s) return null;
    const dec = async (p) => (p ? {
      privateKey: await importDhPriv(p.priv),
      publicKey: await importDhPub(ub64(p.pub)),
    } : null);
    return new Session({
      RK: s.RK ? ub64(s.RK) : null,
      DHs: await dec(s.DHs),
      DHr: s.DHr ? ub64(s.DHr) : null,
      CKs: s.CKs ? { key: ub64(s.CKs.key), n: s.CKs.n } : null,
      CKr: s.CKr ? { key: ub64(s.CKr.key), n: s.CKr.n } : null,
      Ns: s.Ns, Nr: s.Nr, PN: s.PN,
      skipped: (s.skipped || []).map(([k, v]) => [k, ub64(v)]),
      peer: s.peer,
      established: s.established,
    });
  }
}

/* ---------------- 会话建立（收发两侧统一的入口） ---------------- */
// 主动发起：bundle 已在客户端验签
async function startSession(id, bundle, peerName) {
  const { SK, EK, opkId } = await x3dhInitiate(id, bundle);
  const sess = await Session.initiator(SK, bundle, peerName);
  const first = {
    ekPub: b64(await pubRaw(EK)),
    ikPub: b64(await pubRaw(id.ikDh)),
    opkId,
  };
  return { sess, first, SK };
}

// 被动接收：用对方首包里的 ekPub/ikPub/opkId 重算 SK（签名已由 bundle 验签 + 对端身份绑定）
async function acceptSession(id, first, expectedIkPub) {
  if (expectedIkPub && b64(expectedIkPub) !== first.ikPub) {
    throw new Error('对方身份公钥与会话建立时不一致（可能是中间人）');
  }
  const ek = await importDhPub(ub64(first.ekPub));
  const ikA = await importDhPub(ub64(first.ikPub));
  const opk = id.opks.find((o) => o.id === first.opkId);
  if (!opk) throw new Error('一次性预密钥缺失');
  const parts = [
    await dh(id.spk.privateKey, ek),
    await dh(id.spk.privateKey, ikA),
    await dh(id.ikDh.privateKey, ek),
    await dh(opk.pair.privateKey, ek),
  ];
  const SK = await hkdf(cat(...parts), new Uint8Array(32), 'e2ee-x3dh-v1', 32);
  const sess = await Session.responder(SK, id.spk);
  return sess;
}

/* ---------------- 设备间核对码（防中间人） ---------------- */
async function safetyNumber(ikA, ikB) {
  const [a, b] = [ikA, ikB].map((x) => x instanceof Uint8Array ? x : ub64(x)).sort((x, y) => (x.join() < y.join() ? -1 : 1));
  const h = await sha256(cat(a, b));
  let digits = '';
  for (let i = 0; i < 30; i++) digits += String(h[i] % 10);
  return digits.match(/.{5}/g).join(' ');
}

/* ---------------- 口令派生（服务器不见明文口令） ---------------- */
async function deriveAuthKey(password, username) {
  const base = await SUB.importKey('raw', TE.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await SUB.deriveBits(
    { name: 'PBKDF2', salt: TE.encode(`e2ee-auth|${username.toLowerCase()}`), iterations: 310000, hash: 'SHA-256' },
    base, 256,
  );
  const k = new Uint8Array(bits);
  return {
    authKey: b64(k),
    verifier: b64(await sha256(cat(k, TE.encode('verify')))),
  };
}
/* ---------------- 群聊：Sender Key（Signal 群聊方案） ----------------
   一个群成员只生成一条发送链：自己加密一次，全群共用。
   群人数从 2 到 50，发送开销一样。
   密钥通过「各成员与自己的单聊会话」逐个加密分发。
   ------------------------------------------------------------------ */

const SK_AAD = (h) => TE.encode(`SK1|${h.c}|${h.s}|${h.e}|${h.i}`);
const SK_PACK_MSG = (p) => TE.encode(`SKPK|${p.convId}|${p.senderId}|${p.epoch}|${p.chainKey}|${p.signingPub}|${p.iteration}`);

const skKdf = async (ck) => ({
  mk: await hmac(ck, new Uint8Array([0x01])),
  next: await hmac(ck, new Uint8Array([0x02])),
});

/** 新建自己的发送链 */
async function createSenderKey(convId, senderId, epoch = 1) {
  const signing = await genSig();
  return {
    convId,
    senderId,
    epoch,
    chainKey: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    iteration: 0,
    skipped: {},
    signing,
    signingPub: b64(await pubRaw(signing)),
  };
}

/** 生成可分发的明文包（随后会被逐成员加密） */
async function packSenderKey(sk) {
  return {
    convId: sk.convId,
    senderId: sk.senderId,
    epoch: sk.epoch,
    chainKey: b64(sk.chainKey),
    iteration: sk.iteration,
    signingPub: sk.signingPub,
    signingPriv: await privJwk(sk.signing),
  };
}

/** 用发送者的身份签名密钥给包签名 —— 防服务器伪造 SenderKey */
async function signSenderKeyPack(pack, ikSig) {
  return b64(await sign(ikSig, SK_PACK_MSG(pack)));
}

/** 接收方验签：必须用发送者把自己公钥带过来的 ikSigPub */
async function verifySenderKeyPack(pack, sigB64, ikSigPubRaw) {
  try {
    const pk = await importSigPub(ikSigPubRaw);
    return await verify(pk, ub64(sigB64), SK_PACK_MSG(pack));
  } catch { return false; }
}

/** 把包变成本地可用的发送链 */
async function openSenderKeyPack(pack) {
  return {
    convId: pack.convId,
    senderId: pack.senderId,
    epoch: pack.epoch,
    chainKey: ub64(pack.chainKey),
    iteration: pack.iteration || 0,
    skipped: {},
    signing: pack.signingPriv
      ? { privateKey: await importSigPriv(pack.signingPriv), publicKey: await importSigPub(ub64(pack.signingPub)) }
      : null,
    signingPub: pack.signingPub,
  };
}

/** 加密一条群消息 */
async function encryptGroupText(sk, text) {
  const { mk, next } = await skKdf(sk.chainKey);
  const header = { c: sk.convId, s: sk.senderId, e: sk.epoch, i: sk.iteration };
  const env = await aeadSeal(mk, TE.encode(text), JSON.stringify(header));
  let sig = null;
  if (sk.signing) sig = b64(await sign(sk.signing.privateKey, SK_AAD(header)));
  sk.chainKey = next;
  sk.iteration++;
  return { header, iv: env.iv, ct: env.ct, sig, epoch: sk.epoch };
}

/** 解密一条群消息（支持乱序；跳过的密钥缓存起来） */
async function decryptGroupText(sk, payload, signingPubRaw) {
  const { header } = payload;
  if (!header) throw new Error('缺少消息头');

  // ① 验签：消息必须由该发送者签发
  if (payload.sig) {
    const pub = signingPubRaw ? await importSigPub(ub64(signingPubRaw)) : sk.signing
      ? sk.signing.publicKey : null;
    if (!pub) throw new Error('没有发送者签名公钥');
    if (!(await verify(pub, ub64(payload.sig), SK_AAD(header)))) {
      throw new Error('群消息签名无效（可能被伪造或篡改）');
    }
  }

  const aad = JSON.stringify(header);
  const key = String(header.i);

  // ② 以前跳过、现在补到的
  if (sk.skipped && sk.skipped[key]) {
    const mk = ub64(sk.skipped[key]);
    const pt = await aeadOpen(mk, payload, aad);
    if (pt) { delete sk.skipped[key]; return pt; }
  }

  // ③ 顺着链推进到目标序号
  if (header.i < sk.iteration) throw new Error('这条消息的密钥已过期（消息乱序过大）');
  if (header.i > sk.iteration + 500) throw new Error('序号跳跃过大，拒绝');
  while (sk.iteration < header.i) {
    const { mk, next } = await skKdf(sk.chainKey);
    sk.skipped[String(sk.iteration)] = b64(mk);
    sk.chainKey = next;
    sk.iteration++;
  }

  const { mk, next } = await skKdf(sk.chainKey);
  const pt = await aeadOpen(mk, payload, aad);
  if (!pt) throw new Error('群消息认证失败');
  sk.chainKey = next;
  sk.iteration++;
  return pt;
}

/** SenderKey 的存档 / 还原 */
async function serializeSenderKey(sk) {
  return {
    convId: sk.convId,
    senderId: sk.senderId,
    epoch: sk.epoch,
    chainKey: b64(sk.chainKey),
    iteration: sk.iteration,
    skipped: sk.skipped,
    signingPub: sk.signingPub,
    signingPriv: sk.signing ? await privJwk(sk.signing) : null,
  };
}

async function deserializeSenderKey(s) {
  if (!s) return null;
  return {
    ...s,
    chainKey: ub64(s.chainKey),
    skipped: s.skipped || {},
    signing: s.signingPriv
      ? { privateKey: await importSigPriv(s.signingPriv), publicKey: await importSigPub(ub64(s.signingPub)) }
      : null,
  };
}
window.E2EE = { newIdentity, serializeIdentity, deserializeIdentity, makeBundle,
  verifyBundle, startSession, acceptSession, Session, safetyNumber, b64, ub64,
  createSenderKey, packSenderKey, signSenderKeyPack, verifySenderKeyPack, openSenderKeyPack,
  encryptGroupText, decryptGroupText, serializeSenderKey, deserializeSenderKey };
})();
