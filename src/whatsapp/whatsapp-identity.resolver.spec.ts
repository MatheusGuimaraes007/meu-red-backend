import {
  extractSenderLid,
  isTrustedPhoneCandidate,
  normalizeLid,
  primaryIdentifier,
  resolvePayloadIdentity,
} from './whatsapp-identity.resolver';

// Fixtures reais extraidas de RELATORIO_TECNICO_WEBHOOKS_IDENTIDADE_CRM_RED.
const KAROLLAINE_PHONE = '5515991059882';
const KAROLLAINE_LID = '224734214103271@lid';
const THELL_PHONE = '5511965105122';
const THELL_LID = '96890234347665@lid';
const RED_ACCOUNT_ID = '110346517934287';
const RED_ACCOUNT_LID = '110346517934287@lid';
const GROUP_ID_1 = '120363395697918524@g.us';

describe('whatsapp-identity.resolver', () => {
  describe('extractSenderLid', () => {
    it('prioriza sender.senderLid (campo real dos payloads)', () => {
      expect(
        extractSenderLid({ senderLid: THELL_LID, lid: 'outro@lid' }),
      ).toBe(THELL_LID);
    });

    it('usa sender.lid apenas como fallback legado', () => {
      expect(extractSenderLid({ lid: THELL_LID })).toBe(THELL_LID);
    });

    it('retorna null quando nao ha nenhum campo de lid', () => {
      expect(extractSenderLid({ id: THELL_PHONE })).toBeNull();
    });
  });

  describe('isTrustedPhoneCandidate', () => {
    it('aceita telefone real plausivel', () => {
      expect(isTrustedPhoneCandidate(THELL_PHONE, THELL_LID)).toBe(true);
    });

    it('rejeita quando o candidato e a parte numerica do LID conhecido', () => {
      // Caso real: evento B do messageId duplicado trouxe sender.id = digitos do LID.
      const numericLid = THELL_LID.replace('@lid', '');
      expect(isTrustedPhoneCandidate(numericLid, THELL_LID)).toBe(false);
    });

    it('rejeita valores terminados em @lid ou @g.us', () => {
      expect(isTrustedPhoneCandidate(THELL_LID, THELL_LID)).toBe(false);
      expect(isTrustedPhoneCandidate(GROUP_ID_1, null)).toBe(false);
    });

    it('rejeita numeros com tamanho implausivel', () => {
      expect(isTrustedPhoneCandidate('123', null)).toBe(false);
      expect(isTrustedPhoneCandidate('1'.repeat(20), null)).toBe(false);
    });
  });

  describe('resolvePayloadIdentity - privado recebido (fromMe=false)', () => {
    it('resolve Karollaine com telefone confiavel e LID', () => {
      const identity = resolvePayloadIdentity({
        fromMe: false,
        chat: { id: KAROLLAINE_LID },
        sender: { id: KAROLLAINE_PHONE, senderLid: KAROLLAINE_LID, pushName: 'Karollaine' },
      });
      expect(identity).toEqual({
        type: 'private',
        chatId: KAROLLAINE_LID,
        fromMe: false,
        lid: KAROLLAINE_LID,
        phone: KAROLLAINE_PHONE,
        phoneTrusted: true,
      });
    });

    it('resolve ThellTorres com telefone confiavel e LID', () => {
      const identity = resolvePayloadIdentity({
        fromMe: false,
        chat: { id: THELL_LID },
        sender: { id: THELL_PHONE, senderLid: THELL_LID, pushName: 'Terapeuta ThellTorres' },
      });
      expect(identity).toEqual({
        type: 'private',
        chatId: THELL_LID,
        fromMe: false,
        lid: THELL_LID,
        phone: THELL_PHONE,
        phoneTrusted: true,
      });
    });

    it('NAO aceita o LID numerico duplicado como telefone (evento B do caso real)', () => {
      const numericLid = THELL_LID.replace('@lid', '');
      const identity = resolvePayloadIdentity({
        fromMe: false,
        chat: { id: THELL_LID },
        sender: { id: numericLid, senderLid: THELL_LID },
      });
      expect(identity.type).toBe('private');
      if (identity.type !== 'private') throw new Error('expected private');
      expect(identity.phone).toBeNull();
      expect(identity.phoneTrusted).toBe(false);
      expect(identity.lid).toBe(THELL_LID);
    });
  });

  describe('resolvePayloadIdentity - privado enviado (fromMe=true)', () => {
    it('ignora sender (conta RED) e usa chat.id como identidade do cliente', () => {
      // Payload real: resposta da RED para ThellTorres.
      const identity = resolvePayloadIdentity({
        fromMe: true,
        chat: { id: THELL_LID },
        sender: { id: RED_ACCOUNT_ID, senderLid: RED_ACCOUNT_LID },
      });
      expect(identity).toEqual({
        type: 'private',
        chatId: THELL_LID,
        fromMe: true,
        lid: THELL_LID,
        phone: null,
        phoneTrusted: false,
      });
    });

    it('o mesmo sender.id da RED em conversas diferentes nao produz a mesma identidade de cliente', () => {
      const forThell = resolvePayloadIdentity({
        fromMe: true,
        chat: { id: THELL_LID },
        sender: { id: RED_ACCOUNT_ID, senderLid: RED_ACCOUNT_LID },
      });
      const forKarollaine = resolvePayloadIdentity({
        fromMe: true,
        chat: { id: KAROLLAINE_LID },
        sender: { id: RED_ACCOUNT_ID, senderLid: RED_ACCOUNT_LID },
      });
      expect(forThell.chatId).not.toBe(forKarollaine.chatId);
      if (forThell.type !== 'private' || forKarollaine.type !== 'private')
        throw new Error('expected private');
      expect(forThell.lid).toBe(THELL_LID);
      expect(forKarollaine.lid).toBe(KAROLLAINE_LID);
    });
  });

  describe('resolvePayloadIdentity - grupo', () => {
    it('identidade do grupo e chat.id; sender fica separado como participante', () => {
      const identity = resolvePayloadIdentity({
        isGroup: true,
        fromMe: false,
        chat: { id: GROUP_ID_1 },
        sender: { id: KAROLLAINE_PHONE, senderLid: KAROLLAINE_LID },
      });
      expect(identity).toEqual({
        type: 'group',
        chatId: GROUP_ID_1,
        groupId: GROUP_ID_1,
        senderPhone: KAROLLAINE_PHONE,
        senderLid: KAROLLAINE_LID,
      });
    });
  });

  describe('primaryIdentifier', () => {
    it('usa telefone confiavel quando disponivel', () => {
      const identity = resolvePayloadIdentity({
        fromMe: false,
        chat: { id: KAROLLAINE_LID },
        sender: { id: KAROLLAINE_PHONE, senderLid: KAROLLAINE_LID },
      });
      expect(primaryIdentifier(identity)).toBe(KAROLLAINE_PHONE);
    });

    it('usa o LID quando nao ha telefone confiavel', () => {
      const identity = resolvePayloadIdentity({
        fromMe: true,
        chat: { id: THELL_LID },
        sender: { id: RED_ACCOUNT_ID, senderLid: RED_ACCOUNT_LID },
      });
      expect(primaryIdentifier(identity)).toBe(THELL_LID);
    });

    it('usa o chatId (@g.us) para grupos', () => {
      const identity = resolvePayloadIdentity({
        isGroup: true,
        chat: { id: GROUP_ID_1 },
        sender: {},
      });
      expect(primaryIdentifier(identity)).toBe(GROUP_ID_1);
    });
  });

  describe('normalizeLid', () => {
    it('aceita valor ja formatado', () => {
      expect(normalizeLid(THELL_LID)).toBe(THELL_LID);
    });
    it('adiciona sufixo @lid a valores puramente numericos', () => {
      expect(normalizeLid('96890234347665')).toBe(THELL_LID);
    });
    it('retorna null para valores vazios', () => {
      expect(normalizeLid(undefined)).toBeNull();
      expect(normalizeLid(null)).toBeNull();
      expect(normalizeLid('')).toBeNull();
    });
  });
});
