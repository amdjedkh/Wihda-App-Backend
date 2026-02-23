export interface UploadTokenPayload {
  userId: string;
  fileKey: string;
  contentType: string;
  exp: number;
}

export async function createUploadToken(
  secret: string,
  userId: string,
  fileKey: string,
  contentType: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const payload: UploadTokenPayload = {
    userId,
    fileKey,
    contentType,
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
  };

  const payloadB64 = btoa(JSON.stringify(payload));

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadB64),
  );
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

  return `${payloadB64}.${signatureB64}`;
}

export async function verifyUploadToken(
  secret: string,
  token: string,
): Promise<UploadTokenPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, signatureB64] = parts;
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signature = Uint8Array.from(atob(signatureB64), (ch) =>
      ch.charCodeAt(0),
    );
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(payloadB64),
    );
    if (!isValid) return null;

    const payload = JSON.parse(atob(payloadB64)) as UploadTokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}
