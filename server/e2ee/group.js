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
export async function createSenderKey(convId, senderId, epoch = 1) {
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
export async function packSenderKey(sk) {
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
export async function signSenderKeyPack(pack, ikSig) {
  return b64(await sign(ikSig, SK_PACK_MSG(pack)));
}

/** 接收方验签：必须用发送者把自己公钥带过来的 ikSigPub */
export async function verifySenderKeyPack(pack, sigB64, ikSigPubRaw) {
  try {
    const pk = await importSigPub(ikSigPubRaw);
    return await verify(pk, ub64(sigB64), SK_PACK_MSG(pack));
  } catch { return false; }
}

/** 把包变成本地可用的发送链 */
export async function openSenderKeyPack(pack) {
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
export async function encryptGroupText(sk, text) {
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
export async function decryptGroupText(sk, payload, signingPubRaw) {
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
export async function serializeSenderKey(sk) {
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

export async function deserializeSenderKey(s) {
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