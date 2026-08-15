/**
 * Resolução de identidade de contatos a partir de payloads da W-API.
 *
 * Regra central (ver RELATORIO_TECNICO_WEBHOOKS_IDENTIDADE_CRM_RED):
 * instancia + identidade canonica da conversa -> um unico contact.id.
 *
 * Nunca usar last_sender_id (metadado operacional) para localizar contato.
 */

type ProviderPayload = Record<string, unknown>;

export type ResolvedPrivateIdentity = {
  type: 'private';
  chatId: string;
  fromMe: boolean;
  lid: string | null;
  phone: string | null;
  phoneTrusted: boolean;
};

export type ResolvedGroupIdentity = {
  type: 'group';
  chatId: string;
  groupId: string;
  senderPhone: string | null;
  senderLid: string | null;
};

export type ResolvedIdentity = ResolvedPrivateIdentity | ResolvedGroupIdentity;

function record(value: unknown): ProviderPayload {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ProviderPayload)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function onlyDigits(value?: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits || null;
}

/** Normaliza um LID para o formato `<digitos>@lid`. */
export function normalizeLid(value?: string | null): string | null {
  const trimmed = str(value);
  if (!trimmed) return null;
  if (trimmed.endsWith('@lid')) return trimmed;
  const digits = onlyDigits(trimmed);
  return digits ? `${digits}@lid` : null;
}

/** Normaliza um telefone para apenas digitos. */
export function normalizePhone(value?: string | null): string | null {
  const digits = onlyDigits(value ?? undefined);
  return digits;
}

function lidDigits(lid?: string | null): string | null {
  if (!lid) return null;
  return onlyDigits(lid.split('@')[0]);
}

/**
 * Le sender.senderLid (campo real observado nos payloads), com sender.lid
 * apenas como fallback legado.
 */
export function extractSenderLid(sender: ProviderPayload): string | null {
  const senderLid = str(sender.senderLid);
  if (senderLid) return normalizeLid(senderLid);
  const legacyLid = str(sender.lid);
  if (legacyLid) return normalizeLid(legacyLid);
  return null;
}

/**
 * Um candidato a telefone so e confiavel se tiver tamanho plausivel, nao for
 * um JID de grupo/lid, e nao coincidir com os digitos do LID conhecido
 * (caso do LID numerico duplicado como sender.id).
 */
export function isTrustedPhoneCandidate(
  candidate: string | null,
  lid: string | null,
): boolean {
  if (!candidate) return false;
  if (candidate.endsWith('@lid') || candidate.endsWith('@g.us')) return false;
  const digits = onlyDigits(candidate);
  if (!digits || digits.length < 10 || digits.length > 15) return false;
  const knownLidDigits = lidDigits(lid);
  if (knownLidDigits && digits === knownLidDigits) return false;
  return true;
}

/**
 * Resolve a identidade canonica de um payload de mensagem (webhookReceived/
 * webhookDelivery) da W-API. Nao consulta o banco - apenas interpreta o
 * payload.
 */
export function resolvePayloadIdentity(
  payload: ProviderPayload,
): ResolvedIdentity {
  const chat = record(payload.chat);
  const sender = record(payload.sender);
  const chatId = str(chat.id) ?? '';
  const isGroup = payload.isGroup === true && chatId.endsWith('@g.us');
  const fromMe = payload.fromMe === true;

  if (isGroup) {
    const senderLid = extractSenderLid(sender);
    const senderPhoneCandidate = str(sender.id);
    return {
      type: 'group',
      chatId,
      groupId: chatId,
      senderPhone: isTrustedPhoneCandidate(senderPhoneCandidate, senderLid)
        ? senderPhoneCandidate
        : null,
      senderLid,
    };
  }

  if (fromMe) {
    // Identidade do cliente vem exclusivamente de chat.id. O objeto sender
    // representa a propria conta RED e nunca deve ser usado para localizar
    // o cliente.
    return {
      type: 'private',
      chatId,
      fromMe: true,
      lid: chatId.endsWith('@lid') ? chatId : null,
      phone: null,
      phoneTrusted: false,
    };
  }

  const lid = extractSenderLid(sender) ?? (chatId.endsWith('@lid') ? chatId : null);
  const phoneCandidate = str(sender.id);
  const trusted = isTrustedPhoneCandidate(phoneCandidate, lid);
  return {
    type: 'private',
    chatId,
    fromMe: false,
    lid,
    phone: trusted ? phoneCandidate : null,
    phoneTrusted: trusted,
  };
}

/** Identificador primario a usar como contacts.phone_number. */
export function primaryIdentifier(identity: ResolvedIdentity): string {
  if (identity.type === 'group') return identity.groupId;
  return identity.phone ?? identity.lid ?? identity.chatId;
}
