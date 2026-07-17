import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

type WApiMediaInput = {
  providerInstanceId: string;
  providerToken: string | null;
  mediaKey?: string | null;
  directPath?: string | null;
  type: string;
  mimeType?: string | null;
  providerUrl?: string | null;
  fileName?: string | null;
};

type DownloadedMedia = {
  buffer: Buffer;
  mimeType: string;
};

@Injectable()
export class MediaStorageService {
  private readonly logger = new Logger(MediaStorageService.name);
  private readonly bucket: string;
  private readonly signedUrlTtl: number;
  private readonly downloadTimeoutMs: number;
  private readonly downloadRetryAttempts: number;
  private readonly downloadRetryDelayMs: number;
  private readonly maxBytes: number;
  private readonly signedUrlCache = new Map<
    string,
    { url: string | null; expiresAt: number }
  >();
  private client?: SupabaseClient | null;

  constructor(private readonly config: ConfigService) {
    this.bucket =
      this.config.get<string>('SUPABASE_STORAGE_BUCKET_CHAT_MEDIA')?.trim() ||
      'chat-media';
    this.signedUrlTtl = Math.max(
      60,
      Number(this.config.get('MEDIA_SIGNED_URL_TTL_SECONDS', 3600)) || 3600,
    );
    this.downloadTimeoutMs = Math.max(
      1000,
      Number(this.config.get('MEDIA_DOWNLOAD_TIMEOUT_MS', 30_000)) || 30_000,
    );
    this.downloadRetryAttempts = Math.max(
      1,
      Number(this.config.get('MEDIA_DOWNLOAD_RETRY_ATTEMPTS', 3)) || 3,
    );
    this.downloadRetryDelayMs = Math.max(
      0,
      Number(this.config.get('MEDIA_DOWNLOAD_RETRY_DELAY_MS', 1000)) || 1000,
    );
    this.maxBytes = Math.max(
      1_048_576,
      Number(this.config.get('MEDIA_MAX_FILE_SIZE_BYTES', 52_428_800)) ||
        52_428_800,
    );
  }

  async upload(file: Express.Multer.File, userId: string) {
    if (!file?.buffer?.length)
      throw new BadRequestException('Arquivo ausente ou vazio');
    if (file.size > this.maxBytes)
      throw new BadRequestException('Arquivo excede o limite permitido');

    this.assertMimeType(file.mimetype);
    const extension = this.extension(file.originalname, file.mimetype);
    const path = [
      'outbound',
      userId,
      new Date().toISOString().slice(0, 10),
      `${randomUUID()}.${extension}`,
    ].join('/');

    await this.uploadBuffer(path, file.buffer, file.mimetype, false);

    return this.result(
      path,
      file.mimetype,
      extension,
      file.originalname,
      file.size,
    );
  }

  async storeIncoming(messageId: bigint, input: WApiMediaInput) {
    const media = await this.withDownloadRetries(() =>
      this.downloadIncomingMedia(input),
    );

    if (media.buffer.length > this.maxBytes)
      throw new BadRequestException('Mídia recebida excede o limite permitido');

    this.assertMimeType(media.mimeType);
    const extension = this.extension(
      input.fileName,
      media.mimeType,
      input.type,
    );
    const path = [
      'incoming',
      'messages',
      messageId.toString(),
      `${messageId.toString()}.${extension}`,
    ].join('/');

    await this.uploadBuffer(path, media.buffer, media.mimeType, true);

    return this.result(
      path,
      media.mimeType,
      extension,
      input.fileName ?? null,
      media.buffer.length,
    );
  }

  async signedUrl(bucket?: string | null, path?: string | null) {
    const client = this.getClient();
    if (!bucket || !path || !client) return null;

    const key = this.signedUrlCacheKey(bucket, path);
    const cached = this.signedUrlCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.url;

    const { data, error } = await client.storage
      .from(bucket)
      .createSignedUrl(path, this.signedUrlTtl);

    if (error) {
      this.logger.warn(`Failed to create signed URL: ${error.message}`);
      this.signedUrlCache.set(key, {
        url: null,
        expiresAt: Date.now() + Math.max(30, this.signedUrlTtl - 60) * 1000,
      });
      return null;
    }

    this.signedUrlCache.set(key, {
      url: data.signedUrl,
      expiresAt: Date.now() + Math.max(30, this.signedUrlTtl - 60) * 1000,
    });

    return data.signedUrl;
  }

  private async downloadIncomingMedia(input: WApiMediaInput) {
    if (input.mediaKey && input.directPath && input.providerToken) {
      try {
        return await this.downloadFromWApi(input);
      } catch (error) {
        if (!input.providerUrl) throw error;
        this.logger.warn(
          `W-API media download failed, falling back to provider URL: ${this.getErrorMessage(error)}`,
        );
      }
    }

    if (input.providerUrl) {
      return this.downloadUrl(input.providerUrl, input.mimeType);
    }

    throw new Error('Missing W-API media download credentials or payload');
  }

  private async uploadBuffer(
    path: string,
    buffer: Buffer,
    contentType: string,
    upsert: boolean,
  ) {
    const client = this.getClient();
    if (!client) throw new Error('Supabase Storage is not configured');

    const { error } = await client.storage.from(this.bucket).upload(path, buffer, {
      contentType,
      cacheControl: '3600',
      upsert,
    });

    if (error) throw new Error(`storage_upload_failed: ${error.message}`);
    this.invalidateSignedUrl(this.bucket, path);
  }

  private async downloadFromWApi(input: WApiMediaInput) {
    if (
      !input.providerToken ||
      !input.providerInstanceId ||
      !input.mediaKey ||
      !input.directPath
    ) {
      throw new Error('Missing W-API media download credentials or payload');
    }

    const baseUrl =
      this.config.get<string>('W_API_BASE_URL')?.trim() ||
      'https://api.w-api.app';
    const url = new URL('/v1/message/download-media', baseUrl);
    url.searchParams.set('instanceId', input.providerInstanceId);

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.providerToken}`,
        'Content-Type': 'application/json',
        Accept: '*/*',
      },
      body: JSON.stringify({
        mediaKey: input.mediaKey,
        directPath: input.directPath,
        type: input.type,
        mimetype: input.mimeType,
      }),
    }).catch((error) => {
      throw new Error(
        `W-API media download request failed for ${this.sanitizeUrl(url)}: ${this.getErrorMessage(error)}`,
      );
    });

    if (!response.ok)
      throw new Error(`W-API media download failed with ${response.status}`);

    return this.parseMediaResponse(response, input.mimeType);
  }

  private async parseMediaResponse(
    response: Response,
    fallbackMimeType?: string | null,
  ): Promise<DownloadedMedia> {
    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('application/json')) {
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType:
          contentType.split(';')[0] ||
          fallbackMimeType ||
          'application/octet-stream',
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const mediaValue = this.findMediaPayloadValue(payload);

    if (!mediaValue) {
      throw new Error(
        `W-API media response did not include media content. Response keys: ${this.describePayloadKeys(payload)}`,
      );
    }

    if (this.isHttpUrl(mediaValue)) {
      return this.downloadUrl(mediaValue, fallbackMimeType);
    }

    return this.decodeBase64Media(mediaValue, fallbackMimeType);
  }

  private findMediaPayloadValue(payload: Record<string, unknown>): string | null {
    const mediaKeys = new Set([
      'base64',
      'media',
      'file',
      'data',
      'url',
      'URL',
      'downloadUrl',
      'downloadURL',
      'download_url',
      'mediaUrl',
      'mediaURL',
      'media_url',
      'fileUrl',
      'fileURL',
      'file_url',
      'fileLink',
      'fileLINK',
      'file_link',
      'mediaLink',
      'mediaLINK',
      'media_link',
      'link',
      'href',
      'buffer',
      'content',
      'body',
      'result',
    ]);

    const candidates = Object.entries(payload)
      .filter(([key]) => mediaKeys.has(key))
      .map(([, value]) => value);

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    for (const value of Object.values(payload)) {
      if (!value || typeof value !== 'object') continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const found: string | null = this.findMediaPayloadValue(
            item as Record<string, unknown>,
          );
          if (found) return found;
        }
      } else {
        const found: string | null = this.findMediaPayloadValue(
          value as Record<string, unknown>,
        );
        if (found) return found;
      }
    }

    return null;
  }

  private describePayloadKeys(payload: Record<string, unknown>) {
    const keys = new Set<string>();
    this.collectPayloadKeys(payload, keys);
    return Array.from(keys).slice(0, 40).join(', ') || 'none';
  }

  private collectPayloadKeys(value: unknown, keys: Set<string>, prefix = '') {
    if (!value || typeof value !== 'object' || keys.size >= 40) return;
    if (Array.isArray(value)) {
      value.slice(0, 3).forEach((item, index) =>
        this.collectPayloadKeys(item, keys, `${prefix}[${index}]`),
      );
      return;
    }

    for (const [key, childValue] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      keys.add(path);
      if (keys.size >= 40) return;
      this.collectPayloadKeys(childValue, keys, path);
    }
  }

  private async downloadUrl(url: string, fallbackMimeType?: string | null) {
    const response = await this.fetchWithTimeout(url).catch((error) => {
      throw new Error(
        `Media URL download request failed for ${this.sanitizeUrl(url)}: ${this.getErrorMessage(error)}`,
      );
    });

    if (!response.ok)
      throw new Error(`Media URL download failed with ${response.status}`);

    const contentType = response.headers.get('content-type')?.split(';')[0];

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType:
        contentType === 'application/octet-stream'
          ? fallbackMimeType || contentType
          : contentType || fallbackMimeType || 'application/octet-stream',
    };
  }

  private decodeBase64Media(
    value: string,
    fallbackMimeType?: string | null,
  ): DownloadedMedia {
    const dataUrlMatch = value.match(/^data:([^;]+);base64,(.+)$/);

    if (dataUrlMatch) {
      return {
        buffer: Buffer.from(dataUrlMatch[2], 'base64'),
        mimeType: dataUrlMatch[1],
      };
    }

    return {
      buffer: Buffer.from(value, 'base64'),
      mimeType: fallbackMimeType || 'application/octet-stream',
    };
  }

  private getClient() {
    if (this.client !== undefined) return this.client;

    const url =
      this.config.get<string>('SUPABASE_URL')?.trim() ||
      this.inferSupabaseUrl();
    const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY')?.trim();

    if (!url || !key) {
      this.logger.warn('Supabase Storage is not configured');
      this.client = null;
      return null;
    }

    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return this.client;
  }

  private inferSupabaseUrl() {
    try {
      const host = new URL(this.config.getOrThrow<string>('DIRECT_URL')).hostname;
      const match = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
      return match ? `https://${match[1]}.supabase.co` : undefined;
    } catch {
      return undefined;
    }
  }

  private result(
    path: string,
    mimeType: string,
    extension: string,
    originalName: string | null,
    size: number,
  ) {
    return this.signedUrl(this.bucket, path).then((url) => ({
      bucket: this.bucket,
      path,
      url,
      mimeType,
      extension,
      originalName,
      size,
    }));
  }

  private assertMimeType(mimeType: string) {
    const allowed = [
      'image/',
      'video/',
      'audio/',
      'text/plain',
      'text/csv',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument',
      'application/vnd.ms-excel',
      'application/zip',
    ];
    if (!allowed.some((item) => mimeType.startsWith(item)))
      throw new BadRequestException(`Tipo de arquivo não permitido: ${mimeType}`);
  }

  private extension(
    fileName?: string | null,
    mimeType?: string | null,
    fallbackType?: string,
  ) {
    const fromName = fileName?.split('.').pop()?.toLowerCase();
    if (fromName && fromName !== fileName?.toLowerCase()) return fromName;

    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/webm': 'webm',
      'application/pdf': 'pdf',
      'text/plain': 'txt',
      'text/csv': 'csv',
    };

    return (
      (mimeType && map[mimeType]) ||
      ({
        image: 'jpg',
        video: 'mp4',
        audio: 'ogg',
        sticker: 'webp',
        document: 'bin',
      }[fallbackType ?? ''] ??
        'bin')
    );
  }

  private async withDownloadRetries<T>(operation: () => Promise<T>) {
    const attempts = Math.max(1, this.downloadRetryAttempts);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < attempts && this.isRetryableDownloadError(error)) {
          await this.sleep(this.downloadRetryDelayMs * attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  private isRetryableDownloadError(error: unknown) {
    const message = this.getErrorMessage(error).toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('aborted') ||
      message.includes('fetch failed') ||
      message.includes('network') ||
      message.includes('econn') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504')
    );
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchWithTimeout(input: string | URL, init: RequestInit = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.downloadTimeoutMs);

    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private isHttpUrl(value: string) {
    return value.startsWith('http://') || value.startsWith('https://');
  }

  private getErrorMessage(error: unknown) {
    if (error instanceof Error) {
      const cause = this.getErrorCauseMessage(error);
      return cause ? `${error.message} (${cause})` : error.message;
    }
    return String(error);
  }

  private getErrorCauseMessage(error: Error) {
    const cause = error.cause;
    if (!cause) return null;
    return cause instanceof Error ? cause.message : String(cause);
  }

  private sanitizeUrl(url: string | URL) {
    const parsed = new URL(url.toString());
    if (parsed.searchParams.has('instanceId')) {
      parsed.searchParams.set('instanceId', '***');
    }
    return parsed.toString();
  }

  private signedUrlCacheKey(bucket: string, path: string) {
    return `signed-url:${bucket}:${path}`;
  }

  private invalidateSignedUrl(bucket?: string | null, path?: string | null) {
    if (!bucket || !path) return;
    this.signedUrlCache.delete(this.signedUrlCacheKey(bucket, path));
  }
}
