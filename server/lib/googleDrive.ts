import crypto from 'crypto';
import path from 'path';
import { getGlobalConfig } from '../routerTrpc/config';
import { cache } from '@shared/lib/cache';

const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const GOOGLE_DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const DEFAULT_ROOT_FOLDER_NAME = 'Blinko';

export const GOOGLE_DRIVE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export interface GoogleDriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId?: string;
  customPath?: string;
}

export interface GoogleDriveUploadResult {
  fileId: string;
  name: string;
}

export interface GoogleDriveTestResult {
  email?: string;
  displayName?: string;
  storageLimit?: string;
  storageUsage?: string;
  folderName?: string;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function credentialCacheHash(config: GoogleDriveConfig): string {
  return crypto
    .createHash('sha256')
    .update(`${config.clientId}:${config.clientSecret}:${config.refreshToken}`)
    .digest('hex')
    .slice(0, 16);
}

export class GoogleDriveService {
  /**
   * Load and validate Google Drive OAuth 2.0 configuration from global config.
   */
  public static async getConfig(): Promise<GoogleDriveConfig> {
    const config = await getGlobalConfig({ useAdmin: true });
    const clientId = String(config.googleDriveClientId || '').trim();
    const clientSecret = String(config.googleDriveClientSecret || '').trim();
    const refreshToken = String(config.googleDriveRefreshToken || '').trim();
    const folderId = String(config.googleDriveFolderId || '').trim() || undefined;
    const customPath = String(config.googleDriveCustomPath || '').trim() || undefined;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Google Drive OAuth 2.0 configuration is incomplete (clientId, clientSecret, refreshToken are required)');
    }

    return {
      clientId,
      clientSecret,
      refreshToken,
      folderId,
      customPath,
    };
  }

  /**
   * Build the Google OAuth 2.0 authorization URL.
   * Uses access_type=offline and prompt=consent to guarantee a refresh_token is returned.
   */
  public static buildAuthUrl({
    clientId,
    redirectUri,
    state,
  }: {
    clientId: string;
    redirectUri: string;
    state: string;
  }): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_DRIVE_OAUTH_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchange an OAuth 2.0 authorization code for access and refresh tokens.
   */
  public static async exchangeCodeForTokens({
    clientId,
    clientSecret,
    code,
    redirectUri,
  }: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      const msg = data.error_description || data.error || response.statusText;
      throw new Error(`Google OAuth token exchange failed: ${msg}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: Number(data.expires_in) || 3600,
    };
  }

  /**
   * Obtain a cached OAuth 2.0 access token, refreshing automatically when expired.
   */
  public static async getAccessToken(explicitConfig?: GoogleDriveConfig): Promise<string> {
    const config = explicitConfig ?? await this.getConfig();
    const cacheKey = `gdrive:token:${credentialCacheHash(config)}`;

    return cache.wrap(
      cacheKey,
      async () => {
        const body = new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: config.refreshToken,
          grant_type: 'refresh_token',
        });

        const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });

        const data = await response.json().catch(() => ({})) as any;
        if (!response.ok || !data.access_token) {
          const msg = data.error_description || data.error || response.statusText;
          throw new Error(`Failed to refresh Google Drive access token: ${msg}`);
        }

        return data.access_token as string;
      },
      // Google access tokens are typically valid for 3600s; cache for 50 minutes.
      { ttl: 50 * 60 * 1000 }
    );
  }

  /**
   * Perform an authenticated request against the Google Drive API.
   */
  private static async authorizedFetch(
    url: string,
    init: RequestInit = {},
    explicitConfig?: GoogleDriveConfig
  ): Promise<Response> {
    const accessToken = await this.getAccessToken(explicitConfig);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(url, { ...init, headers });
  }

  /**
   * Resolve or create the root folder in Google Drive.
   * If googleDriveFolderId is configured, uses it directly; otherwise finds/creates "Blinko" in My Drive root.
   */
  public static async getRootFolderId(explicitConfig?: GoogleDriveConfig): Promise<string> {
    const config = explicitConfig ?? await this.getConfig();
    if (config.folderId) {
      return config.folderId;
    }

    const cacheKey = `gdrive:root-folder:${credentialCacheHash(config)}`;
    return cache.wrap(
      cacheKey,
      async () => {
        const existing = await this.findFolder(DEFAULT_ROOT_FOLDER_NAME, 'root', config);
        if (existing) {
          return existing;
        }
        return this.createFolder(DEFAULT_ROOT_FOLDER_NAME, 'root', config);
      },
      { ttl: 30 * 60 * 1000 }
    );
  }

  /**
   * Find a folder by exact name inside a parent folder.
   */
  private static async findFolder(
    name: string,
    parentId: string,
    explicitConfig?: GoogleDriveConfig
  ): Promise<string | null> {
    const q = [
      `name = '${escapeDriveQueryValue(name)}'`,
      `'${escapeDriveQueryValue(parentId)}' in parents`,
      `mimeType = '${GOOGLE_DRIVE_FOLDER_MIME}'`,
      'trashed = false',
    ].join(' and ');

    const params = new URLSearchParams({
      q,
      fields: 'files(id,name)',
      pageSize: '1',
      spaces: 'drive',
    });

    const response = await this.authorizedFetch(
      `${GOOGLE_DRIVE_API_BASE}/files?${params.toString()}`,
      { method: 'GET' },
      explicitConfig
    );

    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      throw new Error(`Google Drive folder lookup failed: ${data.error?.message || response.statusText}`);
    }

    return data.files?.[0]?.id || null;
  }

  /**
   * Create a folder inside a parent folder.
   */
  private static async createFolder(
    name: string,
    parentId: string,
    explicitConfig?: GoogleDriveConfig
  ): Promise<string> {
    const response = await this.authorizedFetch(
      `${GOOGLE_DRIVE_API_BASE}/files?fields=id,name`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          mimeType: GOOGLE_DRIVE_FOLDER_MIME,
          parents: [parentId],
        }),
      },
      explicitConfig
    );

    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok || !data.id) {
      throw new Error(`Google Drive folder creation failed: ${data.error?.message || response.statusText}`);
    }

    return data.id as string;
  }

  /**
   * Ensure all folder segments exist under the Blinko root folder, returning the deepest folder ID.
   */
  public static async ensureFolderPath(
    folderSegments: string[],
    explicitConfig?: GoogleDriveConfig
  ): Promise<string> {
    let currentParentId = await this.getRootFolderId(explicitConfig);
    for (const segment of folderSegments) {
      if (!segment || segment === '.') continue;
      const existing = await this.findFolder(segment, currentParentId, explicitConfig);
      currentParentId = existing ?? await this.createFolder(segment, currentParentId, explicitConfig);
    }
    return currentParentId;
  }

  /**
   * Resolve a file ID by walking its relative path under the Blinko root folder.
   */
  public static async resolveFileIdByPath(
    relativePath: string,
    explicitConfig?: GoogleDriveConfig
  ): Promise<string | null> {
    const normalized = relativePath.replace(/^\/+/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    const fileName = parts[parts.length - 1]!;
    const folderSegments = parts.slice(0, -1);

    let currentParentId = await this.getRootFolderId(explicitConfig);
    for (const segment of folderSegments) {
      const folderId = await this.findFolder(segment, currentParentId, explicitConfig);
      if (!folderId) return null;
      currentParentId = folderId;
    }

    const q = [
      `name = '${escapeDriveQueryValue(fileName)}'`,
      `'${escapeDriveQueryValue(currentParentId)}' in parents`,
      `mimeType != '${GOOGLE_DRIVE_FOLDER_MIME}'`,
      'trashed = false',
    ].join(' and ');

    const params = new URLSearchParams({
      q,
      fields: 'files(id,name)',
      pageSize: '1',
      spaces: 'drive',
    });

    const response = await this.authorizedFetch(
      `${GOOGLE_DRIVE_API_BASE}/files?${params.toString()}`,
      { method: 'GET' },
      explicitConfig
    );

    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      throw new Error(`Google Drive file lookup failed: ${data.error?.message || response.statusText}`);
    }

    return data.files?.[0]?.id || null;
  }

  /**
   * Upload a Buffer to Google Drive using multipart/related upload.
   */
  public static async uploadBuffer({
    relativePath,
    buffer,
    mimeType = 'application/octet-stream',
  }: {
    relativePath: string;
    buffer: Buffer;
    mimeType?: string;
  }): Promise<GoogleDriveUploadResult> {
    const config = await this.getConfig();
    const normalized = relativePath.replace(/^\/+/, '');
    const parts = normalized.split('/').filter(Boolean);
    const fileName = parts.pop() || path.basename(normalized);
    const parentId = await this.ensureFolderPath(parts, config);

    const boundary = `blinko_gdrive_${crypto.randomBytes(12).toString('hex')}`;
    const metadataJson = JSON.stringify({
      name: fileName,
      parents: [parentId],
    });

    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadataJson}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
      'utf-8'
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--`, 'utf-8');
    const multipartBody = Buffer.concat([preamble, buffer, epilogue]);

    const response = await this.authorizedFetch(
      `${GOOGLE_DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(multipartBody.length),
        },
        body: multipartBody,
      },
      config
    );

    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok || !data.id) {
      throw new Error(`Google Drive upload failed: ${data.error?.message || response.statusText}`);
    }

    return {
      fileId: data.id as string,
      name: (data.name as string) || fileName,
    };
  }

  /**
   * Upload a ReadableStream to Google Drive using resumable upload.
   */
  public static async uploadStream({
    relativePath,
    stream,
    fileSize,
    mimeType = 'application/octet-stream',
  }: {
    relativePath: string;
    stream: ReadableStream;
    fileSize?: number;
    mimeType?: string;
  }): Promise<GoogleDriveUploadResult> {
    const config = await this.getConfig();
    const normalized = relativePath.replace(/^\/+/, '');
    const parts = normalized.split('/').filter(Boolean);
    const fileName = parts.pop() || path.basename(normalized);
    const parentId = await this.ensureFolderPath(parts, config);

    const initHeaders: Record<string, string> = {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
    };
    if (fileSize && fileSize > 0) {
      initHeaders['X-Upload-Content-Length'] = String(fileSize);
    }

    const initResponse = await this.authorizedFetch(
      `${GOOGLE_DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id,name`,
      {
        method: 'POST',
        headers: initHeaders,
        body: JSON.stringify({
          name: fileName,
          parents: [parentId],
        }),
      },
      config
    );

    if (!initResponse.ok) {
      const errData = await initResponse.json().catch(() => ({})) as any;
      throw new Error(`Google Drive resumable upload init failed: ${errData.error?.message || initResponse.statusText}`);
    }

    const uploadUrl = initResponse.headers.get('location');
    if (!uploadUrl) {
      throw new Error('Google Drive resumable upload did not return an upload URL');
    }

    const putHeaders: Record<string, string> = {
      'Content-Type': mimeType,
    };
    if (fileSize && fileSize > 0) {
      putHeaders['Content-Length'] = String(fileSize);
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: putHeaders,
      body: stream as any,
      // @ts-ignore - required by undici/Node fetch when sending a ReadableStream body
      duplex: 'half',
    });

    const data = await uploadResponse.json().catch(() => ({})) as any;
    if (!uploadResponse.ok || !data.id) {
      throw new Error(`Google Drive stream upload failed: ${data.error?.message || uploadResponse.statusText}`);
    }

    return {
      fileId: data.id as string,
      name: (data.name as string) || fileName,
    };
  }

  /**
   * Stream a file from Google Drive (supports HTTP Range header passthrough).
   */
  public static async downloadStream(
    fileId: string,
    rangeHeader?: string
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (rangeHeader) {
      headers['Range'] = rangeHeader;
    }

    const response = await this.authorizedFetch(
      `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
      { method: 'GET', headers }
    );

    if (!response.ok && response.status !== 206) {
      const errData = await response.json().catch(() => ({})) as any;
      throw new Error(`Google Drive download failed (${response.status}): ${errData.error?.message || response.statusText}`);
    }

    return response;
  }

  /**
   * Download a file's full contents into a Buffer.
   */
  public static async downloadBuffer(fileId: string): Promise<Buffer> {
    const response = await this.downloadStream(fileId);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Delete a file from Google Drive. Treats 404 as already deleted.
   */
  public static async deleteFile(fileId: string): Promise<void> {
    const response = await this.authorizedFetch(
      `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
      { method: 'DELETE' }
    );

    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      const errData = await response.json().catch(() => ({})) as any;
      throw new Error(`Google Drive delete failed: ${errData.error?.message || response.statusText}`);
    }
  }

  /**
   * Rename a file in Google Drive.
   */
  public static async renameFile(fileId: string, newName: string): Promise<void> {
    const response = await this.authorizedFetch(
      `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      }
    );

    if (!response.ok) {
      const errData = await response.json().catch(() => ({})) as any;
      throw new Error(`Google Drive rename failed: ${errData.error?.message || response.statusText}`);
    }
  }

  /**
   * Move a file to a new relative path (folder + optional rename) under the Blinko root folder.
   */
  public static async moveFile(fileId: string, newRelativePath: string): Promise<void> {
    const config = await this.getConfig();
    const normalized = newRelativePath.replace(/^\/+/, '');
    const parts = normalized.split('/').filter(Boolean);
    const newName = parts.pop() || path.basename(normalized);
    const targetParentId = await this.ensureFolderPath(parts, config);

    // Fetch current parents so we can remove them cleanly
    const metaResponse = await this.authorizedFetch(
      `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=parents`,
      { method: 'GET' },
      config
    );
    const metaData = await metaResponse.json().catch(() => ({})) as any;
    if (!metaResponse.ok) {
      throw new Error(`Google Drive metadata lookup failed: ${metaData.error?.message || metaResponse.statusText}`);
    }

    const currentParents: string[] = Array.isArray(metaData.parents) ? metaData.parents : [];
    const params = new URLSearchParams({ fields: 'id,name,parents' });
    if (!currentParents.includes(targetParentId)) {
      params.set('addParents', targetParentId);
      if (currentParents.length > 0) {
        params.set('removeParents', currentParents.join(','));
      }
    }

    const patchResponse = await this.authorizedFetch(
      `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      },
      config
    );

    if (!patchResponse.ok) {
      const errData = await patchResponse.json().catch(() => ({})) as any;
      throw new Error(`Google Drive move failed: ${errData.error?.message || patchResponse.statusText}`);
    }
  }

  /**
   * Verify the current Google Drive OAuth 2.0 credentials and optional target folder.
   */
  public static async testConnection(explicitConfig?: GoogleDriveConfig): Promise<GoogleDriveTestResult> {
    const config = explicitConfig ?? await this.getConfig();
    const aboutResponse = await this.authorizedFetch(
      `${GOOGLE_DRIVE_API_BASE}/about?fields=user(emailAddress,displayName),storageQuota`,
      { method: 'GET' },
      config
    );

    const aboutData = await aboutResponse.json().catch(() => ({})) as any;
    if (!aboutResponse.ok) {
      throw new Error(`Google Drive connection test failed: ${aboutData.error?.message || aboutResponse.statusText}`);
    }

    let folderName: string | undefined;
    if (config.folderId) {
      const folderResponse = await this.authorizedFetch(
        `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(config.folderId)}?fields=id,name,mimeType,trashed`,
        { method: 'GET' },
        config
      );
      const folderData = await folderResponse.json().catch(() => ({})) as any;
      if (!folderResponse.ok) {
        throw new Error(`Configured Google Drive folder is inaccessible: ${folderData.error?.message || folderResponse.statusText}`);
      }
      if (folderData.mimeType !== GOOGLE_DRIVE_FOLDER_MIME) {
        throw new Error('Configured Google Drive Folder ID is not a folder');
      }
      if (folderData.trashed) {
        throw new Error('Configured Google Drive folder is in trash');
      }
      folderName = folderData.name;
    }

    return {
      email: aboutData.user?.emailAddress,
      displayName: aboutData.user?.displayName,
      storageLimit: aboutData.storageQuota?.limit,
      storageUsage: aboutData.storageQuota?.usage,
      folderName,
    };
  }
}
